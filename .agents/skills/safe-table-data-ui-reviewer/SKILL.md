---
name: safe-table-data-ui-reviewer
description: Review and improve data-table UI in an existing frontend application while preserving its business logic, authentication, database, APIs, routes, content, colours, and design direction.
license: MIT
---

# Safe Table Data UI Reviewer

Use this skill when an existing React, Next.js, TypeScript, or JavaScript frontend needs better data-table usability without changing underlying data behaviour or business rules.

## Goals

- Improve table readability, row density, filters, actions, and responsive behaviour.
- Improve scanability and reduce friction in data-heavy screens.
- Preserve business behaviour, data wiring, content, colours, and overall design direction.
- Keep changes incremental and based on current table patterns.

## Hard Boundaries

- Preserve existing business logic.
- Preserve authentication, database integrations, APIs, routes, and state management.
- Preserve content, colours, and the established design direction.
- Avoid redesigns, large table rewrites, and unnecessary refactors.
- Reuse existing table, filter, badge, pagination, and layout components whenever possible.
- Never expose or commit secrets, tokens, passwords, private keys, or environment-variable values.

## Review Workflow

1. Inspect key tables, filters, row actions, pagination, and mobile fallbacks.
2. Identify safe issues that reduce clarity or usability.
3. Prioritize:
   - Hard-to-scan row density or column spacing
   - Weak hierarchy between primary and secondary row actions
   - Filter controls that crowd the table shell
   - Overflow issues on smaller screens
   - Missing empty, loading, or no-results support around tables
4. Apply the smallest safe improvements using existing data UI patterns.
5. Run the available linting, type checks, tests, and build commands.
6. Report issues found, files changed, improvements made, and validation results.

## Change Rules

- Preserve data contracts, sort/filter logic, auth gating, and API usage.
- Do not change row meaning, content strategy, or route structure as part of UI cleanup.
- Prefer shell, spacing, and affordance improvements over logic changes.

## Validation

Run the relevant available project commands:

- Linting
- Type checks
- Tests
- Build

If the codebase includes table-focused tests or visual checks, run them when available.

## Output Format

At the end of the task, report:

- Problems found
- Files changed
- Improvements made
- Validation performed and results
- Remaining table-UI risks or follow-up items
