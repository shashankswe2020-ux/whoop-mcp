# GitHub Governance Setup

This repository includes configuration and templates for dependency hygiene, issue intake, and backlog visibility.

## Automated dependency updates

- Dependabot is configured in `.github/dependabot.yml` for:
  - npm dependencies
  - GitHub Actions
- Update cadence: weekly

## Branch protection

Branch protection intent is captured in `.github/settings.yml` for `main`:

- Require pull request reviews before merge (minimum 1 approval)
- Dismiss stale approvals when new commits are pushed
- Require status checks to pass before merge:
  - `Test, Lint & Build (20.x)`
  - `Test, Lint & Build (22.x)`
- Require branches to be up to date before merge (`strict: true`)
- Enforce rules for administrators

> To apply this file automatically, install the [Probot Settings app](https://github.com/apps/settings) on the repository.  
> If you prefer manual setup, mirror the same values in repository **Settings → Branches**.

## GitHub Projects backlog board

1. Create a GitHub Project board (for example, `whoop-mcp backlog`).
2. Copy the board URL and set repository variable `BACKLOG_PROJECT_URL`.
3. Create a fine-grained PAT with `project` write access and set it as `ADD_TO_PROJECT_PAT`.
4. The workflow `.github/workflows/project-backlog.yml` will automatically add new issues and PRs to the board.

Issue templates link users to the project board from `.github/ISSUE_TEMPLATE/config.yml`.
