import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const PACKAGE = "whoop-ai-mcp";
const REPOSITORY = "shashankswe2020-ux/whoop-mcp";
const FIRST_PUBLISHED = "2026-04-11";
const DAY_MS = 86_400_000;
const countSchema = z.number().int().nonnegative();
const downloadsSchema = z.object({
  package: z.literal(PACKAGE),
  start: z.iso.date(),
  end: z.iso.date(),
  downloads: countSchema,
});
const statsSchema = z.object({
  downloads: countSchema,
  stars: countSchema,
  downloadsThrough: z.iso.date(),
  checkedOn: z.iso.date(),
});

type ProjectStats = z.infer<typeof statsSchema>;

export function downloadRanges(end: string): Array<{ start: string; end: string }> {
  z.iso.date().parse(end);
  if (end < FIRST_PUBLISHED) throw new Error("Download date precedes first publication");
  const ranges = [];
  const last = Date.parse(end);
  // npm limits requests to 18 months; one-year chunks also handle leap years.
  for (let start = Date.parse(FIRST_PUBLISHED); start <= last; start += 365 * DAY_MS) {
    ranges.push({
      start: new Date(start).toISOString().slice(0, 10),
      end: new Date(Math.min(start + 364 * DAY_MS, last)).toISOString().slice(0, 10),
    });
  }
  return ranges;
}

export async function fetchProjectStats(
  fetcher: typeof fetch = fetch,
  githubToken?: string,
  now: Date = new Date()
): Promise<ProjectStats> {
  async function request(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Statistics request failed: ${url} (HTTP ${response.status})`);
    return response.json();
  }

  const repository = await request(`https://api.github.com/repos/${REPOSITORY}`, {
    Accept: "application/vnd.github+json",
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  }).then((value) =>
    z
      .object({
        full_name: z.literal(REPOSITORY),
        stargazers_count: countSchema,
      })
      .parse(value)
  );
  const checkedOn = now.toISOString().slice(0, 10);
  const downloadsThrough = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);

  let downloads = 0;
  for (const range of downloadRanges(downloadsThrough)) {
    const result = downloadsSchema.parse(
      await request(`https://api.npmjs.org/downloads/point/${range.start}:${range.end}/${PACKAGE}`)
    );
    if (result.start !== range.start || result.end !== range.end) {
      throw new Error("npm did not return the full requested range");
    }
    downloads += result.downloads;
  }
  return statsSchema.parse({
    downloads,
    stars: repository.stargazers_count,
    downloadsThrough,
    checkedOn,
  });
}

export function renderProjectStats(input: ProjectStats): string {
  const stats = statsSchema.parse(input);
  const number = new Intl.NumberFormat("en-US");
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `<section class="project-stats" aria-label="Project activity">
  <dl>
    <div><dt><a href="https://www.npmjs.com/package/${PACKAGE}">Total npm downloads</a></dt><dd>${number.format(stats.downloads)}</dd></div>
    <div><dt><a href="https://github.com/${REPOSITORY}/stargazers">GitHub stars</a></dt><dd>${number.format(stats.stars)}</dd></div>
  </dl>
  <details class="stats-disclaimer">
  <summary>* Disclaimer</summary>
  <p>Downloads since first publication, through <time datetime="${stats.downloadsThrough}">${date.format(new Date(stats.downloadsThrough))}</time>.
  Stars checked <time datetime="${stats.checkedOn}">${date.format(new Date(stats.checkedOn))}</time>. Refreshed daily.</p>
  <p>Downloads may include automated installs.</p>
  </details>
</section>`;
}

export function updateStatsMarkup(html: string, markup: string): string {
  const start = "<!-- project-stats:start -->";
  const end = "<!-- project-stats:end -->";
  if (
    html.split(start).length !== 2 ||
    html.split(end).length !== 2 ||
    html.indexOf(start) > html.indexOf(end)
  ) {
    throw new Error("Expected exactly one project statistics slot");
  }
  return html.replace(
    /<!-- project-stats:start -->[\s\S]*?<!-- project-stats:end -->/,
    () => `${start}\n${markup}\n${end}`
  );
}

async function main(): Promise<void> {
  const stats = await fetchProjectStats(fetch, process.env.GITHUB_TOKEN);
  const path = new URL("../site/index.html", import.meta.url);
  const html = await readFile(path, "utf8");
  await writeFile(path, updateStatsMarkup(html, renderProjectStats(stats)));
  process.stdout.write(`Updated project statistics: ${JSON.stringify(stats)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("Unable to refresh project statistics; deployment must not proceed.", error);
    process.exitCode = 1;
  });
}
