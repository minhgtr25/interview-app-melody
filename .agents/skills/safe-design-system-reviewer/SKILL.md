---
name: safe-design-system-reviewer
description: Review and improve design-system consistency in an existing frontend application while preserving its business logic, authentication, database, APIs, routes, content, colours, and design direction.
license: MIT
---

# Safe Design System Reviewer

Use this skill when an existing React, Next.js, TypeScript, or JavaScript frontend needs stronger design-system consistency without changing product behaviour or visual identity.

## Goals

- Improve consistency of tokens, variants, reusable patterns, and shared UI behaviour.
- Reduce one-off styling where an existing component or pattern already fits.
- Preserve business behaviour, integrations, content, colours, and overall design direction.
- Keep changes incremental and aligned with the current component system.

## Hard Boundaries

- Preserve existing business logic.
- Preserve authentication, database integrations, APIs, routes, and state management.
- Preserve content, colours, and the established design direction.
- Avoid redesigns, broad rewrites, and unnecessary refactors.
- Reuse existing components, tokens, utilities, and styling conventions whenever possible.
- Never expose or commit secrets, tokens, passwords, private keys, or environment-variable values.

## Review Workflow

1. Inspect shared components, tokens, utilities, and repeated page patterns.
2. Identify safe inconsistencies that can be improved by standardizing on existing patterns.
3. Prioritize:
   - Variant drift across similar components
   - Repeated one-off spacing, radius, border, or shadow rules
   - Inconsistent typography scales
   - Mixed interaction states for similar controls
4. Apply the smallest safe adjustments using the current design-system direction.
5. Run the available linting, type checks, tests, and build commands.
6. Report issues found, files changed, improvements made, and validation results.

## Change Rules

- Prefer alignment to an existing strong pattern over inventing a new one.
- Do not change content strategy, route structure, API usage, or auth behaviour.
- Avoid replacing the styling system as part of review work.

## Validation

Run the relevant available project commands:

- Linting
- Type checks
- Tests
- Build

If storybook or visual regression checks exist, run them when available.

## Output Format

At the end of the task, report:

- Problems found
- Files changed
- Improvements made
- Validation performed and results
- Remaining design-system risks or follow-up items
