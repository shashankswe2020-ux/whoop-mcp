# Task 6 Plan: MCP Server Shell

> **Parent spec:** `docs/specs/implementation-plan.md` → Task 6
> **Depends on:** Task 1 (scaffold) ✅, Task 2 (types) ✅, Task 3 (token store) ✅, Task 4 (API client) ✅, Task 5 (OAuth flow) ✅
> **Consumed by:** Tasks 7a–7f (tool implementations plug real handlers into stubs), Task 9 (entry point calls `createServer` + connects transport)
> **Created:** 2026-04-11

---

## Overview

Create `src/server.ts` — the MCP server factory that instantiates an `McpServer` from `@modelcontextprotocol/sdk`, registers all 6 WHOOP tools with their Zod input schemas (stub handlers that return "not implemented" for now), and exports a function to create the configured server. The entry point (Task 9) will later call this to get the server and connect it to a `StdioServerTransport`.

This is a **low-risk, medium-scope** task. The SDK API is well-documented and the pattern is mechanical — one `registerTool` call per tool.

## Architecture Decisions

- **Factory function, not module-level side effects** — `createWhoopServer(client: WhoopClient)` returns a configured `McpServer`. This makes it testable (inject a mock client) and avoids import-time side effects.
- **Stub handlers for now** — Each tool handler returns `{ content: [{ type: "text", text: "Not implemented" }], isError: true }`. Tasks 7a–7f replace these with real implementations. This lets us verify the server shell independently.
- **Zod schemas co-located in `server.ts` for now** — In Tasks 7a–7f, each tool gets its own file with the schema + handler. But for Task 6, we define the schemas inline to avoid creating 6 empty files. When Task 7 starts, schemas and handlers move to `src/tools/*.ts`.
- **`@modelcontextprotocol/sdk` v1.29.0** — We're on SDK v1.29.0. The high-level API uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`. Tool registration is `server.registerTool(name, { description, inputSchema }, handler)`.
- **`readOnlyHint: true` annotation on all tools** — All 6 tools are read-only (GET requests). Setting this annotation informs the client that these tools don't modify state.
- **Server metadata** — Name: `"whoop-mcp"`, Version: from `package.json` version (or hardcoded `"0.1.0"` for now).
- **Test with `InMemoryTransport`** — Available from `@modelcontextprotocol/sdk/inMemory.js`. Paired with `Client` from `@modelcontextprotocol/sdk/client/index.js` for verifying tool listing and calling in tests.
- **No stdio transport in `server.ts`** — Transport connection is the entry point's responsibility (Task 9). `server.ts` only creates and configures the server.

## SDK API Reference (v1.29.0)

```typescript
// Imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Create server
const server = new McpServer({ name: "whoop-mcp", version: "0.1.0" });

// Register tool (new API — config object)
server.registerTool(
  "tool_name",
  {
    description: "Tool description",
    inputSchema: z.object({ ... }),        // Zod schema
    annotations: { readOnlyHint: true },   // Optional metadata
  },
  async (args) => ({
    content: [{ type: "text", text: "result" }],
  })
);

// Connect (done by entry point, not server.ts)
const transport = new StdioServerTransport();
await server.connect(transport);
```

## Tools to Register (6 total)

| # | Tool Name | Description | Input Schema | Endpoint |
|---|-----------|-------------|-------------|----------|
| 1 | `get_profile` | Get basic user profile (name, email) | None (empty object) | `/v2/user/profile/basic` |
| 2 | `get_body_measurement` | Get body measurements (height, weight, max HR) | None (empty object) | `/v2/user/measurement/body` |
| 3 | `get_recovery_collection` | Get recovery scores for a date range | `{ start?, end?, limit?, nextToken? }` | `/v2/recovery` |
| 4 | `get_sleep_collection` | Get sleep records for a date range | `{ start?, end?, limit?, nextToken? }` | `/v2/activity/sleep` |
| 5 | `get_workout_collection` | Get workout records for a date range | `{ start?, end?, limit?, nextToken? }` | `/v2/activity/workout` |
| 6 | `get_cycle_collection` | Get physiological cycles for a date range | `{ start?, end?, limit?, nextToken? }` | `/v2/cycle` |

### Shared Collection Input Schema

Tools 3–6 share the same input shape:

```typescript
z.object({
  start: z.string().optional().describe("ISO 8601 start time (inclusive)"),
  end: z.string().optional().describe("ISO 8601 end time (exclusive)"),
  limit: z.number().optional().describe("Max records (1-25). Default 10."),
  nextToken: z.string().optional().describe("Pagination token from previous response"),
})
```

---

## Task Breakdown

### Task 6a: Create `src/server.ts` — server factory with 6 stub tools

**Description:** Create the `createWhoopServer` factory function that instantiates an `McpServer`, registers all 6 tools with their Zod input schemas and stub handlers, and returns the server instance.

**Acceptance criteria:**
- [ ] `createWhoopServer(client)` returns a configured `McpServer` instance
- [ ] All 6 tools are registered with correct names, descriptions, and Zod input schemas
- [ ] All tools have `readOnlyHint: true` annotation
- [ ] Stub handlers return `{ content: [{ type: "text", text: "Not implemented yet" }], isError: true }`
- [ ] No `any` types — `WhoopClient` parameter is properly typed
- [ ] Named export only (no default export)

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds

**Dependencies:** Tasks 1–5 (all complete)

**Files:**
- `src/server.ts` (new)

**Estimated scope:** Small (1 file)

---

### Task 6b: Write tests for the MCP server shell

**Description:** Test that the server correctly registers all 6 tools by connecting a `Client` via `InMemoryTransport` and calling `tools/list`. Verify each tool's name, description, and input schema. Also test that calling a stub tool returns the "not implemented" error response.

**Acceptance criteria:**
- [ ] Test verifies `tools/list` returns exactly 6 tools
- [ ] Test verifies each tool has the correct name and description
- [ ] Test verifies collection tools (4 of them) have `start`, `end`, `limit`, `nextToken` in input schema
- [ ] Test verifies `get_profile` and `get_body_measurement` have no required input params
- [ ] Test verifies all tools have `readOnlyHint: true` annotation
- [ ] Test verifies calling a stub tool returns `isError: true` with "Not implemented yet" text
- [ ] All tests use `InMemoryTransport` + `Client` (no stdio, no network)
- [ ] All tests mock the `WhoopClient` (never hit real API)

**Verification:**
- [ ] `npm test -- tests/server.test.ts` passes
- [ ] `npm test` — all 98 existing tests still pass + new tests pass

**Dependencies:** Task 6a

**Files:**
- `tests/server.test.ts` (new)

**Estimated scope:** Small (1 file)

---

## Implementation Order

```
Task 6a: src/server.ts (factory + 6 stub tools)
    │
    ▼
Task 6b: tests/server.test.ts (verify via InMemoryTransport)
    │
    ▼
Checkpoint ✅
```

## Checkpoint: After Task 6a + 6b

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] `npm test` — all existing tests pass + new server tests pass
- [ ] `tools/list` via InMemoryTransport returns 6 correctly-configured tools
- [ ] Stub tool calls return `isError: true`

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SDK v1.29.0 `registerTool` API differs from docs | 🟡 Medium | Verified API from SDK source + integration tests. `registerTool(name, config, handler)` is the correct signature. |
| Zod version mismatch between our `zod@3.x` and SDK's expectation | 🟡 Medium | SDK v1.29.0 accepts Zod v3 `z.object()` via Standard Schema. Already working in our project (Zod is installed, types compile). |
| `InMemoryTransport` not available for testing | 🟢 Low | Verified: `InMemoryTransport` exports from `@modelcontextprotocol/sdk/inMemory.js`. `Client` exports from `@modelcontextprotocol/sdk/client/index.js`. |

## Open Questions

None — all required information is available from the SDK source, existing codebase, and spec.

---

## Ready to Implement

Order: **6a → 6b → verify checkpoint** → proceed to Tasks 7a–7f.
