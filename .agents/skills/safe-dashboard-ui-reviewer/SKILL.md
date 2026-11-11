---
name: safe-dashboard-ui-reviewer
description: Review and improve dashboard UI in an existing frontend application while preserving its business logic, authentication, database, APIs, routes, content, colours, and design direction.
license: MIT
---

# Safe Dashboard UI Reviewer

Use this skill when an existing React, Next.js, TypeScript, or JavaScript dashboard needs safer UI refinement without changing business behaviour, integrations, or the product's visual identity.

## Goals

- Improve dense layouts, summaries, cards, filters, tables, side panels, and control hierarchy.
- Improve scanability and responsiveness in information-heavy screens.
- Preserve business behaviour, content, colours, and overall design direction.
- Keep changes incremental and consistent with existing dashboard patterns.

## Hard Boundaries

- Preserve existing business logic.
- Preserve authentication, database integrations, APIs, routes, and state management.
- Preserve content, colours, and the established design direction.
- Avoid redesigns, unnecessary refactors, and large component rewrites.
- Reuse existing table, card, filter, metric, and panel components whenever possible.
- Never expose or commit secrets, tokens, passwords, private keys, or environment-variable values.

## Review Workflow

1. Inspect key dashboard views, filters, summaries, tables, charts, panels, and empty states.
2. Identify safe UI issues that can be improved without altering product logic.
3. Prioritize:
   - Weak hierarchy in dense screens
   - Inconsistent spacing between metrics, cards, and controls
   - Hard-to-scan tables or filters
   - Fragile responsive behaviour in dashboards
   - Overcrowded action areas
4. Apply the smallest safe improvements using existing UI patterns and layout conventions.
5. Run the available linting, type checks, tests, and build commands.
6. Report issues found, files changed, improvements made, and validation results.

## Change Rules

- Preserve metrics, labels, routes, API calls, auth gating, and data wiring.
- Do not rewrite charting or table architecture unless a tiny local UI fix is required.
- Preserve colour usage and product identity while improving hierarchy and clarity.

## Validation

Run the relevant available project commands:

- Linting
- Type checks
- Tests
- Build

If the codebase includes visual regression or dashboard-specific tests, run them when available.

## Output Format

At the end of the task, report:

- Problems found
- Files changed
- Improvements made
- Validation performed and results
- Remaining dashboard-UI risks or follow-up items
