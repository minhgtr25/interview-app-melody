---
name: safe-form-ux-reviewer
description: Review and improve the forms in an existing frontend application while preserving its business logic, authentication, database, APIs, routes, content, colours, and design direction.
license: MIT
---

# Safe Form UX Reviewer

Use this skill when an existing React, Next.js, TypeScript, or JavaScript frontend needs form usability improvements without changing underlying form behaviour or integrations.

## Goals

- Improve form clarity, spacing, labels, error presentation, helper text, and submission affordances.
- Improve accessibility and keyboard flow for form interactions.
- Preserve validation logic, submission behaviour, auth, APIs, and data handling.
- Keep the design aligned with the current product.

## Hard Boundaries

- Preserve existing business logic and form submission logic.
- Preserve authentication, database integrations, APIs, routes, and state management.
- Preserve content, colours, and overall design direction.
- Avoid unnecessary refactors or replacing established form libraries and patterns.
- Reuse existing input, button, error, and layout components whenever possible.
- Never expose or commit secrets, tokens, passwords, private keys, or environment-variable values.

## Review Workflow

1. Inspect key forms, validation states, field groupings, and submit flows.
2. Identify safe improvements that increase clarity and reduce user friction.
3. Prioritize:
   - Missing or weak labels
   - Unclear required-field signalling
   - Error messages that are hard to find or interpret
   - Poor spacing or grouping between related fields
   - Fragile mobile form layouts
   - Weak focus and keyboard behaviour
4. Implement the smallest safe changes using existing form and styling patterns.
5. Run the available linting, type checks, tests, and build commands.
6. Report issues found, files changed, improvements made, and validation results.

## Change Rules

- Preserve field names, data shapes, handlers, validation rules, API wiring, and auth flows.
- Do not rewrite form state management unless a tiny local fix is necessary for a UI issue.
- Preserve product copy unless the task explicitly allows text changes.
- Keep visual changes aligned with existing component patterns and colour choices.

## Validation

Run the relevant available project commands:

- Linting
- Type checks
- Tests
- Build

If the codebase has form-specific tests, prioritize running them and report any pre-existing failures separately.

## Output Format

At the end of the task, report:

- Problems found
- Files changed
- Improvements made
- Validation performed and results
- Remaining form UX risks or follow-up items
