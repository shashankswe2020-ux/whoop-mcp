/**
 * Tests for collection-utils.ts — buildCollectionQuery.
 *
 * Covers edge cases: empty params, all params, single param,
 * undefined values omitted.
 */

import { describe, it, expect } from "vitest";
import { buildCollectionQuery } from "../../src/tools/collection-utils.js";

describe("buildCollectionQuery", () => {
  it("returns empty string when no params are set", () => {
    expect(buildCollectionQuery({})).toBe("");
  });

  it("returns empty string when all params are undefined", () => {
    expect(
      buildCollectionQuery({
        start: undefined,
        end: undefined,
        limit: undefined,
        nextToken: undefined,
      })
    ).toBe("");
  });

  it("returns query string with all params when all are provided", () => {
    const query = buildCollectionQuery({
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-10T00:00:00.000Z",
      limit: 5,
      nextToken: "abc123",
    });

    expect(query).toContain("?");
    const params = new URLSearchParams(query.slice(1));
    expect(params.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(params.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(params.get("limit")).toBe("5");
    expect(params.get("nextToken")).toBe("abc123");
  });

  it("returns query string with only start when only start is provided", () => {
    const query = buildCollectionQuery({
      start: "2026-04-01T00:00:00.000Z",
    });

    expect(query).toMatch(/^\?start=/);
    const params = new URLSearchParams(query.slice(1));
    expect(params.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(params.has("end")).toBe(false);
    expect(params.has("limit")).toBe(false);
    expect(params.has("nextToken")).toBe(false);
  });

  it("returns query string with only end when only end is provided", () => {
    const query = buildCollectionQuery({
      end: "2026-04-10T00:00:00.000Z",
    });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(params.has("start")).toBe(false);
  });

  it("returns query string with only limit when only limit is provided", () => {
    const query = buildCollectionQuery({ limit: 10 });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("limit")).toBe("10");
    expect(params.has("start")).toBe(false);
    expect(params.has("end")).toBe(false);
    expect(params.has("nextToken")).toBe(false);
  });

  it("returns query string with only nextToken when only nextToken is provided", () => {
    const query = buildCollectionQuery({ nextToken: "page2" });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("nextToken")).toBe("page2");
    expect(params.has("start")).toBe(false);
  });

  it("omits undefined values from the query string", () => {
    const query = buildCollectionQuery({
      start: "2026-04-01T00:00:00.000Z",
      end: undefined,
      limit: 25,
      nextToken: undefined,
    });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(params.get("limit")).toBe("25");
    expect(params.has("end")).toBe(false);
    expect(params.has("nextToken")).toBe(false);
  });

  it("converts limit number to string in query", () => {
    const query = buildCollectionQuery({ limit: 1 });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("limit")).toBe("1");
  });

  it("starts with ? when at least one param is set", () => {
    const query = buildCollectionQuery({ limit: 5 });

    expect(query.startsWith("?")).toBe(true);
  });
});
