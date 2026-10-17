import { readFileSync } from "node:fs";
import { z } from "zod";

const outcomeSchema = z.enum(["success", "error"]);
const errorCategorySchema = z.enum([
  "api_auth",
  "api_rate_limit",
  "api_client",
  "api_server",
  "network",
  "invalid_data",
  "output_contract",
  "unexpected",
]);
const toolNameSchema = z.enum([
  "get_profile",
  "get_body_measurement",
  "get_recovery_collection",
  "get_sleep_collection",
  "get_workout_collection",
  "get_cycle_collection",
  "get_sleep_by_id",
  "get_workout_by_id",
  "get_cycle_by_id",
  "get_weekly_summary",
  "compare_periods",
  "get_trend",
  "get_today",
  "get_calendar",
  "get_baselines",
  "get_sleep_debt",
  "get_hyrox_session_report",
  "get_hyrox_performance",
  "get_triathlon_performance",
  "get_race_readiness",
  "audit_performance_data",
  "verify_claim",
  "log_race_result",
  "annotate_workout",
  "open_performance_dashboard",
]);
const eventSchema = z.union([
  z.strictObject({
    kind: z.literal("prompt"),
    name: z.enum([
      "weekly_health_review",
      "sleep_analysis",
      "recovery_trend",
      "workout_recap",
      "health_check",
    ]),
    outcome: outcomeSchema,
  }),
  z.strictObject({
    kind: z.literal("command"),
    name: z.enum(["serve", "setup"]),
    outcome: outcomeSchema,
  }),
  z.strictObject({
    kind: z.literal("tool"),
    name: toolNameSchema,
    outcome: z.literal("success"),
  }),
  z.strictObject({
    kind: z.literal("tool"),
    name: toolNameSchema,
    outcome: z.literal("error"),
    error_category: errorCategorySchema.optional(),
  }),
]);

export interface Telemetry {
  readonly status: {
    readonly enabled: boolean;
    readonly reason:
      "enabled" | "not_opted_in" | "do_not_track" | "privacy_mode" | "invalid_endpoint";
  };
  record(event: unknown): void;
  flush(): Promise<void>;
}

export function createTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  let endpoint: string | undefined;
  let reason: Telemetry["status"]["reason"] = "not_opted_in";
  if (env.DO_NOT_TRACK === "1") reason = "do_not_track";
  else if ((env.WHOOP_MCP_PRIVACY_MODE ?? "standard") !== "standard") reason = "privacy_mode";
  else if (env.WHOOP_MCP_TELEMETRY === "1") {
    reason = "invalid_endpoint";
    try {
      const url = new URL(env.WHOOP_MCP_TELEMETRY_ENDPOINT ?? "");
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) {
        endpoint = url.href;
        reason = "enabled";
      }
    } catch {
      endpoint = undefined;
    }
  }

  let packageVersion = "0.0.0";
  if (endpoint) {
    try {
      const pkg = z
        .object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) })
        .parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")));
      packageVersion = pkg.version;
    } catch {
      packageVersion = "0.0.0";
    }
  }

  const pending = new Set<Promise<void>>();
  async function send(body: string): Promise<void> {
    try {
      const response = await fetch(endpoint!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(500),
        redirect: "error",
        credentials: "omit",
      });
      await response.body?.cancel();
    } catch {
      return;
    }
  }

  return {
    status: Object.freeze({ enabled: endpoint !== undefined, reason }),
    record(event: unknown): void {
      if (!endpoint || pending.size >= 8) return;
      const parsed = eventSchema.safeParse(event);
      if (!parsed.success) return;
      const request = send(
        JSON.stringify({
          schema_version: 1,
          package_version: packageVersion,
          ...parsed.data,
        })
      );
      pending.add(request);
      void request.finally(() => pending.delete(request));
    },
    async flush(): Promise<void> {
      await Promise.all(pending);
    },
  };
}
