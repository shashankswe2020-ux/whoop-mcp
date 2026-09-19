#!/usr/bin/env node
/*
 * pull-body.mjs - pull the last 28 days from WHOOP and print the document the
 * Helix HUD stores at stats/body.
 *
 * This exists because the hosted connector is not running. It does the same
 * work PACER would do, on your own machine, using the tokens the local OAuth
 * flow already stored in ~/.whoop-mcp/tokens.json. No server, no hosting bill.
 *
 *   npm run build            (once, if dist/ is stale)
 *   node scripts/pull-body.mjs
 *
 * It writes whoop-body.json and prints the same JSON. Paste that to Claude and
 * it goes straight into the HUD. Nothing secret is in the output - only the
 * measurements. Never paste your .env or tokens.json.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAYS = 28;

// --- .env, without adding a dependency ------------------------------------
for (const file of [".env", ".env.local"]) {
  const p = join(ROOT, file);
  if (!existsSync(p)) continue;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// A bare absolute path is not a valid import specifier on Windows: the ESM
// loader reads "C:" as a URL scheme and refuses it. POSIX paths happen to
// work, which is exactly how this ships broken if it is only run on Linux.
// pathToFileURL is the cross-platform way to hand a path to import().
const dist = (rel) => pathToFileURL(join(ROOT, "dist", rel)).href;
const { authenticate, refreshAccessToken, toOAuthTokens } = await import(dist("auth/oauth.js"));
const { loadTokens, saveTokens } = await import(dist("auth/token-store.js"));
const { createWhoopClient } = await import(dist("api/client.js"));
const { resolveRedirectUri, resolveScopes, redirectPort, WHOOP_TOKEN_URL, WHOOP_AUTH_URL } =
  await import(dist("api/endpoints.js"));

const clientId = process.env.WHOOP_CLIENT_ID;
const clientSecret = process.env.WHOOP_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET.");
  console.error("They live in .env next to package.json - the same ones the setup wizard wrote.");
  process.exit(1);
}
const redirectUri = resolveRedirectUri();
const scopes = resolveScopes();
// Interactive is fine here: this runs on your laptop, so if the stored tokens
// have expired beyond refresh it can open a browser and re-authorise. The
// callback server follows the redirect URI rather than assuming port 3000.
const oauthConfig = {
  clientId,
  clientSecret,
  nonInteractive: false,
  redirectUri,
  port: redirectPort(redirectUri),
};

// ---------------------------------------------------------------------------
// --diagnose: answer "what is actually wrong" in one run, without a browser
// and without touching the stored tokens.
// ---------------------------------------------------------------------------
if (process.argv.includes("--diagnose")) {
  const odd = [...clientId].filter((ch) => !/[0-9a-fA-F-]/.test(ch));
  console.log("client_id     : length " + clientId.length +
    ", starts " + clientId.slice(0, 8) + ", ends " + clientId.slice(-4));
  console.log("                " + (odd.length
    ? "UNEXPECTED CHARACTERS: " + JSON.stringify(odd.join("")) +
      "  <-- a stray quote, space or comment in .env"
    : "all characters are hex/dash, length " +
      (clientId.length === 36 ? "36 (a normal UUID)" : clientId.length + " (a UUID is 36)")));
  console.log("client_secret : length " + clientSecret.length + " (value not shown)");
  console.log("redirect_uri  : " + redirectUri + "   -> callback port " + redirectPort(redirectUri));
  console.log("scopes        : " + scopes);
  console.log("token endpoint: " + WHOOP_TOKEN_URL);
  console.log("\nauthorize URL this would open:");
  console.log(WHOOP_AUTH_URL + "?response_type=code&client_id=" + encodeURIComponent(clientId) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) + "&scope=" + encodeURIComponent(scopes));

  // The decisive probe. A deliberately invalid refresh_token with REAL client
  // credentials separates the two failures that look identical from outside:
  // if WHOOP knows the client it complains about the grant; if it does not, it
  // complains about the client. No browser, no redirect URI involved.
  console.log("\nProbing the token endpoint with a deliberately invalid refresh token...");
  let probe;
  try {
    probe = await fetch(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "this-token-is-intentionally-not-valid",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "offline",
      }).toString(),
    });
  } catch (err) {
    console.log("Could not reach " + WHOOP_TOKEN_URL);
    console.log(String(err && err.message ? err.message : err));
    console.log("\nVERDICT: no network answer, so nothing is proven about the client.");
    console.log("         Check VPN, proxy or firewall and run --diagnose again.");
    process.exit(1);
  }
  const raw = await probe.text();
  let err = "";
  try { err = String(JSON.parse(raw).error ?? ""); } catch { err = ""; }
  console.log("HTTP " + probe.status + "  error=" + (err || "(none)"));
  console.log(raw.slice(0, 300));
  console.log("");
  if (err === "invalid_grant") {
    console.log("VERDICT: WHOOP KNOWS this client. Your ID and secret are correct.");
    console.log("         So the browser failure is the redirect URI or the scopes.");
    console.log("         Check the dashboard's registered Redirect URIs, then set");
    console.log("         WHOOP_REDIRECT_URI (and/or WHOOP_SCOPES) in .env to match.");
  } else if (err === "invalid_client") {
    console.log("VERDICT: WHOOP DOES NOT KNOW this client id/secret pair.");
    console.log("         The dashboard app and these credentials disagree --");
    console.log("         regenerate the secret, or copy both values again.");
  } else if (!raw.trim().startsWith("{")) {
    console.log("VERDICT: that is not a WHOOP OAuth response -- something between you");
    console.log("         and WHOOP answered instead (proxy, firewall or captive portal).");
    console.log("         Nothing is proven about the client until this is cleared.");
  } else {
    console.log("VERDICT: unexpected. Send the two lines above back.");
  }
  process.exit(0);
}

console.error("Authenticating with WHOOP...");
const accessToken = await authenticate(oauthConfig);
const onTokenRefresh = async () => {
  const t = await loadTokens();
  if (!t) throw new Error("no stored tokens");
  const refreshed = await refreshAccessToken(t.refresh_token, oauthConfig);
  const next = toOAuthTokens(refreshed, t.refresh_token);
  await saveTokens(next);
  return next.access_token;
};
const client = createWhoopClient({ accessToken, onTokenRefresh });

// --- window ---------------------------------------------------------------
const now = new Date();
const start = new Date(now.getTime() - DAYS * 864e5);
const dayOf = (iso) => String(iso).slice(0, 10);
const range = `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(now.toISOString())}`;

async function pullAll(path) {
  const out = [];
  let token;
  for (let page = 0; page < 20; page++) {
    const q = `${path}?${range}&limit=25${token ? `&nextToken=${encodeURIComponent(token)}` : ""}`;
    const res = await client.get(q);
    out.push(...(res.records ?? []));
    token = res.next_token;
    if (!token) break;
  }
  return out;
}

console.error(`Pulling ${DAYS} days...`);
const [cycles, recoveries, sleeps, workouts] = await Promise.all([
  pullAll("/v2/cycle"),
  pullAll("/v2/recovery"),
  pullAll("/v2/activity/sleep"),
  pullAll("/v2/activity/workout"),
]);

// Recovery records carry a cycle_id, not a date, so the cycle supplies the day.
const cycleDate = new Map();
const byDate = new Map();
const row = (d) => {
  if (!byDate.has(d)) {
    byDate.set(d, { date: d, recovery: null, hrv: null, restingHr: null, sleepHours: null, strain: null });
  }
  return byDate.get(d);
};

for (const c of cycles) {
  const d = dayOf(c.start);
  cycleDate.set(c.id, d);
  if (c.score_state === "SCORED" && c.score) row(d).strain = round(c.score.strain, 1);
}
for (const r of recoveries) {
  const d = cycleDate.get(r.cycle_id);
  if (!d || r.score_state !== "SCORED" || !r.score) continue;
  const x = row(d);
  x.recovery = r.score.recovery_score;
  x.hrv = round(r.score.hrv_rmssd_milli, 1);
  x.restingHr = r.score.resting_heart_rate;
}
const sleepPerf = new Map();
for (const s of sleeps) {
  if (s.nap || s.score_state !== "SCORED" || !s.score) continue;
  const d = dayOf(s.end); // the day you woke up
  const st = s.score.stage_summary;
  const hours = (st.total_in_bed_time_milli - st.total_awake_time_milli) / 3600000;
  row(d).sleepHours = round(hours, 2);
  if (s.score.sleep_performance_percentage != null) {
    sleepPerf.set(d, Math.round(s.score.sleep_performance_percentage));
  }
}

function round(n, dp) {
  return typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(dp)) : null;
}
function mean(xs) {
  const v = xs.filter((x) => typeof x === "number");
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 1) : null;
}

const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
const scored = series.filter((d) => d.recovery != null);
const latest = scored[scored.length - 1];
if (!latest) {
  console.error("No scored recovery in the window. Is the strap syncing?");
  process.exit(1);
}

// Every day in the window that produced no recovery reading, named honestly
// rather than interpolated.
const gaps = [];
for (let i = 0; i < DAYS; i++) {
  const d = new Date(now.getTime() - i * 864e5).toISOString().slice(0, 10);
  const r = byDate.get(d);
  if (!r || r.recovery == null) gaps.push(d);
}
gaps.sort();

const lastWorkout = workouts
  .filter((w) => w.sport_name)
  .sort((a, b) => String(b.start).localeCompare(String(a.start)))[0];

const doc = {
  live: true,
  asOf: latest.date,
  updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  source: "WHOOP - manual pull via scripts/pull-body.mjs",
  today: {
    date: latest.date,
    recovery: latest.recovery,
    hrv: latest.hrv,
    restingHr: latest.restingHr,
    sleepHours: latest.sleepHours,
    sleepPerformance: sleepPerf.get(latest.date) ?? null,
    strain: latest.strain,
    lastActivity: lastWorkout ? lastWorkout.sport_name : null,
  },
  baselines: {
    hrv30: mean(scored.map((d) => d.hrv)),
    restingHr7: mean(scored.slice(-7).map((d) => d.restingHr)),
    recovery7: mean(scored.slice(-7).map((d) => d.recovery)),
  },
  series,
  coverage: { days: DAYS, withRecovery: scored.length, gaps },
};

const outPath = join(ROOT, "whoop-body.json");
writeFileSync(outPath, JSON.stringify(doc, null, 2));
console.error(`\nWrote ${outPath}`);
console.error(`${scored.length} of ${DAYS} days have a recovery score; latest ${latest.date} at ${latest.recovery}%.`);
console.error("Paste the JSON below to Claude.\n");
console.log(JSON.stringify(doc, null, 2));
