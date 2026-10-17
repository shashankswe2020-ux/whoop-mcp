import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardApi } from "../../src/dashboard/api.js";
import {
  cycle,
  night,
  performanceClient,
  redditHyroxDay,
} from "../helpers/performance-fixtures.js";

let window: Window;
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
    fetch: fetchMock,
    console,
  });
  runInContext(await readFile(new URL("app.js", files), "utf8"), context);
  await idle();
}

function click(text: string): void {
  const button = [...window.document.querySelectorAll("button")].find(
    (node) => node.textContent === text
  );
  expect(button, text).toBeDefined();
  button!.click();
}

function fill(name: string, value: string): void {
  const control = window.document.querySelector<HTMLInputElement>(`[name="${name}"]`);
  expect(control, name).not.toBeNull();
  control!.value = value;
}

function posts(): unknown[] {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}

beforeEach(() => vi.useRealTimers());
afterEach(async () => {
  await window?.happyDOM.close();
});

describe("dashboard reviewed saves", () => {
  it("previews corrections without writing; edit/cancel restores focus and values", async () => {
    await open("audit");
    fill("workout_id", "run-4");
    click("Review correction");
    const dialog = window.document.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain("run-4");
    expect(dialog?.textContent).toContain("Exclude");
    expect(posts()).toHaveLength(0);
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
    click("Review result");
    expect(window.document.querySelector("dialog")?.textContent).toContain("Coastal race");
    expect(posts()).toHaveLength(0);
    click("Confirm save");
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    await vi.waitFor(() => expect(window.document.querySelector("dialog")).toBeNull());
    await idle();
    expect(window.document.querySelector("dialog")).toBeNull();
  });
});
