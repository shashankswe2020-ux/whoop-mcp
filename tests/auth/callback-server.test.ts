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
});
