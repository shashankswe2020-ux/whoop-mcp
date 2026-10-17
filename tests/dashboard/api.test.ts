import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApi, type DashboardApi } from "../../src/dashboard/api.js";
import { WhoopAuthError, WhoopNetworkError } from "../../src/api/client.js";
import { nights, performanceClient, redditHyroxDay } from "../helpers/performance-fixtures.js";
import { getToday } from "../../src/tools/get-today.js";

const NOW = new Date("2026-10-20T12:00:00Z");
let root: string;
let dir: string;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "whoop-dash-api-"));
  dir = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function api(sources: Parameters<typeof performanceClient>[0] = {}): DashboardApi {
  const { sleep, recovery } = nights("2026-10-20", 30, { recovery: 70 });
  return createDashboardApi({
    client: performanceClient({ workouts: redditHyroxDay(), sleep, recovery, ...sources }),
    directory: dir,
    now: () => NOW,
  });
}

const q = (init: Record<string, string> = {}): URLSearchParams => new URLSearchParams(init);

describe("createDashboardApi", () => {
  it("serves the exact get_today snapshot, including partial-source quality", async () => {
    const client = performanceClient({
      workouts: redditHyroxDay(),
      recovery: new WhoopNetworkError("unavailable"),
    });
    const dashboard = createDashboardApi({ client, directory: dir, now: () => NOW });
    const response = await dashboard("GET", "/api/today", q(), undefined);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(await getToday(client, NOW));
    expect(response.body).toMatchObject({
      recovery: null,
      data_quality: { sources: { recovery: { status: "fetch_failed" } } },
    });
    expect((await dashboard("POST", "/api/today", q(), {})).status).toBe(405);
  });
  it("serves each read view through the tool and its output contract", async () => {
    const call = api();
    for (const [path, query] of [
      ["/api/session-report", { date: "2026-10-15" }],
      ["/api/hyrox", {}],
      ["/api/triathlon", {}],
      ["/api/readiness", { sport: "triathlon" }],
      ["/api/audit", { limit: "5" }],
    ] as const) {
      const response = await call("GET", path, q(query), undefined);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(response.body).toMatchObject({ store: { status: "available" } });
    }
  });

  it("session report finds the Reddit HYROX day and its suspects", async () => {
    const response = await api()(
      "GET",
      "/api/session-report",
      q({ date: "2026-10-15" }),
      undefined
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain("short_segment_mislabel");
  });

  it("returns 404 for unknown paths, including prototype keys, and 405 for wrong methods", async () => {
    const call = api();
    expect((await call("GET", "/api/nope", q(), undefined)).status).toBe(404);
    expect((await call("GET", "/api/constructor", q(), undefined)).status).toBe(404);
    expect((await call("GET", "/api/__proto__", q(), undefined)).status).toBe(404);
    expect((await call("POST", "/api/hyrox", q(), {})).status).toBe(405);
    expect((await call("GET", "/api/annotate", q(), undefined)).status).toBe(405);
  });

  it("maps invalid input to 400 with the validation message", async () => {
    const call = api();
    const bad = await call("GET", "/api/readiness", q({ sport: "curling" }), undefined);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: expect.stringContaining("sport") });

    const limit = await call("GET", "/api/audit", q({ limit: "9999" }), undefined);
    expect(limit.status).toBe(400);

    const relabel = await call("POST", "/api/annotate", q(), {
      workout_id: "run-4",
      action: "relabel",
      reason: "misclassified",
    });
    expect(relabel.status).toBe(400);
    expect(relabel.body).toMatchObject({
      error: expect.stringContaining("relabel needs a discipline"),
    });
  });

  it("writes annotations as the dashboard actor and they affect later reads", async () => {
    const call = api();
    const annotated = await call("POST", "/api/annotate", q(), {
      workout_id: "run-1",
      action: "relabel",
      discipline: "hyrox",
      reason: "hyrox_sim",
    });
    expect(annotated.status, JSON.stringify(annotated.body)).toBe(200);

    const audit = await call("GET", "/api/audit", q(), undefined);
    expect(audit.body).toMatchObject({
      store: { status: "available" },
      unconfirmed_candidates: [],
      audit_log: { entries: [{ actor: "dashboard", action: "annotate_workout" }] },
    });
    const log = await readFile(join(dir, "performance-audit.jsonl"), "utf-8");
    expect(log).toContain('"actor":"dashboard"');
  });

  it("logs race results and checks claims", async () => {
    const call = api();
    const race = await call("POST", "/api/race-result", q(), {
      sport: "triathlon",
      date: "2026-10-04",
      name: "Goa 70.3",
      category: "half",
      total_seconds: 20000,
    });
    expect(race.status, JSON.stringify(race.body)).toBe(200);

    const claim = await call("POST", "/api/verify-claim", q(), {
      metric: "workout_count",
      claimed_value: 999,
      period: { start: "2026-10-15", end: "2026-10-16" },
    });
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ verdict: "contradicted" });
  });

  it("maps store corruption to 500 without leaking paths", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "performance.json"), "{broken");
    const response = await api()("POST", "/api/annotate", q(), {
      workout_id: "run-4",
      action: "exclude",
      reason: "misclassified",
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).toContain("Nothing was changed.");
    expect(JSON.stringify(response.body)).not.toContain(root);
  });

  it("maps WHOOP failures to 502 with a generic message", async () => {
    const auth = await api({ workouts: new WhoopAuthError("token expired secret-xyz") })(
      "GET",
      "/api/hyrox",
      q(),
      undefined
    );
    expect(auth.status).toBe(502);
    expect(JSON.stringify(auth.body)).not.toContain("secret-xyz");

    const network = await api({ workouts: new WhoopNetworkError("ECONNRESET 10.0.0.1") })(
      "GET",
      "/api/triathlon",
      q(),
      undefined
    );
    expect(network.status).toBe(502);
    expect(JSON.stringify(network.body)).not.toContain("10.0.0.1");
  });
});
