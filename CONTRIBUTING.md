# Contributing to api-drift

Thanks for helping. This document covers the setup, the rules the code base keeps, and how to
add the most common kinds of change.

## Setup

```bash
npm install
npm run typecheck   # strict TS, plus a browser-only pass with no Node typings
npm test            # vitest: unit, property, runtime, CLI (spawned) tests
npm run build       # tsup: ESM + CJS + .d.ts into dist/, plus dist/cli.js
npm run size        # minified + gzipped size of every entry point, against its budget
```

Node 22 or newer is recommended for development (the published package supports Node 18+).
`npm test` starts a local HTTP server on **port 5184** for the duration of the run (see
`test/setup/global-setup.ts`); make sure that port is free.

## Ground rules

1. **Zero runtime dependencies.** Anything in `dependencies` is a bug.
2. **Browser-safe entries stay browser-safe.** `src/core`, `src/runtime`, `src/index.ts`,
   `src/report.ts` and `src/axios.ts` must not import `node:*` or touch `process`/`Buffer`.
   `tsconfig.browser.json` (no Node typings) and `test/package.test.ts` (bundle inspection)
   enforce it. Node-only code goes in `src/node` and is exported from `api-drift/node`.
3. **Size budget.** `api-drift` and `api-drift/core` stay under 12 KB minified + gzipped.
   `npm run size` fails otherwise, and so does `test/package.test.ts`.
4. **Never throw into the user's request path.** Everything the fetch wrapper and `observe()` do
   runs in try/catch and reports through `onError`.
5. **Values are not data we keep.** New inference features must store shapes, not values. If a
   feature needs values (like enums), it must be opt-out and must respect `enumExclude`.
6. **Deterministic output.** Shapes are built with a fixed field order and sorted keys, and
   baselines serialise identically for identical input. Tests compare exact strings.
7. **Unit tests are offline.** Use the mock server (`mock()` in `test/helpers`) or fake fetch
   functions, never the real network.

## Project layout

```text
src/
  core/        pure engine: shape, infer, merge, diff, describe, formats, endpoint, match,
               baseline, har, typegen, report, tree, style, util
  runtime/     createDrift, stores, reporters, dedup, body reading
  node/        fileStore, jsonlReporter, config (JSONC + env), http, runner (snapshot/check)
  cli/         argument parser and commands
  index.ts     api-drift            core.ts -> api-drift/core (src/core/index.ts)
  report.ts    api-drift/report     axios.ts -> api-drift/axios    node.ts -> api-drift/node
  cli.ts       bin
test/          one file per area; fixtures/session.har; helpers/ (server, CLI runner, PRNG)
examples/      Node script, Next.js route, Cloudflare Worker, axios, workflow, config
schema/        config JSON schema (shipped in the package)
```

## Adding a change kind

1. Add it to `ChangeKind` and `KINDS_BY_SEVERITY` in `src/core/diff.ts`, and emit it from the
   relevant `compare*` function with a short, specific `message` plus `before` / `after`.
2. Add it to the `propertyNames` enum in `schema/config.schema.json` (a test checks they match).
3. Add rows to the table in README.md ("What counts as drift").
4. Add tests in `test/diff.test.ts`: one that fires, one that must not fire. If the change is
   evidence-based, test the threshold.
5. Run the property tests: a sample that was learned must never produce breaking or risky
   changes against its own baseline (`test/merge.test.ts`, "is sound").

## Adding a string format

Add the pattern to `FORMAT_PATTERNS` (or a function) in `src/core/formats.ts`, place it in
`detectFormat` before any broader format it overlaps with, and add positive and negative cases to
`test/formats.test.ts`. Generated Zod schemas reuse `FORMAT_PATTERNS`, so keep patterns precise.

## Commits and releases

- Keep commits focused; describe the user-visible effect.
- Update `CHANGELOG.md` under the unreleased version.
- Before a release: `npm run typecheck && npm test && npm run build && npm run size`, then
  `npm pack --dry-run` and check that only `dist/`, `schema/`, `README.md`, `CHANGELOG.md` and
  `LICENSE` are included. `prepublishOnly` runs the same checks.
