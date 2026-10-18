import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDashboardApi } from "../../src/dashboard/api.js";
import { DEFAULT_STATIC_DIR } from "../../src/dashboard/server.js";
import { performanceClient } from "../helpers/performance-fixtures.js";

const read = (file: string): Promise<string> => readFile(join(DEFAULT_STATIC_DIR, file), "utf-8");

describe("dashboard static assets", () => {
  it("index.html has no inline script, inline style or inline handlers", async () => {
    const html = await read("index.html");
    expect(html).toMatch(/<script type="module" src="\/app\.js"><\/script>/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("app.js never builds HTML from strings or loads remote code", async () => {
    const js = await read("app.js");
    for (const pattern of [
      /innerHTML/,
      /outerHTML/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\(/,
      /new Function/,
      /localStorage|sessionStorage|document\.cookie/,
      /https?:\/\/(?!www\.w3\.org\/2000\/svg)/,
    ])
      expect(js, String(pattern)).not.toMatch(pattern);
  });

  it("app.js strips the token fragment and only calls routes the API serves", async () => {
    const js = await read("app.js");
    expect(js).toMatch(/history\.replaceState\(null, "", `\/\?view=/);
    const paths = [...new Set(js.match(/"\/api\/[a-z-]+"/g)?.map((path) => path.slice(1, -1)))];
    expect(paths.sort()).toEqual([
      "/api/annotate",
      "/api/audit",
      "/api/history",
      "/api/hyrox",
      "/api/race-result",
      "/api/readiness",
      "/api/session-report",
      "/api/today",
      "/api/training",
      "/api/triathlon",
      "/api/verify-claim",
    ]);
    const api = createDashboardApi({ client: performanceClient({}) });
    for (const path of paths)
      expect((await api("PUT", path, new URLSearchParams(), undefined)).status, path).toBe(405);
  });

  it("style.css loads no external resources", async () => {
    const css = await read("style.css");
    expect(css).not.toMatch(/@import|https?:|url\(["']?(?:\/\/|data:)/);
    const fonts = [...css.matchAll(/url\("\/(fonts\/[^"]+)"\)/g)];
    expect(fonts).toHaveLength(7);
    for (const [, path] of fonts)
      expect((await readFile(join(DEFAULT_STATIC_DIR, path!))).subarray(0, 4).toString()).toBe(
        "wOF2"
      );
  });
});
