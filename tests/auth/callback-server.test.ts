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
      const port = 49152 + Math.floor(Math.random() * 1000);
      const expectedState = "random-state-123";

      const resultPromise = startCallbackServer({
        port,
        expectedState,
        timeoutMs: 5_000,
      });

      // Give the server time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate the OAuth redirect
      const callbackUrl = `http://localhost:${port}/callback?code=auth-code-xyz&state=${expectedState}`;
      const response = await fetch(callbackUrl);

      expect(response.ok).toBe(true);
      const html = await response.text();
      expect(html.toLowerCase()).toContain("success");

      const result = await resultPromise;
      expect(result).toEqual({
        code: "auth-code-xyz",
        state: expectedState,
      });
    });

    it("shuts down the server after receiving the callback", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);
      const expectedState = "state-456";

      const resultPromise = startCallbackServer({
        port,
        expectedState,
        timeoutMs: 5_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Hit the callback
      await fetch(
        `http://localhost:${port}/callback?code=code-abc&state=${expectedState}`,
      );

      await resultPromise;

      // Server should be closed — a second request should fail
      await expect(
        fetch(`http://localhost:${port}/callback?code=x&state=y`),
      ).rejects.toThrow();
    });

    it("responds with HTML success page containing success message", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);
      const expectedState = "state-html";

      const resultPromise = startCallbackServer({
        port,
        expectedState,
        timeoutMs: 5_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await fetch(
        `http://localhost:${port}/callback?code=code-html&state=${expectedState}`,
      );

      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html.toLowerCase()).toContain("success");

      await resultPromise;
    });
  });

  describe("error cases", () => {
    it("rejects with an error if state does not match expectedState", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);

      const resultPromise = startCallbackServer({
        port,
        expectedState: "correct-state",
        timeoutMs: 5_000,
      });
      // Prevent unhandled rejection warning — we'll assert below
      resultPromise.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await fetch(
        `http://localhost:${port}/callback?code=some-code&state=wrong-state`,
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html.toLowerCase()).toContain("error");

      await expect(resultPromise).rejects.toThrow(/state mismatch/i);
    });

    it("rejects with an error if code is missing from the callback", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);

      const resultPromise = startCallbackServer({
        port,
        expectedState: "some-state",
        timeoutMs: 5_000,
      });
      resultPromise.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await fetch(
        `http://localhost:${port}/callback?state=some-state`,
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html.toLowerCase()).toContain("missing");

      await expect(resultPromise).rejects.toThrow(/missing authorization code/i);
    });

    it("rejects with an error if WHOOP sends an OAuth error response", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);

      const resultPromise = startCallbackServer({
        port,
        expectedState: "some-state",
        timeoutMs: 5_000,
      });
      resultPromise.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await fetch(
        `http://localhost:${port}/callback?error=access_denied&error_description=User+denied+access`,
      );

      expect(response.status).toBe(400);

      await expect(resultPromise).rejects.toThrow(/User denied access/);
    });

    it("rejects with a timeout error if no callback arrives", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);

      const resultPromise = startCallbackServer({
        port,
        expectedState: "some-state",
        timeoutMs: 100, // Very short timeout for testing
      });

      await expect(resultPromise).rejects.toThrow(/timed out/i);
    });

    it("shuts down the server after a state mismatch error", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);

      const resultPromise = startCallbackServer({
        port,
        expectedState: "correct-state",
        timeoutMs: 5_000,
      });
      resultPromise.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      await fetch(
        `http://localhost:${port}/callback?code=x&state=wrong-state`,
      );

      await expect(resultPromise).rejects.toThrow();

      // Server should be closed — another request should fail
      await expect(
        fetch(`http://localhost:${port}/callback?code=x&state=y`),
      ).rejects.toThrow();
    });

    it("escapes XSS characters in error_description", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);

      const resultPromise = startCallbackServer({
        port,
        expectedState: "some-state",
        timeoutMs: 5_000,
      });
      resultPromise.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const xssPayload = '<script>alert(1)</script>';
      const response = await fetch(
        `http://localhost:${port}/callback?error=bad&error_description=${encodeURIComponent(xssPayload)}`,
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      // The raw script tag must NOT appear in the response
      expect(html).not.toContain("<script>");
      // The escaped form should be present instead
      expect(html).toContain("&lt;script&gt;");

      await expect(resultPromise).rejects.toThrow();
    });

    it("rejects with EADDRINUSE error when port is already taken", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);

      // Start first server on the port
      const first = startCallbackServer({
        port,
        expectedState: "state-1",
        timeoutMs: 5_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Start second server on the same port — should fail
      const second = startCallbackServer({
        port,
        expectedState: "state-2",
        timeoutMs: 5_000,
      });
      second.catch(() => {});

      await expect(second).rejects.toThrow(/already in use/i);

      // Clean up the first server
      await fetch(
        `http://localhost:${port}/callback?code=cleanup&state=state-1`,
      );
      await first;
    });

    it("returns 404 for non-callback paths", async () => {
      const port = 49152 + Math.floor(Math.random() * 1000);
      const expectedState = "state-404";

      const resultPromise = startCallbackServer({
        port,
        expectedState,
        timeoutMs: 5_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await fetch(`http://localhost:${port}/other-path`);
      expect(response.status).toBe(404);

      // Server should still be listening — clean up by sending a valid callback
      await fetch(
        `http://localhost:${port}/callback?code=cleanup-code&state=${expectedState}`,
      );

      await resultPromise;
    });
  });
});
