#!/usr/bin/env node

/**
 * WHOOP MCP Server entry point.
 *
 * Reads OAuth credentials from environment variables, authenticates with WHOOP,
 * creates the API client (with automatic token refresh), builds the MCP server,
 * and connects it to stdio transport for use with Claude Desktop and other
 * MCP-compatible clients.
 *
 * All logging goes to stderr — stdout is reserved for the MCP stdio channel.
 */

import { authenticate, refreshAccessToken, toOAuthTokens } from "./auth/oauth.js";
import type { OAuthConfig } from "./auth/oauth.js";
import { loadTokens, saveTokens } from "./auth/token-store.js";
import { createWhoopClient } from "./api/client.js";
import { createWhoopServer } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a required environment variable.
 * Throws a descriptive error if the variable is missing or empty.
 */
function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}.\n` +
        `Set it in your Claude Desktop config or shell environment.\n` +
        `See: https://github.com/shashankswe2020-ux/whoop-mcp#configuration`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // 1. Read credentials from environment
  const clientId = getRequiredEnv("WHOOP_CLIENT_ID");
  const clientSecret = getRequiredEnv("WHOOP_CLIENT_SECRET");

  const oauthConfig: OAuthConfig = { clientId, clientSecret };

  // 2. Authenticate — returns a valid access token
  //    (uses cached tokens, refreshes if expired, or runs full OAuth flow)
  console.error("Authenticating with WHOOP...");
  const accessToken = await authenticate(oauthConfig);
  console.error("Authentication successful.");

  // 3. Create the WHOOP API client with automatic token refresh
  const onTokenRefresh = async (): Promise<string> => {
    const tokens = await loadTokens();
    if (!tokens) {
      throw new Error(
        "Token refresh failed: no stored tokens found. Re-authentication may be required.",
      );
    }

    const refreshed = await refreshAccessToken(tokens.refresh_token, oauthConfig);
    const newTokens = toOAuthTokens(refreshed);
    await saveTokens(newTokens);

    return newTokens.access_token;
  };

  const client = createWhoopClient({ accessToken, onTokenRefresh });

  // 4. Create the MCP server with all 6 WHOOP tools
  const server = createWhoopServer(client);

  // 5. Connect to stdio transport (stdin/stdout = MCP channel)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("WHOOP MCP server started on stdio.");
}

// ---------------------------------------------------------------------------
// Auto-execute when run directly (not when imported in tests)
// ---------------------------------------------------------------------------

/**
 * Determine if this file is the Node.js entry point.
 *
 * Uses `realpathSync` to resolve symlinks — critical for `npx`, `npm link`,
 * and Claude Desktop's `{ "command": "npx" }` config, which all invoke the
 * binary through a symlink.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
