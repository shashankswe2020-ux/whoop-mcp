import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardApi } from "../../src/dashboard/api.js";
import { performanceClient, redditHyroxDay } from "../helpers/performance-fixtures.js";

let window: Window;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const files = new URL("../../src/dashboard/static/", import.meta.url);

async function idle(): Promise<void> {
  await vi.waitFor(() =>
    expect(window.document.querySelector("#main")?.hasAttribute("aria-busy")).toBe(false)
  );
}

async function open(view: string): Promise<void> {
  window = new Window({ url: `http://localhost/?view=${view}#token=test-only` });
  window.document.write(await readFile(new URL("index.html", files), "utf8"));
  const backend = createDashboardApi({ client: performanceClient({ workouts: redditHyroxDay() }) });
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
