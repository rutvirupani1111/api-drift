# api-drift build status

Last updated: 2026-10-23 (milestone 4: complete; all "done means" checks pass)

## Done
- `npm run build`, `npm run typecheck` (strict + browser-only pass), `npm test` (329 tests, 15 files)
  and `node scripts/size.mjs` all pass. `npm pack --dry-run`: 52 files, 151.5 kB packed
  (dist/, schema/, README.md, CHANGELOG.md, LICENSE, package.json only).
- Entry points and sizes (min+gzip): `api-drift` 11.67 KB, `api-drift/core` 11.25 KB,
  `api-drift/report` 3.67 KB, `api-drift/axios` 0.58 KB, `api-drift/node` 24.6 KB (no budget).
  The renderer split (`api-drift/report`) exists to keep the first two under the 12 KB budget.
- Dev deps pinned (typescript 5.9.3, tsup 8.5.1, vitest 3.2.7, esbuild 0.27, @types/node 22) because
  Node here is 23.6 and vitest 4/5 + tsup 9 exclude Node 23 in `engines`.
- Source: core engine, runtime (createDrift, fetch wrapper, modes, dedup, stores, reporters),
  axios adapter, Node subpath (fileStore, jsonlReporter, config, runSnapshot/runCheck), CLI
  (init, snapshot, check, import-har, diff, types, explain), composite `action.yml`.
- Docs: README, docs/ARCHITECTURE.md, CHANGELOG.md, CONTRIBUTING.md, LICENSE (MIT, Rutvi Rupani),
  schema/config.schema.json, examples/ (Node script, Next.js route, Cloudflare Worker, axios,
  GitHub workflow, config).
- Smoke tests (real network, scratch folder, built `dist`):
  - init/snapshot/check on api.github.com/repos/nodejs/node, registry.npmjs.org/react/latest and
    api.open-meteo.com forecast: 200s, 129 / 60 / 23 fields, check PASS.
  - Baseline edited to simulate drift: 2 breaking / 1 risky / 1 info, exit 1; markdown + JSON OK;
    generated TS for the 3 real APIs compiles with `tsc --strict`.
  - import-har on the fixture: 7 responses, 4 endpoints.
  - action.yml script run with simulated GITHUB_OUTPUT/STEP_SUMMARY: drift, config error, fail-on never.
  - examples/node-script.mjs against live APIs (patchGlobalFetch + fileStore) and runtime watch
    mode on live GitHub traffic (event emitted, query string stripped).
  - Packed tarball installed into a throwaway project: `npx api-drift`, ESM + CJS imports of all
    entries, and `.d.ts` resolution under `bundler` and `node16` without @types/node.

## In progress
- nothing

## Next (roadmap, not started)
- Discriminated unions, OpenAPI/JSON Schema export, header contracts, GraphQL keys, KV/Redis stores.

## Known issues / notes for whoever continues
- No `repository`/`homepage` in package.json; the action is referenced as `OWNER/api-drift` in
  README and examples. Fill in once the GitHub repository exists (npm needs `repository` to resolve
  README's relative links).
- The action prefers `dist/cli.js` from the action checkout; dist is gitignored, so a published
  action tag must commit dist or rely on the npx fallback (`version` input).
- Not published to npm (by instruction).

## Test count
- 329
