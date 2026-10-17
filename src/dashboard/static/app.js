// WHOOP race performance dashboard. Vanilla ES module, no dependencies.
// Security: the session token arrives in the URL fragment, is kept in memory only, and the
// fragment is stripped immediately. Data is rendered only via text nodes and SVG attributes;
// no HTML string is ever parsed.

const VIEWS = ["today", "session", "hyrox", "triathlon", "readiness", "audit"];
const HYROX_STATIONS = [
  "skierg",
  "sled_push",
  "sled_pull",
  "burpee_broad_jumps",
  "row",
  "farmers_carry",
  "sandbag_lunges",
  "wall_balls",
];
const HYROX_DIVISIONS = [
  "open_men",
  "open_women",
  "pro_men",
  "pro_women",
  "doubles_men",
  "doubles_women",
  "doubles_mixed",
  "relay_men",
  "relay_women",
  "relay_mixed",
];
const TRIATHLON_DISTANCES = ["sprint", "olympic", "half", "full", "custom"];
const DISCIPLINES = ["run", "bike", "swim", "multisport", "hyrox", "hyrox_candidate", "other"];
const REASONS = ["misclassified", "bad_hr", "duplicate", "not_mine", "hyrox_sim", "other"];
const CLAIM_METRICS = [
  "discipline_share_pct",
  "workout_count",
  "training_minutes",
  "trimp_total",
  "distance_km",
  "avg_recovery",
  "load_change_pct",
  "hyrox_sessions",
];
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// Session + routing
// ---------------------------------------------------------------------------

const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get("token") ?? "";
const initialView = new URLSearchParams(location.search).get("view");
let currentView = VIEWS.includes(initialView) ? initialView : "session";
history.replaceState(null, "", `/?view=${currentView}`);

const main = document.getElementById("main");
const statusLine = document.getElementById("status");
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));

/** Per-view form state survives tab switches. */
const viewState = {
  session: { date: "" },
  hyrox: { start: "", end: "" },
  triathlon: { start: "", end: "" },
  readiness: { sport: "hyrox", race_date: "" },
  audit: { start: "", end: "" },
};

class ApiError extends Error {}

async function api(path, options = {}) {
  if (!token) throw new ApiError("No session token. Reopen the dashboard from your assistant.");
  const init = { method: options.method ?? "GET", headers: { Authorization: `Bearer ${token}` } };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const query = options.query
    ? `?${new URLSearchParams(Object.entries(options.query).filter(([, value]) => value))}`
    : "";
  let response;
  try {
    response = await fetch(`${path}${query}`, init);
  } catch {
    throw new ApiError(
      "The dashboard server stopped (idle timeout). Reopen it from your assistant."
    );
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401)
    throw new ApiError(
      "This link has expired or was replaced. Reopen the dashboard from your assistant."
    );
  if (!response.ok) throw new ApiError(body.error ?? `Request failed (${response.status}).`);
  return body;
}

function setStatus(text, kind = "info") {
  statusLine.textContent = text;
  statusLine.dataset.kind = kind;
}

function selectTab(view, focus = false) {
  currentView = view;
  history.replaceState(null, "", `/?view=${view}`);
  for (const tab of tabs) {
    const selected = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  main.setAttribute("aria-labelledby", `tab-${view}`);
  void render();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(tab);
    const next = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[next].dataset.view, true);
  });
}

// ---------------------------------------------------------------------------
// DOM helpers (text only)
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs))
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const tip = (text) => svg("title", {}, text);

function table(caption, headers, rows, options = {}) {
  if (!rows.length)
    return el("p", { class: "empty" }, options.empty ?? `No ${caption.toLowerCase()}.`);
  return el(
    "div",
    { class: "table-wrap", tabindex: 0, role: "region", "aria-label": caption },
    el(
      "table",
      {},
      el("caption", {}, caption),
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          headers.map((header) => el("th", { scope: "col" }, header))
        )
      ),
      el(
        "tbody",
        {},
        rows.map((row) =>
          el(
            "tr",
            {},
            row.map((cell) => el("td", {}, cell))
          )
        )
      )
    )
  );
}

function section(title, ...children) {
  return el("section", { class: "card" }, el("h2", {}, title), ...children);
}

function stat(label, value, hint) {
  return el(
    "div",
    { class: "stat" },
    el("span", { class: "stat-label" }, label),
    el("span", { class: "stat-value" }, value),
    hint ? el("span", { class: "stat-hint" }, hint) : null
  );
}

function badge(text, kind) {
  return el("span", { class: `badge badge-${kind}` }, text);
}

function field(label, control, hint) {
  return el(
    "label",
    { class: "field" },
    el("span", {}, label),
    control,
    hint ? el("small", {}, hint) : null
  );
}

function select(name, options, value, extra = {}) {
  return el(
    "select",
    { name, ...extra },
    options.map((option) => {
      const [optionValue, text] = Array.isArray(option) ? option : [option, sentence(option)];
      return el("option", { value: optionValue, selected: optionValue === value }, text);
    })
  );
}

function input(name, attrs = {}) {
  return el("input", { name, ...attrs });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function label(value) {
  return String(value).replaceAll("_", " ");
}

/** Human copy for API enums: "not_ready" -> "Not ready", "hyrox" -> "HYROX". */
function sentence(value) {
  const text = label(value)
    .replace(/\bhyrox\b/gi, "HYROX")
    .replace(/\bhr\b/gi, "HR")
    .replace(/ pct\b/g, " %");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Axis ticks at 1/2/2.5/5 × 10^n so labels read 0, 50, 100 instead of 0, 155. */
function niceTicks(min, max, target = 4) {
  const span = Math.max(1e-9, max - min);
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((m) => m >= raw) ?? 10 * power;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = lo; value <= hi + step / 2; value += step)
    ticks.push(Math.round(value * 1e6) / 1e6);
  return { lo, hi, ticks };
}

function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function parseDuration(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return Number.NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function num(value, digits = 0, unit = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}${unit}`;
}

/** Shares from the API are 0–1 fractions. */
function pct(value, digits = 0) {
  return num(value === null || value === undefined ? value : value * 100, digits, "%");
}

function time(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function day(iso) {
  return iso ? String(iso).slice(0, 10) : "—";
}

function isoDay(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function json(value) {
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Shared panels
// ---------------------------------------------------------------------------

function storeNotice(store) {
  if (!store || store.status === "available") return null;
  return el(
    "p",
    { class: store.status === "error" ? "notice notice-error" : "notice" },
    store.status === "error"
      ? `Local corrections could not be read, so numbers use WHOOP data only. ${store.message ?? ""}`
      : "Local corrections are not available in this mode."
  );
}

function trustFooter(data) {
  const limitations = data.data_quality?.limitations ?? [];
  return el(
    "details",
    { class: "card trust" },
    el("summary", {}, "Method, data quality and limitations"),
    el(
      "dl",
      {},
      el("dt", {}, "Method version"),
      el("dd", {}, data.method_version ?? "—"),
      el("dt", {}, "Evaluated"),
      el("dd", {}, time(data.data_quality?.evaluated_at)),
      el("dt", {}, "Sources"),
      el(
        "dd",
        {},
        Object.entries(data.data_quality?.sources ?? {})
          .map(
            ([name, source]) => `${name}: ${source.status}${source.truncated ? " (truncated)" : ""}`
          )
          .join(" · ") || "—"
      )
    ),
    limitations.length
      ? el(
          "ul",
          {},
          limitations.map((text) => el("li", {}, text))
        )
      : null,
    data.truncated
      ? el("p", { class: "notice" }, "Some sources were truncated; totals may be low.")
      : null,
    el("p", { class: "disclaimer" }, data.disclaimer ?? "")
  );
}

function caveatsPanel(caveats) {
  if (!caveats?.length) return null;
  return el(
    "section",
    { class: "card caveats" },
    el("h2", {}, "Known gaps in this data"),
    el(
      "ul",
      {},
      caveats.map((caveat) =>
        el(
          "li",
          {},
          caveat.text,
          caveat.workout_ids?.length
            ? el("small", { class: "refs" }, ` Applies to: ${caveat.workout_ids.join(", ")}`)
            : null
        )
      )
    ),
    currentView === "audit"
      ? null
      : el(
          "button",
          { type: "button", class: "link", onclick: () => selectTab("audit") },
          "Review these in Audit"
        )
  );
}

function windowForm(state, onSubmit, extra = []) {
  const start = input("start", { type: "date", value: state.start });
  const end = input("end", { type: "date", value: state.end });
  return el(
    "form",
    {
      class: "controls",
      onsubmit: (event) => {
        event.preventDefault();
        state.start = start.value;
        state.end = end.value;
        onSubmit();
      },
    },
    field("From", start),
    field("To (exclusive)", end),
    ...extra,
    el("button", { type: "submit" }, "Update")
  );
}

// ---------------------------------------------------------------------------
// Charts (hand-rolled SVG, each with a text alternative)
// ---------------------------------------------------------------------------

function sessionTimeline(session, segments) {
  const W = 900;
  const H = 240;
  const top = 16;
  const bottom = 36;
  const left = 40;
  const s0 = Date.parse(session.start);
  const span = Math.max(1, Date.parse(session.end) - s0);
  const hrs = segments
    .flatMap((segment) => [segment.avg_hr, segment.max_hr])
    .filter(Number.isFinite);
  const hrMin = Math.min(80, ...hrs) - 10;
  const hrMax = Math.max(190, ...hrs) + 5;
  const x = (iso) => left + ((Date.parse(iso) - s0) / span) * (W - left - 8);
  const y = (hr) => top + (1 - (hr - hrMin) / (hrMax - hrMin)) * (H - top - bottom);
  const base = H - bottom;
  const ordered = [...segments].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const gaps = [];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const gapStart = Date.parse(previous.start) + previous.duration_seconds * 1000;
    const gapEnd = Date.parse(ordered[index].start);
    if (gapEnd - gapStart >= 1000) gaps.push([gapStart, gapEnd]);
  }

  const ticks = [];
  for (let hr = Math.ceil(hrMin / 20) * 20; hr <= hrMax; hr += 20)
    ticks.push(
      svg("line", { x1: left, x2: W - 8, y1: y(hr), y2: y(hr), class: "grid" }),
      svg("text", { x: left - 6, y: y(hr) + 4, class: "axis", "text-anchor": "end" }, hr)
    );

  return svg(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      class: "chart",
      role: "img",
      "aria-label": `Segment timeline: ${ordered.length} segments, ${gaps.length} transitions. Bar height is average heart rate, the tick is peak heart rate. Details are in the table below.`,
    },
    ...ticks,
    ...gaps.map(([gapStart, gapEnd]) =>
      svg(
        "rect",
        {
          x: left + ((gapStart - s0) / span) * (W - left - 8),
          width: Math.max(1, ((gapEnd - gapStart) / span) * (W - left - 8)),
          y: top,
          height: base - top,
          class: "gap",
        },
        tip(`Transition ${duration((gapEnd - gapStart) / 1000)}`)
      )
    ),
    ...ordered.flatMap((segment) => {
      const sx = x(segment.start);
      const width = Math.max(2, (segment.duration_seconds * 1000 * (W - left - 8)) / span);
      const nodes = [];
      const summary = `${segment.label} (${sentence(segment.sport_name)}) ${duration(segment.duration_seconds)} · avg ${num(segment.avg_hr)} / max ${num(segment.max_hr)} bpm`;
      if (Number.isFinite(segment.avg_hr))
        nodes.push(
          svg(
            "rect",
            {
              x: sx,
              width,
              y: y(segment.avg_hr),
              height: base - y(segment.avg_hr),
              class: `seg seg-${segment.role}`,
            },
            tip(summary)
          )
        );
      else
        nodes.push(
          svg(
            "rect",
            { x: sx, width, y: base - 6, height: 6, class: "seg seg-unknown" },
            tip(`${summary} (no HR)`)
          )
        );
      if (Number.isFinite(segment.max_hr))
        nodes.push(
          svg("line", {
            x1: sx,
            x2: sx + width,
            y1: y(segment.max_hr),
            y2: y(segment.max_hr),
            class: "peak",
          })
        );
      if (width > 26)
        nodes.push(
          svg(
            "text",
            { x: sx + width / 2, y: base + 14, class: "axis", "text-anchor": "middle" },
            segment.label
          )
        );
      return nodes;
    }),
    svg("line", { x1: left, x2: W - 8, y1: base, y2: base, class: "axis-line" }),
    svg("text", { x: left, y: H - 4, class: "axis" }, time(session.start)),
    svg("text", { x: W - 8, y: H - 4, class: "axis", "text-anchor": "end" }, time(session.end))
  );
}

function stackedBars(title, weeks, series) {
  const rows = [...weeks].sort((a, b) => a.week_start.localeCompare(b.week_start));
  const W = 900;
  const H = 220;
  const left = 44;
  const bottom = 28;
  const totals = rows.map((row) => series.reduce((sum, item) => sum + (item.value(row) ?? 0), 0));
  const { hi: max, ticks } = niceTicks(0, Math.max(1, ...totals));
  const band = (W - left - 8) / Math.max(1, rows.length);
  const barWidth = Math.max(4, band * 0.7);
  const scale = (value) => (value / max) * (H - 12 - bottom);
  return el(
    "figure",
    { class: "figure" },
    svg(
      "svg",
      {
        viewBox: `0 0 ${W} ${H}`,
        class: "chart",
        role: "img",
        "aria-label": `${title}. Values are in the table below.`,
      },
      ...ticks.flatMap((value) => {
        const ty = H - bottom - scale(value);
        return [
          value ? svg("line", { x1: left, x2: W - 8, y1: ty, y2: ty, class: "grid" }) : null,
          svg("text", { x: left - 6, y: ty + 4, class: "axis", "text-anchor": "end" }, value),
        ];
      }),
      svg("line", { x1: left, x2: W - 8, y1: H - bottom, y2: H - bottom, class: "axis-line" }),
      ...rows.flatMap((row, index) => {
        let offset = 0;
        const bx = left + index * band + (band - barWidth) / 2;
        const nodes = series.map((item) => {
          const value = item.value(row) ?? 0;
          const height = scale(value);
          offset += height;
          return svg(
            "rect",
            { x: bx, width: barWidth, y: H - bottom - offset, height, class: `bar ${item.cls}` },
            tip(`${row.week_start} ${item.name}: ${Math.round(value)}`)
          );
        });
        if (rows.length <= 16 || index % 2 === 0)
          nodes.push(
            svg(
              "text",
              { x: bx + barWidth / 2, y: H - 10, class: "axis", "text-anchor": "middle" },
              row.week_start.slice(5)
            )
          );
        return nodes;
      })
    ),
    el(
      "figcaption",
      {},
      `${title}: `,
      series.map((item) => el("span", { class: `key ${item.cls}` }, item.name))
    )
  );
}

function loadChart(series) {
  const W = 900;
  const H = 240;
  const left = 44;
  const bottom = 28;
  const values = series.flatMap((point) => [point.ctl, point.atl, point.tsb]);
  const { lo: min, hi: max, ticks } = niceTicks(Math.min(0, ...values), Math.max(1, ...values));
  const x = (index) => left + (index / Math.max(1, series.length - 1)) * (W - left - 8);
  const y = (value) => 10 + (1 - (value - min) / (max - min)) * (H - 10 - bottom);
  const path = (key) =>
    series
      .map(
        (point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`
      )
      .join("");
  return el(
    "figure",
    { class: "figure" },
    svg(
      "svg",
      {
        viewBox: `0 0 ${W} ${H}`,
        class: "chart",
        role: "img",
        "aria-label": `Fitness (CTL), fatigue (ATL) and form (TSB) over ${series.length} days. Latest values are in the summary.`,
      },
      ...ticks.flatMap((value) => [
        svg("line", {
          x1: left,
          x2: W - 8,
          y1: y(value),
          y2: y(value),
          class: value ? "grid" : "axis-line",
        }),
        svg("text", { x: left - 6, y: y(value) + 4, class: "axis", "text-anchor": "end" }, value),
      ]),
      svg("path", { d: path("ctl"), class: "line line-ctl" }),
      svg("path", { d: path("atl"), class: "line line-atl" }),
      svg("path", { d: path("tsb"), class: "line line-tsb" }),
      svg("text", { x: left, y: H - 8, class: "axis" }, series[0]?.date ?? ""),
      svg(
        "text",
        { x: W - 8, y: H - 8, class: "axis", "text-anchor": "end" },
        series.at(-1)?.date ?? ""
      )
    ),
    el(
      "figcaption",
      {},
      "Training load (TRIMP): ",
      el("span", { class: "key line-ctl" }, "Fitness CTL (42 d)"),
      el("span", { class: "key line-atl" }, "Fatigue ATL (7 d)"),
      el("span", { class: "key line-tsb" }, "Form TSB")
    )
  );
}

function shareBars(rows, minShare) {
  return el(
    "div",
    { class: "shares" },
    rows.map(([name, value, flagged]) =>
      el(
        "div",
        { class: "share-row" },
        el("span", { class: "share-name" }, sentence(name)),
        el(
          "meter",
          {
            min: 0,
            max: 1,
            value: value ?? 0,
            low: minShare,
            optimum: 1,
            "aria-label": `${label(name)} share`,
          },
          pct(value)
        ),
        el(
          "span",
          { class: "share-value" },
          pct(value),
          flagged ? badge("below minimum", "amber") : null
        )
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function renderSession() {
  const state = viewState.session;
  const dateInput = input("date", { type: "date", value: state.date });
  const controls = el(
    "form",
    {
      class: "controls",
      onsubmit: (event) => {
        event.preventDefault();
        state.date = dateInput.value;
        void render();
      },
    },
    field("Day", dateInput, "Leave blank for the latest workout"),
    el("button", { type: "submit" }, "Load")
  );
  const data = await api("/api/session-report", { query: { date: state.date } });
  const nodes = [controls, storeNotice(data.store)];
  if (data.status === "no_session" || !data.session) {
    nodes.push(
      section(
        "No session found",
        el("p", {}, "No workouts were found for this day. Try another date.")
      )
    );
    nodes.push(trustFooter(data));
    return nodes;
  }
  const session = data.session;
  const context = data.day_context;
  nodes.push(
    section(
      `Session ${day(session.start)}`,
      el(
        "p",
        { class: "actions" },
        session.confirmed_hyrox
          ? badge("Confirmed HYROX", "green")
          : session.kind === "hyrox_candidate"
            ? [
                badge("Possible HYROX, not yet confirmed", "amber"),
                el(
                  "button",
                  { type: "button", class: "link", onclick: () => selectTab("audit") },
                  "Confirm in Audit"
                ),
              ]
            : badge("Not a HYROX session", "grey")
      ),
      el(
        "div",
        { class: "stats" },
        stat("Span", duration(session.span_seconds)),
        stat("Tracked", duration(session.tracked_seconds)),
        stat("Transitions", duration(session.transition_seconds), pct(session.transition_share)),
        stat("Peak HR", num(session.peak_hr, 0, " bpm")),
        stat("Energy", num(session.kcal, 0, " kcal")),
        stat("Segments", session.segment_count)
      ),
      sessionTimeline(session, data.segments),
      table(
        "Segments",
        [
          "#",
          "Segment",
          "WHOOP sport",
          "Start",
          "Duration",
          "Avg HR",
          "Max HR",
          "Strain",
          "Workout",
        ],
        data.segments.map((segment, index) => [
          index + 1,
          segment.label,
          sentence(segment.sport_name),
          time(segment.start),
          duration(segment.duration_seconds),
          num(segment.avg_hr),
          num(segment.max_hr),
          num(segment.strain, 1),
          el("code", {}, segment.workout_id),
        ])
      )
    )
  );
  nodes.push(
    section(
      "Insights",
      data.insights.length
        ? el(
            "ul",
            { class: "insights" },
            data.insights.map((insight) =>
              el(
                "li",
                {},
                el("strong", {}, sentence(insight.id)),
                el("span", {}, insight.text),
                el("small", { class: "rule" }, `Rule: ${insight.rule}`)
              )
            )
          )
        : el("p", { class: "empty" }, "No insight rule fired, or its inputs were missing.")
    )
  );
  nodes.push(
    section(
      "Day context",
      el(
        "div",
        { class: "stats" },
        stat(
          "Recovery",
          num(context.recovery_score, 0, "%"),
          context.recovery_band ? `${sentence(context.recovery_band)} band` : undefined
        ),
        stat(
          "HRV",
          num(context.hrv_rmssd_milli, 0, " ms"),
          `baseline ${num(context.hrv_baseline_milli, 0, " ms")}`
        ),
        stat(
          "Resting HR",
          num(context.resting_heart_rate, 0, " bpm"),
          `baseline ${num(context.rhr_baseline, 0)}`
        ),
        stat(
          "Sleep",
          num(context.sleep_hours, 1, " h"),
          `performance ${num(context.sleep_performance_pct, 0, "%")}`
        ),
        stat("Day strain", num(context.day_strain, 1))
      ),
      el("small", {}, `Baselines from ${context.baseline_days} days.`)
    )
  );
  if (data.time_in_zone_seconds)
    nodes.push(
      section(
        "Time in HR zone",
        table(
          "Zones",
          ["Zone 0", "Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"],
          [
            ["zone_zero", "zone_one", "zone_two", "zone_three", "zone_four", "zone_five"].map(
              (key) => duration(data.time_in_zone_seconds[key])
            ),
          ]
        ),
        el("small", {}, "Zones are WHOOP's and depend on its (often estimated) max HR.")
      )
    );
  if (data.other_activities.length)
    nodes.push(
      section(
        "Other activities that day",
        table(
          "Other activities",
          ["Activity", "Start", "Duration", "Avg HR", "Strain", "Workout"],
          data.other_activities.map((row) => [
            sentence(row.sport_name),
            time(row.start),
            duration(row.duration_seconds),
            num(row.avg_hr),
            num(row.strain, 1),
            el("code", {}, row.workout_id),
          ])
        )
      )
    );
  if (data.sessions_on_day.length > 1)
    nodes.push(
      section(
        "Other sessions this day",
        el(
          "ul",
          {},
          data.sessions_on_day.map((item) =>
            el(
              "li",
              {},
              `${time(item.start)} · ${sentence(item.kind)} · ${item.segment_count} ${item.segment_count === 1 ? "segment" : "segments"}`
            )
          )
        )
      )
    );
  nodes.push(caveatsPanel(data.caveats), trustFooter(data));
  return nodes;
}

async function renderHyrox() {
  const state = viewState.hyrox;
  const data = await api("/api/hyrox", { query: state });
  const nodes = [windowForm(state, () => void render()), storeNotice(data.store)];
  const weekly = data.weekly;
  nodes.push(
    section(
      "Weekly HYROX training",
      el("p", {}, `${day(data.period.start)} → ${day(data.period.end)}`),
      weekly.length
        ? stackedBars("Minutes per week", weekly, [
            { name: "Run", cls: "c-run", value: (row) => row.run.minutes },
            { name: "HYROX", cls: "c-hyrox", value: (row) => row.hyrox.minutes },
          ])
        : null,
      table(
        "Weeks",
        ["Week", "Run min", "Run TRIMP", "HYROX min", "HYROX TRIMP", "Confirmed sessions"],
        weekly.map((row) => [
          row.week_start,
          num(row.run.minutes),
          num(row.run.trimp),
          num(row.hyrox.minutes),
          num(row.hyrox.trimp),
          row.confirmed_sessions,
        ])
      )
    )
  );
  nodes.push(
    section(
      "Confirmed sessions",
      table(
        "Confirmed HYROX sessions",
        ["Start", "Span", "Transitions", "Runs", "Stations", "Workouts"],
        data.sessions.map((row) => [
          time(row.start),
          duration(row.span_seconds),
          pct(row.transition_share),
          row.run_segments,
          row.station_segments,
          row.workout_ids.join(", "),
        ]),
        { empty: "No confirmed HYROX sessions. Confirm candidates below." }
      )
    )
  );
  if (data.unconfirmed_candidates.count)
    nodes.push(
      section(
        `Unconfirmed candidates (${data.unconfirmed_candidates.count})`,
        el(
          "p",
          {},
          "WHOOP logs HYROX sims as Functional Fitness or HIIT, so these are not counted until you confirm them."
        ),
        table(
          "Candidates",
          ["Start", "Kind", "Why", "Workouts"],
          data.unconfirmed_candidates.items.map((item) => [
            time(item.start),
            sentence(item.kind),
            item.reason,
            item.workout_ids.join(", "),
          ])
        ),
        el(
          "button",
          { type: "button", class: "link", onclick: () => selectTab("audit") },
          "Confirm in Audit"
        )
      )
    );
  const analysis = data.station_analysis;
  nodes.push(
    section(
      "Station analysis",
      el(
        "p",
        {},
        analysis.status === "available"
          ? `Based on ${analysis.races_used} races with splits.`
          : "Needs at least two races with splits."
      ),
      analysis.weakest_station
        ? el(
            "p",
            {},
            "Weakest against your median: ",
            el("strong", {}, sentence(analysis.weakest_station))
          )
        : null,
      table(
        "Stations",
        ["Station", "Median", "Latest", "Δ", "Δ %"],
        analysis.stations.map((row) => [
          sentence(row.station),
          duration(row.median_seconds),
          duration(row.latest_seconds),
          `${row.delta_seconds > 0 ? "+" : ""}${Math.round(row.delta_seconds)} s`,
          `${row.delta_pct > 0 ? "+" : ""}${num(row.delta_pct, 1)}%`,
        ])
      ),
      el("small", { class: "rule" }, `Rule: ${analysis.rule}`)
    )
  );
  nodes.push(
    section(
      "Race results",
      table(
        "HYROX races",
        ["Date", "Race", "Division", "Total", "Runs total", "Roxzone", "Workout"],
        data.races.map((race) => [
          race.date,
          race.name,
          sentence(race.category),
          duration(race.total_seconds),
          race.runs_seconds ? duration(race.runs_seconds.reduce((a, b) => a + b, 0)) : "—",
          race.roxzone_seconds === null
            ? "—"
            : `${duration(race.roxzone_seconds)} (${race.roxzone_source})`,
          race.workout_id ?? "—",
        ]),
        { empty: "No HYROX results logged yet." }
      ),
      table(
        "Personal records by division",
        ["Division", "Date", "Total"],
        data.personal_records.best_total_by_division.map((row) => [
          sentence(row.category),
          row.date,
          duration(row.total_seconds),
        ]),
        { empty: "No personal records yet." }
      ),
      raceForm("hyrox")
    )
  );
  nodes.push(trustFooter(data));
  return nodes;
}

async function renderTriathlon() {
  const state = viewState.triathlon;
  const data = await api("/api/triathlon", { query: state });
  const nodes = [windowForm(state, () => void render()), storeNotice(data.store)];
  const share = data.discipline_share;
  nodes.push(
    section(
      "Weekly volume",
      el("p", {}, `${day(data.period.start)} → ${day(data.period.end)}`),
      data.weekly.length
        ? stackedBars("Minutes per week", data.weekly, [
            { name: "Swim", cls: "c-swim", value: (row) => row.swim.minutes },
            { name: "Bike", cls: "c-bike", value: (row) => row.bike.minutes },
            { name: "Run", cls: "c-run", value: (row) => row.run.minutes },
            { name: "Multisport", cls: "c-multi", value: (row) => row.multisport.minutes },
          ])
        : null,
      table(
        "Weeks",
        ["Week", "Swim", "Bike", "Run", "Multisport", "Bricks"],
        data.weekly.map((row) => [
          row.week_start,
          legCell(row.swim),
          legCell(row.bike),
          legCell(row.run),
          legCell(row.multisport),
          row.bricks,
        ])
      )
    )
  );
  nodes.push(
    section(
      "Discipline balance",
      share.status === "available"
        ? shareBars(
            ["swim", "bike", "run"].map((leg) => [leg, share[leg], share.below_min.includes(leg)]),
            share.min_share
          )
        : el("p", { class: "empty" }, "Not enough swim, bike and run training to judge balance."),
      el("small", { class: "rule" }, `Rule: ${share.rule}`),
      table(
        "Totals",
        ["Leg", "Workouts", "Minutes", "Distance", "TRIMP"],
        ["swim", "bike", "run", "multisport"].map((leg) => [
          sentence(leg),
          data.totals[leg].workouts,
          num(data.totals[leg].minutes),
          num(data.totals[leg].distance_km, 1, " km"),
          num(data.totals[leg].trimp),
        ])
      ),
      data.distance_ignored_workout_ids.length
        ? el(
            "p",
            { class: "notice" },
            `Distance ignored as implausible for: ${data.distance_ignored_workout_ids.join(", ")}`
          )
        : null
    )
  );
  nodes.push(
    section(
      "HR zone mix",
      table(
        "Zone share by leg",
        ["Leg", "Z1", "Z2", "Z3", "Z4", "Z5"],
        ["swim", "bike", "run"]
          .filter((leg) => data.zone_mix[leg])
          .map((leg) => [
            sentence(leg),
            ...["zone_one", "zone_two", "zone_three", "zone_four", "zone_five"].map((zone) =>
              pct(data.zone_mix[leg][zone])
            ),
          ]),
        { empty: "No zone data." }
      )
    ),
    section(
      "Bricks",
      table(
        "Bike → run bricks",
        ["Date", "Bike", "Run", "Gap"],
        data.bricks.map((brick) => [
          brick.date,
          brick.bike_id,
          brick.run_id,
          duration(brick.gap_seconds),
        ]),
        { empty: "No bricks found." }
      )
    ),
    section(
      "Race results",
      table(
        "Triathlon races",
        ["Date", "Race", "Distance", "Total", "Swim", "T1", "Bike", "T2", "Run"],
        data.races.map((race) => [
          race.date,
          race.name,
          sentence(race.category),
          duration(race.total_seconds),
          duration(race.swim_seconds),
          duration(race.t1_seconds),
          duration(race.bike_seconds),
          duration(race.t2_seconds),
          duration(race.run_seconds),
        ]),
        { empty: "No triathlon results logged yet." }
      ),
      raceForm("triathlon")
    ),
    trustFooter(data)
  );
  return nodes;
}

function legCell(bucket) {
  if (!bucket.workouts) return "—";
  return `${num(bucket.minutes)} min${bucket.distance_km === null ? "" : ` · ${num(bucket.distance_km, 1)} km`}`;
}

async function renderReadiness() {
  const state = viewState.readiness;
  const sport = select("sport", ["hyrox", "triathlon"], state.sport);
  const raceDate = input("race_date", { type: "date", value: state.race_date });
  const controls = el(
    "form",
    {
      class: "controls",
      onsubmit: (event) => {
        event.preventDefault();
        state.sport = sport.value;
        state.race_date = raceDate.value;
        void render();
      },
    },
    field("Sport", sport),
    field("Race day", raceDate, "Optional, enables the taper check"),
    el("button", { type: "submit" }, "Evaluate")
  );
  const data = await api("/api/readiness", { query: state });
  const bandKind = {
    ready: "green",
    caution: "amber",
    not_ready: "red",
    insufficient_data: "grey",
  }[data.band];
  const verdictText = {
    ready: "Ready",
    caution: "Caution",
    not_ready: "Not ready",
    insufficient_data: "Not enough data",
  }[data.band];
  const named = (band) =>
    data.components.filter((component) => component.band === band).map((c) => sentence(c.id));
  const red = named("red");
  const amber = named("amber");
  const unknown = named("unknown");
  const summary = [
    red.length ? `Red: ${red.join(", ")}.` : null,
    amber.length ? `Amber: ${amber.join(", ")}.` : null,
    unknown.length ? `No data: ${unknown.join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const load = data.load;
  return [
    controls,
    storeNotice(data.store),
    section(
      `${sentence(data.sport)} readiness`,
      el(
        "div",
        { class: "verdict" },
        el(
          "p",
          { class: "verdict-eyebrow" },
          data.days_to_race === null
            ? `As of ${data.today}`
            : `As of ${data.today} · ${data.days_to_race} days to race`
        ),
        el("p", { class: `verdict-band verdict-${bandKind}` }, verdictText),
        el("p", { class: "verdict-summary" }, summary || "Every component is green.")
      ),
      el(
        "div",
        { class: "components" },
        data.components.map((component) =>
          el(
            "article",
            { class: "component" },
            el("h3", {}, sentence(component.id)),
            badge(sentence(component.band), component.band),
            el("p", {}, component.rationale),
            evidence(component.metric)
          )
        )
      ),
      el(
        "details",
        { class: "rule-detail" },
        el("summary", {}, "How the verdict is decided"),
        el("p", {}, data.band_rule)
      )
    ),
    section(
      "Training load",
      load.status === "available" && load.current
        ? el(
            "div",
            { class: "stats" },
            stat("Fitness (CTL)", num(load.current.ctl, 1)),
            stat("Fatigue (ATL)", num(load.current.atl, 1)),
            stat("Form (TSB)", num(load.current.tsb, 1)),
            stat(
              "Load spike",
              load.load_spike.ratio === null ? "—" : `${num(load.load_spike.ratio, 2)}×`,
              load.load_spike.flagged
                ? `Flagged: above ${load.load_spike.threshold}×`
                : `threshold ${load.load_spike.threshold}×`
            )
          )
        : el("p", { class: "empty" }, `Not enough history (${load.history_days} days).`),
      load.series.length ? loadChart(load.series) : null,
      table(
        "Load by discipline",
        ["Discipline", "CTL", "ATL", "TSB", "28-day load"],
        Object.entries(load.by_discipline).map(([name, values]) => [
          sentence(name),
          num(values.ctl, 1),
          num(values.atl, 1),
          num(values.tsb, 1),
          num(load.load_28d[name] ?? null),
        ])
      ),
      el(
        "small",
        { class: "rule" },
        "Method: ",
        el("code", {}, load.method),
        ` (${load.unit}, ${load.method_version})`
      ),
      load.series_truncated
        ? el("p", { class: "notice" }, "Chart shows the latest 90 days only.")
        : null
    ),
    trustFooter(data),
  ];
}

function evidence(metric) {
  const excluded = Object.entries(metric.inputs.excluded_reasons ?? {});
  return el(
    "details",
    { class: "why" },
    el("summary", {}, "Evidence"),
    el(
      "dl",
      {},
      el("dt", {}, "Value"),
      el("dd", {}, metric.value === null ? "—" : `${metric.value} ${metric.unit}`),
      el("dt", {}, "Status"),
      el("dd", {}, sentence(metric.status)),
      el("dt", {}, "Method"),
      el("dd", {}, el("code", {}, metric.method), ` (${metric.method_version})`),
      el("dt", {}, "Window"),
      el(
        "dd",
        {},
        metric.window ? `${time(metric.window.start)} → ${time(metric.window.end)}` : "—"
      ),
      el("dt", {}, "Records used"),
      el("dd", {}, metric.inputs.records_used),
      el("dt", {}, "Records excluded"),
      el(
        "dd",
        {},
        metric.inputs.records_excluded,
        excluded.length
          ? ` (${excluded.map(([reason, count]) => `${label(reason)}: ${count}`).join(", ")})`
          : ""
      ),
      el("dt", {}, "Source"),
      el("dd", {}, metric.source)
    ),
    metric.limitations.length
      ? el(
          "ul",
          {},
          metric.limitations.map((text) => el("li", {}, text))
        )
      : null
  );
}

async function renderAudit() {
  const state = viewState.audit;
  const data = await api("/api/audit", { query: { ...state, limit: "100" } });
  const form = annotationForm();
  const prefill = (values) => () => {
    form.fill(values);
    form.node.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    form.focus();
  };
  return [
    windowForm(state, () => void render()),
    storeNotice(data.store),
    section(
      "To review",
      el(
        "p",
        { class: "lede" },
        "Flagged automatically, never excluded automatically. Pick a row to prefill the correction form."
      ),
      suspectGroups(data.suspects, prefill),
      data.unconfirmed_candidates.length
        ? el(
            "div",
            { class: "suspect-group" },
            el(
              "h3",
              {},
              "Possible HYROX sessions ",
              el("span", { class: "count" }, `(${data.unconfirmed_candidates.length})`)
            ),
            table(
              "Unconfirmed HYROX candidates",
              ["Start", "Why", "Confirm a workout as HYROX"],
              data.unconfirmed_candidates.map((item) => [
                time(item.start),
                item.reason,
                el(
                  "span",
                  { class: "actions" },
                  item.workout_ids.map((id) =>
                    el(
                      "button",
                      {
                        type: "button",
                        class: "chip",
                        title: id,
                        onclick: prefill({
                          workout_id: id,
                          action: "relabel",
                          discipline: "hyrox",
                          reason: "hyrox_sim",
                        }),
                        "aria-label": `Confirm workout ${id} as HYROX`,
                      },
                      shortId(id)
                    )
                  )
                ),
              ])
            )
          )
        : null
    ),
    section(
      "Correct a workout",
      el(
        "p",
        {},
        "Corrections never change WHOOP data. They change how a workout is counted here, and each one is logged below."
      ),
      form.node
    ),
    section(
      `Your corrections (${data.annotations.length})`,
      table(
        "Corrections",
        ["Workout", "Sport", "Start", "Action", "Discipline", "Reason", "Note", "Updated", ""],
        data.annotations.map((annotation) => [
          el("code", {}, annotation.workout_id),
          annotation.sport_name ? sentence(annotation.sport_name) : "not in window",
          time(annotation.start),
          sentence(annotation.action),
          annotation.discipline ? sentence(annotation.discipline) : "—",
          sentence(annotation.reason),
          annotation.note ?? "",
          time(annotation.updated_at),
          annotation.action === "restore"
            ? ""
            : el(
                "button",
                {
                  type: "button",
                  onclick: prefill({
                    workout_id: annotation.workout_id,
                    action: "restore",
                    reason: "other",
                  }),
                },
                "Restore…"
              ),
        ]),
        { empty: "No corrections yet." }
      ),
      data.excluded_workout_ids.length
        ? el("p", {}, `Excluded from metrics: ${data.excluded_workout_ids.join(", ")}`)
        : null,
      data.rules.length
        ? table(
            "Classification rules",
            ["WHOOP sport", "Counts as", "Min minutes", "Weekdays"],
            data.rules.map((rule) => [
              sentence(rule.sport_name),
              sentence(rule.discipline),
              rule.min_duration_minutes ?? "—",
              rule.weekdays?.join(", ") ?? "any",
            ])
          )
        : null
    ),
    section(
      "Check a claim",
      el("p", {}, "Paste a number an assistant told you and recompute it from WHOOP data."),
      claimForm()
    ),
    section(
      "Audit log",
      data.audit_log.invalid_lines
        ? el(
            "p",
            { class: "notice notice-error" },
            `${data.audit_log.invalid_lines} unreadable log lines were skipped.`
          )
        : null,
      table(
        "Audit log (newest first)",
        ["When", "By", "Action", "Target", "Reason", "Before", "After"],
        data.audit_log.entries.map((entry) => [
          time(entry.at),
          entry.actor === "dashboard" ? "Dashboard" : "Assistant",
          sentence(entry.action),
          entry.workout_id ?? entry.race_id ?? "—",
          entry.reason ? sentence(entry.reason) : "—",
          el("code", { class: "json" }, json(entry.before)),
          el("code", { class: "json" }, json(entry.after)),
        ]),
        { empty: "No changes recorded yet." }
      ),
      data.audit_log.truncated ? el("p", {}, "Showing the latest 100 entries.") : null
    ),
    caveatsPanel(data.caveats),
    trustFooter(data),
  ];
}

function shortId(id) {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** One block per suspect rule; long groups start collapsed so a noisy rule cannot bury the rest. */
function suspectGroups(suspects, prefill) {
  if (!suspects.length) return el("p", { class: "empty" }, "No suspect records in this window.");
  const groups = new Map();
  for (const suspect of suspects) {
    if (!groups.has(suspect.rule)) groups.set(suspect.rule, []);
    groups.get(suspect.rule).push(suspect);
  }
  return [...groups].map(([rule, rows]) => {
    const heading = [sentence(rule), " ", el("span", { class: "count" }, `(${rows.length})`)];
    const body = table(
      sentence(rule),
      ["Workout", "Sport", "Start", "Detail", ""],
      rows.map((suspect) => [
        el("code", { title: suspect.workout_id }, shortId(suspect.workout_id)),
        sentence(suspect.sport_name),
        time(suspect.start),
        suspect.detail,
        el(
          "button",
          {
            type: "button",
            onclick: prefill({
              workout_id: suspect.workout_id,
              action: "exclude",
              reason: suspect.rule === "hr_out_of_range" ? "bad_hr" : "misclassified",
            }),
            "aria-label": `Correct workout ${suspect.workout_id}`,
          },
          "Correct…"
        ),
      ])
    );
    return rows.length > 3
      ? el("details", { class: "suspect-group" }, el("summary", {}, ...heading), body)
      : el("div", { class: "suspect-group" }, el("h3", {}, ...heading), body);
  });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function annotationForm() {
  const workoutId = input("workout_id", { required: true, autocomplete: "off", spellcheck: false });
  const action = select(
    "action",
    [
      ["exclude", "Exclude from metrics"],
      ["relabel", "Relabel discipline"],
      ["restore", "Restore (undo my correction)"],
    ],
    "exclude"
  );
  const discipline = select("discipline", DISCIPLINES, "hyrox");
  const reason = select("reason", REASONS, "misclassified");
  const note = input("note", { maxlength: 1000, autocomplete: "off" });
  const disciplineField = field("Discipline", discipline);
  const sync = () => {
    disciplineField.hidden = action.value !== "relabel";
    discipline.disabled = action.value !== "relabel";
  };
  action.addEventListener("change", sync);
  sync();
  const node = el(
    "form",
    {
      class: "controls",
      onsubmit: async (event) => {
        event.preventDefault();
        const body = {
          workout_id: workoutId.value.trim(),
          action: action.value,
          reason: reason.value,
        };
        if (action.value === "relabel") body.discipline = discipline.value;
        if (note.value.trim()) body.note = note.value.trim();
        reviewSave(
          "/api/annotate",
          body,
          `Saved: ${body.action} ${body.workout_id}. Logged in the audit log.`,
          [
            ["Workout", body.workout_id],
            ["Change", action.selectedOptions[0].textContent],
            ...(body.discipline ? [["Discipline", sentence(body.discipline)]] : []),
            ["Reason", sentence(body.reason)],
            ["Note", body.note ?? "None"],
          ],
          event.submitter
        );
      },
    },
    field("Workout id", workoutId),
    field("Change", action),
    disciplineField,
    field("Reason", reason),
    field("Note", note, "Optional"),
    el("button", { type: "submit" }, "Review correction")
  );
  return {
    node,
    focus: () => workoutId.focus(),
    fill(values) {
      workoutId.value = values.workout_id ?? "";
      action.value = values.action ?? "exclude";
      if (values.discipline) discipline.value = values.discipline;
      reason.value = values.reason ?? "misclassified";
      sync();
    },
  };
}

function claimForm() {
  const metric = select("metric", CLAIM_METRICS, "discipline_share_pct");
  const claimed = input("claimed_value", { type: "number", step: "any", required: true });
  const start = input("start", { type: "date", required: true, value: isoDay(-7) });
  const end = input("end", { type: "date", required: true, value: isoDay(1) });
  const sport = select("sport", [["", "Any"], "hyrox", "triathlon"], "");
  const discipline = select("discipline", [["", "Any"], ...DISCIPLINES], "");
  const compareStart = input("comparison_start", { type: "date" });
  const compareEnd = input("comparison_end", { type: "date" });
  const result = el("div", { class: "claim-result", "aria-live": "polite" });
  const form = el(
    "form",
    {
      class: "controls",
      onsubmit: async (event) => {
        event.preventDefault();
        const body = {
          metric: metric.value,
          claimed_value: Number(claimed.value),
          period: { start: start.value, end: end.value },
        };
        if (sport.value) body.sport = sport.value;
        if (discipline.value) body.discipline = discipline.value;
        if (compareStart.value || compareEnd.value)
          body.comparison_period = { start: compareStart.value, end: compareEnd.value };
        result.replaceChildren();
        try {
          setStatus("Checking…");
          const verdict = await api("/api/verify-claim", { method: "POST", body });
          result.replaceChildren(claimResult(verdict));
          setStatus(`Claim ${verdict.verdict}.`);
        } catch (error) {
          setStatus(error.message, "error");
        }
      },
    },
    field("Metric", metric),
    field("Claimed value", claimed),
    field("From", start),
    field("To (exclusive)", end),
    field("Sport", sport),
    field("Discipline", discipline, "Required for share %"),
    field("Compare from", compareStart, "Only for load change %"),
    field("Compare to", compareEnd),
    el("button", { type: "submit" }, "Check")
  );
  return el("div", {}, form, result);
}

function claimResult(verdict) {
  const kind = { confirmed: "green", contradicted: "red", unverifiable: "grey" }[verdict.verdict];
  return el(
    "div",
    { class: "card inner" },
    el(
      "p",
      { class: "headline" },
      badge(sentence(verdict.verdict), kind),
      ` ${sentence(verdict.metric)}`
    ),
    el("p", {}, verdict.reason),
    el(
      "dl",
      {},
      el("dt", {}, "Claimed"),
      el("dd", {}, verdict.claimed_value),
      el("dt", {}, "Recomputed"),
      el("dd", {}, verdict.recomputed_value ?? "—"),
      el("dt", {}, "Difference"),
      el("dd", {}, verdict.difference ?? "—"),
      el("dt", {}, "Tolerance"),
      el("dd", {}, `${verdict.tolerance.value ?? "—"} (${verdict.tolerance.rule})`),
      el("dt", {}, "Method"),
      el("dd", {}, verdict.method),
      el("dt", {}, "Inputs"),
      el(
        "dd",
        {},
        Object.entries(verdict.evidence.inputs)
          .map(([key, value]) => `${label(key)}: ${value ?? "—"}`)
          .join(" · ") || "—"
      ),
      el("dt", {}, "Workouts used"),
      el(
        "dd",
        {},
        verdict.evidence.workout_ids.join(", ") || "none",
        verdict.evidence.workout_ids_truncated ? " (truncated)" : ""
      ),
      verdict.evidence.unconfirmed_candidate_ids.length
        ? el("dt", {}, "Unconfirmed candidates")
        : null,
      verdict.evidence.unconfirmed_candidate_ids.length
        ? el("dd", {}, verdict.evidence.unconfirmed_candidate_ids.join(", "))
        : null
    )
  );
}

function raceForm(sport) {
  const date = input("date", { type: "date", required: true, max: isoDay(0) });
  const name = input("name", { required: true, maxlength: 120, autocomplete: "off" });
  const category =
    sport === "hyrox"
      ? select("category", HYROX_DIVISIONS, "open_men")
      : select("category", TRIATHLON_DISTANCES, "olympic");
  const total = input("total", {
    required: true,
    placeholder: "h:mm:ss",
    inputmode: "numeric",
    autocomplete: "off",
  });
  const workout = input("workout_id", { autocomplete: "off" });
  const splitInputs = new Map();
  const splitField = (key, text) => {
    const control = input(key, {
      placeholder: "m:ss",
      inputmode: "numeric",
      autocomplete: "off",
      size: 7,
    });
    splitInputs.set(key, control);
    return field(text, control);
  };
  const splits =
    sport === "hyrox"
      ? el(
          "fieldset",
          { class: "splits" },
          el("legend", {}, "Splits (optional, all 8 runs and 8 stations)"),
          Array.from({ length: 8 }, (_, index) => [
            splitField(`run_${index}`, `Run ${index + 1}`),
            splitField(`station_${index}`, label(HYROX_STATIONS[index])),
          ]),
          splitField("roxzone", "Roxzone (optional)")
        )
      : el(
          "fieldset",
          { class: "splits" },
          el("legend", {}, "Splits (optional, all five)"),
          splitField("swim_seconds", "Swim"),
          splitField("t1_seconds", "T1"),
          splitField("bike_seconds", "Bike"),
          splitField("t2_seconds", "T2"),
          splitField("run_seconds", "Run")
        );
  const value = (key) => parseDuration(splitInputs.get(key).value);
  const form = el(
    "form",
    {
      class: "controls race-form",
      onsubmit: async (event) => {
        event.preventDefault();
        const body = {
          sport,
          date: date.value,
          name: name.value.trim(),
          category: category.value,
          total_seconds: parseDuration(total.value),
        };
        if (workout.value.trim()) body.workout_id = workout.value.trim();
        const anySplit = [...splitInputs.entries()].some(
          ([key, control]) => key !== "roxzone" && control.value.trim()
        );
        if (anySplit) {
          if (sport === "hyrox") {
            body.splits = {
              runs: Array.from({ length: 8 }, (_, index) => value(`run_${index}`) ?? null),
              stations: HYROX_STATIONS.map((station, index) => ({
                station,
                seconds: value(`station_${index}`) ?? null,
              })),
            };
            if (value("roxzone") !== undefined) body.splits.roxzone_seconds = value("roxzone");
          } else {
            body.splits = Object.fromEntries(
              ["swim_seconds", "t1_seconds", "bike_seconds", "t2_seconds", "run_seconds"].map(
                (key) => [key, value(key) ?? null]
              )
            );
          }
        }
        reviewSave(
          "/api/race-result",
          body,
          `Saved ${name.value.trim()}. Logged in the audit log.`,
          [
            ["Sport", sentence(sport)],
            ["Race", body.name],
            ["Race day", body.date],
            ["Category", sentence(body.category)],
            ["Official time", total.value],
            ["Workout", body.workout_id ?? "Not linked"],
            ...[...splitInputs.entries()]
              .filter(([, control]) => control.value.trim())
              .map(([, control]) => [
                control.closest("label").querySelector("span").textContent,
                control.value,
              ]),
          ],
          event.submitter
        );
      },
    },
    field("Race day", date),
    field("Race name", name),
    field(sport === "hyrox" ? "Division" : "Distance", category),
    field("Official time", total, "h:mm:ss"),
    field("WHOOP workout id", workout, "Optional"),
    splits,
    el("button", { type: "submit" }, "Review result")
  );
  return el(
    "details",
    { class: "log-race" },
    el("summary", {}, `Log a ${sport === "hyrox" ? "HYROX" : "triathlon"} result`),
    form
  );
}

function reviewSave(path, body, message, rows, trigger) {
  if (document.querySelector("dialog")) return;
  let saving = false;
  const close = () => {
    dialog.close();
    dialog.remove();
    trigger?.focus();
  };
  const errorLine = el("p", { role: "alert", class: "notice notice-error", hidden: true });
  const edit = el("button", { type: "button", onclick: close }, "Edit");
  const cancel = el("button", { type: "button", onclick: close }, "Cancel");
  const confirm = el(
    "button",
    {
      type: "button",
      onclick: async () => {
        if (saving) return;
        saving = true;
        for (const button of [confirm, edit, cancel]) button.disabled = true;
        dialog.setAttribute("aria-busy", "true");
        errorLine.hidden = true;
        setStatus("Saving…");
        try {
          const result = await api(path, { method: "POST", body });
          close();
          setStatus(
            result.warnings?.length ? `${message} Notes: ${result.warnings.join(" ")}` : message,
            "success"
          );
          await render({ keepStatus: true });
          main.focus();
        } catch (error) {
          errorLine.textContent = error.message;
          errorLine.hidden = false;
          setStatus(error.message, "error");
        } finally {
          saving = false;
          for (const button of [confirm, edit, cancel]) button.disabled = false;
          dialog.removeAttribute("aria-busy");
        }
      },
    },
    "Confirm save"
  );
  const dialog = el(
    "dialog",
    {
      class: "save-review",
      "aria-labelledby": "save-review-title",
      oncancel: (event) => {
        event.preventDefault();
        if (!saving) close();
      },
    },
    el("h2", { id: "save-review-title" }, "Review before saving"),
    el(
      "p",
      {},
      "This changes local records and calculations only, never your WHOOP account. The change will be recorded in your audit log."
    ),
    el(
      "dl",
      {},
      rows.flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)])
    ),
    errorLine,
    el("div", { class: "actions" }, edit, cancel, confirm)
  );
  document.body.append(dialog);
  dialog.showModal();
  edit.focus();
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

async function renderToday() {
  const data = await api("/api/today");
  const quality = data.data_quality;
  const recovery = quality.sources.recovery.status === "available" ? data.recovery : null;
  const sleep = data.sleep;
  const strain = data.strain;
  const workout = strain?.last_workout;
  const item = (title, value, sourceName, detail) => {
    const source = quality.sources[sourceName];
    return el(
      "div",
      { class: "today-row" },
      el(
        "div",
        {},
        el("h3", {}, title),
        el("p", { class: "today-value" }, value ?? sentence(source.status))
      ),
      el(
        "div",
        {},
        el("p", {}, detail),
        el(
          "details",
          { class: "why" },
          el("summary", {}, "Evidence"),
          el(
            "dl",
            {},
            el("dt", {}, "Source status"),
            el("dd", {}, sentence(source.status)),
            el("dt", {}, "Source record updated"),
            el("dd", {}, time(source.source_updated_at)),
            el("dt", {}, "Records used / fetched"),
            el("dd", {}, `${source.records_used} / ${source.records_fetched}`),
            el("dt", {}, "Excluded records"),
            el("dd", {}, json(source.exclusions)),
            el("dt", {}, "Method"),
            el("dd", {}, el("code", {}, quality.method_version)),
            el("dt", {}, "Requested window"),
            el(
              "dd",
              {},
              `${time(quality.requested_period.start)} to ${time(quality.requested_period.end)}`
            ),
            el("dt", {}, "Cache status"),
            el("dd", {}, sentence(source.cache_status))
          ),
          source.truncated ? el("p", { class: "notice" }, "Source results are truncated.") : null
        )
      )
    );
  };
  return [
    section(
      "Daily overview",
      el(
        "p",
        { class: "lede" },
        `Snapshot evaluated ${time(data.timestamp)}. WHOOP recovery is not a race-readiness verdict.`
      ),
      item(
        "WHOOP recovery",
        recovery ? num(recovery.score, 0, "%") : null,
        "recovery",
        recovery
          ? `HRV ${num(recovery.hrv_rmssd_milli, 1, " ms")} · Resting HR ${num(recovery.resting_heart_rate, 0, " bpm")}`
          : "No usable recovery score for the current cycle and primary sleep."
      ),
      item(
        "Primary sleep",
        sleep ? num(sleep.asleep_hours, 1, " h asleep") : null,
        "sleep",
        sleep
          ? `${num(sleep.time_in_bed_hours, 1)} h in bed · Performance ${num(sleep.performance_pct, 0, "%")}`
          : "No scored primary sleep for today. Older sleep is not substituted."
      ),
      item(
        "Cycle strain",
        strain ? num(strain.day_strain, 1) : null,
        "cycle",
        strain
          ? `${num(strain.energy_burned_kj, 0, " kJ")} recorded for the current cycle.`
          : "No scored current cycle."
      ),
      item(
        "Latest workout",
        workout ? sentence(workout.sport_name) : "Not available in this snapshot",
        "workout",
        workout
          ? `Occurred ${time(workout.occurred_at)} · Strain ${num(workout.strain, 1)} · ${num(workout.percent_recorded, 0, "%")} recorded. This workout may be from an earlier day.`
          : "A scored current cycle and workout are needed for this snapshot's workout summary."
      ),
      el(
        "div",
        { class: "actions" },
        el("button", { type: "button", onclick: () => selectTab("session") }, "Session report"),
        el("button", { type: "button", onclick: () => selectTab("readiness") }, "Race readiness"),
        el("button", { type: "button", onclick: () => selectTab("audit") }, "Audit data")
      ),
      el(
        "p",
        { class: "notice" },
        "This overview uses WHOOP records, not local workout corrections. Race views apply those corrections."
      ),
      el(
        "ul",
        {},
        quality.limitations.map((text) => el("li", {}, text))
      )
    ),
  ];
}

const RENDERERS = {
  today: renderToday,
  session: renderSession,
  hyrox: renderHyrox,
  triathlon: renderTriathlon,
  readiness: renderReadiness,
  audit: renderAudit,
};
let renderId = 0;

async function render(options = {}) {
  const id = ++renderId;
  const view = currentView;
  main.setAttribute("aria-busy", "true");
  if (!options.keepStatus) setStatus("Loading…");
  try {
    const nodes = await RENDERERS[view]();
    if (id !== renderId) return;
    main.replaceChildren(...nodes.filter(Boolean));
    if (!options.keepStatus) setStatus("");
  } catch (error) {
    if (id !== renderId) return;
    main.replaceChildren(
      el(
        "section",
        { class: "card" },
        el("h2", {}, "Could not load this view"),
        el("p", {}, error.message)
      )
    );
    setStatus(error.message, "error");
  } finally {
    if (id === renderId) main.removeAttribute("aria-busy");
  }
}

selectTab(currentView);
