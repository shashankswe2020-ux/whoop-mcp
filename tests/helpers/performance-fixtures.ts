import type { Workout, ZoneDurations } from "../../src/api/types.js";

const MIN = 60_000;

export interface WorkoutSpec {
  id: string;
  sport: string;
  /** UTC ISO start */
  start: string;
  durationSeconds: number;
  avgHr?: number;
  maxHr?: number;
  strain?: number;
  kcal?: number;
  distance?: number | null;
  zonesMinutes?: [number, number, number, number, number, number];
  offset?: string;
  scoreState?: Workout["score_state"];
  percentRecorded?: number;
}

export function zones(minutes: [number, number, number, number, number, number]): ZoneDurations {
  return {
    zone_zero_milli: minutes[0] * MIN,
    zone_one_milli: minutes[1] * MIN,
    zone_two_milli: minutes[2] * MIN,
    zone_three_milli: minutes[3] * MIN,
    zone_four_milli: minutes[4] * MIN,
    zone_five_milli: minutes[5] * MIN,
  };
}

export function workout(spec: WorkoutSpec): Workout {
  const end = new Date(Date.parse(spec.start) + spec.durationSeconds * 1000).toISOString();
  const scoreState = spec.scoreState ?? "SCORED";
  return {
    id: spec.id,
    user_id: 42,
    created_at: end,
    updated_at: end,
    start: spec.start,
    end,
    timezone_offset: spec.offset ?? "+05:30",
    sport_name: spec.sport,
    score_state: scoreState,
    score:
      scoreState === "SCORED"
        ? {
            strain: spec.strain ?? 5,
            average_heart_rate: spec.avgHr ?? 140,
            max_heart_rate: spec.maxHr ?? 160,
            kilojoule: (spec.kcal ?? 50) * 4.184,
            percent_recorded: spec.percentRecorded ?? 100,
            zone_durations: zones(spec.zonesMinutes ?? [0, spec.durationSeconds / 60, 0, 0, 0, 0]),
            distance_meter: spec.distance ?? null,
          }
        : null,
  };
}

/** Local (+05:30) "HH:MM:SS" on 2026-10-15 → UTC ISO. */
function ist(time: string): string {
  return new Date(`2026-10-15T${time}+05:30`).toISOString();
}

/**
 * The HYROX simulation + lift from the r/whoop session report (2026-10-15).
 * Durations, HR, strain and kcal are taken from the report's segment table; start seconds are
 * chosen so tracked time = 40:24 and session span = 46:26 (transition 6:02, 13.0 %).
 */
export function redditHyroxDay(): Workout[] {
  const rows: Array<[string, string, string, number, number, number, number, number, number?]> = [
    ["run-1", "running", "19:32:00", 429, 142, 161, 5.3, 72],
    ["ski-1", "skiing", "19:39:30", 157, 147, 162, 4.5, 30, 1700],
    ["run-2", "running", "19:42:30", 349, 145, 162, 5.1, 62],
    ["row-1", "rowing", "19:50:00", 178, 122, 131, 4.1, 18],
    ["run-3", "running", "19:53:20", 347, 155, 169, 5.7, 74],
    ["run-4", "running", "20:00:10", 78, 118, 148, 4.0, 7],
    ["run-5", "running", "20:02:00", 375, 141, 152, 4.9, 62],
    ["ski-2", "skiing", "20:09:00", 201, 117, 145, 4.1, 16],
    ["run-6", "running", "20:13:16", 310, 162, 171, 5.9, 75, 11_700],
    ["lift-1", "weightlifting", "20:48:00", 3303, 115, 142, 11.9, 238],
  ];
  return rows.map(([id, sport, time, durationSeconds, avgHr, maxHr, strain, kcal, distance]) =>
    workout({
      id,
      sport,
      start: ist(time),
      durationSeconds,
      avgHr,
      maxHr,
      strain,
      kcal,
      distance: distance ?? null,
    })
  );
}

/**
 * One workout per day for `days` days ending on `endDay` (UTC, offset +00:00), each with
 * `zonesMinutes` in zone 1..5 (index 1..5). Edwards TRIMP per day = Σ minutes × zone.
 */
export function dailyWorkouts(
  endDay: string,
  days: number,
  sport: string,
  zonesMinutes: [number, number, number, number, number, number],
  idPrefix = sport
): Workout[] {
  const end = Date.parse(`${endDay}T07:00:00Z`);
  return Array.from({ length: days }, (_, index) => {
    const start = new Date(end - (days - 1 - index) * 86_400_000).toISOString();
    const minutes = zonesMinutes.reduce((total, value) => total + value, 0);
    return workout({
      id: `${idPrefix}-${index}`,
      sport,
      start,
      durationSeconds: minutes * 60,
      zonesMinutes,
      offset: "+00:00",
    });
  });
}
