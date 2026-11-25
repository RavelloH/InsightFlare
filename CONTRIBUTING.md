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

Before opening or updating a pull request, run the fast incremental check:

```bash
pnpm check
```

Use `pnpm check:fix` for safe formatting and lightweight lint fixes. Run
targeted tests and other relevant checks for your changes. For a complete local
validation, use `pnpm check:verify` (strict) or `pnpm check:full` (with
automatic fixes).

The required CI Gate verifies the complete project, including typed ESLint,
TypeScript, contracts, translations, specs, schema, labels, tests and coverage,
Demo build, and deploy artifact packaging. Pre-commit and pre-push retain the
repository admission policy; never bypass those hooks to publish files.

## Pull Requests

Keep pull requests small and focused. A good PR should include:

- A clear description of the problem and solution
- Tests for behavioral changes when practical
- Documentation updates for user-facing behavior
- Screenshots or recordings for UI changes when useful

Avoid mixing unrelated refactors with feature or bug-fix changes.

Use a feature branch rather than pushing development changes directly to main.
Fix failed checks in the same PR. Enable auto-merge after review, when appropriate;
the required CI Gate must pass before merging. For an approved change, run
`gh pr merge --auto --squash` to request automatic merging when the required
checks pass. If the base branch has changed, update the PR before merging.

## Releases

Prepare the version bump, changelog, generated OpenAPI and Skills documents,
and release index together in a release PR. Commit the changelog before running
`pnpm generate:release-index` so the generator has Git metadata. Preserve the
changelog commit in the main history (use a merge commit for release PRs).
The release PR runs full E2E. Publishing uses the verified main SHA and never
commits generated files back to main. To retry a release, dispatch CI on main
with the matching `release_version` input.

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
