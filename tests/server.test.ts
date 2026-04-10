import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhoopServer } from "../src/server.js";
import type { WhoopClient } from "../src/api/client.js";
import {
  WhoopApiError,
  WhoopNetworkError,
  WhoopAuthError,
} from "../src/api/client.js";
import type {
  UserProfile,
  BodyMeasurement,
  RecoveryCollection,
  SleepCollection,
  WorkoutCollection,
  CycleCollection,
} from "../src/api/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE_FIXTURE: UserProfile = {
  user_id: 12345,
  email: "jane@example.com",
  first_name: "Jane",
  last_name: "Doe",
};

const BODY_MEASUREMENT_FIXTURE: BodyMeasurement = {
  height_meter: 1.78,
  weight_kilogram: 75.5,
  max_heart_rate: 195,
};

const RECOVERY_FIXTURE: RecoveryCollection = {
  records: [
    {
      cycle_id: 100,
      sleep_id: "sleep-1",
      user_id: 12345,
      created_at: "2026-04-10T08:00:00.000Z",
      updated_at: "2026-04-10T08:30:00.000Z",
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 85,
        resting_heart_rate: 52,
        hrv_rmssd_milli: 65.3,
        spo2_percentage: 97.5,
        skin_temp_celsius: 33.2,
      },
    },
  ],
};

const SLEEP_FIXTURE: SleepCollection = {
  records: [
    {
      id: "sleep-1",
      cycle_id: 100,
      user_id: 12345,
      created_at: "2026-04-10T06:00:00.000Z",
      updated_at: "2026-04-10T06:30:00.000Z",
      start: "2026-04-09T23:00:00.000Z",
      end: "2026-04-10T06:00:00.000Z",
      timezone_offset: "-04:00",
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 25200000,
          total_awake_time_milli: 1800000,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 9000000,
          total_slow_wave_sleep_time_milli: 7200000,
          total_rem_sleep_time_milli: 7200000,
          sleep_cycle_count: 4,
          disturbance_count: 2,
        },
        sleep_needed: {
          baseline_milli: 28800000,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 1800000,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15.2,
        sleep_performance_percentage: 92,
        sleep_consistency_percentage: 85,
        sleep_efficiency_percentage: 93,
      },
    },
  ],
};

const WORKOUT_FIXTURE: WorkoutCollection = {
  records: [
    {
      id: "workout-1",
      user_id: 12345,
      created_at: "2026-04-10T18:00:00.000Z",
      updated_at: "2026-04-10T19:00:00.000Z",
      start: "2026-04-10T17:00:00.000Z",
      end: "2026-04-10T18:00:00.000Z",
      timezone_offset: "-04:00",
      sport_name: "Running",
      score_state: "SCORED",
      score: {
        strain: 14.2,
        average_heart_rate: 155,
        max_heart_rate: 182,
        kilojoule: 2100,
        percent_recorded: 100,
        zone_durations: {
          zone_zero_milli: 0,
          zone_one_milli: 120000,
          zone_two_milli: 600000,
          zone_three_milli: 1200000,
          zone_four_milli: 900000,
          zone_five_milli: 180000,
        },
        distance_meter: 8500,
        altitude_gain_meter: 45,
        altitude_change_meter: 2,
      },
    },
  ],
};

const CYCLE_FIXTURE: CycleCollection = {
  records: [
    {
      id: 200,
      user_id: 12345,
      created_at: "2026-04-10T00:00:00.000Z",
      updated_at: "2026-04-10T23:59:59.000Z",
      start: "2026-04-10T00:00:00.000Z",
      end: "2026-04-10T23:59:59.000Z",
      timezone_offset: "-04:00",
      score_state: "SCORED",
      score: {
        strain: 12.5,
        kilojoule: 9500,
        average_heart_rate: 68,
        max_heart_rate: 182,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Endpoint-to-fixture mapping for the mock client */
const ENDPOINT_FIXTURES: Record<string, unknown> = {
  "/v2/user/profile/basic": PROFILE_FIXTURE,
  "/v2/user/measurement/body": BODY_MEASUREMENT_FIXTURE,
  "/v2/recovery": RECOVERY_FIXTURE,
  "/v2/activity/sleep": SLEEP_FIXTURE,
  "/v2/activity/workout": WORKOUT_FIXTURE,
  "/v2/cycle": CYCLE_FIXTURE,
};

/** Mock WhoopClient that returns fixture data based on the endpoint path */
function createMockClient(): WhoopClient {
  return {
    get: async <T>(path: string): Promise<T> => {
      // Strip query string to match base endpoint
      const basePath = path.split("?")[0];
      const fixture = ENDPOINT_FIXTURES[basePath];
      if (!fixture) {
        throw new Error(`Mock client: unexpected endpoint ${path}`);
      }
      return fixture as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createWhoopServer", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mockWhoopClient = createMockClient();
    const server = createWhoopServer(mockWhoopClient);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // Tool listing
  // -------------------------------------------------------------------------

  describe("tools/list", () => {
    it("returns exactly 6 tools", async () => {
      const result = await client.listTools();

      expect(result.tools).toHaveLength(6);
    });

    it("returns tools with the correct names", async () => {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();

      expect(names).toEqual([
        "get_body_measurement",
        "get_cycle_collection",
        "get_profile",
        "get_recovery_collection",
        "get_sleep_collection",
        "get_workout_collection",
      ]);
    });

    it("every tool has a description", async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.description).toBe("string");
      }
    });

    it("every tool has readOnlyHint annotation", async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Input schemas — singleton tools (no params)
  // -------------------------------------------------------------------------

  describe("get_profile schema", () => {
    it("has an object input schema with no required properties", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_profile");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.type).toBe("object");
    });
  });

  describe("get_body_measurement schema", () => {
    it("has an object input schema with no required properties", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_body_measurement");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.type).toBe("object");
    });
  });

  // -------------------------------------------------------------------------
  // Input schemas — collection tools (start, end, limit, nextToken)
  // -------------------------------------------------------------------------

  const collectionTools = [
    "get_recovery_collection",
    "get_sleep_collection",
    "get_workout_collection",
    "get_cycle_collection",
  ];

  for (const toolName of collectionTools) {
    describe(`${toolName} schema`, () => {
      it("has start, end, limit, and nextToken properties", async () => {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === toolName);

        expect(tool).toBeDefined();
        expect(tool!.inputSchema.type).toBe("object");

        const props = tool!.inputSchema.properties as Record<
          string,
          unknown
        >;
        expect(props).toHaveProperty("start");
        expect(props).toHaveProperty("end");
        expect(props).toHaveProperty("limit");
        expect(props).toHaveProperty("nextToken");
      });
    });
  }

  // -------------------------------------------------------------------------
  // Tool handler behavior (real implementations)
  // -------------------------------------------------------------------------

  describe("tool handlers", () => {
    it("get_profile returns user profile as JSON text", async () => {
      const result = await client.callTool({
        name: "get_profile",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as unknown;
      expect(parsed).toEqual(PROFILE_FIXTURE);
    });

    it("get_body_measurement returns body measurement as JSON text", async () => {
      const result = await client.callTool({
        name: "get_body_measurement",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as unknown;
      expect(parsed).toEqual(BODY_MEASUREMENT_FIXTURE);
    });

    it("get_recovery_collection returns recovery data as JSON text", async () => {
      const result = await client.callTool({
        name: "get_recovery_collection",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as unknown;
      expect(parsed).toEqual(RECOVERY_FIXTURE);
    });

    it("get_sleep_collection returns sleep data as JSON text", async () => {
      const result = await client.callTool({
        name: "get_sleep_collection",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as unknown;
      expect(parsed).toEqual(SLEEP_FIXTURE);
    });

    it("get_workout_collection returns workout data as JSON text", async () => {
      const result = await client.callTool({
        name: "get_workout_collection",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as unknown;
      expect(parsed).toEqual(WORKOUT_FIXTURE);
    });

    it("get_cycle_collection returns cycle data as JSON text", async () => {
      const result = await client.callTool({
        name: "get_cycle_collection",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as unknown;
      expect(parsed).toEqual(CYCLE_FIXTURE);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 8d: Tool-level error handling
// ---------------------------------------------------------------------------

describe("createWhoopServer (error handling)", () => {
  /**
   * Helper to create a test setup where the mock client throws the given error.
   * Returns a connected MCP Client and a cleanup function.
   */
  async function createErrorServer(
    error: Error,
  ): Promise<{ client: Client; cleanup: () => Promise<void> }> {
    const errorClient: WhoopClient = {
      get: async <T>(): Promise<T> => {
        throw error;
      },
    };
    const server = createWhoopServer(errorClient);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "error-test-client", version: "1.0.0" });
    await Promise.all([
      mcpClient.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    return {
      client: mcpClient,
      cleanup: async () => {
        await mcpClient.close();
        await server.close();
      },
    };
  }

  it("returns isError with message for WhoopApiError", async () => {
    const apiError = new WhoopApiError(403, "Forbidden", { message: "No access" });
    const { client: errClient, cleanup } = await createErrorServer(apiError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("403");
      expect(content[0].text).toContain("Forbidden");
      expect(content[0].text).toContain("WHOOP API returned");
    } finally {
      await cleanup();
    }
  });

  it("returns isError with network message for WhoopNetworkError", async () => {
    const netError = new WhoopNetworkError(new TypeError("fetch failed"));
    const { client: errClient, cleanup } = await createErrorServer(netError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("Network error");
    } finally {
      await cleanup();
    }
  });

  it("returns isError with auth message for WhoopAuthError", async () => {
    const authError = new WhoopAuthError(new Error("token expired"));
    const { client: errClient, cleanup } = await createErrorServer(authError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("Authentication error");
    } finally {
      await cleanup();
    }
  });

  it("returns isError with generic message for unknown errors", async () => {
    const unknownError = new Error("Something went wrong");
    const { client: errClient, cleanup } = await createErrorServer(unknownError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("Unexpected error");
      expect(content[0].text).toContain("Something went wrong");
    } finally {
      await cleanup();
    }
  });

  it("error handling works for collection tools too", async () => {
    const apiError = new WhoopApiError(500, "Internal Server Error", null);
    const { client: errClient, cleanup } = await createErrorServer(apiError);

    try {
      const result = await errClient.callTool({
        name: "get_recovery_collection",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("500");
    } finally {
      await cleanup();
    }
  });
});
