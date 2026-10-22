# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
