# api-drift

> Know when the APIs you depend on change, before your users do.

Third-party APIs change their response shape without notice: a field disappears,
a number becomes a string, `null` starts appearing, a new enum value breaks a
`switch`. Your app finds out in production. Contract-testing tools (Pact, OpenAPI
diffing) assume you own both sides or that the provider publishes a spec.
**api-drift** works from the consumer side with nothing but observed traffic.

npm name `api-drift` is free (checked 2026-10-23). MIT. Do not publish.

## Package

- TypeScript, zero runtime dependencies, ESM + CJS + `.d.ts` (tsup), Node ≥ 18,
  modern browsers, Deno, Bun, Cloudflare Workers / Vercel Edge.
- Entry points: `api-drift` (core + fetch instrumentation), `api-drift/axios`
  (duck-typed interceptor, no axios dependency), `api-drift/node` (file store,
  CLI helpers), `bin: api-drift` (CLI).
- `sideEffects: false`, small: core < 12 KB min+gzip.

## Core concepts

1. **Shape inference** `infer(value, opts?) → Shape`
   - Kinds: null, boolean, integer, number, string, array, object, union.
   - String formats: date-time (ISO 8601), date, time, email, uri, uuid, ipv4,
     ipv6, hex color, semver, base64 (long), jwt, phone-like, numeric-string
     (e.g. "123.45"), empty.
   - Objects: property map with presence counts so merged shapes know which
     fields are always present (required) vs sometimes (optional).
   - Arrays: merged item shape, observed min/max length; tuples not needed.
   - Enums: strings with low cardinality across samples become enums (configurable
     `enumMaxValues`, default 12, `enumMinSamples` default 20); values must look
     like codes (no spaces, ≤ 40 chars) to avoid capturing personal data.
   - Numbers: integer vs float, sign, observed min/max (optional).
   - Size guards: max depth (default 20), max properties per object (500), max
     array items sampled (50), max payload bytes (1 MB) → skip with a warning.
   - **Privacy**: values are never stored, only shapes. Enum capture can be disabled.
2. **Merge** `merge(a, b) → Shape` to learn from many samples (commutative,
   associative, idempotent; property-based tests).
3. **Diff** `diff(baseline, current, opts?) → Change[]` with severity:
   - breaking: field removed (that was required), type changed (incompatible),
     array became object, object became primitive, required → missing
   - risky: became nullable, required → optional, new enum value, string format
     changed (date-time → string), number → integer narrowing, empty array where
     items existed
   - info: new field, enum value disappeared, new optional field, format gained
   Each change has `path` (JSONPath-like `$.data.items[].price`), `kind`,
   `severity`, `before`, `after`, human `message`.
4. **Endpoint keys**: `METHOD host /templated/path status-class`, where path
   segments that look like ids (integers, UUIDs, ObjectIds, hex ≥ 8, slugs with
   digits, emails) become `:id`. Query strings ignored by default (option to keep
   selected keys). User-overridable `keyFor(request)`.
5. **Stores**: `memoryStore()`, `fileStore(path)` (Node; JSON, debounced atomic
   writes), `localStorageStore(prefix)` (browser), custom `{ get, set, list }`.
6. **Modes**: `learn` (merge every sample), `watch` (baseline frozen, report
   drift), `auto` (learn for N samples or T time per endpoint, then freeze).
7. **Reporters**: `consoleReporter()` (pretty, colours on TTY), callbacks
   `onDrift(event)`, `webhookReporter(url, { format: 'slack' | 'discord' | 'json' })`,
   `jsonlReporter(path)`. Each drift event is deduplicated per endpoint + change
   fingerprint, with a configurable cooldown.

## Runtime instrumentation

```ts
import { createDrift } from 'api-drift';
import { fileStore } from 'api-drift/node';

const drift = createDrift({
  store: fileStore('.api-drift/baseline.json'),
  mode: 'auto',
  include: ['api.stripe.com', /\.githubusercontent\.com$/],
  sampleRate: 0.2,
  onDrift: (e) => console.warn(e.summary),
});

export const fetch = drift.wrapFetch(globalThis.fetch); // or drift.patchGlobalFetch()
```

- Wrapped fetch returns the original Response untouched; inspection runs on a
  `clone()` asynchronously; any internal error is swallowed and reported via
  `onError`. Zero added latency on the request path.
- Only JSON responses (content-type includes `json`), bounded size.
- `drift.check(key, payload)` for manual use (queues, websockets, SDKs).

## CLI (`npx api-drift`)

- `init`: writes `api-drift.config.json` with commented examples.
- `snapshot`: calls every endpoint in the config (method, url, headers with
  `${ENV_VAR}` substitution, body, samples per endpoint, timeout), infers and
  writes `.api-drift/baseline.json`.
- `check`: calls endpoints again, diffs against the baseline, prints a report,
  exits 1 on `--fail-on breaking` (default) / `risky` / `never`. Output formats:
  `--format pretty | json | markdown` (markdown fits `$GITHUB_STEP_SUMMARY` and
  PR comments).
- `import-har <file.har>`: builds a baseline from a browser HAR export (group by
  endpoint key, merge all JSON responses). Killer feature: record a session in
  DevTools, get a contract.
- `diff <a> <b>`: diff two baselines or two raw JSON payloads.
- `types [--out file] [--zod]`: generate TypeScript interfaces or Zod schemas
  (as source text, no zod dependency) from a baseline.
- `explain <endpoint-key>`: print the inferred contract as a readable tree.

## GitHub Action

`action.yml` at the repo root (composite): runs `npx api-drift check --format markdown`,
appends to the step summary, fails on breaking changes. Example workflow in
`examples/github-action.yml` (scheduled + on pull_request).

## Quality

- vitest, ≥ 150 tests: inference per kind and format, merge algebra (property
  tests with a tiny hand-written generator, no fast-check dependency needed),
  diff matrix, endpoint templating, fetch wrapper (with a local test server on
  port 5184 or mocked Response), stores, CLI commands (spawned in a temp dir),
  HAR import with a fixture HAR, type generation snapshots.
- `examples/`: Node script, Next.js route, Cloudflare Worker, axios.
- README that sells it: problem, 30-second quick start, how it works (diagram in
  ASCII or mermaid), API reference, CLI reference, FAQ (privacy, performance),
  comparison table (Pact, OpenAPI diff tools, Optic), roadmap.
- `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, LICENSE (MIT).
- Expose a browser-safe subpath `api-drift/core` (infer, merge, diff, types
  generator) so the Driftwatch playground can run it client-side.
