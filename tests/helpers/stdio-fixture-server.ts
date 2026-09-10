import { createWhoopServer } from "../../src/server.js";
import { connectStdioTransport } from "../../src/transport/stdio.js";
import { privacyModeSchema } from "../../src/privacy.js";
import type { WhoopClient } from "../../src/api/client.js";

const client: WhoopClient = {
  get: async <Result>(): Promise<Result> => ({ records: [] }) as Result,
};
const { server } = createWhoopServer(client, {
  privacyMode: privacyModeSchema.parse(process.env.WHOOP_MCP_PRIVACY_MODE),
});
await connectStdioTransport(server);
