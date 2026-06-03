/**
 * Tests for HTTP transport layer (Task 13a).
 *
 * Covers: bearer auth, safeTokenCompare, health endpoint,
 * connection limiting, CORS, graceful shutdown.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import {
  safeTokenCompare,
  createHttpServer,
  type HttpServerOptions,
} from "../../src/transport/http.js";

// ---------------------------------------------------------------------------
// Helper: make HTTP requests to the test server
// ---------------------------------------------------------------------------

function request(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// safeTokenCompare
// ---------------------------------------------------------------------------

describe("safeTokenCompare", () => {
  it("returns true for matching tokens", () => {
    expect(safeTokenCompare("my-secret-token", "my-secret-token")).toBe(true);
  });

  it("returns false for non-matching tokens", () => {
    expect(safeTokenCompare("my-secret-token", "wrong-token")).toBe(false);
  });

  it("returns false for empty provided token", () => {
    expect(safeTokenCompare("", "my-secret-token")).toBe(false);
  });

  it("returns false for empty expected token", () => {
    expect(safeTokenCompare("my-secret-token", "")).toBe(false);
  });

  it("returns false when both are empty", () => {
    expect(safeTokenCompare("", "")).toBe(false);
  });

  it("handles tokens of different lengths", () => {
    expect(safeTokenCompare("short", "a-much-longer-token-value")).toBe(false);
  });

  it("handles unicode tokens", () => {
    expect(safeTokenCompare("tökën-🔑", "tökën-🔑")).toBe(true);
    expect(safeTokenCompare("tökën-🔑", "tökën-🔒")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP Server: Health endpoint
// ---------------------------------------------------------------------------

describe("HTTP Server", () => {
  let server: http.Server;
  let cleanup: (() => Promise<void>) | null = null;

  const defaultOptions: HttpServerOptions = {
    authToken: "test-token-abc123",
    port: 0, // dynamic port
  };

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  describe("/health endpoint", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns { status: 'ok' } without auth", async () => {
      const res = await request(server, "/health");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string };
      expect(body.status).toBe("ok");
      // Should NOT include detailed info without auth
      expect(body).not.toHaveProperty("uptime");
    });

    it("returns detailed health with valid bearer token", async () => {
      const res = await request(server, "/health", {
        headers: { authorization: "Bearer test-token-abc123" },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string; uptime: number };
      expect(body.status).toBe("ok");
      expect(body).toHaveProperty("uptime");
      expect(typeof body.uptime).toBe("number");
    });

    it("returns basic health with invalid bearer token", async () => {
      const res = await request(server, "/health", {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string };
      expect(body.status).toBe("ok");
      expect(body).not.toHaveProperty("uptime");
    });
  });

  // ---------------------------------------------------------------------------
  // Bearer auth on /mcp
  // ---------------------------------------------------------------------------

  describe("/mcp authentication", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns 401 without authorization header", async () => {
      const res = await request(server, "/mcp", { method: "POST" });
      expect(res.status).toBe(401);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 401 with invalid bearer token", async () => {
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 with non-Bearer scheme", async () => {
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
    });

    it("passes auth with valid bearer token (POST)", async () => {
      // Valid token should reach the transport handler (which may return 400
      // for invalid MCP payload, but NOT 401)
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token-abc123",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      // Transport will process it — should not be 401
      expect(res.status).not.toBe(401);
    });

    it("passes auth with valid bearer token (GET for SSE)", async () => {
      const res = await request(server, "/mcp", {
        method: "GET",
        headers: { authorization: "Bearer test-token-abc123" },
      });
      // Should not be 401 (may be 400 if no session established)
      expect(res.status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Connection limiting
  // ---------------------------------------------------------------------------

  describe("connection limiting", () => {
    it("returns 503 when max connections exceeded", async () => {
      // maxConnections=0 means ALL requests get rejected immediately
      const result = await createHttpServer({
        ...defaultOptions,
        maxConnections: 0,
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token-abc123",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("Service Unavailable");
    });

    it("activeConnections counter does not go negative after repeated malformed JSON bodies", async () => {
      // Regression for double-decrement bug: a malformed-JSON catch path must
      // not decrement activeConnections explicitly, since res.on("close")
      // already handles it. Otherwise the counter goes negative and the
      // connection limit silently stops working.
      const result = await createHttpServer({
        ...defaultOptions,
        maxConnections: 1,
      });
      server = result.server;
      cleanup = result.close;

      // Send several malformed POSTs sequentially. Each should return 400
      // and leave activeConnections at 0 (would go to -5 with the bug).
      for (let i = 0; i < 5; i++) {
        const res = await request(server, "/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token-abc123",
            "content-type": "application/json",
          },
          body: "this is not json",
        });
        expect(res.status).toBe(400);
      }

      // Open a POST that writes a partial body but never ends, so the server
      // is stuck inside `await readBody(...)`. This holds activeConnections
      // at 1 (== maxConnections). With the bug it would be at -4 and the
      // limit would not engage.
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      const slowReq = http.request({
        hostname: "127.0.0.1",
        port: addr.port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: "Bearer test-token-abc123",
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      });
      slowReq.on("error", () => {});
      slowReq.write("{");
      // Brief wait so the server-side handler reaches `await readBody` and
      // activeConnections is incremented.
      await new Promise((r) => setTimeout(r, 50));

      // A subsequent POST must be rejected with 503 because the limiter is
      // still working (counter at cap, not negative).
      const blocked = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token-abc123",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(blocked.status).toBe(503);

      slowReq.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------

  describe("CORS", () => {
    it("denies CORS for unknown origins", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        allowedOrigins: ["https://allowed.example.com"],
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows CORS for configured origins", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        allowedOrigins: ["https://allowed.example.com"],
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://allowed.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
    });

    it("denies all origins when no allowedOrigins configured", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://any.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  describe("graceful shutdown", () => {
    it("close() resolves and stops accepting connections", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      // Server should be listening
      expect(server.listening).toBe(true);

      // Close should resolve
      await result.close();

      // Server should no longer be listening
      expect(server.listening).toBe(false);

      // Set cleanup to null since we already closed
      cleanup = null;
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown routes
  // ---------------------------------------------------------------------------

  describe("unknown routes", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns 404 for unknown paths", async () => {
      const res = await request(server, "/unknown");
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Missing auth token at startup
  // ---------------------------------------------------------------------------

  describe("startup validation", () => {
    it("throws if authToken is empty", async () => {
      await expect(createHttpServer({ ...defaultOptions, authToken: "" })).rejects.toThrow(
        /MCP_AUTH_TOKEN/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // /health — upstream WHOOP API status (Task 13a/13d gap)
  // ---------------------------------------------------------------------------

  describe("/health WHOOP API probe", () => {
    it("reports whoopApi='ok' when healthCheck resolves true (authed)", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        healthCheck: () => Promise.resolve(true),
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        headers: { authorization: "Bearer test-token-abc123" },
      });
      const body = JSON.parse(res.body) as { whoopApi: string };
      expect(body.whoopApi).toBe("ok");
    });

    it("reports whoopApi='error' when healthCheck rejects (authed)", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        healthCheck: () => Promise.reject(new Error("upstream down")),
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        headers: { authorization: "Bearer test-token-abc123" },
      });
      const body = JSON.parse(res.body) as { whoopApi: string };
      expect(body.whoopApi).toBe("error");
    });

    it("reports whoopApi='unknown' when no healthCheck configured (authed)", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        headers: { authorization: "Bearer test-token-abc123" },
      });
      const body = JSON.parse(res.body) as { whoopApi: string };
      expect(body.whoopApi).toBe("unknown");
    });

    it("does not include whoopApi field on unauthenticated /health", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        healthCheck: () => Promise.resolve(true),
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health");
      const body = JSON.parse(res.body) as { whoopApi?: string };
      expect(body.whoopApi).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-IP rate limiting on /mcp (Task 13c-13)
  // ---------------------------------------------------------------------------

  describe("/mcp per-IP rate limit", () => {
    it("returns 429 once the per-IP window cap is exceeded", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        mcpRateLimit: { windowMs: 60_000, max: 2 },
      });
      server = result.server;
      cleanup = result.close;

      const headers = {
        authorization: "Bearer test-token-abc123",
        "content-type": "application/json",
      };
      const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });

      const r1 = await request(server, "/mcp", { method: "POST", headers, body });
      const r2 = await request(server, "/mcp", { method: "POST", headers, body });
      const r3 = await request(server, "/mcp", { method: "POST", headers, body });

      expect(r1.status).not.toBe(429);
      expect(r2.status).not.toBe(429);
      expect(r3.status).toBe(429);
      expect(r3.headers["retry-after"]).toBeDefined();
    });

    it("can be disabled with mcpRateLimit max=0", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        mcpRateLimit: { windowMs: 60_000, max: 0 },
      });
      server = result.server;
      cleanup = result.close;

      const headers = {
        authorization: "Bearer test-token-abc123",
        "content-type": "application/json",
      };
      const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });

      // Many requests, none should be 429
      for (let i = 0; i < 5; i++) {
        const r = await request(server, "/mcp", { method: "POST", headers, body });
        expect(r.status).not.toBe(429);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // OAuth handler forwarding (Task 13c runtime wiring)
  // ---------------------------------------------------------------------------

  describe("OAuth handler forwarding", () => {
    it("forwards /authorize, /token, /register, /.well-known/* to the configured handler", async () => {
      const seen: string[] = [];
      const oauthHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        seen.push(req.url ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ forwarded: req.url }));
      };

      const result = await createHttpServer({ ...defaultOptions, oauthHandler });
      server = result.server;
      cleanup = result.close;

      const paths = [
        "/authorize?x=1",
        "/token",
        "/register",
        "/.well-known/oauth-authorization-server",
      ];
      for (const p of paths) {
        const r = await request(server, p);
        expect(r.status).toBe(200);
        const body = JSON.parse(r.body) as { forwarded: string };
        expect(body.forwarded).toBe(p);
      }
      expect(seen).toHaveLength(4);
    });

    it("does not forward when oauthHandler is undefined (returns 404)", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      const r = await request(server, "/authorize");
      expect(r.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // trustProxy: client IP from X-Forwarded-For
  // ---------------------------------------------------------------------------

  describe("trustProxy header parsing", () => {
    it("uses X-Forwarded-For first IP for rate-limit bucketing when trustProxy is true", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        trustProxy: true,
        mcpRateLimit: { windowMs: 60_000, max: 1 },
      });
      server = result.server;
      cleanup = result.close;

      const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
      const headersA = {
        authorization: "Bearer test-token-abc123",
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.1",
      };
      const headersB = {
        authorization: "Bearer test-token-abc123",
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.2",
      };

      const r1 = await request(server, "/mcp", { method: "POST", headers: headersA, body });
      const r2 = await request(server, "/mcp", { method: "POST", headers: headersA, body });
      const r3 = await request(server, "/mcp", { method: "POST", headers: headersB, body });

      expect(r1.status).not.toBe(429);
      expect(r2.status).toBe(429); // same XFF IP
      expect(r3.status).not.toBe(429); // different XFF IP
    });
  });

  // ---------------------------------------------------------------------------
  // SSE periodic token re-validation (Task 13c-15)
  // ---------------------------------------------------------------------------

  describe("SSE re-auth sweep", () => {
    it("closes an active SSE connection when validateBearerToken returns false", async () => {
      let valid = true;
      const result = await createHttpServer({
        ...defaultOptions,
        sseReauthIntervalMs: 25, // fast for test
        validateBearerToken: () => valid,
      });
      server = result.server;
      cleanup = result.close;

      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");

      // Open an SSE connection (GET /mcp). Don't await — we want it open.
      const sseDone = new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: addr.port,
            path: "/mcp",
            method: "GET",
            headers: {
              authorization: "Bearer test-token-abc123",
              accept: "text/event-stream",
            },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", resolve);
            res.on("close", resolve);
          }
        );
        req.on("error", () => resolve());
        req.end();
      });

      // Wait for connection to register
      await new Promise((r) => setTimeout(r, 50));

      // Invalidate the token — sweep should close the connection
      valid = false;

      // sse re-auth runs on 25 ms interval; allow up to ~250 ms
      await Promise.race([
        sseDone,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error("SSE not closed in time")), 1000)
        ),
      ]);
    });
  });
});
