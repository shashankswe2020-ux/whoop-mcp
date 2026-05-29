/**
 * Tests for MCP Prompts.
 *
 * Verifies that:
 * - prompts/list returns all 5 prompts
 * - Each prompt has name, description, and argument schemas
 * - prompts/get for each prompt returns well-structured messages
 * - weekly_health_review accepts optional days argument
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhoopServer } from "../../src/server.js";
import type { WhoopClient } from "../../src/api/client.js";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("MCP Prompts", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mockWhoopClient: WhoopClient = {
      get: vi.fn().mockResolvedValue({ records: [] }),
    } as unknown as WhoopClient;

    const { server } = createWhoopServer(mockWhoopClient);
    const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    client = mcpClient;
    cleanup = async () => {
      await mcpClient.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  it("lists exactly 5 prompts", async () => {
    const result = await client.listPrompts();
    expect(result.prompts).toHaveLength(5);
  });

  it("lists prompts with correct names", async () => {
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name).sort();

    expect(names).toEqual([
      "health_check",
      "recovery_trend",
      "sleep_analysis",
      "weekly_health_review",
      "workout_recap",
    ]);
  });

  it("all prompts have descriptions", async () => {
    const result = await client.listPrompts();
    for (const prompt of result.prompts) {
      expect(prompt.description).toBeDefined();
      expect(prompt.description!.length).toBeGreaterThan(10);
    }
  });

  it("weekly_health_review has optional days argument", async () => {
    const result = await client.listPrompts();
    const prompt = result.prompts.find((p) => p.name === "weekly_health_review");
    expect(prompt).toBeDefined();
    expect(prompt!.arguments).toBeDefined();
    expect(prompt!.arguments!.some((a) => a.name === "days")).toBe(true);
  });

  it("prompts/get for weekly_health_review returns messages", async () => {
    const result = await client.getPrompt({ name: "weekly_health_review", arguments: {} });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]!.role).toBe("user");
  });

  it("prompts/get for weekly_health_review with days argument returns messages", async () => {
    const result = await client.getPrompt({ name: "weekly_health_review", arguments: { days: "14" } });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    // Messages should reference the days value
    const text = JSON.stringify(result.messages);
    expect(text).toContain("14");
  });

  it("prompts/get for sleep_analysis returns messages", async () => {
    const result = await client.getPrompt({ name: "sleep_analysis" });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]!.role).toBe("user");
  });

  it("prompts/get for recovery_trend returns messages", async () => {
    const result = await client.getPrompt({ name: "recovery_trend" });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]!.role).toBe("user");
  });

  it("prompts/get for workout_recap returns messages", async () => {
    const result = await client.getPrompt({ name: "workout_recap" });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]!.role).toBe("user");
  });

  it("prompts/get for health_check returns messages referencing resources", async () => {
    const result = await client.getPrompt({ name: "health_check" });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    const text = JSON.stringify(result.messages);
    expect(text).toContain("resource");
  });

  it("prompt messages contain relevant tool/resource references", async () => {
    const result = await client.getPrompt({ name: "weekly_health_review", arguments: {} });
    const text = JSON.stringify(result.messages);
    // Should mention recovery, sleep, or workout tools
    expect(text).toMatch(/recovery|sleep|workout/i);
  });
});
