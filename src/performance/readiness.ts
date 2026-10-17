import { DAY_MS, DISCLAIMER, RECOVERY_ZONES } from "../tools/analytics-utils.js";
import type { EvidencedMetric } from "./evidence.js";
import type { ResolvedDiscipline } from "./sport-classifier.js";
import type { TrainingLoadResult } from "./training-load.js";

export const READINESS_METHOD_VERSION = "1.0.0";
export const TSB_FRESH = 5;
export const TSB_FATIGUED = -20;
export const MIN_DISCIPLINE_SHARE = 0.15;
export const SLEEP_DEBT_AMBER_HOURS = 2;
export const SLEEP_DEBT_RED_HOURS = 5;
export const TAPER_WINDOW_DAYS = 14;

export const BAND_RULE =
  "Any red component → not_ready; otherwise 2+ unknown → insufficient_data; otherwise 2+ amber → caution; otherwise ready. not_applicable components are ignored.";

export type ComponentBand = "green" | "amber" | "red" | "unknown" | "not_applicable";
export type ReadinessBand = "ready" | "caution" | "not_ready" | "insufficient_data";
export type RaceSport = "hyrox" | "triathlon";

export interface ReadinessComponent {
  id: "recovery" | "form" | "specificity" | "sleep" | "taper";
  band: ComponentBand;
  rationale: string;
  metric: EvidencedMetric;
}

export interface ReadinessInput {
  sport: RaceSport;
  /** Local day YYYY-MM-DD. */
  today: string;
  race_date?: string;
  recovery: { score: number | null; baseline_mean: number | null; date: string | null };
  load: TrainingLoadResult;
  sleep_debt_hours: number | null;
}

export interface ReadinessResult {
  sport: RaceSport;
  band: ReadinessBand;
  band_rule: string;
  days_to_race: number | null;
  components: ReadinessComponent[];
  method_version: string;
  disclaimer: string;
}

const RACE_DISCIPLINES: Readonly<Record<RaceSport, ResolvedDiscipline[]>> = {
  hyrox: ["run", "hyrox"],
  triathlon: ["swim", "bike", "run"],
};

const HEURISTIC = "Threshold is a common coaching heuristic, not validated for you individually.";

function metric(
  partial: Pick<EvidencedMetric, "value" | "unit" | "method" | "window" | "source" | "status"> &
    Partial<EvidencedMetric>
): EvidencedMetric {
  return {
    method_version: READINESS_METHOD_VERSION,
    inputs: { records_used: 0, records_excluded: 0, excluded_reasons: {} },
    limitations: [],
    ...partial,
  };
}

function recoveryComponent(input: ReadinessInput): ReadinessComponent {
  const { score, baseline_mean: baseline, date } = input.recovery;
  const band: ComponentBand =
    score === null
      ? "unknown"
      : score < RECOVERY_ZONES.red_below
        ? "red"
        : score > RECOVERY_ZONES.green_above
          ? "green"
          : "amber";
  return {
    id: "recovery",
    band,
    rationale:
      score === null
        ? "No scored WHOOP recovery for today."
        : `Recovery ${score}% (WHOOP zones: <${RECOVERY_ZONES.red_below} red, >${RECOVERY_ZONES.green_above} green)${baseline === null ? "" : `; your 30-day mean is ${baseline.toFixed(0)}%`}.`,
    metric: metric({
      value: score,
      unit: "%",
      method: "whoop_recovery_zone",
      window: date ? { start: date, end: date } : null,
      source: "whoop",
      status: score === null ? "insufficient_data" : "available",
      inputs: { records_used: score === null ? 0 : 1, records_excluded: 0, excluded_reasons: {} },
    }),
  };
}

function formComponent(input: ReadinessInput): ReadinessComponent {
  const { load } = input;
  const tsb = load.current?.tsb ?? null;
  const band: ComponentBand =
    tsb === null ? "unknown" : tsb >= TSB_FRESH ? "green" : tsb >= TSB_FATIGUED ? "amber" : "red";
  return {
    id: "form",
    band,
    rationale:
      tsb === null
        ? `Need at least 28 days of workout history (have ${load.history_days}).`
        : `Form (fitness − fatigue) is ${tsb.toFixed(1)} TRIMP; ≥ ${TSB_FRESH} is fresh, < ${TSB_FATIGUED} is fatigued.`,
    metric: metric({
      value: tsb,
      unit: "TRIMP",
      method: "tsb_ctl42_atl7",
      window: load.window,
      source: "whoop",
      status: tsb === null ? "insufficient_data" : "available",
      inputs: load.inputs,
      limitations: [...load.limitations, HEURISTIC],
    }),
  };
}

function specificityComponent(input: ReadinessInput): ReadinessComponent {
  const { load_28d: load28 } = input.load;
  const disciplines = RACE_DISCIPLINES[input.sport];
  if (load28.total <= 0)
    return {
      id: "specificity",
      band: "unknown",
      rationale: "No training load in the last 28 days.",
      metric: metric({
        value: null,
        unit: "share",
        method: "discipline_share_28d",
        window: null,
        source: "whoop",
        status: "insufficient_data",
        inputs: input.load.inputs,
      }),
    };
  const shares = disciplines.map((discipline) => ({
    discipline,
    share: (load28[discipline] ?? 0) / load28.total,
  }));
  const below = shares.filter((item) => item.share < MIN_DISCIPLINE_SHARE);
  const band: ComponentBand = below.length === 0 ? "green" : below.length === 1 ? "amber" : "red";
  const limitations = [HEURISTIC];
  if (input.sport === "hyrox")
    limitations.push("Only workouts you confirmed as HYROX count; unconfirmed candidates do not.");
  else
    limitations.push(
      "Triathlon or duathlon sessions cannot be split into legs and are not counted."
    );
  return {
    id: "specificity",
    band,
    rationale: `28-day load share: ${shares.map((item) => `${item.discipline} ${(item.share * 100).toFixed(0)}%`).join(", ")}; each should be ≥ ${MIN_DISCIPLINE_SHARE * 100}%.`,
    metric: metric({
      value: Math.min(...shares.map((item) => item.share)),
      unit: "share",
      method: "discipline_share_28d",
      window: input.load.window
        ? {
            start: new Date(Date.parse(`${input.load.window.end}T00:00:00Z`) - 27 * DAY_MS)
              .toISOString()
              .slice(0, 10),
            end: input.load.window.end,
          }
        : null,
      source: "mixed",
      status: "available",
      inputs: input.load.inputs,
      limitations,
    }),
  };
}

function sleepComponent(input: ReadinessInput): ReadinessComponent {
  const debt = input.sleep_debt_hours;
  const band: ComponentBand =
    debt === null
      ? "unknown"
      : debt > SLEEP_DEBT_RED_HOURS
        ? "red"
        : debt >= SLEEP_DEBT_AMBER_HOURS
          ? "amber"
          : "green";
  return {
    id: "sleep",
    band,
    rationale:
      debt === null
        ? "Sleep debt could not be computed."
        : `Sleep debt ${debt.toFixed(1)} h; ≥ ${SLEEP_DEBT_AMBER_HOURS} h is amber, > ${SLEEP_DEBT_RED_HOURS} h is red.`,
    metric: metric({
      value: debt,
      unit: "h",
      method: "get_sleep_debt",
      window: null,
      source: "whoop",
      status: debt === null ? "insufficient_data" : "available",
      limitations: [HEURISTIC],
    }),
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function taperComponent(input: ReadinessInput, daysToRace: number | null): ReadinessComponent {
  const base = { unit: "TRIMP", method: "atl_7d_trend", source: "whoop" as const };
  if (daysToRace === null || daysToRace < 0 || daysToRace > TAPER_WINDOW_DAYS)
    return {
      id: "taper",
      band: "not_applicable",
      rationale: `Only evaluated within ${TAPER_WINDOW_DAYS} days before a race date.`,
      metric: metric({ ...base, value: null, window: null, status: "insufficient_data" }),
    };
  const { series } = input.load;
  if (series.length < 8)
    return {
      id: "taper",
      band: "unknown",
      rationale: "Need at least 8 days of load series to see the fatigue trend.",
      metric: metric({ ...base, value: null, window: null, status: "insufficient_data" }),
    };
  const now = series[series.length - 1]!;
  const weekAgo = series[series.length - 8]!;
  const change = now.atl - weekAgo.atl;
  return {
    id: "taper",
    band: change < 0 ? "green" : "amber",
    rationale: `Fatigue changed by ${change.toFixed(1)} TRIMP over 7 days with ${daysToRace} days to race; a taper should bring it down.`,
    metric: metric({
      ...base,
      value: change,
      window: { start: weekAgo.date, end: now.date },
      status: "available",
      inputs: input.load.inputs,
    }),
  };
}

function overallBand(components: ReadinessComponent[]): ReadinessBand {
  const count = (band: ComponentBand): number =>
    components.filter((component) => component.band === band).length;
  if (count("red") > 0) return "not_ready";
  if (count("unknown") >= 2) return "insufficient_data";
  if (count("amber") >= 2) return "caution";
  return "ready";
}

export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const daysToRace = input.race_date ? daysBetween(input.today, input.race_date) : null;
  const components = [
    recoveryComponent(input),
    formComponent(input),
    specificityComponent(input),
    sleepComponent(input),
    taperComponent(input, daysToRace),
  ];
  return {
    sport: input.sport,
    band: overallBand(components),
    band_rule: BAND_RULE,
    days_to_race: daysToRace,
    components,
    method_version: READINESS_METHOD_VERSION,
    disclaimer: DISCLAIMER,
  };
}
