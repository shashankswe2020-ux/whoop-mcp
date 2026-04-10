/**
 * Temporary HTTP callback server for OAuth2 redirect.
 *
 * Starts a minimal HTTP server that waits for the OAuth callback,
 * captures the authorization code, and shuts down.
 * Uses only `node:http` — no external dependencies.
 */

import { createServer, type Server } from "node:http";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from the callback server after receiving the OAuth redirect */
export interface CallbackResult {
  code: string;
  state: string;
}

/** Options for the callback server */
export interface CallbackServerOptions {
  /** Port to listen on. Default: 3000 */
  port?: number;
  /** State parameter to validate against (CSRF protection) */
  expectedState: string;
  /** How long to wait before timing out in ms. Default: 120_000 (2 min) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// HTML responses
// ---------------------------------------------------------------------------

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>WHOOP MCP — Success</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:3rem">
<h1>✅ Authentication Successful</h1>
<p>You can close this window and return to your terminal.</p>
</body></html>`;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>WHOOP MCP — Error</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:3rem">
<h1>❌ Authentication Failed</h1>
<p>${escapeHtml(message)}</p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

/**
 * Start a temporary HTTP server that waits for the OAuth callback.
 *
 * Returns a promise that resolves with the authorization code and state.
 * The server shuts down automatically after receiving the callback or timing out.
 */
export function startCallbackServer(
  options: CallbackServerOptions,
): Promise<CallbackResult> {
  const port = options.port ?? 3000;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const server: Server = createServer((req, res) => {
      // Only handle GET /callback
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      // Check for OAuth error response from provider
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        const description =
          url.searchParams.get("error_description") ?? oauthError;
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml(description));
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(`OAuth error: ${description}`));
        }
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      // Validate required params
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml("Missing authorization code in callback."));
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error("Missing authorization code in callback"));
        }
        return;
      }

      // Validate state parameter (CSRF protection)
      if (state !== options.expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml("State parameter mismatch — possible CSRF attack."));
        cleanup();
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `State mismatch: expected "${options.expectedState}", got "${state}"`,
            ),
          );
        }
        return;
      }

      // Success — return the code
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SUCCESS_HTML);
      cleanup();
      if (!settled) {
        settled = true;
        resolve({ code, state });
      }
    });

    function cleanup(): void {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      server.close();
    }

    // Timeout — reject if no callback arrives
    timer = setTimeout(() => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `OAuth callback timed out after ${timeoutMs}ms. No redirect received.`,
          ),
        );
      }
    }, timeoutMs);

    server.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      if (!settled) {
        settled = true;
        const msg =
          err.code === "EADDRINUSE"
            ? `Port ${port} is already in use. Close other servers on port ${port} and try again.`
            : `Callback server error: ${err.message}`;
        reject(new Error(msg));
      }
    });

    server.listen(port, "127.0.0.1");
  });
}
