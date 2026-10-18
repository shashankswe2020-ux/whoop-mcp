# Race dashboard redesign kit (athlete appeal)

Redesign of the local performance dashboard (`src/dashboard/static`) for the people who
actually use it: HYROX and triathlon athletes looking at it after training, often on a
laptop in a gym or at night. The brief was "athlete appeal"; the constraint was to keep
everything that makes this dashboard trustworthy (evidence, rules, caveats, audit).

Contents:

| Path | What |
|---|---|
| `redesign/dashboard.html` | Working prototype, one file. Five views, dark and light, responsive to 390 px. Embeds 24 days of your real recovery/sleep and 30 real workouts. |
| `redesign/fonts/` | Archivo 400–700 and Archivo Narrow 500–700 (OFL, from @fontsource). |
| `tokens.css`, `tokens.json` | Color, type, spacing, radius. Dark is primary; light is a selected set, not a flip. |
| `brand/icons/*.svg`, `brand/icons.svg` | 14 icons, 24 px grid, 1.75 stroke, `currentColor`. Sprite included. |
| `brand/mark.svg`, `brand/mark-light.svg` | Mark from the first pass; not used by the split-sheet design. |
| `brand/icon-sheet.svg` | Contact sheet of the icon set. |
| `shots/` | Full-page screenshots of every view, desktop and mobile. |

## Direction: chart-first, one heat ramp

Third pass. The first (dark tiles, giant verdict) read as generic; the second (a printed
split sheet) read as dead. Athletes want to see the session and the trend, not read them.

One visual system runs through every chart: **heart-rate intensity as a cool-to-hot ramp**
(Z0 slate → Z1 indigo → Z2 violet → Z3 magenta → Z4 orange → Z5 yellow, lightness rising with
effort). Recovery keeps WHOOP's red/yellow/green. Sports use a validated four-colour set.

| View | Charts | Data |
|---|---|---|
| Today | Recovery ring; **vitals stack** on one timeline (recovery bars, HRV and resting HR with your normal band, sleep stages) with one crosshair across all four | Real, Sep 15 – Oct 18; gaps are real (no sync / not worn) |
| Session | **Heart-rate profile**: every segment as a block at its average over the zone bands, peak marked, transitions hatched, run trend dotted; **course ring** of all 16 HYROX legs; time-in-zone bar; run-by-run build | r/whoop HYROX fixture |
| Training | Weekly minutes **stacked by HR zone**; every workout as a bubble (strain × duration); **fitness / fatigue / form** chart | Real, Aug 29 – Oct 18 |
| Readiness | Five-part **readiness ring** around the verdict; training mix against the 15% HYROX targets; form chart | Real |
| Audit | Workout tiles with flagged ones outlined; change log; what WHOOP can't measure | Real |

Every chart has hover detail. One reveal animation on load; respects reduced motion.
Dark is primary; light is a selected set.

## Production integration in `src/dashboard/static`

### Shipped in 1.0.2

The production renderer now uses this chart-first visual system, including
Today history, Session charts, Training, Readiness and Audit, with dark/light
themes and bundled OFL fonts. README/site screenshots come from the production
app using `scripts/preview-dashboard.ts`, never this prototype's personal data.
Session remains the default; HYROX and Triathlon views remain available.

The production session ring counts recorded segments, not inferred station
coverage. HR colours are relative to the observed session peak, not WHOOP zone
boundaries. Historical bands describe visible observations, not medical norms.

### Integration constraints

Port the chart-first visual system into the production DOM renderer, using only
validated WHOOP sources and existing local performance state. Keep Session as the
default and retain HYROX/Triathlon tools, review dialogs, keyboard navigation,
evidence, missing-source states and the strict local-server CSP. Add Training as
a separate view; dark is default with an explicit light toggle. History must
preserve missing days and training charts must preserve empty weeks. Never infer
continuous HR, station splits or WHOOP sync times from summary records.

Implement and test data contracts first, then visual rendering and local font
serving, then browser-check every view with synthetic fixtures and capture those
production views for README/site. Verify with `npm test`, `npm run lint`,
`npm run typecheck`, `npm run format:check`, `npm run build`, `npm audit` and a
packaged-artifact check before publishing 1.0.2. No new runtime dependencies,
WHOOP endpoints, token storage or OAuth changes.

The prototype is plain DOM + inline SVG, same as `app.js`, so it ports function by function:

| Prototype | app.js |
|---|---|
| `verdict()` | new; built from `/api/readiness`, shown on Today, HYROX, Triathlon and Readiness |
| `session()` course strip and split table | replaces the `renderSession()` chart and segment table |
| `logTable()` | replaces the weekly charts in `renderHyrox()` and `renderTriathlon()` |
| `readiness()` check-in table | `renderReadiness()` |
| `audit()` | `renderAudit()`; keep the existing review dialog |

Static assets stay within the CSP (`style-src 'self'`, no external fonts): copy
`redesign/fonts/` next to `style.css` and add the `@font-face` rules, and add the seven woff2
files to `STATIC_FILES` in `src/dashboard/server.ts` (the allowlist serves nothing else).

Data issues identified while testing against live records:

1. `percent_recorded` can arrive as a fraction (0.99999). Production analytics now normalise 0–1 values to percentages before coverage checks, while preserving older 0–100 values above 1. Public MCP record schemas remain transform-free and expose the original records.
2. Training's new weekly series generates every UTC week and zero-fills missing weeks. The older HYROX/Triathlon weekly series have not been changed.

## Placeholders and caveats

- The session on the prototype is the r/whoop HYROX simulation fixture (2026-10-15), chosen because the account had no HYROX-shaped session. Today, readiness and audit are a real snapshot from 2026-10-18 with WHOOP unsynced since Oct 16.
- "HYROX Bengaluru, 1:25:30" is a test race result logged during QA, not a real race.
- Forms and buttons in the prototype are inert; the shapes match the real API so wiring is a copy of the existing `api()` calls.
- No Blender renders or Runway video were made: a local training dashboard has no hero image, and the kit's 3D/video steps were skipped deliberately.
