import { describe, it, expect } from "vitest";
import {
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
  normalizeWorkoutCoverage,
} from "../../src/api/record-schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseActivity = {
  user_id: 1,
  created_at: "2026-09-27T18:00:00.000Z",
  updated_at: "2026-09-27T18:00:00.000Z",
  start: "2026-09-27T18:00:00.000Z",
  end: "2026-09-27T19:00:00.000Z",
  timezone_offset: "-07:00",
  score_state: "SCORED" as const,
};

// ---------------------------------------------------------------------------
// recoveryRecordSchema
//
// WHOOP omits SpO2 and skin temp on hardware that doesn't support those
// sensors (e.g. WHOOP 3.0), returning the field as an explicit `null` rather
// than omitting the key. `.optional()` only accepts `undefined` — it rejects
// `null` — so these were previously mis-declared.
// ---------------------------------------------------------------------------

describe("recoveryRecordSchema", () => {
  const validRecoveryBase = {
    ...baseActivity,
    cycle_id: 123,
    sleep_id: "sleep-1",
    score: {
      user_calibrating: false,
      recovery_score: 68,
      resting_heart_rate: 60,
      hrv_rmssd_milli: 48,
    },
  };

  it("accepts spo2_percentage: null (device without SpO2 sensor)", () => {
    const result = recoveryRecordSchema.safeParse({
      ...validRecoveryBase,
      score: { ...validRecoveryBase.score, spo2_percentage: null },
    });
    expect(result.success).toBe(true);
  });

  it("accepts skin_temp_celsius: null (device without skin temp sensor)", () => {
    const result = recoveryRecordSchema.safeParse({
      ...validRecoveryBase,
      score: { ...validRecoveryBase.score, skin_temp_celsius: null },
    });
    expect(result.success).toBe(true);
  });

  it("still accepts spo2_percentage/skin_temp_celsius omitted entirely", () => {
    const result = recoveryRecordSchema.safeParse(validRecoveryBase);
    expect(result.success).toBe(true);
  });

  it("still accepts a real numeric spo2_percentage/skin_temp_celsius", () => {
    const result = recoveryRecordSchema.safeParse({
      ...validRecoveryBase,
      score: { ...validRecoveryBase.score, spo2_percentage: 98.1, skin_temp_celsius: 33.2 },
    });
    expect(result.success).toBe(true);
  });

  it("still rejects a wrong-type spo2_percentage (e.g. a string)", () => {
    const result = recoveryRecordSchema.safeParse({
      ...validRecoveryBase,
      score: { ...validRecoveryBase.score, spo2_percentage: "98.1" },
    });
    expect(result.success).toBe(false);
  });

  it("still accepts score: null for a PENDING_SCORE/UNSCORABLE recovery", () => {
    const result = recoveryRecordSchema.safeParse({ ...validRecoveryBase, score: null });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sleepRecordSchema
//
// respiratory_rate / sleep_performance_percentage / sleep_efficiency_percentage /
// sleep_consistency_percentage can each independently be `null` — e.g.
// sleep_consistency_percentage requires enough sleep history to compute a
// baseline and is null for new users or after a tracking gap.
// ---------------------------------------------------------------------------

describe("sleepRecordSchema", () => {
  const validSleepBase = {
    ...baseActivity,
    id: "sleep-1",
    cycle_id: 123,
    nap: false,
    score: {
      stage_summary: {
        total_in_bed_time_milli: 27000000,
        total_awake_time_milli: 600000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 16000000,
        total_slow_wave_sleep_time_milli: 5000000,
        total_rem_sleep_time_milli: 5000000,
        sleep_cycle_count: 5,
        disturbance_count: 3,
      },
      sleep_needed: {
        baseline_milli: 27000000,
        need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0,
        need_from_recent_nap_milli: 0,
      },
    },
  };

  it.each([
    "respiratory_rate",
    "sleep_performance_percentage",
    "sleep_efficiency_percentage",
    "sleep_consistency_percentage",
  ])("accepts %s: null", (field) => {
    const result = sleepRecordSchema.safeParse({
      ...validSleepBase,
      score: { ...validSleepBase.score, [field]: null },
    });
    expect(result.success).toBe(true);
  });

  it("accepts all four optional score fields null at once (new user, no history)", () => {
    const result = sleepRecordSchema.safeParse({
      ...validSleepBase,
      score: {
        ...validSleepBase.score,
        respiratory_rate: null,
        sleep_performance_percentage: null,
        sleep_efficiency_percentage: null,
        sleep_consistency_percentage: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it("still rejects a wrong-type sleep_performance_percentage", () => {
    const result = sleepRecordSchema.safeParse({
      ...validSleepBase,
      score: { ...validSleepBase.score, sleep_performance_percentage: "85" },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// workoutRecordSchema
//
// Confirmed against a live account: every workout returned distance_meter /
// altitude_gain_meter / altitude_change_meter as `null` for non-GPS
// activities (e.g. weightlifting, bouldering) — this was the original
// production failure ("WHOOP data did not match the expected output
// contract") that led to this fix.
// ---------------------------------------------------------------------------

describe("workoutRecordSchema", () => {
  const validWorkoutBase = {
    ...baseActivity,
    id: "workout-1",
    sport_name: "weightlifting",
    score: {
      strain: 8.2,
      average_heart_rate: 120,
      max_heart_rate: 150,
      kilojoule: 1200,
      percent_recorded: 100,
      zone_durations: {
        zone_zero_milli: 0,
        zone_one_milli: 0,
        zone_two_milli: 0,
        zone_three_milli: 0,
        zone_four_milli: 0,
        zone_five_milli: 0,
      },
    },
  };

  it.each([
    [0, 0],
    [0.99999, 99.999],
    [1, 100],
    [79.9, 79.9],
    [100, 100],
  ])("normalizes recorded coverage %s to percentage %s", (raw, expected) => {
    const result = normalizeWorkoutCoverage(
      workoutRecordSchema.parse({
        ...validWorkoutBase,
        score: { ...validWorkoutBase.score, percent_recorded: raw },
      })
    );
    expect(result.score?.percent_recorded).toBeCloseTo(expected);
  });

  it("accepts distance_meter/altitude_gain_meter/altitude_change_meter: null (non-GPS workout)", () => {
    const result = workoutRecordSchema.safeParse({
      ...validWorkoutBase,
      score: {
        ...validWorkoutBase.score,
        distance_meter: null,
        altitude_gain_meter: null,
        altitude_change_meter: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it("still accepts real numeric distance/altitude for a GPS workout (e.g. running)", () => {
    const result = workoutRecordSchema.safeParse({
      ...validWorkoutBase,
      sport_name: "running",
      score: {
        ...validWorkoutBase.score,
        distance_meter: 5000,
        altitude_gain_meter: 42.5,
        altitude_change_meter: 3.1,
      },
    });
    expect(result.success).toBe(true);
  });

  it("still accepts these fields omitted entirely", () => {
    const result = workoutRecordSchema.safeParse(validWorkoutBase);
    expect(result.success).toBe(true);
  });
});
