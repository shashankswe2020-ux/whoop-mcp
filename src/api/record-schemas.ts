import { z } from "zod";

const nonnegative = z.number().finite().nonnegative();
const percentage = nonnegative.max(100);
export const timestampSchema = z.string().datetime({ offset: true });
export const offsetSchema = z.string().regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/);
const common = {
  user_id: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]),
};
const activity = {
  ...common,
  start: timestampSchema,
  end: timestampSchema,
  timezone_offset: offsetSchema,
};

export const recoveryRecordSchema = z
  .object({
    ...common,
    cycle_id: z.number().int(),
    sleep_id: z.string().min(1),
    score: z
      .object({
        user_calibrating: z.boolean(),
        recovery_score: percentage,
        resting_heart_rate: nonnegative,
        hrv_rmssd_milli: nonnegative,
        spo2_percentage: percentage.optional(),
        skin_temp_celsius: z.number().finite().optional(),
      })
      .nullish(),
  })
  .passthrough();

export const sleepRecordSchema = z
  .object({
    ...activity,
    id: z.string().min(1),
    cycle_id: z.number().int(),
    nap: z.boolean(),
    score: z
      .object({
        stage_summary: z.object({
          total_in_bed_time_milli: nonnegative,
          total_awake_time_milli: nonnegative,
          total_no_data_time_milli: nonnegative,
          total_light_sleep_time_milli: nonnegative,
          total_slow_wave_sleep_time_milli: nonnegative,
          total_rem_sleep_time_milli: nonnegative,
          sleep_cycle_count: nonnegative,
          disturbance_count: nonnegative,
        }),
        sleep_needed: z.object({
          baseline_milli: nonnegative,
          need_from_sleep_debt_milli: z.number().finite(),
          need_from_recent_strain_milli: z.number().finite(),
          need_from_recent_nap_milli: z.number().finite(),
        }),
        respiratory_rate: nonnegative.optional(),
        sleep_performance_percentage: percentage.optional(),
        sleep_efficiency_percentage: percentage.optional(),
        sleep_consistency_percentage: percentage.optional(),
      })
      .nullish(),
  })
  .passthrough();

export const cycleRecordSchema = z
  .object({
    ...activity,
    id: z.number().int(),
    end: timestampSchema.nullish(),
    score: z
      .object({
        strain: nonnegative.max(21),
        kilojoule: nonnegative,
        average_heart_rate: nonnegative,
        max_heart_rate: nonnegative,
      })
      .nullish(),
  })
  .passthrough();

export const workoutRecordSchema = z
  .object({
    ...activity,
    id: z.string().min(1),
    sport_name: z.string().max(200),
    score: z
      .object({
        strain: nonnegative.max(21),
        average_heart_rate: nonnegative,
        max_heart_rate: nonnegative,
        kilojoule: nonnegative,
        percent_recorded: percentage,
        zone_durations: z.object({
          zone_zero_milli: nonnegative,
          zone_one_milli: nonnegative,
          zone_two_milli: nonnegative,
          zone_three_milli: nonnegative,
          zone_four_milli: nonnegative,
          zone_five_milli: nonnegative,
        }),
        distance_meter: z.number().finite().optional(),
        altitude_gain_meter: z.number().finite().optional(),
        altitude_change_meter: z.number().finite().optional(),
      })
      .nullish(),
  })
  .passthrough();
