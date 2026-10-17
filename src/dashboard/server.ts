import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardApi } from "./api.js";

export const DASHBOARD_HOST = "127.0.0.1";
export const DASHBOARD_IDLE_MS = 30 * 60_000;
export const MAX_BODY_BYTES = 64 * 1024;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

/** The only files ever served. No user-controlled path reaches the file system. */
const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("./static/", import.meta.url));

export interface DashboardServerOptions {
  api: DashboardApi;
  staticDir?: string;
  idleMs?: number;
  onClose?: () => void;
}

export interface DashboardServer {
  readonly port: number;
  readonly origin: string;
  /** Current session token. Rotating invalidates the previous one. */
  token(): string;
  rotateToken(): string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function sameSecret(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  type = "application/json; charset=utf-8"
): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "Content-Type must be application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
}

/**
 * Loopback-only dashboard server.
 * - Binds 127.0.0.1 on an ephemeral port.
 * - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding).
 * - /api/* needs `Authorization: Bearer <token>`; POST also needs a matching Origin (CSRF).
 * - Static files carry no data and are served from a fixed allowlist.
 * - Shuts itself down after `idleMs` without requests.
 */
export async function startDashboardServer(
  options: DashboardServerOptions
): Promise<DashboardServer> {
  const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
  const idleMs = options.idleMs ?? DASHBOARD_IDLE_MS;
  let token = newToken();
  let port = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const allowedHosts = (): string[] => [`${DASHBOARD_HOST}:${port}`, `localhost:${port}`];
  const allowedOrigins = (): string[] => allowedHosts().map((host) => `http://${host}`);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!allowedHosts().includes(request.headers.host ?? ""))
      throw new HttpError(403, "Forbidden host.");
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins().includes(origin))
      throw new HttpError(403, "Forbidden origin.");
    const url = new URL(request.url ?? "/", `http://${DASHBOARD_HOST}:${port}`);
    const method = request.method ?? "GET";

    if (!url.pathname.startsWith("/api/")) {
      const entry = Object.hasOwn(STATIC_FILES, url.pathname)
        ? STATIC_FILES[url.pathname]
        : undefined;
      if (!entry) throw new HttpError(404, "Not found.");
      if (method !== "GET") throw new HttpError(405, "Method not allowed.");
      let content: Buffer;
      try {
        content = await readFile(join(staticDir, entry.file));
      } catch {
        throw new HttpError(404, "Not found.");
      }
      send(response, 200, content, entry.type);
      return;
    }

    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !sameSecret(header.slice(7), token))
      throw new HttpError(401, "Missing or invalid dashboard token. Reopen the dashboard.");
    if (method === "POST" && origin === undefined) throw new HttpError(403, "Origin required.");
    if (method !== "GET" && method !== "POST") throw new HttpError(405, "Method not allowed.");
    const body = method === "POST" ? await readJsonBody(request) : undefined;
    const result = await options.api(method, url.pathname, url.searchParams, body);
    sendJson(response, result.status, result.body);
  };

  const server = createServer((request, response) => {
    resetIdle();
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) sendJson(response, error.status, { error: error.message });
      else sendJson(response, 500, { error: "Unexpected error." });
    });
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    options.onClose?.();
  };

  function resetIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close(), idleMs);
    idleTimer.unref();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DASHBOARD_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  server.unref();
  resetIdle();

  return {
    port,
    origin: `http://${DASHBOARD_HOST}:${port}`,
    token: () => token,
    rotateToken: () => {
      token = newToken();
      resetIdle();
      return token;
    },
    close,
  };
}
