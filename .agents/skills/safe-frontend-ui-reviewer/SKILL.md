---
name: safe-frontend-ui-reviewer
description: Review and improve an existing frontend application while preserving its business logic, authentication, database, APIs, routes, content, colours, and design direction.
license: MIT
---

# Safe Frontend UI Reviewer

Use this skill when working on an existing React, Next.js, TypeScript, or JavaScript frontend that needs targeted UI and UX improvement without changing what the product does.

## Goals

- Improve responsiveness across common viewport sizes.
- Improve spacing, typography, visual hierarchy, cards, containers, forms, navigation, and animations.
- Improve accessibility, including semantics, labels, focus handling, keyboard navigation, and motion sensitivity.
- Preserve the current product behaviour and overall design direction.
- Produce a clear report of issues found, changes made, and validation results.

## Hard Boundaries

- Preserve existing business logic.
- Preserve authentication flows and database integrations.
- Preserve APIs, routes, and state management.
- Preserve content, colours, and the established design direction.
- Avoid complete redesigns.
- Reuse existing components, utilities, styling conventions, and layout patterns.
- Avoid unnecessary refactoring or architecture changes.
- Never expose, log, commit, or reproduce secrets, tokens, passwords, private keys, or environment-variable values.

If a requested UI change conflicts with these boundaries, prefer the smallest safe change or stop and report the conflict.

## Review Workflow

1. Inspect the app structure, framework, styling system, component patterns, and validation commands.
2. Identify UI issues that can be improved safely without altering application logic or integrations.
3. Prioritize high-value fixes:
   - Broken or weak responsive layouts
   - Inconsistent spacing and container widths
   - Weak typographic hierarchy or unreadable sizing
   - Accessibility gaps in forms, interactive controls, landmarks, headings, and focus states
   - Fragile navigation patterns
   - Card and surface inconsistencies
   - Animations that distract, block interaction, or ignore reduced-motion preferences
4. Implement the minimum viable set of changes using existing components and styling patterns whenever possible.
5. Validate the result with the available linting, type-checking, test, and build commands.
6. Report the problems found, files changed, improvements made, and validation performed.

## Change Rules

- Prefer small, local edits over broad rewrites.
- Keep props, data flow, and state behaviour intact unless a UI fix absolutely requires a minimal safe adjustment.
- Do not replace whole component systems when extending existing styles is sufficient.
- Do not rename routes, API calls, state containers, auth wiring, or database-related code as part of UI cleanup.
- Preserve copy and user-facing content unless the task explicitly requires text fixes.
- Preserve current colour choices and overall visual identity; refine layout and usability instead of rebranding.

## Accessibility And Motion

- Use semantic elements and maintain a logical heading structure where possible.
- Ensure form controls have labels, descriptions, and clear error associations.
- Preserve visible focus indicators or improve them without changing the brand direction.
- Check keyboard access for navigation, dialogs, menus, and form interactions.
- Respect `prefers-reduced-motion` for transitions, animations, parallax, autoplay, and other motion-heavy behaviour.
- Prefer subtle motion that supports comprehension rather than decorative motion.

## Validation

Run the relevant available commands for the project. Prefer the project's documented or existing scripts.

- Linting, such as `npm run lint`, `pnpm lint`, or equivalent
- Type checks, such as `npm run typecheck`, `tsc --noEmit`, or equivalent
- Tests, such as `npm test`, `pnpm test`, or equivalent
- Production build, such as `npm run build`, `next build`, or equivalent

If a command is unavailable or fails for pre-existing reasons, state that clearly and distinguish it from issues introduced by your changes.

## Output Format

At the end of the task, report:

- Problems found
- Files changed
- Improvements made
- Validation performed and results
- Any remaining risks or follow-up items

Keep the report concise and implementation-focused.
