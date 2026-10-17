import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { Window, type HTMLInputElement } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardApi } from "../../src/dashboard/api.js";
import {
  cycle,
  night,
  performanceClient,
  redditHyroxDay,
} from "../helpers/performance-fixtures.js";

let window: Window;
let directory: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const files = new URL("../../src/dashboard/static/", import.meta.url);

async function idle(): Promise<void> {
  await vi.waitFor(() =>
    expect(window.document.querySelector("#main")?.hasAttribute("aria-busy")).toBe(false)
  );
}

async function open(
  view: string,
  sources: Parameters<typeof performanceClient>[0] = {}
): Promise<void> {
  window = new Window({ url: `http://localhost/?view=${view}#token=test-only` });
  window.document.write(await readFile(new URL("index.html", files), "utf8"));
  const backend = createDashboardApi({
    client: performanceClient({ workouts: redditHyroxDay(), ...sources }),
    directory,
    now: () => new Date("2026-10-20T12:00:00Z"),
  });
  fetchMock = vi.fn(async (input, init) => {
    const url = new URL(String(input), window.location.href);
    if (init?.method === "POST") return Response.json({ saved: true });
    const response = await backend(
      init?.method ?? "GET",
      url.pathname,
      url.searchParams,
      undefined
    );
    return Response.json(response.body, { status: response.status });
  });
  const context = createContext({
    document: window.document,
    Node: window.Node,
    location: window.location,
    history: window.history,
    URLSearchParams,
    Date,
    fetch: fetchMock,
    console,
  });
  runInContext(await readFile(new URL("app.js", files), "utf8"), context);
  await idle();
}

function click(text: string): void {
  const button = [...window.document.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text
  );
  expect(button, text).toBeDefined();
  button!.click();
}

function fill(name: string, value: string): void {
  const control = window.document.querySelector<HTMLInputElement>(`[name="${name}"]`);
  expect(control, name).not.toBeNull();
  control!.value = value;
  control!.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function posts(): unknown[] {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}

beforeEach(async () => {
  vi.useRealTimers();
  directory = await mkdtemp(join(tmpdir(), "whoop-dashboard-ui-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await window?.happyDOM.close();
  await rm(directory, { recursive: true, force: true });
});

describe("dashboard interactions", () => {
  it("previews corrections without writing; edit/cancel restores focus and values", async () => {
    await open("audit");
    fill("workout_id", "run-4");
    click("Review correction");
    const dialog = window.document.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain("run-4");
    expect(dialog?.textContent).toContain("Exclude");
    expect(posts()).toHaveLength(0);
    window.document.activeElement?.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    expect(window.document.activeElement?.textContent).toBe("Confirm save");
    window.document.activeElement?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );
    expect(window.document.activeElement?.textContent).toBe("Edit");
    click("Edit");
    expect(window.document.querySelector("dialog")).toBeNull();
    expect(window.document.activeElement?.textContent).toBe("Review correction");
    expect(window.document.querySelector<HTMLInputElement>('[name="workout_id"]')?.value).toBe(
      "run-4"
    );
    click("Review correction");
    click("Cancel");
    expect(posts()).toHaveLength(0);
  });

  describe("dashboard navigation and refresh", () => {
    it("does not open a stale form review while a refresh is pending", async () => {
      await open("audit");
      fill("workout_id", "run-4");
      let finish: (response: Response) => void = () => {
        throw new Error("Not started");
      };
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      );
      click("Refresh");
      click("Review correction");
      expect(window.document.querySelector("dialog")).toBeNull();
      expect(window.document.querySelector("#status")?.textContent).toContain("still loading");
      finish(Response.json({ error: "Retry later." }, { status: 502 }));
      await idle();
      expect(posts()).toHaveLength(0);
    });
    it("uses exact completed UTC days across year boundaries and keeps filters across tabs", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2027-01-03T18:30:00Z"));
      await open("hyrox");
      click("Last 7 days");
      await idle();
      let request = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), "http://localhost");
      expect(request.searchParams.get("start")).toBe("2026-12-27");
      expect(request.searchParams.get("end")).toBe("2027-01-03");
      click("Triathlon");
      await idle();
      click("HYROX");
      await idle();
      expect(window.document.querySelector<HTMLInputElement>('[name="start"]')?.value).toBe(
        "2026-12-27"
      );
      click("Last 28 days");
      await idle();
      request = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), "http://localhost");
      expect(request.searchParams.get("start")).toBe("2026-12-06");
      expect(request.searchParams.get("end")).toBe("2027-01-03");
    });

    it("retains filters and prior data on a failed refresh, and supports retry", async () => {
      await open("hyrox");
      click("Last 7 days");
      await idle();
      const loaded = window.document.querySelector("#loaded-at")?.textContent;
      expect(loaded).toContain("View loaded");
      expect(window.document.body.textContent).toContain("cached");
      const previousStart =
        window.document.querySelector<HTMLInputElement>('[name="start"]')?.value;
      fetchMock.mockResolvedValueOnce(
        Response.json({ error: "Try again later." }, { status: 502 })
      );
      click("Refresh");
      await idle();
      expect(window.document.querySelector("#status")?.textContent).toContain("Try again later");
      expect(window.document.querySelector("#loaded-at")?.textContent).toBe(loaded);
      expect(window.document.querySelector<HTMLInputElement>('[name="start"]')?.value).toBe(
        previousStart
      );
      click("Retry");
      await idle();
      expect(window.document.querySelector("#status")?.textContent).toBe("");
    });

    it("does not replace a newer view when an older request completes", async () => {
      await open("hyrox");
      let finish: (response: Response) => void = () => {
        throw new Error("Not started");
      };
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      );
      click("Refresh");
      click("Today");
      await idle();
      finish(Response.json({ error: "Old request failed" }, { status: 502 }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(window.document.querySelector("#main")?.textContent).toContain("Daily overview");
      expect(window.document.querySelector("#status")?.textContent).not.toContain("Old request");
    });
  });

  describe("daily overview", () => {
    it("preserves zero scores and dates a historical latest workout", async () => {
      const { sleep, recovery } = night({ day: "2026-10-20", recovery: 0 });
      await open("today", {
        sleep: [sleep],
        recovery: [recovery],
        cycles: [{ ...cycle("2026-10-20", 0), end: null }],
      });
      const rows = window.document.querySelectorAll(".today-row");
      expect(rows[0]?.textContent).toContain("0%");
      expect(rows[1]?.textContent).toContain("7.5 h asleep");
      expect(rows[2]?.textContent).toContain("0.0");
      expect(rows[3]?.textContent).toContain("earlier day");
      expect(rows[3]?.textContent).toContain("15");
    });

    it("labels pending sleep and does not substitute an older scored sleep", async () => {
      const current = night({ day: "2026-10-20", recovery: 70 });
      const older = night({ day: "2026-10-19", recovery: 70 });
      await open("today", {
        sleep: [{ ...current.sleep, score_state: "PENDING_SCORE", score: null }, older.sleep],
        cycles: [{ ...cycle("2026-10-20", 5), end: null }],
      });
      const row = window.document.querySelectorAll(".today-row")[1];
      expect(row?.textContent).toContain("Pending");
      expect(row?.textContent).not.toContain("7.5 h asleep");
    });
    it("shows missing data and source evidence instead of zero scores", async () => {
      await open("today");
      expect(window.document.querySelector("#main")?.textContent).toContain("Daily overview");
      expect(window.document.querySelector("#main")?.textContent).toContain("Missing");
      expect(window.document.querySelector("#main")?.textContent).not.toContain("0% recovery");
      expect(window.document.querySelector("#main")?.textContent).toContain("today-2");
      click("Race readiness");
      await idle();
      expect(
        window.document.querySelector('[data-view="readiness"]')?.getAttribute("aria-selected")
      ).toBe("true");
    });
  });

  it("sends one write while pending and preserves values on error", async () => {
    await open("audit");
    fill("workout_id", "run-4");
    click("Review correction");
    let finish: (response: Response) => void = () => {
      throw new Error("Not started");
    };
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    click("Confirm save");
    click("Confirm save");
    expect(posts()).toHaveLength(1);
    finish(Response.json({ error: "Store busy. Try again." }, { status: 503 }));
    await vi.waitFor(() =>
      expect(window.document.querySelector("dialog")?.textContent).toContain("Store busy")
    );
    expect(window.document.querySelector("dialog")?.open).toBe(true);
    click("Edit");
    expect(window.document.querySelector<HTMLInputElement>('[name="workout_id"]')?.value).toBe(
      "run-4"
    );
  });

  it("reviews race details and splits before one confirmed write", async () => {
    await open("triathlon");
    fill("date", "2026-10-10");
    fill("name", "Coastal race");
    fill("total", "1:00:00");
    fill("swim_seconds", "10:00");
    fill("t1_seconds", "2:00");
    fill("bike_seconds", "30:00");
    fill("t2_seconds", "3:00");
    fill("run_seconds", "15:00");
    click("Review result");
    expect(window.document.querySelector("dialog")?.textContent).toContain("Coastal race");
    expect(window.document.querySelector("dialog")?.textContent).toContain("Swim10:00");
    expect(posts()).toHaveLength(0);
    click("Confirm save");
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    await vi.waitFor(() => expect(window.document.querySelector("dialog")).toBeNull());
    await idle();
    expect(window.document.querySelector("dialog")).toBeNull();
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({
      total_seconds: 3600,
      splits: {
        swim_seconds: 600,
        t1_seconds: 120,
        bike_seconds: 1800,
        t2_seconds: 180,
        run_seconds: 900,
      },
    });
  });
});
