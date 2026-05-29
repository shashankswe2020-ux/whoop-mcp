/**
 * MCP Prompts — pre-built conversation starters for health queries.
 *
 * Provides 5 prompts that guide users toward the most valuable health
 * conversations. Prompts are static message templates that reference
 * tools and resources for the AI client to resolve.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Prompt definitions
// ---------------------------------------------------------------------------

/**
 * Register all MCP prompts on the server.
 */
export function registerPrompts(server: McpServer): void {
  // -------------------------------------------------------------------------
  // Prompt 1: weekly_health_review
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "weekly_health_review",
    {
      description:
        "Comprehensive review of recovery, sleep, and workouts from a specified number of days. Provides insights into overall health trends.",
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe("Number of days to review (default: 7)"),
      },
    },
    (args) => {
      const days = args.days ?? "7";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Please provide a comprehensive health review for the past ${days} days. ` +
                `Use the following tools to gather data:\n\n` +
                `1. **get_recovery_collection** — Fetch recovery scores (HRV, resting heart rate, recovery score) for the past ${days} days\n` +
                `2. **get_sleep_collection** — Fetch sleep records (duration, performance, efficiency) for the past ${days} days\n` +
                `3. **get_workout_collection** — Fetch workout data (strain, sport type, calories) for the past ${days} days\n` +
                `4. **get_weekly_summary** — Get a pre-computed summary with averages and trends\n\n` +
                `Analyze the data and provide:\n` +
                `- Overall recovery trend (improving, declining, stable)\n` +
                `- Sleep quality assessment and patterns\n` +
                `- Training load and strain summary\n` +
                `- Actionable recommendations based on the data`,
            },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Prompt 2: sleep_analysis
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "sleep_analysis",
    {
      description:
        "Analyze recent sleep patterns and quality — identifies trends in duration, performance, and efficiency.",
    },
    () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Analyze my recent sleep patterns and quality. ` +
                `Use the following tools:\n\n` +
                `1. **get_sleep_collection** — Fetch sleep records for the past 14 days\n` +
                `2. **get_trend** with metric "sleep_duration" — Analyze sleep duration trend\n` +
                `3. **get_trend** with metric "sleep_performance" — Analyze sleep performance trend\n\n` +
                `Provide insights on:\n` +
                `- Average sleep duration vs recommended (7-9 hours)\n` +
                `- Sleep performance and efficiency patterns\n` +
                `- Any anomalies or concerning trends\n` +
                `- Tips for improving sleep based on the data`,
            },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Prompt 3: recovery_trend
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "recovery_trend",
    {
      description:
        "Analyze how recovery is trending — tracks HRV, resting heart rate, and recovery score over time.",
    },
    () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `How is my recovery trending? ` +
                `Use the following tools to analyze:\n\n` +
                `1. **get_trend** with metric "recovery" — Overall recovery score trend (30 days)\n` +
                `2. **get_trend** with metric "hrv" — HRV trend (30 days)\n` +
                `3. **get_trend** with metric "rhr" — Resting heart rate trend (30 days)\n` +
                `4. **get_recovery_collection** — Recent recovery records for context\n\n` +
                `Analyze and explain:\n` +
                `- Is recovery improving, declining, or stable?\n` +
                `- What does the HRV trend indicate about autonomic nervous system health?\n` +
                `- Are there any anomalies that need attention?\n` +
                `- How does resting heart rate correlate with recovery?`,
            },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Prompt 4: workout_recap
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "workout_recap",
    {
      description:
        "Summarize recent workouts and strain — shows training volume, sport breakdown, and strain patterns.",
    },
    () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Summarize my recent workouts and training strain. ` +
                `Use the following tools:\n\n` +
                `1. **get_workout_collection** — Fetch recent workouts (past 14 days)\n` +
                `2. **get_cycle_collection** — Fetch physiological cycles for strain data\n` +
                `3. **get_trend** with metric "strain" — Analyze strain trend\n\n` +
                `Provide a recap including:\n` +
                `- Total workouts and sport type breakdown\n` +
                `- Total and average strain levels\n` +
                `- Strain trend (increasing/decreasing/stable)\n` +
                `- Whether current training load is sustainable based on recovery data`,
            },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Prompt 5: health_check
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "health_check",
    {
      description:
        "Quick health status check — uses cached resource data for an instant snapshot of current recovery, sleep, and strain.",
    },
    () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Give me a quick health status check. ` +
                `Use the following MCP resources for instant data (no tool calls needed for these):\n\n` +
                `1. **resource: whoop://v2/user/recovery/latest** — Current recovery score, HRV, resting heart rate\n` +
                `2. **resource: whoop://v2/user/sleep/latest** — Most recent sleep record\n` +
                `3. **resource: whoop://v2/user/cycle/latest** — Current strain and cycle data\n\n` +
                `Provide a brief status update:\n` +
                `- Current recovery level (green/yellow/red) and what it means\n` +
                `- Last night's sleep quality\n` +
                `- Today's strain so far\n` +
                `- One actionable recommendation for today`,
            },
          },
        ],
      };
    }
  );
}
