---
name: safe-navigation-flow-reviewer
description: Review and improve navigation flow in an existing frontend application while preserving its business logic, authentication, database, APIs, routes, content, colours, and design direction.
license: MIT
---

# Safe Navigation Flow Reviewer

Use this skill when an existing React, Next.js, TypeScript, or JavaScript frontend needs clearer navigation and interaction flow without changing route structure or application behaviour.

## Goals

- Improve wayfinding, menu clarity, active states, and page-to-page flow.
- Improve the discoverability of primary actions and common navigation paths.
- Preserve business behaviour, routes, content, colours, and design direction.
- Keep changes local and aligned with the current UI system.

## Hard Boundaries

- Preserve existing business logic.
- Preserve authentication, database integrations, APIs, routes, and state management.
- Preserve content, colours, and the established design direction.
- Avoid redesigns, unnecessary refactors, and route changes.
- Reuse existing navigation components, link patterns, and page shells whenever possible.
- Never expose or commit secrets, tokens, passwords, private keys, or environment-variable values.

## Review Workflow

1. Inspect main navigation, subnavigation, breadcrumbs, menus, tabs, and high-traffic interaction paths.
2. Identify safe navigation issues that can be improved without changing information architecture.
3. Prioritize:
   - Weak or missing active states
   - Unclear primary vs secondary actions
   - Hard-to-discover navigation affordances
   - Inconsistent link and button treatment
   - Fragile mobile nav behaviour
   - Keyboard or focus issues in menus and tabs
4. Apply the smallest safe improvements using existing components and styles.
5. Run the available linting, type checks, tests, and build commands.
6. Report issues found, files changed, improvements made, and validation results.

## Change Rules

- Do not rename routes, move pages, or change auth gating as part of navigation cleanup.
- Preserve content and overall page structure unless a tiny local UI adjustment is necessary.
- Prefer state and styling fixes over structural rewrites.

## Validation

Run the relevant available project commands:

- Linting
- Type checks
- Tests
- Build

If the codebase includes end-to-end navigation coverage, run it and report the results.

## Output Format

At the end of the task, report:

- Problems found
- Files changed
- Improvements made
- Validation performed and results
- Remaining navigation-flow risks or follow-up items
