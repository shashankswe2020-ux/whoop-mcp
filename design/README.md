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

## Porting into `src/dashboard/static`

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

Two data bugs found while testing against live records, both needed for the redesign to be truthful:

1. `percent_recorded` arrives as a fraction (0.99999) from the live API; `suspect-detector.ts` compares it with 80, flagging every workout as low coverage. Normalise at the schema boundary.
2. Weekly series are built from a `Map` keyed by workouts, so rest weeks vanish. Generate weeks from the period and zero-fill.

## Placeholders and caveats

- The session on the prototype is the r/whoop HYROX simulation fixture (2026-10-15), chosen because the account had no HYROX-shaped session. Today, readiness and audit are a real snapshot from 2026-10-18 with WHOOP unsynced since Oct 16.
- "HYROX Bengaluru, 1:25:30" is a test race result logged during QA, not a real race.
- Forms and buttons in the prototype are inert; the shapes match the real API so wiring is a copy of the existing `api()` calls.
- No Blender renders or Runway video were made: a local training dashboard has no hero image, and the kit's 3D/video steps were skipped deliberately.
