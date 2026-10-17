import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardApi } from "../../src/dashboard/api.js";
import {
  CONTENT_SECURITY_POLICY,
  MAX_BODY_BYTES,
  startDashboardServer,
  type DashboardServer,
} from "../../src/dashboard/server.js";

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function raw(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

let staticDir: string;
let server: DashboardServer | undefined;
let api: ReturnType<typeof vi.fn<DashboardApi>>;

beforeEach(async () => {
  staticDir = await mkdtemp(join(tmpdir(), "whoop-dash-static-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>dash</title>");
  await writeFile(join(staticDir, "app.js"), "console.log(1);");
  await writeFile(join(staticDir, "style.css"), "body{}");
  await writeFile(join(staticDir, "secret.txt"), "do-not-serve");
  api = vi.fn<DashboardApi>(async (method, path, query, body) => ({
    status: 200,
    body: { method, path, query: Object.fromEntries(query), body: body ?? null },
  }));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(staticDir, { recursive: true, force: true });
});

async function start(idleMs?: number, onClose?: () => void): Promise<DashboardServer> {
  server = await startDashboardServer({
    api,
    staticDir,
    ...(idleMs ? { idleMs } : {}),
    ...(onClose ? { onClose } : {}),
  });
  return server;
}

const bearer = (s: DashboardServer): Record<string, string> => ({
  authorization: `Bearer ${s.token()}`,
});

describe("startDashboardServer", () => {
  it("binds to 127.0.0.1 on an ephemeral port with a 256-bit token", async () => {
    const s = await start();
    expect(s.origin).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.port).toBeGreaterThan(0);
    expect(Buffer.from(s.token(), "base64url")).toHaveLength(32);
  });

  it("serves only allowlisted static files with security headers", async () => {
    const s = await start();
    const index = await raw(s.port, { path: "/" });
    expect(index.status).toBe(200);
    expect(index.headers["content-type"]).toMatch(/^text\/html/);
    expect(index.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(index.headers["x-content-type-options"]).toBe("nosniff");
    expect(index.headers["x-frame-options"]).toBe("DENY");
    expect(index.headers["referrer-policy"]).toBe("no-referrer");
    expect(index.headers["cache-control"]).toBe("no-store");
    expect((await raw(s.port, { path: "/app.js" })).headers["content-type"]).toMatch(
      /^text\/javascript/
    );
    expect((await raw(s.port, { path: "/style.css?v=1" })).status).toBe(200);

    for (const path of ["/secret.txt", "/../secret.txt", "/%2e%2e/secret.txt", "/static/app.js"])
      expect((await raw(s.port, { path })).status, path).toBe(404);
    expect((await raw(s.port, { path: "/", method: "POST" })).status).toBe(405);
  });

  it("rejects foreign Host headers (DNS rebinding) even with a valid token", async () => {
    const s = await start();
    for (const host of ["evil.example", `evil.example:${s.port}`, "127.0.0.1:1"]) {
      const response = await raw(s.port, { path: "/api/hyrox", headers: { host, ...bearer(s) } });
      expect(response.status, host).toBe(403);
    }
    const ok = await raw(s.port, {
      path: "/api/hyrox",
      headers: { host: `localhost:${s.port}`, ...bearer(s) },
    });
    expect(ok.status).toBe(200);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("requires the current bearer token on /api/*", async () => {
    const s = await start();
    expect((await raw(s.port, { path: "/api/hyrox" })).status).toBe(401);
    expect(
      (await raw(s.port, { path: "/api/hyrox", headers: { authorization: "Bearer nope" } })).status
    ).toBe(401);
    expect(
      (await raw(s.port, { path: "/api/hyrox", headers: { authorization: s.token() } })).status
    ).toBe(401);

    const old = s.token();
    s.rotateToken();
    expect(
      (await raw(s.port, { path: "/api/hyrox", headers: { authorization: `Bearer ${old}` } }))
        .status
    ).toBe(401);
    const ok = await raw(s.port, { path: "/api/hyrox?limit=3", headers: bearer(s) });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({
      method: "GET",
      path: "/api/hyrox",
      query: { limit: "3" },
    });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("guards POST with Origin, content type and body size", async () => {
    const s = await start();
    const json = { "content-type": "application/json", ...bearer(s) };
    const body = JSON.stringify({ workout_id: "w1" });

    expect(
      (await raw(s.port, { method: "POST", path: "/api/annotate", headers: json, body })).status
    ).toBe(403);
    expect(
      (
        await raw(s.port, {
          method: "POST",
          path: "/api/annotate",
          headers: { ...json, origin: "http://evil.example" },
          body,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await raw(s.port, {
          method: "POST",
          path: "/api/annotate",
          headers: { ...bearer(s), origin: s.origin, "content-type": "text/plain" },
          body,
        })
      ).status
    ).toBe(415);
    expect(
      (
        await raw(s.port, {
          method: "POST",
          path: "/api/annotate",
          headers: { ...json, origin: s.origin },
          body: "{not json",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await raw(s.port, {
          method: "POST",
          path: "/api/annotate",
          headers: { ...json, origin: s.origin },
          body: "x".repeat(MAX_BODY_BYTES + 1),
        })
      ).status
    ).toBe(413);
    expect(
      (await raw(s.port, { method: "DELETE", path: "/api/annotate", headers: bearer(s) })).status
    ).toBe(405);
    expect(api).not.toHaveBeenCalled();

    const ok = await raw(s.port, {
      method: "POST",
      path: "/api/annotate",
      headers: { ...json, origin: `http://localhost:${s.port}` },
      body,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ body: { workout_id: "w1" } });
  });

  it("returns the API status and a generic 500 when the API throws", async () => {
    const s = await start();
    api.mockResolvedValueOnce({ status: 404, body: { error: "Not found." } });
    expect((await raw(s.port, { path: "/api/x", headers: bearer(s) })).status).toBe(404);

    api.mockRejectedValueOnce(new Error("/Users/someone/.whoop-mcp exploded"));
    const failed = await raw(s.port, { path: "/api/x", headers: bearer(s) });
    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain("/Users/");
    expect(failed.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
  });

  it("shuts down after the idle period and notifies onClose", async () => {
    const onClose = vi.fn();
    const s = await start(60, onClose);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await expect(raw(s.port, { path: "/" })).rejects.toThrow();
  });
});
