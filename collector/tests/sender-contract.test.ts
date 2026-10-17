import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetry } from "../../src/telemetry/telemetry.js";
import { handleEvent } from "../src/collector.js";

describe("existing client wire contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["command", "serve"],
    ["command", "setup"],
    ["prompt", "weekly_health_review"],
    ["prompt", "sleep_analysis"],
    ["prompt", "recovery_trend"],
    ["prompt", "workout_recap"],
    ["prompt", "health_check"],
    ["tool", "get_profile"],
    ["tool", "get_body_measurement"],
    ["tool", "get_recovery_collection"],
    ["tool", "get_sleep_collection"],
    ["tool", "get_workout_collection"],
    ["tool", "get_cycle_collection"],
    ["tool", "get_sleep_by_id"],
    ["tool", "get_workout_by_id"],
    ["tool", "get_cycle_by_id"],
    ["tool", "get_weekly_summary"],
    ["tool", "compare_periods"],
    ["tool", "get_trend"],
    ["tool", "get_today"],
    ["tool", "get_calendar"],
    ["tool", "get_baselines"],
    ["tool", "get_sleep_debt"],
    ["tool", "get_hyrox_session_report"],
    ["tool", "get_hyrox_performance"],
    ["tool", "get_triathlon_performance"],
    ["tool", "get_race_readiness"],
    ["tool", "audit_performance_data"],
    ["tool", "verify_claim"],
    ["tool", "log_race_result"],
    ["tool", "annotate_workout"],
    ["tool", "open_performance_dashboard"],
  ])("accepts both outcomes emitted for %s %s", async (kind, name) => {
    const increment = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init: RequestInit) =>
        handleEvent(new Request(input, init), {
          enabled: true,
          allowRequest: async () => true,
          increment,
          now: () => new Date("2026-09-19T00:00:00.000Z"),
        })
      )
    );
    const telemetry = createTelemetry({
      WHOOP_MCP_TELEMETRY: "1",
      WHOOP_MCP_TELEMETRY_ENDPOINT: "https://collector.example/events",
    });
    telemetry.record({ kind, name, outcome: "success" });
    telemetry.record({ kind, name, outcome: "error" });
    await telemetry.flush();

    expect(increment).toHaveBeenCalledTimes(2);
    for (const outcome of ["success", "error"]) {
      expect(increment).toHaveBeenCalledWith({
        day: "2026-09-19",
        package_version: expect.any(String),
        kind,
        name,
        outcome,
        error_category: kind === "tool" && outcome === "error" ? "unknown" : "none",
      });
    }
  });

  it("preserves an allowlisted tool error category end to end", async () => {
    const increment = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init: RequestInit) =>
        handleEvent(new Request(input, init), {
          enabled: true,
          allowRequest: async () => true,
          increment,
          now: () => new Date("2026-09-19T00:00:00.000Z"),
        })
      )
    );
    const telemetry = createTelemetry({
      WHOOP_MCP_TELEMETRY: "1",
      WHOOP_MCP_TELEMETRY_ENDPOINT: "https://collector.example/events",
    });

    telemetry.record({
      kind: "tool",
      name: "get_workout_collection",
      outcome: "error",
      error_category: "api_auth",
    });
    await telemetry.flush();

    expect(increment).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", error_category: "api_auth" })
    );
  });
});
