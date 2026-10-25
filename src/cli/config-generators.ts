/**
 * Pure functions for generating MCP client configuration.
 *
 * No I/O — all functions take inputs and return objects/strings. The wizard
 * (src/cli/setup.ts) handles file reads, writes, and prompting.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const CLIENT_TARGETS = [
  "claude-desktop",
  "claude-code",
  "codex",
  "copilot",
  "claude",
  "claude-web",
  "chatgpt",
  "grok",
  "perplexity",
  "gemini-cli",
  "cursor",
  "vscode",
  "openclaw",
] as const;

export type ClientTarget = (typeof CLIENT_TARGETS)[number];

export interface ServerEnv {
  readonly WHOOP_CLIENT_ID: string;
  readonly WHOOP_CLIENT_SECRET: string;
  readonly WHOOP_MCP_TELEMETRY?: string;
  readonly WHOOP_MCP_TELEMETRY_ENDPOINT?: string;
  readonly DO_NOT_TRACK?: string;
  readonly WHOOP_MCP_PRIVACY_MODE?: string;
}

export interface ClaudeDesktopServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: ServerEnv;
}

export interface ClaudeDesktopConfig {
  mcpServers?: Record<string, ClaudeDesktopServerEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

/**
 * OS-specific path to Claude Desktop's `claude_desktop_config.json`.
 *
 * - macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 * - Windows: %APPDATA%/Claude/claude_desktop_config.json
 * - Linux:   ~/.config/Claude/claude_desktop_config.json
 */
export function claudeDesktopConfigPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Claude", "claude_desktop_config.json");
    }
    default:
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const SERVER_NAME = "whoop";

/**
 * Build the server entry for Claude Desktop's `mcpServers` map.
 * Uses `npx -y whoop-ai-mcp` so users don't need a global install.
 */
export function generateClaudeDesktopEntry(env: ServerEnv): ClaudeDesktopServerEntry {
  return {
    command: "npx",
    args: ["-y", "whoop-ai-mcp"],
    env: {
      WHOOP_CLIENT_ID: env.WHOOP_CLIENT_ID,
      WHOOP_CLIENT_SECRET: env.WHOOP_CLIENT_SECRET,
      ...telemetrySettings(env),
    },
  };
}

/**
 * Merge a new whoop server entry into an existing Claude Desktop config,
 * preserving any other configured MCP servers and top-level keys.
 */
export function mergeClaudeDesktopConfig(
  existing: ClaudeDesktopConfig | null,
  entry: ClaudeDesktopServerEntry,
  serverName: string = SERVER_NAME
): ClaudeDesktopConfig {
  const base: ClaudeDesktopConfig = existing ? { ...existing } : {};
  base.mcpServers = {
    ...(base.mcpServers ?? {}),
    [serverName]: entry,
  };
  return base;
}

/**
 * Generate the `claude mcp add` shell command for Claude Code.
 * Single-quoted env values; values are validated by the wizard before reaching here.
 */
export function generateClaudeCodeCommand(env: ServerEnv): string {
  const id = shellQuote(env.WHOOP_CLIENT_ID);
  const secret = shellQuote(env.WHOOP_CLIENT_SECRET);
  const telemetry = telemetryFlags(env, "-e");
  return `claude mcp add ${SERVER_NAME} -e WHOOP_CLIENT_ID=${id} -e WHOOP_CLIENT_SECRET=${secret}${telemetry} -- npx -y whoop-ai-mcp`;
}

/**
 * Generate the `codex mcp add` shell command for the OpenAI Codex CLI.
 * Registers the server in `~/.codex/config.toml` under `[mcp_servers.whoop]`.
 * Single-quoted env values; values are validated by the wizard before reaching here.
 */
export function generateCodexCommand(env: ServerEnv): string {
  const id = shellQuote(env.WHOOP_CLIENT_ID);
  const secret = shellQuote(env.WHOOP_CLIENT_SECRET);
  return `codex mcp add ${SERVER_NAME} --env WHOOP_CLIENT_ID=${id} --env WHOOP_CLIENT_SECRET=${secret}${telemetryFlags(env, "--env")} -- npx -y whoop-ai-mcp`;
}

/**
 * Generate the `code --add-mcp` shell command for GitHub Copilot in VS Code.
 * The flag accepts a JSON server definition; the JSON is single-quoted for the
 * shell. Values are validated by the wizard before reaching here.
 */
export function generateCopilotCommand(env: ServerEnv): string {
  const payload = JSON.stringify({
    name: SERVER_NAME,
    command: "npx",
    args: ["-y", "whoop-ai-mcp"],
    env: {
      WHOOP_CLIENT_ID: env.WHOOP_CLIENT_ID,
      WHOOP_CLIENT_SECRET: env.WHOOP_CLIENT_SECRET,
      ...telemetrySettings(env),
    },
  });
  return `code --add-mcp ${shellQuote(payload)}`;
}

export function generateLocalSetupInstructions(
  target: ClientTarget,
  env: ServerEnv
): string | undefined {
  const entry = generateClaudeDesktopEntry(env);
  const warning = "Contains credentials: keep this private and out of version control.\n";
  switch (target) {
    case "gemini-cli":
    case "cursor": {
      const path = target === "cursor" ? "~/.cursor/mcp.json" : "~/.gemini/settings.json";
      const source =
        target === "cursor"
          ? "https://cursor.com/docs/context/mcp"
          : "https://geminicli.com/docs/tools/mcp-server/";
      return `Merge this into ${path}, preserving other settings and servers:\n${warning}\n${JSON.stringify(
        { mcpServers: { whoop: entry } },
        null,
        2
      )}\n\nRestart the client and approve the WHOOP server. Node.js/npx must be on its PATH.\n${source}\n`;
    }
    case "openclaw":
      return `In OpenClaw Settings > MCP, merge this into the scoped config editor, preserving other settings and servers:\n${warning}\n${JSON.stringify(
        { mcp: { servers: { whoop: { transport: "stdio", ...entry } } } },
        null,
        2
      )}\n\nUse a current OpenClaw version with native mcp.servers support (not the separate mcporter registry).\nThe server runs on the Gateway host; Node.js/npx and WHOOP authorization must be available there.\nVerify after saving: openclaw mcp doctor whoop --probe\nhttps://docs.openclaw.ai/tools/mcp\n`;
    case "perplexity": {
      const vars = Object.entries(entry.env)
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join(" ");
      return `Perplexity local MCP requires the macOS app and PerplexityXPC helper.\nOpen Plugins > Add custom > Simple, name it whoop, and paste this launch command:\n${warning}\n  env ${vars} npx -y whoop-ai-mcp\n\nSave, wait for Running, then enable it under Sources. Node.js/npx must be on the helper's PATH.\nFor web/non-macOS clients, use Perplexity's remote connector workflow and an authenticated HTTPS deployment instead; availability depends on your account.\nhttps://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity\n`;
    }
    default:
      return undefined;
  }
}

export function remoteSetupInstructions(target: ClientTarget): string | undefined {
  let instructions: string;
  switch (target) {
    case "claude-web":
      instructions =
        "Claude web/mobile: in Settings > Connectors, add a custom connector using your public /mcp URL. Configure the existing OAuth connector on the host and enter its connector password on the host's authorization page.\nhttps://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp";
      break;
    case "chatgpt":
      instructions =
        "ChatGPT: use a custom MCP app/connector in an account/workspace with developer mode enabled. Supply your public /mcp URL and configure OAuth. Availability and admin approval depend on your plan/workspace. ChatGPT is not the Codex CLI.\nhttps://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt";
      break;
    case "grok":
      instructions =
        "Grok support here means the xAI API remote MCP tool, not a verified custom-connector feature in the consumer Grok chat app. Add this tool to your API request (replace both placeholders; never use a WHOOP token):\n" +
        JSON.stringify(
          {
            type: "mcp",
            server_label: "whoop",
            server_url: "https://YOUR_HOST/mcp",
            authorization: "YOUR_MCP_AUTH_TOKEN",
          },
          null,
          2
        ) +
        "\nThe xAI API credential is separate from MCP_AUTH_TOKEN.\nhttps://docs.x.ai/developers/tools/remote-mcp";
      break;
    default:
      return undefined;
  }
  return (
    `Remote setup guidance only: not deployed or verified.\n\n${instructions}\n\n` +
    "Deploy either implementation with MCP_TRANSPORT=http behind public HTTPS; the MCP URL is https://YOUR_HOST/mcp (replace YOUR_HOST). Local stdio and localhost are not reachable by cloud clients.\n" +
    "Keep WHOOP credentials and private tokens on the server host. Bootstrap WHOOP authorization there before connecting; this is a single-account service, not a multi-user relay.\n" +
    "Keep MCP_AUTH_TOKEN authentication enabled. For OAuth clients, also configure PUBLIC_URL, MCP_CONNECTOR_PASSWORD and exact ALLOWED_REDIRECT_URIS. The existing connector uses one static MCP_OAUTH_CLIENT_ID (default whoop-mcp-connector); configure that client ID in the app where supported. Clients requiring dynamic registration or incompatible OAuth flows may need server changes, outside this setup command.\n" +
    "Do not disable authentication to bypass incompatibilities. Setup does not provision hosting, change OAuth, or test the client connection.\n" +
    "Deployment prerequisites: https://github.com/shashankswe2020-ux/whoop-mcp/blob/main/references/deployment.md\n"
  );
}

/**
 * Single-quote a value for safe inclusion in a POSIX shell command,
 * escaping any embedded single quotes.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function telemetrySettings(env: ServerEnv): Partial<ServerEnv> {
  return {
    ...(env.WHOOP_MCP_TELEMETRY !== undefined
      ? { WHOOP_MCP_TELEMETRY: env.WHOOP_MCP_TELEMETRY }
      : {}),
    ...(env.WHOOP_MCP_TELEMETRY_ENDPOINT !== undefined
      ? { WHOOP_MCP_TELEMETRY_ENDPOINT: env.WHOOP_MCP_TELEMETRY_ENDPOINT }
      : {}),
  };
}

function telemetryFlags(env: ServerEnv, flag: string): string {
  return Object.entries(telemetrySettings(env))
    .map(([key, value]) => ` ${flag} ${key}=${shellQuote(value)}`)
    .join("");
}
