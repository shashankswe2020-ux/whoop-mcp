import { describe, it, expect } from "vitest";
import type {
  ScoreState,
  PaginatedResponse,
  UserProfile,
  BodyMeasurement,
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
