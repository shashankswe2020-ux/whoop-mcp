import { z } from "zod";

export interface EvidenceInputs {
  records_used: number;
  records_excluded: number;
  excluded_reasons: Record<string, number>;
}

/** A derived number plus everything needed to audit it. */
export interface EvidencedMetric {
  value: number | null;
  unit: string;
  method: string;
  method_version: string;
  window: { start: string; end: string } | null;
  inputs: EvidenceInputs;
  source: "whoop" | "manual" | "mixed";
  status: "available" | "insufficient_data" | "unconfirmed" | "fetch_failed";
  limitations: string[];
}

export const evidencedMetricSchema = z.object({
  value: z.number().nullable(),
  unit: z.string(),
  method: z.string(),
  method_version: z.string(),
  window: z.object({ start: z.string(), end: z.string() }).nullable(),
  inputs: z.object({
    records_used: z.number().int(),
    records_excluded: z.number().int(),
    excluded_reasons: z.record(z.string(), z.number()),
  }),
  source: z.enum(["whoop", "manual", "mixed"]),
  status: z.enum(["available", "insufficient_data", "unconfirmed", "fetch_failed"]),
  limitations: z.array(z.string()),
}) satisfies z.ZodType<EvidencedMetric>;
