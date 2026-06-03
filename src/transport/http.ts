/**
 * HTTP transport for the WHOOP MCP server.
 *
 * Provides bearer-token authenticated HTTP access to the MCP server
 * using the SDK's StreamableHTTPServerTransport.
 *
 * All logging goes to stderr — stdout is reserved for stdio MCP channel.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpServerOptions {
  /** Bearer token required for /mcp routes */
  authToken: string;
  /** Port to listen on (0 = dynamic, used in tests) */
  port: number;
  /** Hostname to bind to (default: 0.0.0.0) */
  host?: string;
  /** Maximum concurrent connections (default: 5) */
  maxConnections?: number;
  /** Allowed CORS origins (default: deny all) */
  allowedOrigins?: string[];
  /** Whether to trust proxy headers (default: false) */
  trustProxy?: boolean;
  /**
   * Optional async probe used by GET /health (with valid bearer) to report
   * upstream WHOOP API status. Resolves true if reachable, false otherwise.
   * Probe failures are caught and reported as `whoopApi: "error"`.
   */
  healthCheck?: () => Promise<boolean>;
  /**
   * Optional handler for OAuth-related routes. When provided, requests whose
   * pathname starts with `/authorize`, `/token`, `/register`, or
   * `/.well-known/` are forwarded to it (typically an Express app from
   * `createOAuthApp`). Allows the connector + MCP transport to share a port.
   */
  oauthHandler?: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Per-IP rate limit for /mcp (default: 100 requests / 60s window).
   * Set both to 0 to disable.
   */
  mcpRateLimit?: { windowMs: number; max: number };
  /**
   * SSE re-validation interval in ms (default: 5 * 60 * 1000 = 5 min).
   * Active /mcp GET (SSE) connections whose bearer token no longer matches
   * are terminated. Set to 0 to disable.
   */
  sseReauthIntervalMs?: number;
  /**
   * Optional bearer-token validator used by the SSE re-auth sweep. Defaults
   * to a static comparison against `authToken` (never expires). Override to
   * plug in OAuth JWT expiry checks.
   */
  validateBearerToken?: (token: string) => boolean;
}

export interface HttpServerResult {
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** Gracefully close the server and drain connections */
  close: () => Promise<void>;
}

export interface HealthResponse {
  status: "ok";
  uptime?: number;
  version?: string;
  /** Upstream WHOOP API reachability — only present on authed /health */
  whoopApi?: "ok" | "error" | "unknown";
}

// ---------------------------------------------------------------------------
// safeTokenCompare — SHA-256 hash comparison (no length oracle)
// ---------------------------------------------------------------------------

/**
 * Compare two tokens using SHA-256 hashing + timing-safe comparison.
 * Hashing first ensures constant-time comparison regardless of token length.
 * Returns false for empty strings (avoids vacuous truth).
 */
export function safeTokenCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1] ?? null;
}

// ---------------------------------------------------------------------------
// CORS handling
// ---------------------------------------------------------------------------

function handleCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(origin && allowedOrigins.includes(origin) ? 204 : 403);
    res.end();
    return true; // request fully handled
  }

  return false; // not a preflight, continue processing
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Body parser (reads raw body for POST requests)
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1MB limit

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// createHttpServer
// ---------------------------------------------------------------------------

/**
 * Create an HTTP server with bearer-token auth for the MCP transport.
 *
 * The server exposes:
 * - POST /mcp — MCP protocol (requires bearer token)
 * - GET /mcp — SSE stream (requires bearer token)
 * - DELETE /mcp — Session termination (requires bearer token)
 * - GET /health — Health check (public: basic, authed: detailed)
 *
 * @throws Error if authToken is empty
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerResult> {
  const {
    authToken,
    port,
    host = "0.0.0.0",
    maxConnections = 5,
    allowedOrigins = [],
    trustProxy = false,
    healthCheck,
    oauthHandler,
    mcpRateLimit = { windowMs: 60_000, max: 100 },
    sseReauthIntervalMs = 5 * 60 * 1000,
    validateBearerToken,
  } = options;

  if (!authToken) {
    throw new Error(
      "MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http or MCP_TRANSPORT=both. " +
        "Set it to a secure random string (32+ characters recommended)."
    );
  }

  // Track active connections for limiting
  let activeConnections = 0;
  const startTime = Date.now();

  // Per-IP fixed-window rate limiter for /mcp (no extra deps).
  const mcpRateBuckets = new Map<string, { count: number; resetAt: number }>();
  function checkMcpRateLimit(ip: string): boolean {
    if (mcpRateLimit.max <= 0 || mcpRateLimit.windowMs <= 0) return true;
    const now = Date.now();
    const bucket = mcpRateBuckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      mcpRateBuckets.set(ip, { count: 1, resetAt: now + mcpRateLimit.windowMs });
      return true;
    }
    if (bucket.count >= mcpRateLimit.max) return false;
    bucket.count++;
    return true;
  }

  function clientIp(req: IncomingMessage): string {
    if (trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff.length > 0) {
        const first = xff.split(",")[0]?.trim();
        if (first) return first;
      }
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  // Track live SSE responses so we can re-validate the bearer token periodically.
  const sseConnections = new Set<{ res: ServerResponse; token: string }>();
  let sseTimer: NodeJS.Timeout | null = null;
  if (sseReauthIntervalMs > 0) {
    sseTimer = setInterval(() => {
      const validate =
        validateBearerToken ?? ((t: string): boolean => safeTokenCompare(t, authToken));
      for (const c of sseConnections) {
        if (!validate(c.token)) {
          c.res.end();
          sseConnections.delete(c);
        }
      }
    }, sseReauthIntervalMs);
    sseTimer.unref();
  }

  // Create the SDK transport (stateful with session IDs)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // Create HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // CORS handling
    if (handleCors(req, res, allowedOrigins)) {
      return; // preflight handled
    }

    // Route: /health
    if (pathname === "/health") {
      const token = extractBearerToken(req);
      const isAuthed = token !== null && safeTokenCompare(token, authToken);

      const health: HealthResponse = { status: "ok" };
      if (isAuthed) {
        health.uptime = Math.floor((Date.now() - startTime) / 1000);
        if (healthCheck) {
          try {
            health.whoopApi = (await healthCheck()) ? "ok" : "error";
          } catch {
            health.whoopApi = "error";
          }
        } else {
          health.whoopApi = "unknown";
        }
      }
      sendJson(res, 200, health);
      return;
    }

    // OAuth connector routes — forward to mounted handler if configured
    if (
      oauthHandler &&
      (pathname === "/authorize" ||
        pathname === "/token" ||
        pathname === "/register" ||
        pathname.startsWith("/.well-known/"))
    ) {
      oauthHandler(req, res);
      return;
    }

    // Route: /mcp (all methods)
    if (pathname === "/mcp") {
      // Auth check
      const token = extractBearerToken(req);
      if (!token || !safeTokenCompare(token, authToken)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      // Per-IP rate limit (100/min default)
      if (!checkMcpRateLimit(clientIp(req))) {
        res.setHeader("Retry-After", String(Math.ceil(mcpRateLimit.windowMs / 1000)));
        sendJson(res, 429, { error: "Too Many Requests" });
        return;
      }

      // Connection limit check
      if (activeConnections >= maxConnections) {
        sendJson(res, 503, {
          error: "Service Unavailable",
          message: "Maximum connections reached",
        });
        return;
      }

      // Track connection
      activeConnections++;
      const sseEntry = { res, token };
      if (req.method === "GET") {
        sseConnections.add(sseEntry);
      }
      res.on("close", () => {
        activeConnections--;
        sseConnections.delete(sseEntry);
      });

      // Parse body for POST requests
      let parsedBody: unknown = undefined;
      if (req.method === "POST") {
        try {
          const rawBody = await readBody(req);
          parsedBody = JSON.parse(rawBody) as unknown;
        } catch {
          sendJson(res, 400, { error: "Bad Request", message: "Invalid JSON body" });
          // res.on("close") handles activeConnections decrement
          return;
        }
      }

      // Delegate to SDK transport
      try {
        await transport.handleRequest(req, res, parsedBody);
      } catch (error: unknown) {
        // If response hasn't been sent yet
        if (!res.headersSent) {
          const message = error instanceof Error ? error.message : "Internal server error";
          sendJson(res, 500, { error: "Internal Server Error", message });
        }
      }
      return;
    }

    // Unknown routes
    sendJson(res, 404, { error: "Not Found" });
  });

  // Start listening
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      resolve();
    });
  });

  // Graceful shutdown
  const close = async (): Promise<void> => {
    if (sseTimer) {
      clearInterval(sseTimer);
      sseTimer = null;
    }
    await transport.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { server, transport, close };
}
