---
name: safe-mobile-layout-reviewer
description: Review and improve mobile layout behaviour in an existing frontend application while preserving its business logic, authentication, database, APIs, routes, content, colours, and design direction.
license: MIT
---

# Safe Mobile Layout Reviewer

Use this skill when an existing React, Next.js, TypeScript, or JavaScript frontend needs better mobile responsiveness without changing how the product works.

## Goals

- Improve stacking, wrapping, spacing, and viewport behaviour on small screens.
- Reduce overflow, clipping, cramped layouts, and hard-to-tap interactions.
- Preserve business behaviour, integrations, routes, content, colours, and overall design direction.
- Keep changes incremental and aligned with existing styling patterns.

## Hard Boundaries

- Preserve existing business logic.
- Preserve authentication, database integrations, APIs, routes, and state management.
- Preserve content, colours, and the established design direction.
- Avoid complete redesigns, broad rewrites, and unnecessary refactors.
- Reuse existing layout primitives, utility classes, breakpoints, and components whenever possible.
- Never expose or commit secrets, tokens, passwords, private keys, or environment-variable values.

## Review Workflow

1. Inspect key screens at common mobile widths.
2. Identify safe issues that reduce usability on phones and small tablets.
3. Prioritize:
   - Horizontal overflow
   - Broken stacking or wrapping
   - Inconsistent padding and spacing
   - Touch targets that are too small or too close together
   - Text that becomes unreadable at small sizes
   - Sticky elements or modals that block core actions on small screens
4. Implement the smallest safe layout fixes using the current design system and breakpoint patterns.
5. Run the available linting, type checks, tests, and build commands.
6. Report issues found, files changed, improvements made, and validation results.

## Change Rules

- Preserve content structure, API usage, auth flows, and route behaviour.
- Prefer breakpoint-level fixes over component rewrites.
- Keep existing colours and visual identity intact.
- Avoid desktop regressions while improving mobile behaviour.

## Validation

Run the relevant available project commands:

- Linting
- Type checks
- Tests
- Build

If the codebase includes viewport or visual regression checks, run them when available.

## Output Format

At the end of the task, report:

- Problems found
- Files changed
- Improvements made
- Validation performed and results
- Remaining mobile-layout risks or follow-up items
