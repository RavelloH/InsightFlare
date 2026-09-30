# Contributing to InsightFlare

Thanks for taking the time to improve InsightFlare.

This project is still early, so the most useful contributions are focused bug fixes, tests, documentation improvements, and small feature changes that are easy to review.

## Development Setup

InsightFlare uses Node.js 24 and pnpm 10.33.0.

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

For local Cloudflare-related development, copy the example environment file and fill in local values:

```bash
cp .dev.vars.example .dev.vars
```

At minimum, local secret-backed flows need `MAIN_SECRET` and `BOOTSTRAP_ADMIN_PASSWORD`. Legacy `DAILY_SALT_SECRET` is still supported for migration tests, but new development should prefer `MAIN_SECRET`.

## Quality Checks

Before opening a pull request, run:

```bash
pnpm run check
```

This runs the same core checks expected by CI:

- TypeScript type checking
- ESLint
- Prettier format check
- i18n key validation
- Vitest tests

For build-related changes, also run:

```bash
pnpm run build:demo
```

## Pull Requests

Keep pull requests small and focused. A good PR should include:

- A clear description of the problem and solution
- Tests for behavioral changes when practical
- Documentation updates for user-facing behavior
- Screenshots or recordings for UI changes when useful

Avoid mixing unrelated refactors with feature or bug-fix changes.

## Tests

Tests are written with Vitest. Prefer colocated tests under `__tests__` directories near the code being tested.

```bash
pnpm run test
pnpm run test:coverage
```

## Documentation

User-facing behavior should be documented in the README or project docs when it affects installation, deployment, configuration, privacy behavior, APIs, or tracking behavior.

## Security Issues

Do not open public issues for security vulnerabilities. Follow the reporting process in [SECURITY.md](SECURITY.md).
