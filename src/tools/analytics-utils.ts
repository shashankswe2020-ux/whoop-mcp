import { z } from "zod";
import { offsetSchema } from "../api/record-schemas.js";
import type { Sleep } from "../api/types.js";
import type { WhoopClient } from "../api/client.js";
import { fetchAllPages, ABSOLUTE_MAX_RECORDS } from "../api/pagination.js";

export const DISCLAIMER = "Statistical observation from your data, not medical advice.";
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const periodSchema = z.object({ start: z.string(), end: z.string() });
export const sourceQualitySchema = z.object({
  status: z.enum([
    "available",
    "pending",
    "missing",
    "stale",
    "unscored",
    "calibrating",
    "invalid",
    "fetch_failed",
  ]),
  fetched_at: z.string().nullable(),
  source_updated_at: z.string().nullable(),
  cache_status: z.enum(["hit", "miss", "unknown"]),
  records_fetched: z.number().int().nonnegative(),
  records_used: z.number().int().nonnegative(),
  exclusions: z.record(z.string(), z.number().int().nonnegative()),
  truncated: z.boolean(),
});
export const dataQualitySchema = z.object({
  evaluated_at: z.string(),
  requested_period: periodSchema,
  observed_period: periodSchema.nullable(),
  sources: z.record(z.string(), sourceQualitySchema),
  method_version: z.string(),
  limitations: z.array(z.string()),
});
export type SourceQuality = z.infer<typeof sourceQualitySchema>;
export type DataQuality = z.infer<typeof dataQualitySchema>;

export function sourceQuality(count = 0, truncated = false): SourceQuality {
  return {
    status: "missing",
    fetched_at: null,
    source_updated_at: null,
    cache_status: "unknown",
    records_fetched: count,
    records_used: 0,
    exclusions: {},
    truncated,
  };
}

export function exclude(quality: SourceQuality, reason: string): void {
  quality.exclusions[reason] = (quality.exclusions[reason] ?? 0) + 1;
}

export function localTime(timestamp: string, offset: string): Date {
  offsetSchema.parse(offset);
  const minutes =
    (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * (offset[0] === "-" ? -1 : 1);
  return new Date(Date.parse(timestamp) + minutes * 60_000);
}

export function localDay(timestamp: string, offset: string): string {
  return localTime(timestamp, offset).toISOString().slice(0, 10);
}

export function asleepHours(sleep: Sleep): number {
  const stages = sleep.score!.stage_summary;
  return (
    (stages.total_light_sleep_time_milli +
      stages.total_slow_wave_sleep_time_milli +
      stages.total_rem_sleep_time_milli) /
    HOUR_MS
  );
}

export function observedPeriod(timestamps: string[]): { start: string; end: string } | null {
  const sorted = timestamps
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return sorted.length ? { start: sorted[0]!, end: sorted[sorted.length - 1]! } : null;
}

export function parseRecords<T>(
  records: unknown[],
  schema: z.ZodType<T>,
  quality: SourceQuality
): T[] {
  const parsed: T[] = [];
  for (const record of records) {
    const result = schema.safeParse(record);
    if (result.success) parsed.push(result.data);
    else exclude(quality, "invalid");
  }
  if (!parsed.length && records.length) quality.status = "invalid";
  return parsed;
}

export async function loadAnalyticsSource<T>(
  client: WhoopClient,
  endpoint: string,
  period: { start: string; end: string },
  schema: z.ZodType<T>
): Promise<{ records: T[]; quality: SourceQuality }> {
  const query = new URLSearchParams({ ...period, limit: "25" });
  const pageSchema = z.object({
    records: z.array(z.unknown()),
    next_token: z.string().max(4096).optional(),
  });
  const validatedClient: WhoopClient = {
    get: async <Result>(path: string): Promise<Result> =>
      pageSchema.parse(await client.get<unknown>(path)) as Result,
  };
  try {
    const result = await fetchAllPages<unknown>(validatedClient, `${endpoint}?${query}`, {
      maxRecords: ABSOLUTE_MAX_RECORDS,
    });
    const quality = sourceQuality(result.records.length, result.truncated);
    const records = parseRecords(result.records, schema, quality);
    return { records, quality };
  } catch (error: unknown) {
    return {
      records: [],
      quality: {
        ...sourceQuality(),
        status: error instanceof z.ZodError ? "invalid" : "fetch_failed",
      },
    };
  }
}

export function mainSleeps(
  records: Sleep[],
  period: { start: string; end: string },
  quality: SourceQuality
): Sleep[] {
  const selected = new Map<string, Sleep>();
  for (const record of records) {
    const duration = Date.parse(record.end) - Date.parse(record.start);
    if (
      duration <= 0 ||
      Date.parse(record.end) < Date.parse(period.start) ||
      Date.parse(record.end) >= Date.parse(period.end)
    ) {
      exclude(quality, "outside_window_or_invalid_duration");
      continue;
    }
    if (record.nap) {
      exclude(quality, "nap");
      continue;
    }
    if (record.score_state !== "SCORED" || !record.score) {
      exclude(quality, record.score_state === "PENDING_SCORE" ? "pending" : "unscored");
      continue;
    }
    const key = localDay(record.end, record.timezone_offset);
    const previous = selected.get(key);
    if (previous) {
      exclude(quality, "duplicate_day");
      const previousDuration = Date.parse(previous.end) - Date.parse(previous.start);
      if (
        duration < previousDuration ||
        (duration === previousDuration &&
          (Date.parse(record.end) < Date.parse(previous.end) ||
            (record.end === previous.end && record.id >= previous.id)))
      )
        continue;
    }
    selected.set(key, record);
  }
  return [...selected.values()].sort((left, right) => Date.parse(right.end) - Date.parse(left.end));
}

export function finishQuality(quality: SourceQuality, records: { updated_at: string }[]): void {
  quality.records_used = records.length;
  quality.source_updated_at =
    observedPeriod(records.map((record) => record.updated_at))?.end ?? null;
  if (records.length) quality.status = "available";
  else if (quality.status !== "fetch_failed" && quality.status !== "invalid") {
    quality.status = quality.exclusions.pending
      ? "pending"
      : quality.exclusions.calibrating
        ? "calibrating"
        : quality.exclusions.unscored
          ? "unscored"
          : "missing";
  }
}
