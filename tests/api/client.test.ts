import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";

// ---------------------------------------------------------------------------
// Task 4a: WhoopApiError
// ---------------------------------------------------------------------------

describe("WhoopApiError", () => {
  it("extends Error", () => {
    const error = new WhoopApiError(401, "Unauthorized", { message: "Invalid token" });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WhoopApiError);
  });

  it("has name 'WhoopApiError'", () => {
    const error = new WhoopApiError(500, "Internal Server Error", null);

    expect(error.name).toBe("WhoopApiError");
  });

  it("carries statusCode, statusText, and body", () => {
    const body = { error: "rate_limited", retry_after: 30 };
    const error = new WhoopApiError(429, "Too Many Requests", body);

    expect(error.statusCode).toBe(429);
    expect(error.statusText).toBe("Too Many Requests");
    expect(error.body).toEqual(body);
  });

  it("has a human-readable message", () => {
    const error = new WhoopApiError(401, "Unauthorized", null);

    expect(error.message).toBe("WHOOP API error: 401 Unauthorized");
  });
});
