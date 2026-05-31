/**
 * Tool: get_calendar
 *
 * Returns a multi-day grid view with recovery scores, sleep hours,
 * and strain per day. Uses auto-pagination for ranges > 25 records
 * and resolves natural language date inputs.
 */

import type { WhoopClient } from "../api/client.js";
import type { Recovery, Sleep, Cycle } from "../api/types.js";
import { ENDPOINT_RECOVERY, ENDPOINT_SLEEP, ENDPOINT_CYCLE } from "../api/endpoints.js";
import { fetchAllPages } from "../api/pagination.js";
import { resolveDateExpression } from "./date-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendarDay {
  date: string;
  recovery_score: number | null;
  recovery_zone: "green" | "yellow" | "red" | null;
  sleep_hours: number | null;
  sleep_performance_pct: number | null;
  day_strain: number | null;
  workout_count: number;
}

export interface CalendarAverages {
  recovery: number | null;
  sleep_hours: number | null;
  strain: number | null;
}

export interface CalendarGrid {
  period: { start: string; end: string; days: number };
  days: CalendarDay[];
  averages: CalendarAverages;
}

export interface CalendarParams {
  days?: number;
  start?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 7;
const MILLI_PER_HOUR = 1000 * 60 * 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function milliToHours(ms: number): number {
  return Math.round((ms / MILLI_PER_HOUR) * 10) / 10;
}

function recoveryZone(score: number): "green" | "yellow" | "red" {
  if (score >= 67) return "green";
  if (score >= 34) return "yellow";
  return "red";
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

/**
 * Extract the YYYY-MM-DD date from an ISO timestamp (uses the date portion in UTC).
 */
function dateFromTimestamp(iso: string): string {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Get a day-by-day calendar grid of recovery, sleep, and strain.
 *
 * @param client - Authenticated WHOOP API client
 * @param params - Optional: days (default 7), start (natural language or ISO)
 * @returns Calendar grid with per-day data and averages
 */
export async function getCalendar(
  client: WhoopClient,
  params: CalendarParams
): Promise<CalendarGrid> {
  const numDays = params.days ?? DEFAULT_DAYS;
  const now = new Date();

  // Determine date range
  let startDate: Date;
  if (params.start) {
    const resolved = resolveDateExpression(params.start);
    startDate = new Date(resolved.start);
  } else {
    startDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - numDays + 1)
    );
  }

  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const startISO = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  ).toISOString();
  const endISO = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate(), 23, 59, 59, 999)
  ).toISOString();

  // Fetch all three streams in parallel
  const [recoveryResult, sleepResult, cycleResult] = await Promise.all([
    fetchAllPages<Recovery>(
      client,
      `${ENDPOINT_RECOVERY}?start=${startISO}&end=${endISO}&limit=25`,
      {
        maxRecords: numDays * 2,
        interPageDelayMs: 0,
      }
    ),
    fetchAllPages<Sleep>(client, `${ENDPOINT_SLEEP}?start=${startISO}&end=${endISO}&limit=25`, {
      maxRecords: numDays * 2,
      interPageDelayMs: 0,
    }),
    fetchAllPages<Cycle>(client, `${ENDPOINT_CYCLE}?start=${startISO}&end=${endISO}&limit=25`, {
      maxRecords: numDays * 2,
      interPageDelayMs: 0,
    }),
  ]);

  // Index recovery by date (use created_at date)
  const recoveryByDate = new Map<string, Recovery>();
  for (const r of recoveryResult.records) {
    const date = dateFromTimestamp(r.created_at);
    recoveryByDate.set(date, r);
  }

  // Index sleep by wake-up date (end timestamp), exclude naps
  const sleepByDate = new Map<string, Sleep>();
  for (const s of sleepResult.records) {
    if (s.nap) continue;
    const date = dateFromTimestamp(s.end);
    // Only keep the first (most recent) non-nap sleep per day
    if (!sleepByDate.has(date)) {
      sleepByDate.set(date, s);
    }
  }

  // Index cycle by date (use start date)
  const cycleByDate = new Map<string, Cycle>();
  for (const c of cycleResult.records) {
    const date = dateFromTimestamp(c.start);
    cycleByDate.set(date, c);
  }

  // Build day grid (most recent first)
  const days: CalendarDay[] = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(
      Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate() - i)
    );
    const dateStr = formatDateUTC(d);

    const recovery = recoveryByDate.get(dateStr);
    const sleep = sleepByDate.get(dateStr);
    const cycle = cycleByDate.get(dateStr);

    const recoveryScore = recovery?.score?.recovery_score ?? null;

    days.push({
      date: dateStr,
      recovery_score: recoveryScore,
      recovery_zone: recoveryScore !== null ? recoveryZone(recoveryScore) : null,
      sleep_hours: sleep?.score
        ? milliToHours(sleep.score.stage_summary.total_in_bed_time_milli)
        : null,
      sleep_performance_pct: sleep?.score?.sleep_performance_percentage ?? null,
      day_strain: cycle?.score?.strain ?? null,
      workout_count: 0, // Workout count not available from cycle endpoint directly
    });
  }

  // Compute averages from non-null values
  const recoveryScores = days.map((d) => d.recovery_score).filter((v): v is number => v !== null);
  const sleepHours = days.map((d) => d.sleep_hours).filter((v): v is number => v !== null);
  const strains = days.map((d) => d.day_strain).filter((v): v is number => v !== null);

  return {
    period: {
      start: formatDateUTC(
        new Date(
          Date.UTC(
            endDate.getUTCFullYear(),
            endDate.getUTCMonth(),
            endDate.getUTCDate() - numDays + 1
          )
        )
      ),
      end: formatDateUTC(endDate),
      days: numDays,
    },
    days,
    averages: {
      recovery: average(recoveryScores),
      sleep_hours: average(sleepHours),
      strain: average(strains),
    },
  };
}
