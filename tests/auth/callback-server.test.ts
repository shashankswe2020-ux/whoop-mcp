/**
 * Tests for the OAuth callback server.
 *
 * Tests use port 0 (OS-assigned) to avoid conflicts.
 */

import { describe, it, expect } from "vitest";
import { startCallbackServer } from "../../src/auth/callback-server.js";

describe("startCallbackServer", () => {
  describe("happy path", () => {
    it("resolves with code and state on a valid callback", async () => {
      const expectedState = "random-state-123";

      const handle = startCallbackServer({
        port: 0,
        expectedState,
        timeoutMs: 5_000,
      });

      // Give the server time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;

      // Simulate the OAuth redirect
      const callbackUrl = `http://127.0.0.1:${port}/callback?code=auth-code-xyz&state=${expectedState}`;
      const response = await fetch(callbackUrl);

      expect(response.ok).toBe(true);
      const html = await response.text();
      expect(html.toLowerCase()).toContain("success");

      const result = await handle.result;
      expect(result).toEqual({
        code: "auth-code-xyz",
        state: expectedState,
      });
    });

    it("shuts down the server after receiving the callback", async () => {
      const expectedState = "state-456";

      const handle = startCallbackServer({
        port: 0,
        expectedState,
        timeoutMs: 5_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;

      // Hit the callback
      await fetch(
        `http://127.0.0.1:${port}/callback?code=code-abc&state=${expectedState}`,
      );

      await handle.result;

      // Server should be closed — a second request should fail
      await expect(
        fetch(`http://127.0.0.1:${port}/callback?code=x&state=y`),
      ).rejects.toThrow();
    });

    it("responds with HTML success page containing success message", async () => {
      const expectedState = "state-html";

      const handle = startCallbackServer({
        port: 0,
        expectedState,
        timeoutMs: 5_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;

      const response = await fetch(
        `http://127.0.0.1:${port}/callback?code=code-html&state=${expectedState}`,
      );

      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html.toLowerCase()).toContain("success");

      await handle.result;
    });
  });

  describe("error cases", () => {
    it("rejects with an error if state does not match expectedState", async () => {
      const handle = startCallbackServer({
        port: 0,
        expectedState: "correct-state",
        timeoutMs: 5_000,
      });
      // Prevent unhandled rejection warning — we'll assert below
      handle.result.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?code=some-code&state=wrong-state`,
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html.toLowerCase()).toContain("error");

      await expect(handle.result).rejects.toThrow(/state mismatch/i);
    });

    it("rejects with an error if code is missing from the callback", async () => {
      const handle = startCallbackServer({
        port: 0,
        expectedState: "some-state",
        timeoutMs: 5_000,
      });
      handle.result.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?state=some-state`,
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html.toLowerCase()).toContain("missing");

      await expect(handle.result).rejects.toThrow(/missing authorization code/i);
    });

    it("rejects with an error if WHOOP sends an OAuth error response", async () => {
      const handle = startCallbackServer({
        port: 0,
        expectedState: "some-state",
        timeoutMs: 5_000,
      });
      handle.result.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?error=access_denied&error_description=User+denied+access`,
      );

      expect(response.status).toBe(400);

      await expect(handle.result).rejects.toThrow(/User denied access/);
    });

    it("HTML-escapes error_description to prevent reflected XSS", async () => {
      const handle = startCallbackServer({
        port: 0,
        expectedState: "some-state",
        timeoutMs: 5_000,
      });
      handle.result.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;
      const xssPayload = "<script>alert('XSS')</script>";
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?error=access_denied&error_description=${encodeURIComponent(xssPayload)}`,
      );

      const html = await response.text();
      // Should NOT contain raw <script> — should be escaped
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");

      await expect(handle.result).rejects.toThrow();
    });

    it("rejects with a timeout error if no callback arrives", async () => {
      const handle = startCallbackServer({
        port: 0,
        expectedState: "some-state",
        timeoutMs: 100, // Very short timeout for testing
      });

      await expect(handle.result).rejects.toThrow(/timed out/i);
    });

    it("shuts down the server after a state mismatch error", async () => {
      const handle = startCallbackServer({
        port: 0,
        expectedState: "correct-state",
        timeoutMs: 5_000,
      });
      handle.result.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;
      await fetch(
        `http://127.0.0.1:${port}/callback?code=x&state=wrong-state`,
      );

      await expect(handle.result).rejects.toThrow();

      // Server should be closed — another request should fail
      await expect(
        fetch(`http://127.0.0.1:${port}/callback?code=x&state=y`),
      ).rejects.toThrow();
    });

    it("returns 404 for non-callback paths", async () => {
      const expectedState = "state-404";

      const handle = startCallbackServer({
        port: 0,
        expectedState,
        timeoutMs: 5_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const port = handle.port;
      const response = await fetch(`http://127.0.0.1:${port}/other-path`);
      expect(response.status).toBe(404);

      // Server should still be listening — clean up by sending a valid callback
      await fetch(
        `http://127.0.0.1:${port}/callback?code=cleanup-code&state=${expectedState}`,
      );

      await handle.result;
    });

    it("rejects with EADDRINUSE message when port is already in use", async () => {
      const expectedState = "state-conflict";

      // Start first server to occupy a specific (non-zero) port
      const firstHandle = startCallbackServer({
        port: 0,
        expectedState,
        timeoutMs: 5_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const occupiedPort = firstHandle.port;

      // Start second server on the same port — should fail with EADDRINUSE
      const secondHandle = startCallbackServer({
        port: occupiedPort,
        expectedState: "state-2",
        timeoutMs: 5_000,
      });

      await expect(secondHandle.result).rejects.toThrow(/already in use/i);

      // Clean up the first server
      await fetch(
        `http://127.0.0.1:${occupiedPort}/callback?code=cleanup&state=${expectedState}`,
      );
      await firstHandle.result;
    });
  });
});
