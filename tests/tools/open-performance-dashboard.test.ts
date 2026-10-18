import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDashboardController,
  openPerformanceDashboardInputSchema,
  openPerformanceDashboardOutputSchema,
  type DashboardController,
} from "../../src/tools/open-performance-dashboard.js";
import { performanceClient } from "../helpers/performance-fixtures.js";

let root: string;
let controller: DashboardController | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "whoop-dash-tool-"));
  await writeFile(join(root, "index.html"), "<!doctype html>");
});
afterEach(async () => {
  await controller?.close();
  controller = undefined;
  await rm(root, { recursive: true, force: true });
});

function make(openBrowser: (url: string) => void, idleMs?: number): DashboardController {
  controller = createDashboardController({
    client: performanceClient({}),
    directory: join(root, "state"),
    staticDir: root,
    openBrowser,
    ...(idleMs ? { idleMs } : {}),
  });
  return controller;
}

function tokenOf(url: string): string {
  return new URL(url).hash.replace(/^#token=/, "");
}

describe("open_performance_dashboard", () => {
  it.each(["today", "training"])("accepts %s as a starting view", async (view) => {
    const params = openPerformanceDashboardInputSchema.parse({ view });
    const result = await make(vi.fn()).open(params);
    expect(result.view).toBe(view);
    expect(result.url).toContain(`/?view=${view}#`);
    expect(openPerformanceDashboardOutputSchema.parse(result)).toEqual(result);
  });
  it("starts a loopback server, opens the browser and keeps the token in the fragment", async () => {
    const openBrowser = vi.fn();
    const result = await make(openBrowser).open({ view: "readiness" });

    expect(openPerformanceDashboardOutputSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      view: "readiness",
      reused: false,
      browser_opened: true,
      expires_after_idle_minutes: 30,
    });
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?view=readiness#token=[\w-]{43}$/);
    expect(result.url).not.toContain("&");
    expect(openBrowser).toHaveBeenCalledWith(result.url);

    const page = await fetch(result.url);
    expect(page.status).toBe(200);
    const api = await fetch(new URL("/api/audit", result.url), {
      headers: { authorization: `Bearer ${tokenOf(result.url)}` },
    });
    expect(api.status).toBe(200);
  });

  it("reuses the server and rotates the token on each call", async () => {
    const first = await make(vi.fn()).open({});
    const second = await controller!.open({ view: "audit" });

    expect(first.view).toBe("session");
    expect(second).toMatchObject({ reused: true, view: "audit" });
    expect(new URL(second.url).port).toBe(new URL(first.url).port);
    expect(tokenOf(second.url)).not.toBe(tokenOf(first.url));

    const stale = await fetch(new URL("/api/audit", first.url), {
      headers: { authorization: `Bearer ${tokenOf(first.url)}` },
    });
    expect(stale.status).toBe(401);
  });

  it("still returns the URL when the browser cannot be opened", async () => {
    const result = await make(() => {
      throw new Error("no display");
    }).open({});
    expect(result.browser_opened).toBe(false);
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("starts a fresh server after idle shutdown", async () => {
    const first = await make(vi.fn(), 50).open({});
    await vi.waitFor(
      async () => {
        await expect(fetch(first.url)).rejects.toThrow();
      },
      { timeout: 2000 }
    );
    const second = await controller!.open({});
    expect(second.reused).toBe(false);
    expect((await fetch(second.url)).status).toBe(200);
  });
});
