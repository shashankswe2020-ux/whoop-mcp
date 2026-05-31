import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ResourceCache,
  RESOURCE_DEFINITIONS,
  registerResources,
  DYNAMIC_TTL_MS,
  PROFILE_TTL_MS,
} from "../../src/resources/index.js";
import type { WhoopClient } from "../../src/api/client.js";

// ---------------------------------------------------------------------------
// ResourceCache unit tests
// ---------------------------------------------------------------------------

describe("ResourceCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns fetched data on cache miss", async () => {
    const cache = new ResourceCache();
    const fetcher = vi.fn().mockResolvedValue({ score: 85 });

    const result = await cache.getOrFetch("key1", 5000, fetcher);

    expect(result).toEqual({ score: 85 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns cached data within TTL without calling fetcher", async () => {
    const cache = new ResourceCache();
    const fetcher = vi.fn().mockResolvedValue({ score: 85 });

    await cache.getOrFetch("key1", 5000, fetcher);
    const result = await cache.getOrFetch("key1", 5000, fetcher);

    expect(result).toEqual({ score: 85 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const cache = new ResourceCache();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ score: 85 })
      .mockResolvedValueOnce({ score: 90 });

    await cache.getOrFetch("key1", 5000, fetcher);
    vi.advanceTimersByTime(5001);
    const result = await cache.getOrFetch("key1", 5000, fetcher);

    expect(result).toEqual({ score: 90 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent in-flight requests", async () => {
    const cache = new ResourceCache();
    let resolvePromise: (val: unknown) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
    );

    const p1 = cache.getOrFetch("key1", 5000, fetcher);
    const p2 = cache.getOrFetch("key1", 5000, fetcher);

    // Both should share the same in-flight request
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolvePromise!({ score: 85 });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual({ score: 85 });
    expect(r2).toEqual({ score: 85 });
  });

  it("invalidateAll clears cached data", async () => {
    const cache = new ResourceCache();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ score: 85 })
      .mockResolvedValueOnce({ score: 90 });

    await cache.getOrFetch("key1", 5000, fetcher);
    cache.invalidateAll();
    const result = await cache.getOrFetch("key1", 5000, fetcher);

    expect(result).toEqual({ score: 90 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidateAll prevents stale in-flight requests from repopulating cache", async () => {
    const cache = new ResourceCache();
    let resolveFirst: (val: unknown) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ score: 99 });

    // Start a fetch
    const p1 = cache.getOrFetch("key1", 5000, fetcher);

    // Invalidate while fetch is in-flight
    cache.invalidateAll();

    // Resolve the original fetch — it should NOT cache because generation changed
    resolveFirst!({ score: 85 });
    await p1;

    // Next fetch should call fetcher again (cache was not repopulated)
    const result = await cache.getOrFetch("key1", 5000, fetcher);
    expect(result).toEqual({ score: 99 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("propagates fetcher errors and cleans up inflight", async () => {
    const cache = new ResourceCache();
    const fetcher = vi.fn().mockRejectedValue(new Error("network fail"));

    await expect(cache.getOrFetch("key1", 5000, fetcher)).rejects.toThrow("network fail");

    // After error, inflight should be cleared — next call retries
    fetcher.mockResolvedValue({ score: 85 });
    const result = await cache.getOrFetch("key1", 5000, fetcher);
    expect(result).toEqual({ score: 85 });
  });

  it("different keys are cached independently", async () => {
    const cache = new ResourceCache();
    const fetcher1 = vi.fn().mockResolvedValue("a");
    const fetcher2 = vi.fn().mockResolvedValue("b");

    const r1 = await cache.getOrFetch("k1", 5000, fetcher1);
    const r2 = await cache.getOrFetch("k2", 5000, fetcher2);

    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(fetcher1).toHaveBeenCalledTimes(1);
    expect(fetcher2).toHaveBeenCalledTimes(1);
  });
});

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

  it("dynamic resources use 5-minute TTL", () => {
    const dynamicResources = RESOURCE_DEFINITIONS.filter(
      (d) => d.uri !== "whoop://v2/user/profile"
    );
    for (const def of dynamicResources) {
      expect(def.ttlMs).toBe(DYNAMIC_TTL_MS);
    }
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
      expect(mockClient.get).toHaveBeenCalledWith("/v2/recovery?limit=1");
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
      expect(mockClient.get).toHaveBeenCalledWith("/v2/activity/sleep?limit=1");
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
      expect(mockClient.get).toHaveBeenCalledWith("/v2/cycle?limit=1");
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
      expect(mockClient.get).toHaveBeenCalledWith("/v2/user/profile/basic");
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

  it("returns a ResourceCache instance", () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = { get: vi.fn().mockResolvedValue({}) };

    const cache = registerResources(mockServer, mockClient);

    expect(cache).toBeInstanceOf(ResourceCache);
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
          text: JSON.stringify({ error: "API timeout" }),
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
