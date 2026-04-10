import { describe, it, expect } from "vitest";
import type {
  ScoreState,
  PaginatedResponse,
  UserProfile,
  BodyMeasurement,
  Recovery,
  RecoveryCollection,
  Sleep,
  SleepCollection,
  Cycle,
  CycleCollection,
  Workout,
  WorkoutCollection,
} from "../../src/api/types.js";
import {
  WHOOP_API_BASE_URL,
  WHOOP_AUTH_URL,
  WHOOP_TOKEN_URL,
  WHOOP_REQUIRED_SCOPES,
  WHOOP_REDIRECT_URI,
  ENDPOINT_USER_PROFILE,
  ENDPOINT_BODY_MEASUREMENT,
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
  ENDPOINT_CYCLE,
} from "../../src/api/endpoints.js";

describe("shared types", () => {
  describe("ScoreState", () => {
    it("accepts all three valid score states", () => {
      const scored: ScoreState = "SCORED";
      const pending: ScoreState = "PENDING_SCORE";
      const unscorable: ScoreState = "UNSCORABLE";

      expect(scored).toBe("SCORED");
      expect(pending).toBe("PENDING_SCORE");
      expect(unscorable).toBe("UNSCORABLE");
    });
  });

  describe("PaginatedResponse", () => {
    it("accepts a paginated response with records and next_token", () => {
      const response: PaginatedResponse<{ id: number }> = {
        records: [{ id: 1 }, { id: 2 }],
        next_token: "abc123",
      };

      expect(response.records).toHaveLength(2);
      expect(response.next_token).toBe("abc123");
    });

    it("accepts a paginated response without next_token", () => {
      const response: PaginatedResponse<{ id: number }> = {
        records: [{ id: 1 }],
      };

      expect(response.records).toHaveLength(1);
      expect(response.next_token).toBeUndefined();
    });
  });
});

describe("user types", () => {
  describe("UserProfile", () => {
    it("accepts a valid user profile from the API", () => {
      const profile: UserProfile = {
        user_id: 10129,
        email: "jsmith123@whoop.com",
        first_name: "John",
        last_name: "Smith",
      };

      expect(profile.user_id).toBe(10129);
      expect(profile.email).toBe("jsmith123@whoop.com");
      expect(profile.first_name).toBe("John");
      expect(profile.last_name).toBe("Smith");
    });
  });

  describe("BodyMeasurement", () => {
    it("accepts valid body measurements from the API", () => {
      const body: BodyMeasurement = {
        height_meter: 1.8288,
        weight_kilogram: 90.7185,
        max_heart_rate: 200,
      };

      expect(body.height_meter).toBeCloseTo(1.8288);
      expect(body.weight_kilogram).toBeCloseTo(90.7185);
      expect(body.max_heart_rate).toBe(200);
    });
  });
});

describe("recovery types", () => {
  it("accepts a scored recovery with all score fields", () => {
    const recovery: Recovery = {
      cycle_id: 93845,
      sleep_id: "123e4567-e89b-12d3-a456-426614174000",
      user_id: 10129,
      created_at: "2022-04-24T11:25:44.774Z",
      updated_at: "2022-04-24T14:25:44.774Z",
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 44.0,
        resting_heart_rate: 64.0,
        hrv_rmssd_milli: 31.813562,
        spo2_percentage: 95.6875,
        skin_temp_celsius: 33.7,
      },
    };

    expect(recovery.score_state).toBe("SCORED");
    expect(recovery.score?.recovery_score).toBe(44.0);
    expect(recovery.score?.spo2_percentage).toBe(95.6875);
    expect(recovery.score?.skin_temp_celsius).toBe(33.7);
  });

  it("accepts a pending recovery without score", () => {
    const recovery: Recovery = {
      cycle_id: 93846,
      sleep_id: "223e4567-e89b-12d3-a456-426614174000",
      user_id: 10129,
      created_at: "2022-04-25T11:25:44.774Z",
      updated_at: "2022-04-25T14:25:44.774Z",
      score_state: "PENDING_SCORE",
    };

    expect(recovery.score).toBeUndefined();
  });

  it("accepts a paginated recovery collection", () => {
    const collection: RecoveryCollection = {
      records: [
        {
          cycle_id: 93845,
          sleep_id: "123e4567-e89b-12d3-a456-426614174000",
          user_id: 10129,
          created_at: "2022-04-24T11:25:44.774Z",
          updated_at: "2022-04-24T14:25:44.774Z",
          score_state: "SCORED",
          score: {
            user_calibrating: false,
            recovery_score: 78.0,
            resting_heart_rate: 55.0,
            hrv_rmssd_milli: 45.2,
          },
        },
      ],
      next_token: "MTIzOjEyMzEyMw",
    };

    expect(collection.records).toHaveLength(1);
    expect(collection.next_token).toBe("MTIzOjEyMzEyMw");
  });
});

describe("sleep types", () => {
  it("accepts a scored sleep with full stage summary and sleep needed", () => {
    const sleep: Sleep = {
      id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
      cycle_id: 93845,
      user_id: 10129,
      created_at: "2022-04-24T11:25:44.774Z",
      updated_at: "2022-04-24T14:25:44.774Z",
      start: "2022-04-24T02:25:44.774Z",
      end: "2022-04-24T10:25:44.774Z",
      timezone_offset: "-05:00",
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 30272735,
          total_awake_time_milli: 1403507,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 14905851,
          total_slow_wave_sleep_time_milli: 6630370,
          total_rem_sleep_time_milli: 5879573,
          sleep_cycle_count: 3,
          disturbance_count: 12,
        },
        sleep_needed: {
          baseline_milli: 27395716,
          need_from_sleep_debt_milli: 352230,
          need_from_recent_strain_milli: 208595,
          need_from_recent_nap_milli: -12312,
        },
        respiratory_rate: 16.11328125,
        sleep_performance_percentage: 98.0,
        sleep_consistency_percentage: 90.0,
        sleep_efficiency_percentage: 91.69533848,
      },
    };

    expect(sleep.score_state).toBe("SCORED");
    expect(sleep.nap).toBe(false);
    expect(sleep.score?.stage_summary.sleep_cycle_count).toBe(3);
    expect(sleep.score?.sleep_needed.baseline_milli).toBe(27395716);
    expect(sleep.score?.respiratory_rate).toBeCloseTo(16.113);
  });

  it("accepts a sleep without optional fields", () => {
    const sleep: Sleep = {
      id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
      cycle_id: 93845,
      user_id: 10129,
      created_at: "2022-04-24T11:25:44.774Z",
      updated_at: "2022-04-24T14:25:44.774Z",
      start: "2022-04-24T02:25:44.774Z",
      end: "2022-04-24T10:25:44.774Z",
      timezone_offset: "-05:00",
      nap: true,
      score_state: "PENDING_SCORE",
    };

    expect(sleep.score).toBeUndefined();
    expect(sleep.v1_id).toBeUndefined();
  });

  it("accepts a paginated sleep collection", () => {
    const collection: SleepCollection = {
      records: [],
    };

    expect(collection.records).toHaveLength(0);
    expect(collection.next_token).toBeUndefined();
  });
});

describe("cycle types", () => {
  it("accepts a scored cycle with strain data", () => {
    const cycle: Cycle = {
      id: 93845,
      user_id: 10129,
      created_at: "2022-04-24T11:25:44.774Z",
      updated_at: "2022-04-24T14:25:44.774Z",
      start: "2022-04-24T02:25:44.774Z",
      end: "2022-04-24T10:25:44.774Z",
      timezone_offset: "-05:00",
      score_state: "SCORED",
      score: {
        strain: 5.2951527,
        kilojoule: 8288.297,
        average_heart_rate: 68,
        max_heart_rate: 141,
      },
    };

    expect(cycle.score_state).toBe("SCORED");
    expect(cycle.score?.strain).toBeCloseTo(5.295);
    expect(cycle.score?.kilojoule).toBeCloseTo(8288.297);
  });

  it("accepts a cycle without end time (user currently in cycle)", () => {
    const cycle: Cycle = {
      id: 93846,
      user_id: 10129,
      created_at: "2022-04-25T11:25:44.774Z",
      updated_at: "2022-04-25T14:25:44.774Z",
      start: "2022-04-25T02:25:44.774Z",
      timezone_offset: "-05:00",
      score_state: "PENDING_SCORE",
    };

    expect(cycle.end).toBeUndefined();
    expect(cycle.score).toBeUndefined();
  });

  it("accepts a paginated cycle collection", () => {
    const collection: CycleCollection = {
      records: [
        {
          id: 93845,
          user_id: 10129,
          created_at: "2022-04-24T11:25:44.774Z",
          updated_at: "2022-04-24T14:25:44.774Z",
          start: "2022-04-24T02:25:44.774Z",
          timezone_offset: "-05:00",
          score_state: "UNSCORABLE",
        },
      ],
      next_token: "abc123",
    };

    expect(collection.records).toHaveLength(1);
    expect(collection.records[0]?.score_state).toBe("UNSCORABLE");
  });
});

describe("workout types", () => {
  it("accepts a scored workout with zone durations and optional distance", () => {
    const workout: Workout = {
      id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
      user_id: 9012,
      created_at: "2022-04-24T11:25:44.774Z",
      updated_at: "2022-04-24T14:25:44.774Z",
      start: "2022-04-24T02:25:44.774Z",
      end: "2022-04-24T10:25:44.774Z",
      timezone_offset: "-05:00",
      sport_name: "running",
      score_state: "SCORED",
      score: {
        strain: 8.2463,
        average_heart_rate: 123,
        max_heart_rate: 146,
        kilojoule: 1569.34033203125,
        percent_recorded: 100.0,
        distance_meter: 1772.77035916,
        altitude_gain_meter: 46.64384460449,
        altitude_change_meter: -0.781372010707855,
        zone_durations: {
          zone_zero_milli: 300000,
          zone_one_milli: 600000,
          zone_two_milli: 900000,
          zone_three_milli: 900000,
          zone_four_milli: 600000,
          zone_five_milli: 300000,
        },
      },
    };

    expect(workout.sport_name).toBe("running");
    expect(workout.score?.strain).toBeCloseTo(8.246);
    expect(workout.score?.zone_durations.zone_five_milli).toBe(300000);
    expect(workout.score?.distance_meter).toBeCloseTo(1772.77);
  });

  it("accepts a workout without optional fields", () => {
    const workout: Workout = {
      id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
      user_id: 9012,
      created_at: "2022-04-24T11:25:44.774Z",
      updated_at: "2022-04-24T14:25:44.774Z",
      start: "2022-04-24T02:25:44.774Z",
      end: "2022-04-24T10:25:44.774Z",
      timezone_offset: "-05:00",
      sport_name: "cycling",
      score_state: "PENDING_SCORE",
    };

    expect(workout.score).toBeUndefined();
    expect(workout.v1_id).toBeUndefined();
    expect(workout.sport_id).toBeUndefined();
  });

  it("accepts a paginated workout collection", () => {
    const collection: WorkoutCollection = {
      records: [
        {
          id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
          user_id: 9012,
          created_at: "2022-04-24T11:25:44.774Z",
          updated_at: "2022-04-24T14:25:44.774Z",
          start: "2022-04-24T02:25:44.774Z",
          end: "2022-04-24T10:25:44.774Z",
          timezone_offset: "-05:00",
          sport_name: "running",
          score_state: "SCORED",
          score: {
            strain: 8.2463,
            average_heart_rate: 123,
            max_heart_rate: 146,
            kilojoule: 1569.34,
            percent_recorded: 100.0,
            zone_durations: {
              zone_zero_milli: 300000,
              zone_one_milli: 600000,
              zone_two_milli: 900000,
              zone_three_milli: 900000,
              zone_four_milli: 600000,
              zone_five_milli: 300000,
            },
          },
        },
      ],
      next_token: "nextPage123",
    };

    expect(collection.records).toHaveLength(1);
    expect(collection.next_token).toBe("nextPage123");
  });
});

describe("endpoint constants", () => {
  it("defines the correct WHOOP API base URL", () => {
    expect(WHOOP_API_BASE_URL).toBe(
      "https://api.prod.whoop.com/developer",
    );
  });

  it("defines the correct OAuth URLs", () => {
    expect(WHOOP_AUTH_URL).toBe(
      "https://api.prod.whoop.com/oauth/oauth2/auth",
    );
    expect(WHOOP_TOKEN_URL).toBe(
      "https://api.prod.whoop.com/oauth/oauth2/token",
    );
  });

  it("defines all required OAuth scopes", () => {
    expect(WHOOP_REQUIRED_SCOPES).toContain("read:recovery");
    expect(WHOOP_REQUIRED_SCOPES).toContain("read:cycles");
    expect(WHOOP_REQUIRED_SCOPES).toContain("read:workout");
    expect(WHOOP_REQUIRED_SCOPES).toContain("read:sleep");
    expect(WHOOP_REQUIRED_SCOPES).toContain("read:profile");
    expect(WHOOP_REQUIRED_SCOPES).toContain("read:body_measurement");
  });

  it("defines the default redirect URI", () => {
    expect(WHOOP_REDIRECT_URI).toBe("http://localhost:3000/callback");
  });

  it("defines all 6 endpoint paths as v2 routes", () => {
    expect(ENDPOINT_USER_PROFILE).toBe("/v2/user/profile/basic");
    expect(ENDPOINT_BODY_MEASUREMENT).toBe("/v2/user/measurement/body");
    expect(ENDPOINT_RECOVERY).toBe("/v2/recovery");
    expect(ENDPOINT_SLEEP).toBe("/v2/activity/sleep");
    expect(ENDPOINT_WORKOUT).toBe("/v2/activity/workout");
    expect(ENDPOINT_CYCLE).toBe("/v2/cycle");
  });
});
