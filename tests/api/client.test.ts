import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WhoopApiError,
  WhoopNetworkError,
  WhoopAuthError,
  createWhoopClient,
} from "../../src/api/client.js";
import type { WhoopClient } from "../../src/api/client.js";

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

// ---------------------------------------------------------------------------
// Task 4b: createWhoopClient + successful GET
// ---------------------------------------------------------------------------

describe("createWhoopClient", () => {
  const TEST_BASE_URL = "https://test.whoop.api";
  const TEST_TOKEN = "test_access_token_abc123";

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Helper to create a mock Response for successful JSON responses */
  function mockJsonResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    } as Response;
  }

  describe("get (happy path)", () => {
    it("calls fetch with the correct URL (baseUrl + path)", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ user_id: 1 }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await client.get("/v2/user/profile/basic");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://test.whoop.api/v2/user/profile/basic",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("sends Authorization: Bearer <token> header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await client.get("/v2/recovery");

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    });

    it("sends Content-Type: application/json header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await client.get("/v2/recovery");

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("parses and returns the JSON response body", async () => {
      const responseData = {
        user_id: 10129,
        email: "test@whoop.com",
        first_name: "Test",
        last_name: "User",
      };
      mockFetch.mockResolvedValue(mockJsonResponse(responseData));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const result = await client.get<{ user_id: number; email: string }>("/v2/user/profile/basic");

      expect(result.user_id).toBe(10129);
      expect(result.email).toBe("test@whoop.com");
    });

    it("defaults to WHOOP_API_BASE_URL when baseUrl not provided", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      const client = createWhoopClient({ accessToken: TEST_TOKEN });

      await client.get("/v2/recovery");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.prod.whoop.com/developer/v2/recovery",
        expect.anything()
      );
    });

    it("sends AbortSignal.timeout for request timeout", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ ok: true }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await client.get("/v2/recovery");

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].signal).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Task 4c: Error handling — non-2xx responses
  // -------------------------------------------------------------------------

  describe("get (error responses)", () => {
    /** Helper to create a mock error Response with JSON body */
    function mockErrorResponse(status: number, statusText: string, body: unknown): Response {
      return {
        ok: false,
        status,
        statusText,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response;
    }

    it("throws WhoopApiError on 401 Unauthorized", async () => {
      mockFetch.mockResolvedValue(
        mockErrorResponse(401, "Unauthorized", { message: "Invalid token" })
      );
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);

      try {
        await client.get("/v2/recovery");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(401);
        expect(apiError.statusText).toBe("Unauthorized");
        expect(apiError.body).toEqual({ message: "Invalid token" });
      }
    });

    it("throws WhoopApiError on 429 Too Many Requests (after retries)", async () => {
      vi.useFakeTimers();
      const response429 = {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: () => null },
        json: () => Promise.resolve({ retry_after: 30 }),
        text: () => Promise.resolve("rate limited"),
      } as unknown as Response;
      mockFetch
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(response429);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");
      // Prevent PromiseRejectionHandledWarning — rejection is handled below
      promise.catch(() => {});
      // Advance through all retries
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      try {
        await promise;
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(429);
        expect(apiError.body).toEqual({ retry_after: 30 });
      }
      vi.useRealTimers();
    });

    it("throws WhoopApiError on 500 Internal Server Error", async () => {
      mockFetch.mockResolvedValue(
        mockErrorResponse(500, "Internal Server Error", { error: "unexpected" })
      );
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);

      try {
        await client.get("/v2/recovery");
      } catch (error) {
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(500);
        expect(apiError.statusText).toBe("Internal Server Error");
      }
    });

    it("includes status code and text in error message", async () => {
      mockFetch.mockResolvedValue(mockErrorResponse(403, "Forbidden", null));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow("WHOOP API error: 403 Forbidden");
    });

    it("falls back to text body when error response is not valid JSON", async () => {
      const htmlBody = "<html>Service Unavailable</html>";
      const response = {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
        text: () => Promise.resolve(htmlBody),
      } as Response;
      mockFetch.mockResolvedValue(response);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(503);
        expect(apiError.body).toBe(htmlBody);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Task 8b: 429 retry with backoff
  // -------------------------------------------------------------------------

  describe("get (429 retry)", () => {
    /** Helper to create a 429 response with optional Retry-After header */
    function mock429Response(retryAfter?: string): Response {
      const headers = new Map<string, string>();
      if (retryAfter !== undefined) {
        headers.set("retry-after", retryAfter);
      }
      return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: () => Promise.resolve({ error: "rate_limited" }),
        text: () => Promise.resolve("rate limited"),
      } as unknown as Response;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries on 429 and succeeds on 2nd attempt", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mockJsonResponse({ user_id: 1 }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get<{ user_id: number }>("/v2/recovery");
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.user_id).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 429 and succeeds on 3rd attempt", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mockJsonResponse({ ok: true }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");
      await vi.advanceTimersByTimeAsync(1000); // 1st retry
      await vi.advanceTimersByTimeAsync(2000); // 2nd retry

      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("throws WhoopApiError after max retries exhausted", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mock429Response());
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");
      // Prevent PromiseRejectionHandledWarning — rejection is handled below
      promise.catch(() => {});
      // Advance through all 3 retry delays: 1s, 2s, 4s
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      try {
        await promise;
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        expect((error as WhoopApiError).statusCode).toBe(429);
      }
      // 1 initial + 3 retries = 4 total calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("respects Retry-After header (seconds)", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response("5"))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");

      // Should not resolve before 5 seconds
      await vi.advanceTimersByTimeAsync(4000);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should resolve after 5 seconds
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("caps Retry-After to 60 seconds maximum", async () => {
      // Server says wait 999999 seconds — should be capped to 60s
      mockFetch
        .mockResolvedValueOnce(mock429Response("999999"))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");

      // Should not resolve before 60 seconds
      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should resolve at 60 seconds (the cap), not 999999 seconds
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on non-429 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve({ error: "server_error" }),
        text: () => Promise.resolve("server error"),
      } as unknown as Response);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("uses exponential backoff: 1s, 2s, 4s", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response()) // initial call
        .mockResolvedValueOnce(mock429Response()) // retry 1
        .mockResolvedValueOnce(mock429Response()) // retry 2
        .mockResolvedValueOnce(mock429Response()); // retry 3 (still fails)
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");
      // Prevent PromiseRejectionHandledWarning — rejection is handled below
      promise.catch(() => {});

      // After 999ms: only 1 call (initial)
      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // After 1s: retry 1 fires
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After 2s more: retry 2 fires
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // After 4s more: retry 3 fires
      await vi.advanceTimersByTimeAsync(4000);
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // All retries exhausted → throws
      try {
        await promise;
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Task 4d + Task 8a: Network errors
  // -------------------------------------------------------------------------

  describe("get (network errors)", () => {
    it("wraps network errors in WhoopNetworkError", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopNetworkError);
    });

    it("WhoopNetworkError has a user-friendly message", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(
        "Network error: Unable to reach the WHOOP API. Check your internet connection."
      );
    });

    it("WhoopNetworkError preserves the original error as cause", async () => {
      const originalError = new TypeError("fetch failed");
      mockFetch.mockRejectedValue(originalError);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopNetworkError);
        expect((error as WhoopNetworkError).cause).toBe(originalError);
      }
    });

    it("WhoopNetworkError has name 'WhoopNetworkError'", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as WhoopNetworkError).name).toBe("WhoopNetworkError");
      }
    });

    it("wraps non-TypeError network errors too", async () => {
      mockFetch.mockRejectedValue(new Error("DNS resolution failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopNetworkError);
    });

    it("does not wrap WhoopApiError as WhoopNetworkError", async () => {
      // Simulate a case where response processing throws a WhoopApiError
      // (this shouldn't be wrapped in network error)
      const apiError = new WhoopApiError(500, "Internal Server Error", null);
      mockFetch.mockRejectedValue(apiError);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);
      await expect(client.get("/v2/recovery")).rejects.not.toThrow(WhoopNetworkError);
    });
  });

  // -------------------------------------------------------------------------
  // Task 8c: 401 token refresh
  // -------------------------------------------------------------------------

  describe("get (401 token refresh)", () => {
    function mock401Response(): Response {
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => null },
        json: () => Promise.resolve({ message: "Invalid token" }),
        text: () => Promise.resolve("Unauthorized"),
      } as unknown as Response;
    }

    it("refreshes token and retries on 401", async () => {
      const NEW_TOKEN = "refreshed_token_xyz";
      mockFetch
        .mockResolvedValueOnce(mock401Response())
        .mockResolvedValueOnce(mockJsonResponse({ user_id: 42 }));
      const onTokenRefresh = vi.fn().mockResolvedValue(NEW_TOKEN);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      const result = await client.get<{ user_id: number }>("/v2/user/profile/basic");

      expect(result.user_id).toBe(42);
      expect(onTokenRefresh).toHaveBeenCalledOnce();
      // Second fetch should use the refreshed token
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const retryCall = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(retryCall[1].headers).toEqual(
        expect.objectContaining({ Authorization: `Bearer ${NEW_TOKEN}` })
      );
    });

    it("throws WhoopApiError if retry after refresh also returns 401", async () => {
      mockFetch.mockResolvedValueOnce(mock401Response()).mockResolvedValueOnce(mock401Response());
      const onTokenRefresh = vi.fn().mockResolvedValue("new_token");
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        expect((error as WhoopApiError).statusCode).toBe(401);
      }
      // Should NOT retry again (no infinite loop)
      expect(onTokenRefresh).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws WhoopApiError immediately when no onTokenRefresh callback", async () => {
      mockFetch.mockResolvedValueOnce(mock401Response());
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        // no onTokenRefresh
      });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        expect((error as WhoopApiError).statusCode).toBe(401);
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws WhoopAuthError when onTokenRefresh callback fails", async () => {
      mockFetch.mockResolvedValueOnce(mock401Response());
      const refreshError = new Error("Refresh token expired");
      const onTokenRefresh = vi.fn().mockRejectedValue(refreshError);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopAuthError);
        expect((error as WhoopAuthError).message).toContain("refresh token");
        expect((error as WhoopAuthError).cause).toBe(refreshError);
      }
    });

    it("WhoopAuthError has name 'WhoopAuthError'", async () => {
      mockFetch.mockResolvedValueOnce(mock401Response());
      const onTokenRefresh = vi.fn().mockRejectedValue(new Error("fail"));
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopAuthError);
        expect((error as WhoopAuthError).name).toBe("WhoopAuthError");
      }
    });

    it("does not call onTokenRefresh for non-401 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: { get: () => null },
        json: () => Promise.resolve({ message: "Forbidden" }),
        text: () => Promise.resolve("Forbidden"),
      } as unknown as Response);
      const onTokenRefresh = vi.fn().mockResolvedValue("new_token");
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);
      expect(onTokenRefresh).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Task 4d: Edge cases
  // -------------------------------------------------------------------------

  describe("get (edge cases)", () => {
    it("WhoopClient type can be used to type a variable", () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as Response);

      const client: WhoopClient = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
      });

      expect(client).toBeDefined();
      expect(typeof client.get).toBe("function");
    });

    it("falls back to exponential backoff when Retry-After header is non-numeric", async () => {
      // 429 with a non-numeric Retry-After header → parseRetryAfter returns null → exponential backoff
      const headers429 = new Headers();
      headers429.set("retry-after", "not-a-number");

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: headers429,
          json: () => Promise.resolve({ message: "rate limited" }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: "ok" }),
        } as Response);

      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
      });

      const result = await client.get<{ data: string }>("/v2/recovery");
      expect(result).toEqual({ data: "ok" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("falls back to exponential backoff when Retry-After header is negative", async () => {
      const headers429 = new Headers();
      headers429.set("retry-after", "-5");

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: headers429,
          json: () => Promise.resolve({ message: "rate limited" }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: "ok" }),
        } as Response);

      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
      });

      const result = await client.get<{ data: string }>("/v2/recovery");
      expect(result).toEqual({ data: "ok" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
