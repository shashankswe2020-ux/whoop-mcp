# whoop-mcp

MCP server to connect to WHOOP API.

## Table of Contents

- [GitHub Copilot Integration](#github-copilot-integration)
  - [Custom Agents](#custom-agents)
  - [Agent Skills](#agent-skills)
  - [Project Instructions](#project-instructions)
  - [Reference Checklists](#reference-checklists)
- [Usage Guide](#usage-guide)
  - [Invoking Agents](#invoking-agents)
  - [Using Skills](#using-skills)
  - [Skill Discovery](#skill-discovery)

---

## GitHub Copilot Integration

This repository includes a comprehensive GitHub Copilot configuration with custom agents, skills, and project instructions to enhance AI-assisted development.

### Custom Agents

Located in `.github/agents/`, these are specialized personas that Copilot can adopt for specific tasks:

| Agent | Invocation | Description |
|-------|------------|-------------|
| **Build** | `@build` | Implement tasks incrementally — TDD cycle with build, test, verify, commit |
| **Code Simplify** | `@code-simplify` | Simplify code for clarity and maintainability without changing behavior |
| **Plan** | `@plan` | Break work into small verifiable tasks with acceptance criteria |
| **Review** | `@review` | Five-axis code review tailored to the WHOOP MCP project |
| **Ship** | `@ship` | Pre-launch checklist for npm publish + Claude Desktop integration |
| **Spec** | `@spec` | Write or update specifications before writing code |
| **Test** | `@test` | TDD workflow — failing tests first, Prove-It pattern for bugs |
| **Issue Orchestrator** | `@issue-orchestrator` | Triage open GitHub issues, categorize by type, and dispatch sub-agents to resolve them |
| **Code Reviewer** | `@code-reviewer` | Five-axis code review covering correctness, readability, architecture, security, and performance |
| **Security Auditor** | `@security-auditor` | Vulnerability detection, threat modeling, OWASP Top 10 compliance checks |
| **Test Engineer** | `@test-engineer` | Test strategy design, coverage analysis, and the Prove-It pattern for bugs |

### Agent Skills

Located in `.github/skills/`, these are reusable workflows that Copilot loads on demand. Skills are organized by development phase:

| Phase | Skills |
|-------|--------|
| **Define** | `idea-refine`, `spec-driven-development` |
| **Plan** | `planning-and-task-breakdown` |
| **Build** | `incremental-implementation`, `source-driven-development`, `context-engineering`, `frontend-ui-engineering`, `api-and-interface-design` |
| **Verify** | `test-driven-development`, `browser-testing-with-devtools`, `debugging-and-error-recovery` |
| **Review** | `code-review-and-quality`, `security-and-hardening`, `performance-optimization`, `code-simplification` |
| **Ship** | `git-workflow-and-versioning`, `ci-cd-and-automation`, `documentation-and-adrs`, `shipping-and-launch`, `deprecation-and-migration` |
| **Meta** | `using-agent-skills` (discovery and routing) |

### Project Instructions

The `.github/copilot-instructions.md` file provides project-level coding standards that apply to all Copilot interactions:

- **Testing**: TDD, Prove-It pattern, test hierarchy
- **Code Quality**: Five-axis review, CI gates
- **Implementation**: Incremental development, verification before commit
- **Boundaries**: What to always do, ask first, or never do

### Reference Checklists

Located in `references/`, these are quick-reference guides for common concerns:

| Reference | Purpose |
|-----------|---------|
| `accessibility-checklist.md` | WCAG 2.1 AA compliance |
| `performance-checklist.md` | Core Web Vitals targets |
| `security-checklist.md` | OWASP Top 10 reference |
| `testing-patterns.md` | AAA pattern, mocking, component/E2E patterns |

---

## Usage Guide

### Invoking Agents

In GitHub Copilot Chat (VS Code, GitHub.com, or CLI), use the `@` symbol followed by the agent name:

```
@build Implement the next task from the implementation plan
@code-simplify Simplify the error handling in src/api/client.ts
@plan Break down Task 9 into sub-tasks
@review Review recent changes to src/auth/
@ship Run the full pre-launch checklist
@spec Write a spec for adding a new workout endpoint
@test Write tests for the token refresh flow
@issue-orchestrator triage
@issue-orchestrator #14
@code-reviewer Review this PR for security issues
@security-auditor Audit this authentication flow
@test-engineer Analyze test coverage for the user module
```

**What each agent does:**

#### @build
Implements features using a strict TDD cycle:
1. Picks the next task from the implementation plan
2. Writes failing tests (RED), implements code (GREEN), refactors
3. Runs full verification (test, build, typecheck, lint)
4. Dispatches sub-agents for review before committing

Skills used: `incremental-implementation`, `test-driven-development`, `debugging-and-error-recovery`

#### @code-simplify
Reduces code complexity without changing behavior:
1. Identifies simplification opportunities (nesting, duplication, naming)
2. Applies each change incrementally with test verification
3. Dispatches sub-agents to validate the result

Skills used: `code-simplification`, `code-review-and-quality`

#### @plan
Produces task breakdowns without writing code:
1. Reads existing specs and implementation status
2. Decomposes work into ordered, verifiable tasks
3. Consults sub-agents for architectural and testing input

Skills used: `planning-and-task-breakdown`

#### @review
Conducts project-specific five-axis code review:
1. Evaluates correctness, readability, architecture, security, performance
2. Checks WHOOP-specific concerns (API spec compliance, token handling)
3. Dispatches specialized sub-agents for deep analysis

Skills used: `code-review-and-quality`, `security-and-hardening`, `performance-optimization`

#### @ship
Runs the complete pre-launch checklist:
1. Code quality — tests, build, typecheck, lint, coverage
2. Security — npm audit, secrets check, token permissions
3. Packaging — bin field, shebang, tarball contents
4. Integration — MCP Inspector, Claude Desktop config
5. Documentation — README, changelog, license

Skills used: `shipping-and-launch`, `ci-cd-and-automation`, `documentation-and-adrs`, `git-workflow-and-versioning`

#### @spec
Writes specifications before code:
1. Gathers requirements (objective, tools, auth, constraints)
2. Produces a structured spec with acceptance criteria
3. Consults sub-agents before finalizing

Skills used: `spec-driven-development`

#### @test
Practices strict test-driven development:
1. Writes failing tests before implementation (RED → GREEN → REFACTOR)
2. For bugs, uses the Prove-It pattern (reproduce with test first)
3. Dispatches sub-agents for review and coverage analysis

Skills used: `test-driven-development`, `debugging-and-error-recovery`

#### @issue-orchestrator
Triages and resolves open GitHub issues by dispatching sub-agents:
1. Scans open issues (or accepts a specific issue number like `#14`)
2. Classifies each issue (security, bug, code-quality, testing, dependency)
3. Prioritizes by severity and dispatches the appropriate sub-agent
4. Reviews sub-agent output before marking the issue as resolved

Sub-agents dispatched: `code-reviewer`, `security-auditor`, `test-engineer`

#### @code-reviewer
Evaluates code across five dimensions:
1. **Correctness** — Does it do what the spec says?
2. **Readability** — Can others understand it?
3. **Architecture** — Does it fit the system design?
4. **Security** — Are there vulnerabilities?
5. **Performance** — Any bottlenecks?

Findings are categorized as **Critical**, **Important**, or **Suggestion**.

#### @security-auditor
Performs security-focused review checking:
- Input validation and injection vectors
- Authentication/authorization flows
- Data protection and encryption
- Security headers and CORS
- Third-party integration security

Findings are classified by severity: **Critical**, **High**, **Medium**, **Low**, **Info**.

#### @test-engineer
Helps with test strategy:
- Analyzes existing coverage
- Recommends test levels (unit/integration/E2E)
- Follows the **Prove-It Pattern** for bugs (write failing test first)
- Ensures tests verify behavior, not implementation

### Using Skills

Skills are automatically loaded by Copilot when relevant to your task. In VS Code, you can use the `/skills` command in chat to view available skills.

Each skill encodes a senior engineer's workflow for a specific task type. For example:

```
"I need to implement a new API endpoint"
→ Copilot loads: api-and-interface-design, test-driven-development
```

### Skill Discovery

The `using-agent-skills` skill provides a decision tree for choosing the right skill:

```
Task arrives
    │
    ├── Vague idea? ──────────────→ idea-refine
    ├── New feature? ─────────────→ spec-driven-development
    ├── Have spec, need tasks? ───→ planning-and-task-breakdown
    ├── Implementing code? ───────→ incremental-implementation
    ├── Writing tests? ───────────→ test-driven-development
    ├── Something broke? ─────────→ debugging-and-error-recovery
    ├── Reviewing code? ──────────→ code-review-and-quality
    ├── Committing? ──────────────→ git-workflow-and-versioning
    └── Deploying? ───────────────→ shipping-and-launch
```

### Typical Feature Workflow

For a complete feature, skills are typically used in this sequence:

1. `idea-refine` — Refine vague ideas
2. `spec-driven-development` — Define requirements
3. `planning-and-task-breakdown` — Break into tasks
4. `context-engineering` — Load right context
5. `incremental-implementation` — Build slice by slice
6. `test-driven-development` — Prove each slice works
7. `code-review-and-quality` — Review before merge
8. `git-workflow-and-versioning` — Clean commits
9. `documentation-and-adrs` — Document decisions
10. `shipping-and-launch` — Deploy safely

---

## Contributing

When contributing to this repository, Copilot will automatically use the configured agents and skills. Follow the project coding standards in `.github/copilot-instructions.md`.
