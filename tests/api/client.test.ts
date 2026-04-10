import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WhoopApiError, createWhoopClient } from "../../src/api/client.js";
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
        expect.objectContaining({ method: "GET" }),
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

      const result = await client.get<{ user_id: number; email: string }>(
        "/v2/user/profile/basic",
      );

      expect(result.user_id).toBe(10129);
      expect(result.email).toBe("test@whoop.com");
    });

    it("defaults to WHOOP_API_BASE_URL when baseUrl not provided", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      const client = createWhoopClient({ accessToken: TEST_TOKEN });

      await client.get("/v2/recovery");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.prod.whoop.com/developer/v2/recovery",
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Task 4c: Error handling — non-2xx responses
  // -------------------------------------------------------------------------

  describe("get (error responses)", () => {
    /** Helper to create a mock error Response with JSON body */
    function mockErrorResponse(
      status: number,
      statusText: string,
      body: unknown,
    ): Response {
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
        mockErrorResponse(401, "Unauthorized", { message: "Invalid token" }),
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

    it("throws WhoopApiError on 429 Too Many Requests", async () => {
      mockFetch.mockResolvedValue(
        mockErrorResponse(429, "Too Many Requests", { retry_after: 30 }),
      );
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);

      try {
        await client.get("/v2/recovery");
      } catch (error) {
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(429);
        expect(apiError.body).toEqual({ retry_after: 30 });
      }
    });

    it("throws WhoopApiError on 500 Internal Server Error", async () => {
      mockFetch.mockResolvedValue(
        mockErrorResponse(500, "Internal Server Error", { error: "unexpected" }),
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
      mockFetch.mockResolvedValue(
        mockErrorResponse(403, "Forbidden", null),
      );
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(
        "WHOOP API error: 403 Forbidden",
      );
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
  // Task 4d: Edge cases
  // -------------------------------------------------------------------------

  describe("get (edge cases)", () => {
    it("propagates network errors from fetch", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(TypeError);
      await expect(client.get("/v2/recovery")).rejects.toThrow("fetch failed");
    });

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
  });
});
