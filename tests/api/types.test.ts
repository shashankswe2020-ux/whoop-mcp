import { describe, it, expect } from "vitest";
import type {
  ScoreState,
  PaginatedResponse,
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
