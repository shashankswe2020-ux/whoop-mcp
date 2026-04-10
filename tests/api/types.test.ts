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
} from "../../src/api/types.js";

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
