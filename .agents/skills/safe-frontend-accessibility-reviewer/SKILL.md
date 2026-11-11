---
name: safe-frontend-accessibility-reviewer
description: Review and improve accessibility in an existing frontend application while preserving its business logic, authentication, database, APIs, routes, content, colours, and design direction.
license: MIT
---

# Safe Frontend Accessibility Reviewer

Use this skill when an existing React, Next.js, TypeScript, or JavaScript frontend needs accessibility improvements without changing the product's business behaviour.

## Goals

- Improve semantics, landmarks, heading structure, labels, and keyboard access.
- Improve focus visibility, interaction clarity, and screen-reader friendliness.
- Respect `prefers-reduced-motion` and reduce avoidable motion burden.
- Preserve behaviour, content, colours, routes, APIs, and integrations.

## Hard Boundaries

- Preserve existing business logic.
- Preserve authentication, database integrations, APIs, routes, and state management.
- Preserve content, colours, and overall design direction.
- Avoid redesigns, unnecessary refactors, or broad component rewrites.
- Reuse existing components and styling patterns whenever possible.
- Never expose or commit secrets, tokens, passwords, private keys, or environment-variable values.

## Review Workflow

1. Inspect layouts, navigation, forms, dialogs, menus, and interactive controls.
2. Identify concrete accessibility issues that can be fixed safely.
3. Prioritize:
   - Missing labels or descriptions
   - Weak heading or landmark structure
   - Inaccessible keyboard flows
   - Missing or unclear focus states
   - Motion that ignores reduced-motion preferences
   - Non-semantic interactive patterns that can be corrected locally
4. Apply the smallest safe fixes using the existing UI system.
5. Run the available linting, type checks, tests, and build commands.
6. Report issues found, files changed, improvements made, and validation results.

## Change Rules

- Prefer semantic HTML and small attribute-level fixes first.
- Improve ARIA usage only when native semantics are insufficient.
- Keep copy intact unless a fix requires minimal clarification text already consistent with the product.
- Do not change route structure, auth behaviour, API usage, or data flow as part of accessibility cleanup.

## Validation

Run the relevant available project commands:

- Linting
- Type checks
- Tests
- Build

If accessibility checks are already present in the codebase, run those as well.

## Output Format

At the end of the task, report:

- Problems found
- Files changed
- Improvements made
- Validation performed and results
- Remaining accessibility risks or follow-up items
