# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - Unreleased

### Added
- OpenAPI 3.1 export: `api-drift openapi [--out openapi.json] [--yaml] [--title ...]
  [--api-version ...] [--endpoint ...]` and `toOpenApi(baseline, options)` in `api-drift/core`.
  - Endpoint keys become paths and operations: `:id` segments turn into named path parameters
    (`/repos/{repoId}/pulls/{pullId}`), kept query keys into query parameters (fixed values as an
    `enum`), status classes into `2XX`/`4XX`/`5XX` responses.
  - Hosts become `servers` (per path item when several hosts are present). The same route on
    several hosts is one operation whose schema merges what each host returned.
  - Shapes become JSON Schema 2020-12 under `components.schemas` (named like `api-drift types`):
    types, formats, enums, `required` from presence counts, nullability as type arrays, array
    items, `additionalProperties` for id-keyed dictionaries, `anyOf` for rich unions.
  - No example values, URLs, ids, timestamps or sample counts. Keys are sorted, so the output is
    byte-for-byte deterministic and diffs cleanly in git.
- `shapeToJsonSchema`, `openApiPath`, `openApiToJson`, `unmappedKeys` and a dependency-free YAML
  emitter, `toYaml`, all exported from `api-drift/core`.

### Changed
- `api-drift/core` size budget raised from 12 KB to 14 KB min+gzip (13.5 KB with the exporter).
  `api-drift`, `api-drift/report` and `api-drift/axios` are unchanged.

## [0.1.0] - Unreleased

First release.

### Engine (`api-drift/core`)
- `infer`: shapes for null, boolean, integer, number, string, array, object and unions, with
  observation counts, array length bounds and 15 string formats (date-time, date, time, email, uri,
  uuid, ipv4, ipv6, hex color, semver, base64, jwt, phone, numeric string, empty).
- Enum capture for low-cardinality code-like strings (`enumMaxValues` 12, `enumMinSamples` 20),
  with free text, formatted values, id-like values and personal/secret keys excluded.
- Size guards: `maxDepth` 20, `maxProperties` 500, `maxArrayItems` 50 (evenly spaced sample),
  `maxPayloadBytes` 1 MB. Id-keyed dictionaries collapse into one `additional` shape.
- `merge`: commutative, associative and structurally idempotent (counts are additive);
  property-tested on generated documents.
- `diff`: 18 change kinds graded breaking / risky / info, JSONPath-like paths, human `before`,
  `after` and `message`; ignore paths and severity overrides.
- Endpoint keys `METHOD host /templated/path status-class` with id templating and optional query keys.
- Baselines: versioned, sorted, diff-friendly JSON; `learn`, `mergeBaselines`, `diffBaselines`
  (including status-class changes), strict `parseBaseline` validation.
- `importHar`: build a baseline from a browser HAR export (base64 bodies, filters, stats).
- `generateTypes`: TypeScript interfaces or Zod schemas as source text.

### Runtime (`api-drift`)
- `createDrift` with `learn`, `watch` and `auto` modes (freeze after N samples or T time).
- `wrapFetch` / `patchGlobalFetch`: original `Response` returned untouched, inspection on a
  bounded `clone()` off the request path, errors routed to `onError`.
- `check(key, payload)` for queues, websockets and SDKs; `observe()` for adapters.
- Per-endpoint serialisation, sampling, include/exclude matchers, custom `keyFor`.
- Deduplication per endpoint and change fingerprint with a configurable cooldown.
- Stores: `memoryStore`, `localStorageStore`, `fileStore` (Node, debounced atomic writes), custom.
- Reporters: `consoleReporter`, `webhookReporter` (Slack, Discord, JSON), `jsonlReporter` (Node).

### Adapters and renderers
- `api-drift/axios`: duck-typed response interceptor (successes and error responses).
- `api-drift/report`: terminal text with ANSI colours and Unicode/ASCII symbols, GitHub markdown,
  JSON reports and aligned trees.

### CLI and CI
- `api-drift init | snapshot | check | import-har | diff | types | explain`, with
  `--format pretty|json|markdown`, `--fail-on`, `--update`, `--json-file` and exit codes 0/1/2.
- JSONC config with `${ENV}` / `${ENV:-default}` substitution and secret masking; JSON schema.
- Composite GitHub Action (`action.yml`) writing the markdown report to the job summary.
