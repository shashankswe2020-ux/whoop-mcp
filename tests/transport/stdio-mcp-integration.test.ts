import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("stdio release contracts", () => {
  it.each(["standard", "aggregate"])(
    "supports %s mode through an actual child process",
    async (mode) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "tests/helpers/stdio-fixture-server.ts"],
        env: { WHOOP_MCP_PRIVACY_MODE: mode },
        stderr: "pipe",
      });
      const client = new Client({ name: "stdio-test", version: "1" });
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools).toHaveLength(mode === "standard" ? 16 : 5);
        const result = await client.callTool({ name: "get_sleep_debt", arguments: {} });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ text: string }>;
        expect(JSON.parse(content[0]!.text)).toEqual(result.structuredContent);
        if (mode === "aggregate") {
          expect(JSON.stringify(result)).not.toContain('"nights"');
          expect((await client.callTool({ name: "get_profile", arguments: {} })).isError).toBe(
            true
          );
          await expect(client.readResource({ uri: "whoop://v2/user/profile" })).rejects.toThrow();
          await expect(client.getPrompt({ name: "health_check" })).rejects.toThrow();
        }
      } finally {
        await client.close();
        await transport.close();
      }
    },
    15_000
  );
});
