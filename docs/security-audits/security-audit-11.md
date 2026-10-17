# Security Audit Report #11

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-10-18 (+05:30)
> **Scope:** Local performance dashboard, commits `579d43c` (T10) and `6762793` (T11), and earlier local write tools. Reviewed at HEAD `719146f`; no subsequent scoped source changes. Files: `src/dashboard/server.ts`, `src/dashboard/api.ts`, `src/dashboard/static/{index.html,app.js,style.css}`, `src/tools/open-performance-dashboard.ts`, `src/performance/{store,audit-log,schemas,context}.ts`, `src/tools/{annotate-workout,log-race-result}.ts`; supporting browser launch, token directory resolution, route/tool registration, audit read path, tests, and dashboard security specification. This is not a full remote OAuth/transport re-audit.
> **Dependencies:** 0 known vulnerabilities (`npm audit --json`, full production and development dependency tree; 288 total dependencies reported).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 2 |
| Info | 0 |

No unauthenticated API read/write bypass, DNS-rebinding bypass, exploitable dashboard XSS, static path traversal, or global prototype pollution was demonstrated. The main problems concern capability leakage through browser-launch error logs and persistence/audit integrity. Medium findings require log access, multiple legitimate local processes, or a filesystem failure; they are not remote compromise findings. Low findings have explicit preconditions below.

**Validation:** The scoped Vitest run passed **8 files / 53 tests**. Additional isolated checks used synthetic data and disposable temporary directories: mocked browser-spawn failure; two independent Node writers synchronized after reading the same snapshot; forced audit append failure; existing 0755/0644 filesystem modes; audit-file symlink; an 11.6 MB synthetic audit log; JSON/query prototype keys; and a raw conflicting Content-Length/Transfer-Encoding request. No real WHOOP calls or credentials were used. Runtime was Node v26.11.1 on macOS. No source code was modified or committed. Remediation snippets below are recommendations, not applied patches.

**Previous audits:** Reports #1–#10 were checked for overlapping and carried findings. Earlier `exec` injection and callback XSS findings were marked resolved; the dashboard-specific Windows URL is assessed separately below rather than assuming that argument arrays make `cmd` safe. Audit #10 LOW-1 remains open outside this scope: runtime `express`/`jose` imports still lack direct dependency declarations. Audit #10 LOW-2 (printed setup credential charset) and #9 LOW-1 (multi-identity cache assumption) remain outside this review; no renewed exploit assessment is claimed. Audit #9 LOW-2 is now resolved: `MemoryCache.clear()` clears `inflight`. Audit #8 password-page anti-framing and proxy configuration concerns have corresponding controls in current source. Audit #10 historical dependency advisories are absent from the current full-tree npm audit. Prior reports did not cover this new dashboard/store implementation; do not interpret their permission and no-token-logging confirmations as covering the error paths reproduced here.

OWASP Top 10 baseline considered: access control, cryptographic protection, injection, insecure design, security configuration, dependency vulnerabilities, authentication, software/data integrity, logging, and SSRF. Database authentication, uploads, webhooks, and external OAuth authorization flows are not dashboard features and were not re-audited.

---

## Findings

### [MEDIUM-1] Browser-launch failure logs the live dashboard bearer capability

- **Location:** `src/auth/oauth.ts:274-284`; caller `src/tools/open-performance-dashboard.ts:83-89`.
- **Description:** Both browser-launch failure paths interpolate the complete supplied URL into `console.error`. The new caller passes a URL containing `#token=...`. Moving the token into the fragment prevents HTTP and Referer transmission, but does not protect these stderr messages. The asynchronous child error also occurs after the controller has reported browser launch success.
- **Impact:** An observer with access to assistant/server stderr or retained diagnostics can recover the token. To use it directly, the observer also needs access to the same host/loopback network namespace. A non-browser client can supply the accepted Origin header and use the token to read health/performance data and submit local corrections. The token remains useful until rotation or server shutdown; this is not an internet-reachable bearer endpoint.
- **Proof of concept:** Replace `spawn` in an isolated test with an EventEmitter that emits `error` (simulating missing `xdg-open`), then call `openBrowser` with a synthetic dashboard URL. Captured stderr contained the entire `#token=SYNTHETIC_AUDIT_TOKEN`. The checked-in controller uses this same helper without an alternate log policy.
- **Recommendation:** Never log raw capability URLs, including on asynchronous spawn failure. Return the full URL only through the intended tool response; log a fragment-free URL or a generic instruction instead. Ensure every launcher failure path uses the sanitized value. Example:
  ```ts
  const printable = new URL(url);
  printable.hash = "";
  const onLaunchError = () => {
    console.error(`Could not open browser; reopen the dashboard from your assistant. ${printable.href}`);
  };
  child.on("error", onLaunchError);
  ```
  Use the same sanitization in the synchronous catch. Add a spawn-error test asserting that neither the token nor `#token=` appears in captured logs. Returning a promise from the launcher would also make `browser_opened` accurate.
- **Confidence:** 10/10 (synthetic error-path reproduction).

### [MEDIUM-2] Process-local write queue permits cross-process lost updates

- **Location:** `src/performance/store.ts:83-103` (especially 90-96); callers `src/tools/annotate-workout.ts:51-59`, `src/tools/log-race-result.ts:59-72`.
- **Description:** The queue serializes mutations only inside one Node process and only for the identical directory string. Separate MCP processes sharing `~/.whoop-mcp` each load a snapshot and atomically rename their own replacement. Atomic rename prevents partial JSON; it does not make the read-modify-write cycle atomic. Noncanonical directory aliases can likewise defeat the per-string queue when injected/configured.
- **Impact:** A correction, restoration, or race result acknowledged as successful can disappear. With competing processes a newer exclusion/restoration can be reverted by an older snapshot, and the audit log can claim a change no longer present in state. Two assistants using the same account are sufficient; no additional OS privilege is needed. Ordinary concurrent requests within the same controller/process and directory key are serialized correctly.
- **Proof of concept:** Start two independent Node processes calling `updatePerformanceState` against one temporary directory. In each synchronous mutation callback, signal readiness and wait until the other callback has also loaded its snapshot, then add a distinct annotation. Both writers returned success, but the final file contained only `writer-b` instead of both annotations. The barrier controls scheduling without modifying production code.
- **Recommendation:** Acquire an exclusive interprocess lock on a validated, canonical directory before loading state; retain it through persistence and the audit commit. Use atomic lock acquisition and owner-aware crash recovery, or transactional storage. A module-local promise map alone is insufficient. Illustrative integration:
  ```ts
  const canonical = await realpath(await ensurePerformanceDirectory(directory));
  return withPerformanceFileLock(canonical, async () => {
    const { state, result } = mutate(await loadPerformanceState(canonical));
    await savePerformanceState(state, canonical);
    return result;
  });
  ```
  `withPerformanceFileLock` must be an actual OS/filesystem-coordinated exclusive lock, not another Map; an atomic lock directory with verified ownership and safe stale-lock handling is one option. Reuse the existing OAuth lock design where appropriate. Include two-process tests and canonical-path tests. Address MEDIUM-3 in the same transaction design.
- **Confidence:** 10/10 (deterministic two-process reproduction).

### [MEDIUM-3] Failed audit append leaves committed but unlogged mutations and a false rollback message

- **Location:** `src/tools/annotate-workout.ts:51-72`; `src/tools/log-race-result.ts:59-93`; `src/dashboard/api.ts:110-111`; equivalent MCP message `src/server.ts:166-167`.
- **Description:** Each tool commits `performance.json` before appending the audit entry, outside the state-update queue. If append fails or the process exits between these operations, the mutation remains while its audit record is absent. The API/MCP then reports that nothing changed, which is false. Concurrent appends can also be observed in a different order from state commits.
- **Impact:** Audit completeness is not guaranteed. Users may retry a failed race submission and create duplicates, or trust an exclusion/restoration failure despite the metrics having changed. An existing unwritable log path or a disk/I/O failure is enough. This does not give an unauthenticated web page write access.
- **Proof of concept:** In a disposable state directory, create a directory named `performance-audit.jsonl`, then POST a valid annotation through `createDashboardApi`. Response: 500 with `Could not append to performance-audit.jsonl. Nothing was changed.` Reloading `performance.json` showed the annotation was persisted. A crash after rename has the same logical gap without preparing the log path.
- **Recommendation:** Commit state and audit together under the interprocess lock, with crash recovery. Use a durable write-ahead journal or a single transactional database, with operation IDs for retry deduplication. Simply swapping append/rename order or attempting an in-memory rollback does not make two files atomic. For example, if approved transactional storage is adopted, both changes belong in one transaction:
  ```ts
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE performance_state SET json = ? WHERE id = 1").run(nextJson);
    db.prepare("INSERT INTO audit_log (operation_id, json) VALUES (?, ?)")
      .run(operationId, auditJson);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  ```
  A new dependency/runtime requirement would need project approval; a properly recovered journal can preserve JSON/JSONL exports without that dependency. In the interim, distinguish precommit failure from partial success and do not claim rollback unless verified. Add append-failure, crash-recovery, and retry-idempotency tests.
- **Confidence:** 10/10 (API failure and persistent state reproduced together).

### [LOW-1] Audit limit is applied only after unbounded full-file allocation and parsing

- **Location:** `src/performance/audit-log.ts:34-57`; reachable via `src/tools/audit-performance-data.ts:33-41,113-116` and `/api/audit`.
- **Description:** Every read loads the complete append-only log, splits all lines, parses every entry into an array, reverses the array, and only then slices to the requested limit. The API cap of 200 controls response length, not disk-read, parsing, or memory cost. There is no log rotation or read-size/line-size ceiling.
- **Impact:** A long-lived/repeatedly edited store can make an audit view expensive, and sufficiently large logs or concurrent authenticated reads can exhaust the MCP process heap or stall its event loop. Valid repeated corrections can grow the log without increasing the annotation count. This requires accumulated data, an authenticated writer/reader, or preexisting file access; no unauthenticated memory-exhaustion exploit was shown, so severity is Low.
- **Proof of concept:** An isolated 10,000-entry, 11.6 MB synthetic log with `limit: 1` returned one entry but increased heap usage by approximately 41 MiB and parsed the entire file (about 25 ms on the tested machine). These measurements establish amplification, not a demonstrated production OOM threshold.
- **Recommendation:** For recent-entry reads, scan backward in bounded chunks and stop after enough valid records; bound line length and bytes scanned, returning explicit truncation metadata. Preserve global invalid-line counts via a maintained index or separate streaming diagnostics, not an unbounded interactive read. Enforce retention/rotation and bound concurrent scans. Illustrative limits:
  ```ts
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  return readRecentJsonl(file, {
    limit,
    maxScanBytes: 4 * 1024 * 1024,
    maxLineBytes: 64 * 1024,
  });
  ```
  Implement `readRecentJsonl` using bounded file-handle reads; it must not wrap `readFile`. A forward stream with a ring buffer bounds memory but still needs a scan-time/byte budget to bound CPU. Add large-log and overlong-line tests.
- **Confidence:** 10/10 (source review plus bounded-size measurement).

### [LOW-2] Creation modes do not enforce privacy for preexisting directories and audit files

- **Location:** `src/performance/store.ts:25-28`; `src/performance/audit-log.ts:18-23`; related load at `src/performance/store.ts:31-34`.
- **Description:** `mkdir(..., mode: 0700)` does not tighten an existing directory, and `appendFile(..., mode: 0600)` does not tighten an existing audit file. Thus a previously created 0755 store and 0644 log remain so while receiving health-related notes and before/after records. The append also follows a preexisting audit-file symlink. The atomic state rename, by contrast, replaces the destination symlink rather than writing through it.
- **Impact:** If ancestor traversal is permitted and the existing directory/log have broad permissions, another OS account can read new audit notes. If another principal can already modify the store directory (for example, an existing group-writable directory), it can substitute the audit symlink and redirect appends to another file writable by the application account. This is not a standalone privilege escalation against a fresh private 0700 directory; same-UID malware already has equivalent access. Low severity reflects these prerequisites.
- **Proof of concept:** Precreate a 0755 directory and 0644 empty log in a temporary fixture. After annotation, modes remained 0755/0644 and the synthetic private note appeared in the log. Separately, precreate the audit pathname as a symlink to a synthetic target; annotation appended JSON to that target. No files outside the fixture were accessed.
- **Recommendation:** Validate owner, type, and permissions of existing paths; reject unexpected symlinks and unsafe ownership. Tighten known-owned files/directories using verified handles, and use no-follow opens for the audit file. On POSIX, after securely validating the directory, an example audit-open sequence is:
  ```ts
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND |
    constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid!()) throw new Error("Unsafe audit file");
    await handle.chmod(0o600);
    await handle.writeFile(serializedEntry + "\n");
  } finally {
    await handle.close();
  }
  ```
  Also validate the parent with `lstat`/ownership checks, enforce 0700 for a known-owned directory, and reject unsafe ancestor configurations rather than relying on a vulnerable check-then-open sequence in an attacker-writable directory. Apply equivalent checks to reads. Use platform-specific ACL/reparse-point protections on Windows; POSIX mode arguments alone are not a Windows ACL guarantee. Consider `wx` for unpredictable temporary-file creation as additional hardening.
- **Confidence:** 10/10 for retained modes and symlink following; cross-account impact is conditional on the stated filesystem configuration.

---

## Positive Observations

- **Loopback and API authorization:** Literal 127.0.0.1 bind on an ephemeral port; no 0.0.0.0 bind. All `/api/` paths require the current 32-byte CSPRNG bearer token, compared with equal-length `timingSafeEqual`. Wrong tokens and rotated tokens are rejected. Non-browser clients are intentionally possible only with the capability.
- **Other origins / DNS rebinding / CSRF:** Exact Host allowlist includes the actual port, not arbitrary DNS names; foreign Origin is rejected, including on reads. POST additionally requires an allowed Origin. No permissive CORS/preflight route is exposed. Both accepted loopback hostnames still require the token. An attacker page without the token cannot supply an authorized header through an ordinary form/image request, and CORS cannot grant it a read.
- **Token handling in the normal browser flow:** Token is in the fragment rather than query parameters; HTTP request targets and Referer do not carry fragments. `app.js:49-54` reads it into module memory and immediately replaces the history entry; no local/session storage or token-bearing DOM links were found. HTTP and HTML referrer policy is no-referrer; responses use no-store. This does not override MEDIUM-1 or guarantee that extensions, OS process inspection, crash recovery, or browser sync never see an initially opened URL. The token-bearing MCP response is an intentional capability delivery channel and should remain private.
- **XSS:** Reviewed static HTML, app DOM helpers, all view/form rendering, and SVG attributes. WHOOP sport names, race names, notes, audit before/after JSON, and error messages become text nodes/textContent or fixed-name non-executable attributes. No innerHTML, outerHTML, insertAdjacentHTML, eval, dynamic code generation, or attacker-controlled resource URL sink was found. CSP forbids inline scripts, external scripts, frames, objects, form submission, and base URL changes. No third-party scripts, fonts, or CDN dependencies were found in the dashboard.
- **Static path safety:** Four-entry fixed static allowlist with own-property checks; no request-derived filesystem path. Traversal, percent-encoded traversal, unknown files, and prototype route names are rejected. The trusted test/config `staticDir` is not an HTTP-controlled input.
- **Validation and prototype keys:** API input and output contracts use Zod; write tools additionally enforce bounded IDs/notes, enumerated actions/categories, and split consistency. Own-property route lookups prevent inherited route execution. Synthetic JSON `__proto__`/constructor payloads and query keys did not pollute Object.prototype. The one-level query assignment does not interpret bracket/dot paths or merge objects. This finding is limited to global pollution; arbitrary non-WHOOP IDs are intentionally accepted by the local write tools.
- **Error confidentiality:** Provider auth/network/API errors map to generic 502 messages; unexpected errors map to generic 500. Store exceptions expose fixed filenames rather than absolute home paths. Source and existing tests support this for expected error classes. MEDIUM-3 concerns truthfulness/partial success, not provider-body/path disclosure. There are no dashboard-specific console logs; the shared launcher error logs are the exception in MEDIUM-1.
- **HTTP framing / body bounds:** POSTs require a JSON media-type prefix and valid JSON, with a streaming 64 KiB accumulated-byte cap checked before routing. No request-controlled shell or file-upload functionality exists. Node rejected a synthetic request combining Content-Length and Transfer-Encoding with HTTP 400. There is no proxy chain in this dashboard design to establish a conventional request-smuggling differential. Header/body timeout behavior is inherited from Node, not comprehensively load-tested.
- **Windows / browser launch:** The shared helper does invoke `cmd /c start` on Windows, so argument arrays alone would not justify accepting arbitrary URLs. For this dashboard, the host/port are server-generated, view is an enum, and token is base64url; the generated URL contains no ampersand, pipe, quotes, percent expansion, redirection, caret, or whitespace. No attacker-supplied command metacharacter reaches `cmd` through the validated tool path. macOS/Linux use executable argument arrays without a shell. Windows behavior was source-reviewed, not executed on this macOS host; no claim is made that the general helper safely accepts arbitrary future HTTP URLs.
- **Lifecycle and transport boundary:** Idle close and token rotation are implemented and covered by tests. All received requests reset the idle timer, including rejected requests; this is request-idle cleanup, not a hard authentication/session expiry. No absolute lifetime guarantee is claimed. Local write/dashboard tools are registered only with local performance configuration; remote-mode gating is covered by the scoped tests.
- **Fresh store integrity/privacy:** Newly created directories/files request 0700/0600; validated state is persisted through random temporary files and rename. Corrupt JSON is left untouched and rejected. The process-local queue correctly protects ordinary same-key concurrent requests in one process. JSONL writes append rather than deliberately rewriting old entries. These controls do not eliminate MEDIUM-2, MEDIUM-3, or LOW-2 and are not a tamper-evident audit mechanism against the owning user.
- **Repository/dependency checks:** Full `npm audit` returned zero advisories. `.gitignore` covers `.env`, `.env.local`, `tokens.json`, node_modules, dist, and coverage; it does not wildcard every possible `.env.*` filename. `git log --all --format=... -- "*.env" "tokens.json"` returned no matching commits. This targeted history check is not an exhaustive content-based secret scan. Console log/error sites throughout `src/` were enumerated and reviewed; no additional dashboard-token log path beyond the shared launcher was found.

**Limitations:** No actual Windows browser launch, browser-extension/history database inspection, hostile cross-account OS test, sustained slowloris/connection-flood test, or production out-of-memory test was performed. Native Node timeouts do not establish immunity to resource exhaustion, and no custom connection/parallel-request quotas were found. HTTPS/HSTS and at-rest encryption were not required for this literal-loopback, single-user filesystem design; local administrator/same-user compromise is not treated as a new remote vulnerability.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | MEDIUM-1: bearer capability in launcher logs | Remove fragment/token from every launcher error log; test asynchronous failure. Fix in current sprint. |
| 2 | Medium | MEDIUM-2: cross-process lost updates | Canonicalize store identity and use an interprocess lock or transactional storage. Fix in current sprint. |
| 3 | Medium | MEDIUM-3: committed state without audit / false rollback | One recoverable state+audit transaction; truthful partial-success errors and idempotent retries. Fix in current sprint. |
| 4 | Low | LOW-1: unbounded audit read | Bounded recent-entry reads, scan budgets, retention, and bounded concurrency. Schedule next sprint. |
| 5 | Low | LOW-2: existing permission/symlink trust | Verify ownership/path types, enforce private existing modes, no-follow handles, and Windows ACL equivalents. Schedule next sprint. |

## Resolution

| Finding | Issue | Commit | Status |
|---------|-------|--------|--------|
| MEDIUM-1 | #295 | a9194dd | Fixed: launcher logs print only the URL before `#`; sync and async failure tests. |
| MEDIUM-2 | #296 | 4b4af99 | Fixed: O_EXCL lockfile with owner token, 30 s stale break, 5 s timeout (`busy`); tested with two independent module instances. The lockfile lives inside the data directory, so path aliases share it. |
| MEDIUM-3 | #293 | 4b4af99 | Fixed: `commitPerformanceChange` restores the previous bytes when the audit append fails; a failed rollback raises `partial_write` without "Nothing was changed.". Idempotent retries not added. |
| LOW-1 | #292 | 0252cca | Fixed: reverse chunked read stops at limit+1 entries, 10,000 lines or 2 MiB; 256 KiB line cap. Retention not added. |
| LOW-2 | #294 | 11e7b77 | Partly fixed: directory owner/type check and 0700 repair; audit log opened with O_NOFOLLOW, regular-file/owner check, 0600 repair. Windows ACL/reparse points and ancestor checks remain open. |
