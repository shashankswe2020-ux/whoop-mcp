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
import type { WhoopClient, WhoopGetOptions } from "./api/client.js";
import { MemoryCache } from "./cache/memory-cache.js";
import { createWhoopServer } from "./server.js";
import { connectStdioTransport } from "./transport/stdio.js";
import { createHttpServer, type HttpServerResult } from "./transport/http.js";
import { createLogger, type LogLevel, type Logger } from "./logging/logger.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { privacyModeSchema } from "./privacy.js";
import { createTelemetry, type Telemetry } from "./telemetry/telemetry.js";

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

export async function main(telemetry?: Telemetry): Promise<void> {
  const privacyMode = privacyModeSchema.parse(process.env.WHOOP_MCP_PRIVACY_MODE ?? "standard");
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

  // 3. Create a deferred WHOOP API client with automatic token refresh.
  // Authentication starts on the first WHOOP request so MCP initialization and
  // tool discovery are never blocked by an interactive browser flow.
  // A single process-wide cache is shared by the client (opt-in per request)
  // and the MCP resources; it is cleared whenever tokens are refreshed.
  const cache = new MemoryCache();

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

    cache.clear();
    logger.info("whoop token refreshed");

    return newTokens.access_token;
  };

  let authenticatedClientPromise: Promise<WhoopClient> | undefined;
  const getAuthenticatedClient = (): Promise<WhoopClient> => {
    authenticatedClientPromise ??= (async () => {
      console.error("Authenticating with WHOOP...");
      const accessToken = await authenticate(oauthConfig);
      console.error("Authentication successful.");
      logger.info("whoop authentication complete");
      return createWhoopClient({ accessToken, onTokenRefresh, logger, cache });
    })();
    return authenticatedClientPromise;
  };

  const client: WhoopClient = {
    async get<T>(path: string, options?: WhoopGetOptions): Promise<T> {
      const authenticatedClient = await getAuthenticatedClient();
      return authenticatedClient.get<T>(path, options);
    },
  };

  // 4. Create the MCP server with all WHOOP tools and resources
  const disableResources = process.env.WHOOP_MCP_DISABLE_RESOURCES === "1";
  const { server } = createWhoopServer(client, {
    disableResources,
    privacyMode,
    ...(telemetry?.status.enabled ? { telemetry } : {}),
    // Local race logs and write tools only when no remote client can reach this server.
    ...(transportMode === "stdio" ? { localPerformance: {} } : {}),
  });

  // 5. Connect transports based on MCP_TRANSPORT mode
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
    let verifyBearerToken:
      | ((
          token: string
        ) => Promise<import("@modelcontextprotocol/sdk/server/auth/types.js").AuthInfo>)
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
      verifyBearerToken = (token: string) => oauthApp.provider.verifyAccessToken(token);
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
      verifyBearerToken,
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

  // 6. Graceful shutdown — close HTTP servers on SIGTERM/SIGINT
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

export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  const subcommand = args[0];
  if (subcommand === "doctor") {
    try {
      const { runDoctor } = await import("./cli/doctor.js");
      return await runDoctor(args.slice(1));
    } catch {
      console.error("Local diagnostics failed.");
      return 1;
    }
  }

  let telemetry = createTelemetry(
    subcommand === "setup" ? { WHOOP_MCP_TELEMETRY: "0" } : process.env
  );
  if (subcommand === "telemetry") {
    if (args.length !== 2 || args[1] !== "status") {
      console.error("Usage: whoop-ai-mcp telemetry status");
      return 1;
    }
    process.stdout.write(`${JSON.stringify(telemetry.status)}\n`);
    return 0;
  }

  const name = subcommand === "setup" ? "setup" : "serve";
  let outcome: "success" | "error" = "error";
  try {
    if (name === "setup") {
      const { runSetup, parseSetupArgs } = await import("./cli/setup.js");
      const consent = await runSetup(parseSetupArgs(args.slice(1)));
      telemetry = createTelemetry({ ...process.env, WHOOP_MCP_TELEMETRY: "0", ...consent });
    } else {
      await main(telemetry);
    }
    outcome = "success";
    return 0;
  } catch (error: unknown) {
    if (name === "setup") {
      console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
    } else console.error("Fatal error:", error);
    return 1;
  } finally {
    telemetry.record({ kind: "command", name, outcome });
    await telemetry.flush();
  }
}

if (isMainModule()) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
    if (exitCode !== 0 && process.argv[2] !== "doctor" && process.argv[2] !== "telemetry") {
      process.exit(exitCode);
    }
  });
}
