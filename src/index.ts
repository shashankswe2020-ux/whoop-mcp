#!/usr/bin/env node

/**
 * WHOOP MCP Server entry point.
 *
 * Reads OAuth credentials and transport configuration from environment
 * variables, authenticates with WHOOP, creates the API client (with
 * automatic token refresh), builds the MCP server, and connects it to
 * the configured transport(s).
 *
 * Supported transports (via `MCP_TRANSPORT`):
 *   stdio  — local Claude Desktop / Claude Code (default)
 *   http   — remote HTTP transport (claude.ai, Cursor, custom integrations)
 *   both   — stdio AND HTTP simultaneously
 *
 * All logging goes to stderr — stdout is reserved for the MCP stdio channel.
 */

import { authenticate, refreshAccessToken, toOAuthTokens } from "./auth/oauth.js";
import type { OAuthConfig } from "./auth/oauth.js";
import { loadTokens, saveTokens } from "./auth/token-store.js";
import { createWhoopClient } from "./api/client.js";
import { createWhoopServer } from "./server.js";
import { connectStdioTransport } from "./transport/stdio.js";
import { createHttpServer, type HttpServerResult } from "./transport/http.js";
import { createLogger, type LogLevel, type Logger } from "./logging/logger.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportMode = "stdio" | "http" | "both";

// ---------------------------------------------------------------------------
// Env parsing helpers
// ---------------------------------------------------------------------------

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}.\n` +
        `Set it in your Claude Desktop config or shell environment.\n` +
        `See: https://github.com/shashankswe2020-ux/whoop-mcp#configuration`
    );
  }
  return value;
}

function parseTransport(): TransportMode {
  const raw = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase().trim();
  if (raw === "stdio" || raw === "http" || raw === "both") {
    return raw;
  }
  throw new Error(
    `Invalid MCP_TRANSPORT: "${process.env.MCP_TRANSPORT}". ` + `Must be one of: stdio, http, both.`
  );
}

function parsePort(): number {
  const raw = process.env.MCP_PORT ?? "3000";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid MCP_PORT: "${raw}". Must be an integer 0-65535.`);
  }
  return n;
}

function parseLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase().trim();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  throw new Error(
    `Invalid LOG_LEVEL: "${process.env.LOG_LEVEL}". ` + `Must be one of: debug, info, warn, error.`
  );
}

function parseLogFormat(): "json" | "pretty" {
  const raw = (process.env.LOG_FORMAT ?? "json").toLowerCase().trim();
  if (raw === "json" || raw === "pretty") return raw;
  throw new Error(`Invalid LOG_FORMAT: "${process.env.LOG_FORMAT}". Must be one of: json, pretty.`);
}

function parseAllowedOrigins(): string[] {
  const raw = process.env.MCP_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // 1. Parse transport + logging configuration
  const transportMode = parseTransport();
  const logger: Logger = createLogger({
    level: parseLogLevel(),
    format: parseLogFormat(),
  });

  // 2. Read WHOOP OAuth credentials (always required)
  const clientId = getRequiredEnv("WHOOP_CLIENT_ID");
  const clientSecret = getRequiredEnv("WHOOP_CLIENT_SECRET");
  const oauthConfig: OAuthConfig = { clientId, clientSecret };

  // 3. Authenticate with WHOOP — uses cached tokens, refreshes, or runs full flow
  console.error("Authenticating with WHOOP...");
  const accessToken = await authenticate(oauthConfig);
  console.error("Authentication successful.");
  logger.info("whoop authentication complete");

  // 4. Create the WHOOP API client with automatic token refresh.
  let resourceCacheRef: { invalidateAll(): void } | null = null;

  const onTokenRefresh = async (): Promise<string> => {
    const tokens = await loadTokens();
    if (!tokens) {
      throw new Error(
        "Token refresh failed: no stored tokens found. Re-authentication may be required."
      );
    }

    const refreshed = await refreshAccessToken(tokens.refresh_token, oauthConfig);
    const newTokens = toOAuthTokens(refreshed, tokens.refresh_token);
    await saveTokens(newTokens);

    resourceCacheRef?.invalidateAll();
    logger.info("whoop token refreshed");

    return newTokens.access_token;
  };

  const client = createWhoopClient({ accessToken, onTokenRefresh, logger });

  // 5. Create the MCP server with all WHOOP tools and resources
  const disableResources = process.env.WHOOP_MCP_DISABLE_RESOURCES === "1";
  const { server, resourceCache } = createWhoopServer(client, { disableResources });
  resourceCacheRef = resourceCache;

  // 6. Connect transports based on MCP_TRANSPORT mode
  const httpResults: HttpServerResult[] = [];
  let oauthCloseFn: (() => void) | null = null;

  if (transportMode === "stdio" || transportMode === "both") {
    await connectStdioTransport(server);
  }

  if (transportMode === "http" || transportMode === "both") {
    const authToken = getRequiredEnv("MCP_AUTH_TOKEN");
    const port = parsePort();
    const host = process.env.MCP_HOST ?? "0.0.0.0";
    const allowedOrigins = parseAllowedOrigins();
    const trustProxy = process.env.MCP_TRUST_PROXY === "1";

    // Lightweight upstream WHOOP health probe used by GET /health (authed).
    const healthCheck = async (): Promise<boolean> => {
      try {
        await client.get("/v2/user/profile/basic");
        return true;
      } catch {
        return false;
      }
    };

    // Optional OAuth 2.1 connector — mounted on the same HTTP port if all
    // required env vars are set. Letting any required var be missing simply
    // disables the connector (keeps stdio/http parity for local dev).
    let oauthHandler:
      | ((
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse
        ) => void)
      | undefined;
    const connectorPassword = process.env.MCP_CONNECTOR_PASSWORD;
    const publicUrl = process.env.PUBLIC_URL;
    const allowedRedirectUris = process.env.ALLOWED_REDIRECT_URIS;

    if (connectorPassword && publicUrl && allowedRedirectUris) {
      const { createOAuthApp } = await import("./transport/oauth-connector.js");
      const { deriveJwtSecret, parseAllowedRedirectUris } =
        await import("./transport/oauth-helpers.js");
      const jwtSecretEnv = process.env.MCP_JWT_SECRET;
      const jwtSecret = jwtSecretEnv
        ? Buffer.from(jwtSecretEnv, "utf-8")
        : await deriveJwtSecret(authToken);
      const oauthApp = createOAuthApp({
        connectorPassword,
        publicUrl,
        allowedRedirectUris: parseAllowedRedirectUris(allowedRedirectUris),
        jwtSecret,
        scopes: ["mcp"],
        client: {
          clientId: process.env.MCP_OAUTH_CLIENT_ID ?? "whoop-mcp-connector",
          clientName: "WHOOP MCP Connector",
          redirectUris: parseAllowedRedirectUris(allowedRedirectUris),
        },
        trustProxy: trustProxy ? 1 : false,
      });
      oauthHandler = oauthApp.app as unknown as (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse
      ) => void;
      oauthCloseFn = oauthApp.close;
      logger.info("oauth connector mounted", { publicUrl });
    }

    const httpResult = await createHttpServer({
      authToken,
      port,
      host,
      allowedOrigins,
      trustProxy,
      healthCheck,
      oauthHandler,
    });
    await server.connect(httpResult.transport);
    httpResults.push(httpResult);

    logger.info("http transport listening", {
      port,
      host,
      allowedOriginsCount: allowedOrigins.length,
      oauthMounted: oauthHandler !== undefined,
    });
  }

  // 7. Graceful shutdown — close HTTP servers on SIGTERM/SIGINT
  if (httpResults.length > 0) {
    const shutdown = async (): Promise<void> => {
      logger.info("shutting down");
      if (oauthCloseFn) {
        try {
          oauthCloseFn();
        } catch {
          /* ignore */
        }
      }
      for (const r of httpResults) {
        try {
          await r.close();
        } catch (err) {
          logger.error("error closing http server", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
  }

  // Existing tests assert this exact log line — keep it unchanged for compat
  console.error("WHOOP MCP server started on stdio.");
  logger.info("whoop mcp server started", { transport: transportMode });
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
  const subcommand = process.argv[2];

  if (subcommand === "setup") {
    // Lazy-load so the setup CLI's deps aren't pulled into the hot stdio path.
    void (async (): Promise<void> => {
      try {
        const { runSetup, parseSetupArgs } = await import("./cli/setup.js");
        const opts = parseSetupArgs(process.argv.slice(3));
        await runSetup(opts);
      } catch (error: unknown) {
        console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    })();
  } else {
    main().catch((error: unknown) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
  }
}
