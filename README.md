<picture>
	<source media="(prefers-color-scheme: dark)" srcset="images/readme/banner-dark.svg">
	<img src="images/readme/banner-light.svg" width="100%" alt="WHOOP MCP. Your WHOOP data, a conversation away. Asking 'How am I doing today?' calls the get_today, get_baselines and get_sleep_debt tools.">
</picture>

<p align="center">
	<a href="https://www.npmjs.com/package/whoop-ai-mcp"><img src="https://img.shields.io/npm/v/whoop-ai-mcp?color=16803c&label=npm" alt="Latest npm version"></a>
	<a href="https://www.npmjs.com/package/whoop-ai-mcp"><img src="https://img.shields.io/npm/dm/whoop-ai-mcp?color=087e8b" alt="Monthly npm downloads"></a>
	<a href="https://npm-history.pages.dev/?package=whoop-ai-mcp&amp;start=2026-04-11&amp;mode=cumulative"><img src="https://img.shields.io/npm/dt/whoop-ai-mcp?color=087e8b&label=total%20downloads" alt="Total npm downloads"></a>
	<a href="https://github.com/shashankswe2020-ux/whoop-mcp/stargazers"><img src="https://img.shields.io/github/stars/shashankswe2020-ux/whoop-mcp?style=flat&color=d49b16" alt="GitHub stars"></a>
	<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555" alt="MIT license"></a>
	<a href="https://buymeacoffee.com/shashanksw9"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-support-FFDD00?logo=buymeacoffee&logoColor=000000" alt="Buy me a coffee to support whoop-ai-mcp"></a>
</p>

**whoop-ai-mcp** is a read-only [WHOOP](https://www.whoop.com/) [MCP server](https://modelcontextprotocol.io/) for Claude Desktop, Claude Code, Codex and GitHub Copilot. Ask about your recovery, compare weeks of sleep, or check today against your own baseline, without exporting the data yourself.

```bash
npx -y whoop-ai-mcp@latest setup --client=claude-desktop
```

<p align="center">
	<a href="#quickstart"><strong>Quickstart</strong></a>&ensp;|&ensp;<a href="https://youtu.be/2vwxEjctcWs">Watch the walkthrough</a>&ensp;|&ensp;<a href="https://whoopconnector.com/">Website</a>&ensp;|&ensp;<a href="references/tools.md">Tool reference</a>
</p>

<p align="center">
	<a href="https://github.com/shashankswe2020-ux/whoop-mcp/issues/new?template=bug_report.yml"><img src="https://img.shields.io/badge/Report%20an%20issue-d73a4a?style=for-the-badge&logo=github&logoColor=white" alt="Report an issue"></a>
	<a href="https://github.com/shashankswe2020-ux/whoop-mcp/issues/new?template=feature_request.yml"><img src="https://img.shields.io/badge/Request%20a%20feature-16803c?style=for-the-badge&logo=github&logoColor=white" alt="Request a feature"></a>
</p>

<p align="center">
	<img src="images/Screenshot%202026-05-30%20at%201.36.39%E2%80%AFPM.png" width="880" alt="WHOOP MCP in Claude Desktop: a weekly health review with recovery, HRV, sleep and workout summaries">
	<br><sub>Claude Desktop builds the review; whoop-ai-mcp supplies the data. Your results and layout will differ.</sub>
</p>

## Ask your WHOOP data anything

| Ask | You get |
|-----|---------|
| **"How am I doing today?"** | Recovery, primary sleep, strain and your latest workout, with gaps flagged where data is missing |
| **"Is my HRV unusual for me?"** | Your personal baseline: distribution, percentiles and how many days it's based on |
| **"How did my sleep change this month?"** | Trends, period-to-period comparisons, sleep debt and consistency |
| **"Give me my weekly health review."** | Recovery, sleep and training in one summary |

Statistics describe your recorded history. They aren't medical diagnoses or predictions.

## Quickstart

**You need:** Node.js 20 or later, an active WHOOP membership, and a [WHOOP Developer App](https://developer.whoop.com) with the redirect URL `http://localhost:3000/callback`.

1. **Set up.** Run the command for your assistant and enter your developer app's client ID and secret when asked.

   | Assistant | Command |
   |-----------|---------|
   | Claude Desktop | `npx -y whoop-ai-mcp@latest setup --client=claude-desktop` |
   | Claude Code | `npx -y whoop-ai-mcp@latest setup --client=claude-code` |
   | Codex | `npx -y whoop-ai-mcp@latest setup --client=codex` |
   | GitHub Copilot | `npx -y whoop-ai-mcp@latest setup --client=copilot` |

   For Claude Code, Codex and Copilot, run the registration command that setup prints. Nothing is installed globally, and optional usage telemetry defaults to **No**.

2. **Authorize.** Fully quit and reopen your assistant. The first time the server starts, WHOOP opens in your browser so you can approve access.

3. **Ask.** Try *"Summarize my sleep and recovery this week."*

Need manual configuration, environment variables or a remote deployment? See the [full setup guide](references/installation.md).

<details>
<summary><strong>Prefer a native binary?</strong></summary>
<br>

The [Rust implementation](https://github.com/shashankswe2020-ux/whoop-mcp-rs) supports the same four assistants without a Node.js runtime. It needs Rust 1.88 or later:

```bash
cargo install whoop-mcp
whoop-mcp setup --client=claude-desktop
```

</details>

## How it works

<picture>
	<source media="(prefers-color-scheme: dark)" srcset="images/readme/how-it-works-dark.svg">
	<img src="images/readme/how-it-works-light.svg" width="100%" alt="Your WHOOP account grants read-only access to whoop-ai-mcp, which runs on your computer with 16 read-only tools and no hosted relay. It sends tool results to your AI assistant: Claude Desktop, Claude Code, Codex or GitHub Copilot.">
</picture>

- **Read-only.** The server has no tools that create, change or delete anything in your WHOOP account. Race results and workout corrections are saved only to local files, with an audit log.
- **Local by default.** The server runs on your machine. No hosted relay is involved.
- **Your assistant sees the results.** Health data reaches the assistant provider you use, the same as anything else you share in that chat.
- **Aggregate mode** limits the server to five summary tools and hides per-record data. It reduces what's shared, but it isn't anonymization.
- **Telemetry is off unless you opt in.** It never includes health data or chat text.

Details: [data handling](references/privacy.md) and [telemetry controls](references/telemetry.md).

## What's included

In standard mode, the server provides **16 read-only tools, 4 resources and 5 prompt templates**, plus **9 HYROX and triathlon tools**. Support for resources, prompts and remote connections depends on your assistant.

### HYROX and triathlon tracking

Ask "How did yesterday's HYROX sim go?" or "Am I ready for my triathlon in two weeks?" The race tools:

- Rebuild a HYROX session from WHOOP's back-to-back workouts: segment timeline, transition time, time in zone and rule-based insights.
- Track weekly running and HYROX load, swim/bike/run balance and bricks, plus logged races with station and leg splits and PRs.
- Give a **readiness** band from recovery, training form, specificity, sleep debt and taper. Every component shows its evidence; there's no opaque score.
- Let you **audit** the numbers: suspect workouts are flagged, you can relabel or exclude workouts, every change is logged, and `verify_claim` recomputes a number your assistant told you.
- Open a **local dashboard** (`open_performance_dashboard`) on `127.0.0.1` with daily overview, session, HYROX, triathlon, readiness and audit views. Review corrections and race results before confirming a local save.

<p align="center">
	<img src="images/readme/dashboard-session.png" width="880" alt="Dashboard Session view: a HYROX sim rebuilt from nine WHOOP workouts, with span, tracked time, transition time, peak heart rate, energy and a segment timeline showing average and peak heart rate for each run and erg, with transition gaps shaded">
</p>
<table>
	<tr>
		<td width="50%"><img src="images/readme/dashboard-readiness.png" alt="Dashboard Readiness view: a large Not ready verdict with a one-line summary of which components are red or amber, then one row per component (recovery, form, specificity, sleep, taper) with its band and rationale; the recovery row's Evidence panel lists its value, method, window and records used"></td>
		<td width="50%"><img src="images/readme/dashboard-audit.png" alt="Dashboard Audit view: automatically flagged records grouped by rule (implausible pace, overlap, indoor distance), each row with a Correct button that prefills the correction form; long groups such as Overlap start collapsed"></td>
	</tr>
</table>
<p align="center"><sub>Screenshots use synthetic sample data.</sub></p>

The race log, workout corrections and dashboard are available only when the server runs locally (stdio). Details: [race performance tools](references/tools.md#race-performance-hyrox-and-triathlon) and [local data](references/privacy.md#race-performance-data-and-the-local-dashboard).

<details>
<summary><strong>See all tools and prompts</strong></summary>
<br>

| Group | Tools |
|-------|-------|
| Today and baselines | `get_today`, `get_baselines`, `get_sleep_debt` |
| Trends and reviews | `get_weekly_summary`, `get_trend`, `compare_periods`, `get_calendar` |
| Records | `get_recovery_collection`, `get_sleep_collection`, `get_workout_collection`, `get_cycle_collection`, `get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id` |
| Profile | `get_profile`, `get_body_measurement` |
| HYROX and triathlon | `get_hyrox_session_report`, `get_hyrox_performance`, `get_triathlon_performance`, `get_race_readiness`, `audit_performance_data`, `verify_claim` |
| Local only: race log, corrections, dashboard | `log_race_result`, `annotate_workout`, `open_performance_dashboard` |

**Prompt templates:** `weekly_health_review`, `sleep_analysis`, `recovery_trend`, `workout_recap`, `health_check`

Parameters, date expressions, resources and caching are in the [tool reference](references/tools.md).

</details>

## Documentation

| Guide | What's in it |
|-------|--------------|
| [Installation](references/installation.md) | Assistants, manual configuration, environment variables and WHOOP authorization |
| [Tool reference](references/tools.md) | Every tool and its parameters, date expressions, resources, prompts and caching |
| [Privacy](references/privacy.md) | Structured results, aggregate mode and what your assistant provider receives |
| [Telemetry](references/telemetry.md) | Consent, opting out, what's collected and how long it's kept |
| [Troubleshooting](references/troubleshooting.md) | Local diagnostics, common errors and MCP Inspector |
| [Deployment](references/deployment.md) | Docker, cloud hosting and remote connector OAuth |
| [Development](references/development.md) | Tests, project structure and release workflow |
| [Background](references/background.md) | Ecosystem research and the video walkthrough |

What changed recently? See the [changelog](CHANGELOG.md) or the [latest release](https://github.com/shashankswe2020-ux/whoop-mcp/releases/latest).

## Feedback and contributing

<p align="center">
	<a href="https://github.com/shashankswe2020-ux/whoop-mcp/issues/new?template=bug_report.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="images/readme/btn-bug-dark.svg"><img src="images/readme/btn-bug-light.svg" height="44" alt="Report a bug"></picture></a>&nbsp;
	<a href="https://github.com/shashankswe2020-ux/whoop-mcp/issues/new?template=feature_request.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="images/readme/btn-feature-dark.svg"><img src="images/readme/btn-feature-light.svg" height="44" alt="Request a feature"></picture></a>
</p>

Something not working, or a question you wish you could ask? Use the buttons above. Each opens a short form that asks for the details needed to help. Issues are public, so never include credentials or health records; security problems go through the [security policy](SECURITY.md) instead.

Want to contribute code? Read the [contributing guide](CONTRIBUTING.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

If whoop-ai-mcp is useful to you, a GitHub star helps other people find it, and you can [buy me a coffee](https://buymeacoffee.com/shashanksw9) to support development.

<details>
<summary><strong>Project growth</strong></summary>
<br>

<p align="center">
	<a href="https://www.star-history.com/#shashankswe2020-ux/whoop-mcp&Date">
		<img src="https://api.star-history.com/svg?repos=shashankswe2020-ux/whoop-mcp&type=Date" width="720" alt="WHOOP MCP GitHub star history chart">
	</a>
</p>

<p align="center">
	<a href="https://npm-history.pages.dev/?package=whoop-ai-mcp&amp;start=2026-04-11&amp;mode=cumulative">
		<picture>
			<source media="(prefers-color-scheme: dark)" srcset="https://npm-history.pages.dev/svg?package=whoop-ai-mcp&amp;start=2026-04-11&amp;mode=cumulative&amp;theme=dark">
			<source media="(prefers-color-scheme: light)" srcset="https://npm-history.pages.dev/svg?package=whoop-ai-mcp&amp;start=2026-04-11&amp;mode=cumulative&amp;theme=light">
			<img src="https://npm-history.pages.dev/svg?package=whoop-ai-mcp&amp;start=2026-04-11&amp;mode=cumulative&amp;theme=light" width="720" alt="WHOOP MCP cumulative npm downloads since April 11, 2026">
		</picture>
	</a>
	<br><sub>Downloads include automated installs and may not represent unique users.</sub>
</p>

</details>

## License

[MIT](LICENSE). This is an unofficial project and isn't affiliated with WHOOP. A WHOOP membership and API access are separate from this package.
