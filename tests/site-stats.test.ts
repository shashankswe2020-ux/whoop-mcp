import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  downloadRanges,
  fetchProjectStats,
  renderProjectStats,
  updateStatsMarkup,
} from "../scripts/update-site-stats.js";

describe("public project statistics", () => {
  it("splits lifetime downloads into inclusive, non-overlapping one-year ranges", () => {
    expect(downloadRanges("2027-04-12")).toEqual([
      { start: "2026-04-11", end: "2027-04-10" },
      { start: "2027-04-11", end: "2027-04-12" },
    ]);
    expect(() => downloadRanges("2026-02-30")).toThrow();
    expect(() => downloadRanges("2026-04-10")).toThrow();
  });

  it("sums the full history and keeps the GitHub token away from npm", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return Response.json({
          full_name: "shashankswe2020-ux/whoop-mcp",
          stargazers_count: 166,
        });
      }
      const range = url.split("/")[5]!;
      const [start, end] = range.split(":");
      return Response.json({
        package: "whoop-ai-mcp",
        start,
        end,
        downloads: start === "2026-04-11" ? 7946 : 7,
      });
    });

    const stats = await fetchProjectStats(fetcher, "test-token", new Date("2027-04-13"));
    expect(stats).toEqual({
      downloads: 7953,
      stars: 166,
      downloadsThrough: "2027-04-12",
      checkedOn: "2027-04-13",
    });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("last-day"))).toBe(false);
    for (const [url, init] of fetcher.mock.calls) {
      const authorization = new Headers(init?.headers).get("Authorization");
      expect(authorization).toBe(
        String(url).includes("api.github.com") ? "Bearer test-token" : null
      );
    }
  });

  it.each([
    { response: { downloads: -1 }, status: 200 },
    { response: { downloads: "7946" }, status: 200 },
    { response: {}, status: 429 },
    { response: {}, status: 503 },
  ])(
    "rejects invalid or failed responses instead of publishing zero ($status)",
    async ({ response, status }) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response, { status }));
      await expect(fetchProjectStats(fetcher)).rejects.toThrow();
    }
  );

  it("rejects truncated ranges instead of presenting a partial total", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("api.github.com")) {
        return Response.json({ full_name: "shashankswe2020-ux/whoop-mcp", stargazers_count: 1 });
      }
      return Response.json({
        package: "whoop-ai-mcp",
        start: "2026-10-06",
        end: "2026-10-06",
        downloads: 3,
      });
    });
    await expect(fetchProjectStats(fetcher, undefined, new Date("2026-10-07"))).rejects.toThrow(
      "requested range"
    );
  });

  it("renders exact, dated totals with source links and preserves the rest of the page", () => {
    const markup = renderProjectStats({
      downloads: 7946,
      stars: 166,
      downloadsThrough: "2026-10-06",
      checkedOn: "2026-10-07",
    });
    expect(markup).toContain("7,946");
    expect(markup).toContain("166");
    expect(markup).toContain("Total npm downloads");
    expect(markup).toContain("GitHub stars");
    expect(markup).toContain('datetime="2026-10-06"');
    expect(markup).toContain("Downloads may include automated installs.");
    const disclaimer = markup.match(/<details class="stats-disclaimer">([\s\S]*?)<\/details>/)?.[1];
    expect(disclaimer).toContain("<summary>* Disclaimer</summary>");
    expect(disclaimer).toContain("Downloads since first publication");
    expect(disclaimer).toContain("Refreshed daily.");
    expect(disclaimer).toContain("Downloads may include automated installs.");
    expect(markup).toContain("https://www.npmjs.com/package/whoop-ai-mcp");
    expect(markup).toContain("https://github.com/shashankswe2020-ux/whoop-mcp/stargazers");
    const html = "<main><!-- project-stats:start -->old<!-- project-stats:end --></main>";
    expect(updateStatsMarkup(html, markup)).toBe(
      `<main><!-- project-stats:start -->\n${markup}\n<!-- project-stats:end --></main>`
    );
    expect(() => updateStatsMarkup("<main></main>", markup)).toThrow();
    expect(() => updateStatsMarkup(html + html, markup)).toThrow();
  });

  it("has one server-rendered stats slot and a daily deployment schedule", async () => {
    const [html, workflow] = await Promise.all([
      readFile(new URL("../site/index.html", import.meta.url), "utf8"),
      readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"),
    ]);
    expect(html.match(/<!-- project-stats:start -->/g)).toHaveLength(1);
    expect(html).toContain("Total npm downloads");
    expect(html).toContain('<details class="stats-disclaimer">');
    expect(html).toContain("<summary>* Disclaimer</summary>");
    expect(workflow).toContain('cron: "17 6 * * *"');
    expect(workflow.indexOf("npm run site:stats")).toBeLessThan(
      workflow.indexOf("actions/upload-pages-artifact")
    );
    expect(workflow).not.toContain("continue-on-error");
  });
});
