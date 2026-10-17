# Tools, Resources and Prompts

[Back to README](../README.md)

## Tools

Standard mode exposes these 16 read-only tools with validated inputs and outputs,
plus the [race performance tools](#race-performance-hyrox-and-triathlon).
Scores may be pending/unscored and optional measurements unavailable; missing
values are not zero. Aggregate mode exposes only the five tools listed in
[Structured Results And Privacy](privacy.md#structured-results-and-privacy).

The four collection tools return **one page**, default limit 10, maximum 25.
Pass the response's `next_token` as the next call's `nextToken`. Analytics fetch
multiple pages internally within their limits. Collection `start` is inclusive
and `end` exclusive; omitted bounds use WHOOP defaults. Supply both bounds for
a specific historical period:

```json
{"start":"2026-09-01T00:00:00Z","end":"2026-09-08T00:00:00Z","limit":25}
```

### `get_profile`

Get the authenticated user's ID, name and email. This is identifying data;
avoid including results in public logs or issue reports.

**Parameters:** None

---

### `get_body_measurement`

Get the user's body measurements: height in metres, weight in kilograms, and
maximum heart rate in beats per minute.

**Parameters:** None

---

### `get_recovery_collection`

Get recovery records for a date range. Scored records include HRV and resting
heart rate; SpO2 and skin temperature can be unavailable.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start` | string | No | ISO 8601 or relative expression ("today", "last 7 days", "this week"). |
| `end` | string | No | ISO 8601 or relative expression. Defaults to now. |
| `limit` | number | No | Max records to return (1–25). Defaults to 10. |
| `nextToken` | string | No | Pagination token from a previous response. |

---

### `get_sleep_collection`

Get main sleeps and naps for a date range. Scored records include stage durations
in milliseconds, sleep need and available respiratory/performance measures.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start` | string | No | ISO 8601 or relative expression ("today", "last 7 days", "this week"). |
| `end` | string | No | ISO 8601 or relative expression. Defaults to now. |
| `limit` | number | No | Max records to return (1–25). Defaults to 10. |
| `nextToken` | string | No | Pagination token from a previous response. |

---

### `get_workout_collection`

Get workout records for a date range. Scored records include strain, heart-rate
zones, energy in kilojoules and sport name. Distance/elevation may be unavailable.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start` | string | No | ISO 8601 or relative expression ("today", "last 7 days", "this week"). |
| `end` | string | No | ISO 8601 or relative expression. Defaults to now. |
| `limit` | number | No | Max records to return (1–25). Defaults to 10. |
| `nextToken` | string | No | Pagination token from a previous response. |

---

### `get_cycle_collection`

Get physiological cycles for a date range, including scored strain, kilojoules
and heart rates. The current open cycle can have a null end timestamp.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start` | string | No | ISO 8601 or relative expression ("today", "last 7 days", "this week"). |
| `end` | string | No | ISO 8601 or relative expression. Defaults to now. |
| `limit` | number | No | Max records to return (1–25). Defaults to 10. |
| `nextToken` | string | No | Pagination token from a previous response. |

---

### `get_sleep_by_id`

Get a single sleep record in the same provider shape as the sleep collection.
Optional measurements and scoring status still apply.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Sleep record ID; letters, digits, hyphens and underscores only. |

---

### `get_workout_by_id`

Get a single workout record in the same provider shape as the workout collection,
including scored strain, heart-rate zones and kilojoules.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Workout record ID; letters, digits, hyphens and underscores only. |

---

### `get_cycle_by_id`

Get a single physiological cycle, including scored strain, kilojoules and heart
rates. An open cycle may not have an end timestamp.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Positive integer cycle record ID. |

---

### `get_weekly_summary`

Get a UTC-grouped weekly report: average recovery, HRV, RHR, sleep duration and
quality, workout count and strain, plus recovery trend direction. An incomplete
week summarizes only available records; it is not a prediction.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `week_start` | string | No | ISO 8601 or relative expression ("last week", "this week"). Defaults to most recent Monday. |

---

### `compare_periods`

Compare observed recovery, sleep and strain between two explicit periods.
Differences describe the available data, not causation or clinical improvement.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `period_a_start` | string | Yes | ISO 8601 start of the first period. |
| `period_a_end` | string | Yes | ISO 8601 end of the first period. |
| `period_b_start` | string | Yes | ISO 8601 start of the second period. |
| `period_b_end` | string | Yes | ISO 8601 end of the second period. |

---

### `get_trend`

Analyze one metric's direction, variability and anomalies using linear regression.
Interpret labels alongside sample counts and missing days, not as a diagnosis.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `metric` | string | Yes | One of: `recovery`, `hrv`, `rhr`, `sleep_duration`, `sleep_performance`, `strain`. |
| `days` | number | No | Number of days to analyze (7–90). Default: 30. |

---

### `get_today`

Get a best-available current health snapshot: recovery, primary sleep, strain
and last workout. Partial or stale sources are identified rather than described
as a guaranteed complete picture of today.

**Parameters:** None

**Returns:** Recovery score with zone, sleep breakdown (hours, stages, performance), current strain, last workout (sport + strain), and a human-readable summary.

Recovery is returned only when it matches the current local cycle and primary sleep.
Pending or invalid primary sleep never falls back to an older recovery. Missing optional
sleep percentages are `null`, not zero. `data_quality` distinguishes missing, pending,
stale, unscored, calibrating, invalid and failed sources; cache status and fetch time
remain unknown when the client cannot establish them.

For compatibility, `sleep.total_hours` remains time in bed. Use `time_in_bed_hours`
or `asleep_hours` explicitly; summaries now use scored asleep stages. The latest
workout includes `occurred_at` and recording percentage and may be historical.

---

### `get_baselines`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseline_days` | integer | No | History window, 14-180; default 30. |

Returns personal distributions for HRV, resting heart rate, respiratory rate,
asleep hours and recovery score. `baseline_days` is an integer from 14 to 180
(default 30). Each band includes mean, median, standard deviation, percentiles,
sample size and the latest observation's midrank percentile.

The latest observation and current local day are excluded from each baseline.
Calibrating, unscored, invalid and unjoinable observations are excluded. A metric
needs 14 historical points after exclusions; otherwise its band is null with an
insufficient-data status. Constant distributions are labeled explicitly.

### `get_sleep_debt`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `days` | integer | No | Window length, 3-90; default 14. |
| `start` | string | No | ISO 8601 or relative expression; begins a forward window. |

Analyzes scored main sleeps using `days` (3-90, default 14) and optional `start`
(ISO or a supported relative expression). With `start`, the window extends forward
for `days` calendar days, clamped to evaluation time. Resolved bounds are returned.

`total_debt_hours` sums observed nightly deficits. Need excludes WHOOP's accumulated
debt component and preserves the signed nap adjustment; achieved sleep is light +
slow-wave + REM. `standing_debt_hours` is the latest WHOOP debt value, separately
dated, not the deficit sum. Missing nights are not zero-sleep nights; fewer than
three usable nights returns null aggregates. Circular local-clock statistics describe
consistency and heuristic social jetlag, not clinical diagnoses or recovery forecasts.

Analytics paginate up to 500 records per source and report upstream truncation.
Sleep-debt calculations use all selected records but echo at most 30 nights, with
a separate `output_capped` flag. Both tools include a statistical/medical disclaimer.

### `get_calendar`

Get a UTC day-by-day grid of recovery, sleep and strain, with period averages.
Missing days remain distinct from measured zero values.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `days` | number | No | Number of days to show (1–90). Default: 7. |
| `start` | string | No | ISO date or supported expression. With `start`, iterate forward for `days`, clamped to today; otherwise use a trailing window. |

**Returns:** Per-day grid with recovery score + zone (green/yellow/red), sleep hours, sleep performance, and strain. Includes period averages.

---

## Race performance (HYROX and triathlon)

Nine tools track HYROX and triathlon training from your WHOOP workouts, plus race
results you log yourself. WHOOP doesn't know what a HYROX station or a brick is, so
these tools rebuild sessions from back-to-back workouts and show their working:

- Every number is an evidenced metric: `value`, `status`, `method`, `window`,
  `records_used`, `records_excluded` and `source`.
- Every result ends with **caveats** ("before you trust these numbers") naming the
  workouts each caveat applies to.
- Suspect records are flagged, never silently dropped: low coverage, implausible
  pace, HR out of range, overlaps, unscored, split-sum mismatch, indoor distance
  and short "run" segments that are really transitions.
- Load is Edwards TRIMP from WHOOP's heart-rate zones. Strain is logarithmic and is
  never summed. Readiness is a deterministic rule, not a percentage score.

| Mode | Tools available |
|------|-----------------|
| Local stdio (default) | All nine. Corrections and races are stored in `~/.whoop-mcp` (see [privacy](privacy.md#race-performance-data-and-the-local-dashboard)). |
| Remote HTTP | The six read-only tools. They report `store.status: "not_configured"` and use WHOOP data only. |
| Aggregate privacy mode | None. |

Window bounds take `YYYY-MM-DD` or ISO 8601; `start` is inclusive and `end`
exclusive (default: now).

### `get_hyrox_session_report`

Breaks one training day into its WHOOP segments (runs, ergs, functional work):
timeline, avg/peak HR, strain and kcal per segment, transition time, time in zone,
day context (recovery, HRV/RHR vs your 30-day baseline, sleep) and rule-based
insights. Each insight shows the rule that triggered it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Local day `YYYY-MM-DD`. Default: most recent day with a workout in the last 7 days. |
| `session_start` | string | No | ISO 8601 start of a specific session. Overrides the default pick. |

### `get_hyrox_performance`

Weekly run vs HYROX load, confirmed HYROX sessions, unconfirmed candidates (likely
sims you haven't confirmed), logged races with station splits, your personal
weakest station (needs 2+ races) and PRs.

**Parameters:** `start`, `end` (optional; default the last 56 days).

### `get_triathlon_performance`

Per-discipline weekly duration, distance, TRIMP and zone mix; discipline share
(a leg under 15% is flagged); bricks; races with leg and transition splits.

**Parameters:** `start`, `end` (optional; default the last 56 days).

### `get_race_readiness`

Readiness band (`ready`, `caution`, `not_ready`, `insufficient_data`) from five
components: recovery, form (CTL − ATL), specificity, sleep debt and taper. Each
component carries its evidence. Also returns fitness/fatigue/form series (up to
90 points) and a load-spike ratio. Form needs 28+ days of history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sport` | `"hyrox"` \| `"triathlon"` | Yes | Race type to evaluate. |
| `race_date` | string | No | `YYYY-MM-DD`. Enables the taper check within 14 days of the race. |

### `audit_performance_data`

Everything you need to check the numbers: your corrections, suspect records with
rule ids, unconfirmed HYROX candidates, the audit log and the rules used.

**Parameters:** `start`, `end` (optional; default the last 28 days), `limit`
(audit-log entries, 1–200, default 50).

### `verify_claim`

Recomputes a number an assistant told you and returns `confirmed`, `contradicted`
or `unverifiable`, with the recomputed value, tolerance and the workouts used. It
returns `unverifiable` rather than guessing when data is missing or unconfirmed
candidates could change the answer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `metric` | enum | Yes | `discipline_share_pct`, `workout_count`, `training_minutes`, `trimp_total`, `distance_km`, `avg_recovery`, `load_change_pct`, `hyrox_sessions` |
| `claimed_value` | number | Yes | The number to check. |
| `period` | `{start, end}` | Yes | Period the claim is about. |
| `discipline` | enum | No | Required for `discipline_share_pct`. |
| `sport` | `"hyrox"` \| `"triathlon"` | No | Restricts scope to that race's disciplines. |
| `comparison_period` | `{start, end}` | No | Required for `load_change_pct`. |

### `log_race_result` (local only)

Saves an official race result to the local race log. HYROX splits must list 8 runs
and 8 stations in official order (roxzone optional; if omitted, the remainder is
reported as implied roxzone). Triathlon splits are swim, T1, bike, T2, run. Split
sums must be within ±5 s of `total_seconds`, and race dates can't be in the future.

**Parameters:** `sport`, `date`, `name`, `category` (HYROX division such as
`open_men`, or triathlon `sprint`/`olympic`/`half`/`full`/`custom`),
`total_seconds`, `splits` (optional), `workout_id` (optional), `notes` (optional).

### `annotate_workout` (local only)

Corrects how a WHOOP workout is counted. Your WHOOP account is never changed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workout_id` | string | Yes | WHOOP workout id. |
| `action` | `"relabel"` \| `"exclude"` \| `"restore"` | Yes | Relabel changes the discipline, exclude drops it from metrics (it stays listed), restore undoes your correction. |
| `discipline` | enum | For relabel | e.g. `hyrox` to confirm a HYROX sim. |
| `reason` | enum | Yes | `misclassified`, `bad_hr`, `duplicate`, `not_mine`, `hyrox_sim`, `other` |
| `note` | string | No | Free text. |

### `open_performance_dashboard` (local only)

Starts (or reuses) a dashboard on `127.0.0.1` and opens it in your browser. Views:
Session, HYROX, Triathlon, Readiness (with a "Why?" evidence drill-down for each
component) and Audit (relabel/exclude/restore, suspects, audit log and a "Check a
claim" form). Corrections made in the dashboard go through the same validation and
audit log as the MCP tools.

**Parameters:** `view` (optional): `session`, `hyrox`, `triathlon`, `readiness` or `audit`.

**Returns:** `url`, `view`, `reused`, `browser_opened`, `expires_after_idle_minutes`
(30) and a `note`. The URL carries a one-time access token in its fragment; each
call issues a new token and invalidates the old one. If no browser opens (for
example over SSH), open the URL yourself on the same machine.

---

## Supported Date Expressions

The four collection tools, `get_calendar`, `get_sleep_debt.start` and
`get_weekly_summary.week_start` accept supported relative expressions
(case-insensitive). `compare_periods` requires explicit ISO bounds;
`get_trend` takes a day count.

| Expression | Example Result |
|------------|----------------|
| `"today"` | Today's UTC day boundaries |
| `"yesterday"` | Yesterday's UTC day boundaries |
| `"last N days"` (1–365) | N days back from today |
| `"last N weeks"` (1–52) | N×7 days back from today |
| `"last N months"` (1–12) | N calendar months back |
| `"this week"` | Monday to today |
| `"last week"` | Previous Monday–Sunday |
| `"this month"` | 1st of month to today |
| `"last month"` | Full previous month |
| `"this quarter"` | Quarter start (Jan/Apr/Jul/Oct) to today |
| `"last quarter"` | Full previous quarter |
| `"last year"` | Jan 1–Dec 31 of previous year |
| `"YYYY-MM"` (e.g., `"2026-05"`) | Full calendar month |
| ISO 8601 | Pass-through (e.g., `"2026-03-15T00:00:00Z"`) |

Relative bounds use UTC. A collection `start` expression supplies its lower bound,
not an implicit matching `end`; pass both for a bounded historical query.
These rules do not change local-day attribution inside personal analytics.

---

## Resources

In standard mode, clients can read these four JSON resources without invoking a
tool. “Latest” is the most recent provider record, not necessarily today or fully
scored. Use `get_today` for current-cycle matching and data-quality flags.

| Resource URI | Description | Cache TTL |
|--------------|-------------|-----------|
| `whoop://v2/user/recovery/latest` | Most recent recovery score, HRV, RHR | 5 min |
| `whoop://v2/user/sleep/latest` | Most recent sleep record | 5 min |
| `whoop://v2/user/cycle/latest` | Most recent physiological cycle (strain) | 2 min |
| `whoop://v2/user/profile` | User profile (name, email) | 1 hr |

**Privacy:** Resources expose the same data available through tools — they simply make it accessible as ambient context. No additional WHOOP scopes are required. Data is cached in-memory with short TTLs and invalidated on token refresh.

To disable resources: set `WHOOP_MCP_DISABLE_RESOURCES=1`.

---

## Caching

Selected internal read requests opt into a shared in-memory LRU/TTL cache.
Resources use it; an identical path and normalized query can reuse an entry.
Different queries do not share records automatically, and composite tool results
are not themselves cached. There is no persistent health-data database.

| Data | TTL |
|------|-----|
| Profile | 1 hr |
| Recovery, Sleep | 5 min |
| Cycle | 2 min |
| Collections (date-range queries) | Uncached |

- Cache keys are normalized by request path with sorted query params; **no tokens are ever part of a cache key**.
- Concurrent identical requests are de-duplicated (single in-flight fetch — stampede prevention).
- The entire cache is cleared on token refresh.
- Restarting the process discards the cache. Raw collection requests do not
  automatically reuse cached resource responses.

---

## Write Operations

The server registers no WHOOP create/update/delete tools. `log_race_result`,
`annotate_workout` and the dashboard's correction forms write only to local files
in `~/.whoop-mcp`; every write is appended to an audit log. The internal
[`withPreview()` helper](../src/tools/write-safety.ts) is a future implementation
scaffold, not an exposed preview/confirm command or a shipped write workflow.
This describes the package's scope, not every capability of the WHOOP platform.

---

## Prompts

Standard mode exposes five named templates through MCP `prompts/list` and
`prompts/get`. Client support determines how they are presented; typing the same
words into chat is not necessarily a template request. Aggregate mode hides them.

| Prompt | Description |
|--------|-------------|
| `weekly_health_review` | Comprehensive review of recovery, sleep, and workouts (accepts optional `days` arg) |
| `sleep_analysis` | Analyze recent sleep patterns and quality |
| `recovery_trend` | How is recovery trending? HRV, RHR, recovery score analysis |
| `workout_recap` | Summarize recent workouts, strain, and training load |
| `health_check` | Quick health status using cached resource data |

With telemetry consent, a successful template retrieval records only its name
and success outcome, never arguments, template text or conversation content.
Listing is not counted. Retrieval itself does not fetch WHOOP data.
