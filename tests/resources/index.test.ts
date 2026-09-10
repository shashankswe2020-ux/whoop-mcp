import { describe, it, expect, vi } from "vitest";
import {
  RESOURCE_DEFINITIONS,
  registerResources,
  DYNAMIC_TTL_MS,
  CYCLE_TTL_MS,
  PROFILE_TTL_MS,
} from "../../src/resources/index.js";
import type { WhoopClient } from "../../src/api/client.js";

// ---------------------------------------------------------------------------
// RESOURCE_DEFINITIONS tests
// ---------------------------------------------------------------------------

describe("RESOURCE_DEFINITIONS", () => {
  it("defines exactly 4 resources", () => {
    expect(RESOURCE_DEFINITIONS).toHaveLength(4);
  });

  it("all resources have required fields", () => {
    for (const def of RESOURCE_DEFINITIONS) {
      expect(def.uri).toMatch(/^whoop:\/\//);
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.mimeType).toBe("application/json");
      expect(def.ttlMs).toBeGreaterThan(0);
      expect(typeof def.fetch).toBe("function");
    }
  });

  it("recovery and sleep resources use 5-minute TTL", () => {
    const fiveMinResources = RESOURCE_DEFINITIONS.filter(
      (d) => d.uri === "whoop://v2/user/recovery/latest" || d.uri === "whoop://v2/user/sleep/latest"
    );
    expect(fiveMinResources).toHaveLength(2);
    for (const def of fiveMinResources) {
      expect(def.ttlMs).toBe(DYNAMIC_TTL_MS);
    }
  });

  it("cycle resource uses 2-minute TTL", () => {
    const cycleDef = RESOURCE_DEFINITIONS.find((d) => d.uri === "whoop://v2/user/cycle/latest");
    expect(cycleDef).toBeDefined();
    expect(cycleDef!.ttlMs).toBe(CYCLE_TTL_MS);
  });

  it("profile resource uses 1-hour TTL", () => {
    const profileDef = RESOURCE_DEFINITIONS.find((d) => d.uri === "whoop://v2/user/profile");
    expect(profileDef).toBeDefined();
    expect(profileDef!.ttlMs).toBe(PROFILE_TTL_MS);
  });

  describe("recovery latest fetcher", () => {
    const def = RESOURCE_DEFINITIONS.find((d) => d.uri === "whoop://v2/user/recovery/latest")!;

    it("returns first record from recovery endpoint", async () => {
      const mockClient: WhoopClient = {
        get: vi.fn().mockResolvedValue({ records: [{ recovery_score: 85 }] }),
      };

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ recovery_score: 85 });
      expect(mockClient.get).toHaveBeenCalledWith("/v2/recovery?limit=1", {
        cache: true,
        ttlMs: DYNAMIC_TTL_MS,
      });
    });

    it("returns empty message when no records", async () => {
      const mockClient: WhoopClient = {
        get: vi.fn().mockResolvedValue({ records: [] }),
      };

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ message: "No recovery data available." });
    });
  });

  describe("sleep latest fetcher", () => {
    const def = RESOURCE_DEFINITIONS.find((d) => d.uri === "whoop://v2/user/sleep/latest")!;

    it("returns first record from sleep endpoint", async () => {
      const mockClient: WhoopClient = {
        get: vi.fn().mockResolvedValue({ records: [{ id: "sleep-1" }] }),
      };

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ id: "sleep-1" });
      expect(mockClient.get).toHaveBeenCalledWith("/v2/activity/sleep?limit=1", {
        cache: true,
        ttlMs: DYNAMIC_TTL_MS,
      });
    });

    it("returns empty message when no records", async () => {
      const mockClient: WhoopClient = {
        get: vi.fn().mockResolvedValue({ records: [] }),
      };

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ message: "No sleep data available." });
    });
  });

  describe("cycle latest fetcher", () => {
    const def = RESOURCE_DEFINITIONS.find((d) => d.uri === "whoop://v2/user/cycle/latest")!;

    it("returns first record from cycle endpoint", async () => {
      const mockClient: WhoopClient = {
        get: vi.fn().mockResolvedValue({ records: [{ id: 200 }] }),
      };

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ id: 200 });
      expect(mockClient.get).toHaveBeenCalledWith("/v2/cycle?limit=1", {
        cache: true,
        ttlMs: CYCLE_TTL_MS,
      });
    });

    it("returns empty message when no records", async () => {
      const mockClient: WhoopClient = {
        get: vi.fn().mockResolvedValue({ records: [] }),
      };

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ message: "No cycle data available." });
    });
  });

  describe("profile fetcher", () => {
    const def = RESOURCE_DEFINITIONS.find((d) => d.uri === "whoop://v2/user/profile")!;

    it("returns profile from profile endpoint", async () => {
      const mockClient: WhoopClient = {
        get: vi.fn().mockResolvedValue({ first_name: "Jane" }),
      };

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ first_name: "Jane" });
      expect(mockClient.get).toHaveBeenCalledWith("/v2/user/profile/basic", {
        cache: true,
        ttlMs: PROFILE_TTL_MS,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// registerResources tests
// ---------------------------------------------------------------------------

describe("registerResources", () => {
  it("registers 4 resources on the server", () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = { get: vi.fn().mockResolvedValue({}) };

    registerResources(mockServer, mockClient);

    expect(mockServer.registerResource).toHaveBeenCalledTimes(4);
  });

  it("registers resources with correct URIs and metadata", () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = { get: vi.fn().mockResolvedValue({}) };

    registerResources(mockServer, mockClient);

    const calls = mockServer.registerResource.mock.calls;
    const uris = calls.map((c: unknown[]) => c[1]);

    expect(uris).toContain("whoop://v2/user/recovery/latest");
    expect(uris).toContain("whoop://v2/user/sleep/latest");
    expect(uris).toContain("whoop://v2/user/cycle/latest");
    expect(uris).toContain("whoop://v2/user/profile");
  });

  it("resource read callback returns JSON content", async () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = {
      get: vi.fn().mockResolvedValue({ records: [{ recovery_score: 85 }] }),
    };

    registerResources(mockServer, mockClient);

    // Get the callback for recovery resource
    const recoveryCall = mockServer.registerResource.mock.calls.find(
      (c: unknown[]) => c[1] === "whoop://v2/user/recovery/latest"
    );
    expect(recoveryCall).toBeDefined();

    const callback = recoveryCall![3] as (uri: URL) => Promise<unknown>;
    const result = await callback(new URL("whoop://v2/user/recovery/latest"));

    expect(result).toEqual({
      contents: [
        {
          uri: "whoop://v2/user/recovery/latest",
          mimeType: "application/json",
          text: JSON.stringify({ recovery_score: 85 }, null, 2),
        },
      ],
    });
  });

  it("resource read callback returns error JSON on failure", async () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = {
      get: vi.fn().mockRejectedValue(new Error("API timeout")),
    };

    // Suppress stderr output during this test
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    registerResources(mockServer, mockClient);

    const recoveryCall = mockServer.registerResource.mock.calls.find(
      (c: unknown[]) => c[1] === "whoop://v2/user/recovery/latest"
    );
    const callback = recoveryCall![3] as (uri: URL) => Promise<unknown>;
    const result = await callback(new URL("whoop://v2/user/recovery/latest"));

    expect(result).toEqual({
      contents: [
        {
          uri: "whoop://v2/user/recovery/latest",
          mimeType: "application/json",
          text: JSON.stringify({
            error: "Resource unavailable. Retry later or verify authorization.",
          }),
        },
      ],
    });

    stderrSpy.mockRestore();
  });

  it("resource read logs errors to stderr", async () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = {
      get: vi.fn().mockRejectedValue(new Error("timeout")),
    };

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    registerResources(mockServer, mockClient);

    const recoveryCall = mockServer.registerResource.mock.calls.find(
      (c: unknown[]) => c[1] === "whoop://v2/user/recovery/latest"
    );
    const callback = recoveryCall![3] as (uri: URL) => Promise<unknown>;
    await callback(new URL("whoop://v2/user/recovery/latest"));

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Resource read failed"));

    stderrSpy.mockRestore();
  });
});
