# api-drift build status

Last updated: 2026-10-23 (0.2.0: OpenAPI 3.1 export added; build, typecheck and tests green)

## Done
- 0.2.0, OpenAPI 3.1 export:
  - `src/core/openapi.ts`: `toOpenApi(baseline, options)`, `shapeToJsonSchema`, `openApiPath`,
    `openApiToJson`, `unmappedKeys`, `toYaml` (dependency-free emitter), exported from `api-drift/core`.
  - CLI `api-drift openapi [--out file] [--yaml] [--title] [--api-version] [--endpoint]`;
    `--out x.yaml` implies YAML; custom (non `METHOD host /path`) keys are skipped with a warning.
  - Mapping: `:id` -> named path parameters (`{userId}`, unique per path), kept query keys -> query
    parameters (fixed values as `enum`), status class -> `2XX`/`4XX`, hosts -> `servers` (per path
    item when several hosts), same route on several hosts -> one operation, shapes merged.
    Schemas: JSON Schema 2020-12 in `components.schemas` (names match `api-drift types`), type
    arrays for nullability (enum gets `null` too), `anyOf` for rich unions, `X|empty` strings as
    `anyOf [format, maxLength 0]`, non-standard formats as `x-api-drift-format`, base64 as
    `contentEncoding`. No examples, URLs, ids, timestamps or sample counts. Sorted keys.
  - Tests (`test/openapi.test.ts`, 16 + 1 CLI test): JSON and YAML snapshots from two fixture
    baselines (`test/fixtures/openapi-shop.baseline.json` from the HAR fixture,
    `openapi-multi.baseline.json`: 5 hosts, collisions, query keys, 4xx, unions), a hand-written
    OpenAPI 3.1 structural validator (required fields, path template/parameter agreement, unique
    operationIds, response descriptions, `$ref` resolution, schema keyword whitelist, nullable
    enums) with a negative test proving it catches errors, and a YAML read-back test.
  - Smoke: built CLI on the HAR fixture -> 3 paths, 3 operations; JSON and YAML written.
  - `api-drift/core` size budget raised 12 KB -> 14 KB min+gzip (now 13.54 KB); see
    `scripts/size.mjs` and `test/package.test.ts`.
- `npm run build`, `npm run typecheck` (strict + browser-only pass), `npm test` (346 tests, 16 files)
  and `node scripts/size.mjs` all pass. `npm pack --dry-run`: 52 files, 151.5 kB packed
  (dist/, schema/, README.md, CHANGELOG.md, LICENSE, package.json only).
- Entry points and sizes (min+gzip): `api-drift` 11.67 KB, `api-drift/core` 13.54 KB (was 11.25 KB before 0.2.0),
  `api-drift/report` 3.67 KB, `api-drift/axios` 0.58 KB, `api-drift/node` 24.6 KB (no budget).
  The renderer split (`api-drift/report`) exists to keep the first two under the 12 KB budget.
- Dev deps pinned (typescript 5.9.3, tsup 8.5.1, vitest 3.2.7, esbuild 0.27, @types/node 22) because
  Node here is 23.6 and vitest 4/5 + tsup 9 exclude Node 23 in `engines`.
- Source: core engine, runtime (createDrift, fetch wrapper, modes, dedup, stores, reporters),
  axios adapter, Node subpath (fileStore, jsonlReporter, config, runSnapshot/runCheck), CLI
  (init, snapshot, check, import-har, diff, types, openapi, explain), composite `action.yml`.
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
- Discriminated unions, header contracts, GraphQL keys, KV/Redis stores.
- OpenAPI follow-ups: request bodies (needs request-body contracts first), `--split-by-host`
  for hosts that share routes but differ in contract, optional `x-api-drift-samples` stats.

## Known issues / notes for whoever continues
- No `repository`/`homepage` in package.json; the action is referenced as `OWNER/api-drift` in
  README and examples. Fill in once the GitHub repository exists (npm needs `repository` to resolve
  README's relative links).
- The action prefers `dist/cli.js` from the action checkout; dist is gitignored, so a published
  action tag must commit dist or rely on the npx fallback (`version` input).
- Not published to npm (by instruction).

## Test count
- 346
