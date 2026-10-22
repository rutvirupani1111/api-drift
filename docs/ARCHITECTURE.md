# api-drift architecture

This document explains how api-drift is put together and why. It is written for contributors
and for integrators (such as Driftwatch) who build on the engine.

## Layers

```text
                      ┌───────────────────────────────────────────────┐
  bin: api-drift ───► │ cli/        args, commands, exit codes        │  Node only
                      ├───────────────────────────────────────────────┤
  api-drift/node ───► │ node/       fileStore, jsonl, config, http,   │  Node only
                      │             runSnapshot / runCheck            │
                      ├───────────────────────────────────────────────┤
  api-drift ────────► │ runtime/    createDrift, stores, reporters,   │  any JS runtime
  api-drift/axios ──► │             dedup, body reading               │
                      ├───────────────────────────────────────────────┤
  api-drift/core ───► │ core/       shape, infer, merge, diff,        │  any JS runtime,
  api-drift/report ─► │             endpoint, baseline, har, typegen, │  pure functions
                      │             report, tree, style               │
                      └───────────────────────────────────────────────┘
```

Each layer only imports from the layers below it. `core` has no I/O and no globals beyond `URL`,
`TextDecoder` and `atob`; `runtime` adds `fetch`, timers and optional `localStorage`; `node` adds
the file system and `process`.

### Entry points and the size budget

| Entry | Contents | min+gzip |
| --- | --- | --- |
| `api-drift` | runtime + engine essentials (infer, merge, diff, keys, baselines) | 11.7 KB |
| `api-drift/core` | full engine incl. `generateTypes`, `importHar`, `diffBaselines` | 11.2 KB |
| `api-drift/report` | text / markdown / JSON reports, trees, styles | 3.6 KB |
| `api-drift/axios` | interceptor | 0.6 KB |
| `api-drift/node` | everything Node-side, incl. the CLI's `main` | 24 KB |

The spec budget is 12 KB for the core. The full set of browser-safe code is about 17 KB, so
presentation code (renderers) lives in `api-drift/report` and type generation / HAR import live
in `api-drift/core` rather than in the runtime entry. Everything is tree-shakeable
(`sideEffects: false`), so an app that only calls `createDrift` pays for less than the entry total.

Browser safety is enforced twice: `tsconfig.browser.json` type-checks the browser entries with no
Node typings, and `test/package.test.ts` bundles each entry with esbuild (`platform: neutral`) and
asserts there are no `node:` imports, no `require(` and no `process.*` access, and that the gzip
size is under budget.

## The shape model

```jsonc
{
  "kind": "object",
  "count": 3,                                   // objects observed at this location
  "properties": {
    "id":        { "kind": "integer", "count": 3 },
    "nickname":  { "kind": "string", "count": 1, "formats": ["plain"] },   // 1 of 3: optional
    "avatar_url": {
      "kind": "union",
      "variants": [
        { "kind": "null", "count": 1 },
        { "kind": "string", "count": 2, "formats": ["uri"] }
      ]
    },
    "role":      { "kind": "string", "count": 3, "formats": ["plain"], "values": ["admin", "member"] }
  }
}
```

- **Kinds:** `null`, `boolean`, `integer`, `number`, `string`, `array`, `object`, `union`, plus
  `unknown` for parts the size guards did not inspect.
- **Counts** are the number of values observed at a location with that kind. A property is
  *required* when `countOf(property) >= object.count`. Required and nullable are independent: a
  property that is always present but sometimes `null` is required and nullable.
- **Unions** hold at most one variant per *slot*, ordered by slot: null, boolean, numeric
  (`integer` and `number` share a slot), string, array, object, unknown.
- **Numbers:** `integer` means every value was whole; `number` means at least one had decimals and
  records how many were whole (`integral`). `negative` records the sign. Ranges (`min`/`max`) are
  opt-in because they are values.
- **Strings:** `formats` is the sorted set of formats seen (`plain` = none). `values` holds
  distinct code-like values (enum candidates), and disappears for good once a non-code value is
  seen or the cardinality cap is exceeded.
- **Arrays:** `minItems` / `maxItems` and the merged shape of the sampled items (absent while only
  empty arrays were seen).
- **Objects:** named `properties` (sorted, prototype-less maps), `additional` for id-like keys,
  `truncated` when more than `maxProperties` keys exist.

## Inference

`infer(value, options)` is a single recursive walk that mirrors `JSON.stringify` semantics
(`toJSON` is honoured, `undefined` and functions vanish from objects and become `null` in arrays).

- **Formats** are detected most-specific first: empty, uuid, date-time, date, time, email, jwt,
  uri, ipv4, ipv6, hex color, semver, numeric string, phone, base64, then plain. Cheap guards
  (length, first character, `@`, `://`) skip regexes that cannot match.
- **Enum capture** keeps a value only when all of these hold: enums enabled, the format is `plain`,
  the value is code-like (`[\w.:/+-]`, at most 40 chars, not an identifier with 3+ digits), and the
  key is not personal or secret. The key test splits snake, kebab and camel case into words and
  matches them against a list (`name`, `email`, `phone`, `address`, `token`, `password`, `id`, ...).
- **Dynamic keys:** object keys that are data (integers, UUIDs, hex ids, emails, semver, dates,
  long random ids) are merged into `additional` instead of becoming properties. This keeps ids out
  of the baseline and stops dictionaries from "adding a field" on every new key.
- **Size guards:** containers below `maxDepth` become `unknown`; objects keep at most
  `maxProperties` named keys; arrays and dictionaries sample `maxArrayItems` entries, evenly spaced
  and including the first and last; a byte budget (`maxPayloadBytes`) is charged as nodes are
  visited and aborts inference with `unknown` when exhausted. Each guard warns once per call.

## Merge algebra

`merge(a, b)` combines field by field with operations that are each commutative, associative and
idempotent: set union (formats, enum values, property names), min/max (array bounds, ranges),
logical OR (`negative`, `truncated`), AND on kinds (`integer + integer = integer`, anything with
`number` is `number`). The enum cap is monotone (once the union of values exceeds the cap it stays
absent), so it keeps associativity.

Counts are the exception: they add. That is deliberate: two observations of the same response
are twice the evidence. So the precise statement, which the property tests check on hundreds of
generated documents, is:

- `merge(a, b)` equals `merge(b, a)` exactly;
- `merge(merge(a, b), c)` equals `merge(a, merge(b, c))` exactly;
- `merge(a, a)` equals `a` with every count doubled, so its structure (kinds, formats, enums,
  required/optional ratios) equals `a`'s;
- merging any permutation of a list of samples gives the same result.

The only behaviour that depends on counts is evidence thresholds (`enumMinSamples`,
`minSamples`), which is the point of having counts.

## Diff semantics

`diff(baseline, current)` reports evidence in `current` that the baseline did not allow. It never
reports something merely because `current` saw less (a single response cannot show every enum
value or every optional field). This gives a soundness property, also tested: for any samples
`a` and `b`, `diff(merge(a, b), a)` contains no breaking or risky change.

Rules, per location:

- **New kinds:** a new `null` variant is `nullable` (risky). A new non-null kind is `type-changed`
  (breaking), with tailored messages for container changes; if the baseline only ever saw `null`
  it is `type-learned` (info).
- **Objects:** a required property absent from every current object is `removed` (breaking); one
  absent from some is `optional` (risky); properties the baseline never saw are `added` /
  `added-optional` (info) unless the baseline object was truncated.
- **Strings:** if the baseline had a definite format set, any new format is `format-changed`
  (risky); if it had none, a definite new format is `format-gained` (info). Established enums
  (`count >= enumMinSamples`) report new values as `enum-added` (risky) and, when the current side
  is itself established, vanished values as `enum-removed` (info).
- **Numbers:** after `minSamples` baseline observations, decimals appearing in an integer field
  (`number-widened`) or only integers in a field that never had any (`number-narrowed`) are risky;
  a first negative value is `negative` (info).
- **Arrays:** an array that never was empty and now always is: `emptied` (risky). Items are
  compared under `path[]`.

Paths are JSONPath-like: `$.a.b`, `$["odd-key"]`, `$.items[].price`, `$.versions.*`. Ignore
patterns match a path and its descendants; `*` is a wildcard. Changes are ordered breaking, risky,
info, keeping traversal order within a severity.

## Endpoint keys

`METHOD host /templated/path status-class`. A segment becomes `:id` when it is an integer, UUID,
hex string of 8+ characters with a digit (ObjectIds, SHAs), email, a digit-led value with
separators (dates, versions like `18.2.0`), or a slug mixing letters and digits with a separator
or 8+ characters (`iphone-15-pro`, `cus_N3x8aB2kQ`). API version segments (`v1`, `v2beta1`,
`2.0`) and short words with digits (`oauth2`, `h264`) are kept. Query strings are dropped unless
listed in `keepQuery`. The status class keeps error contracts apart from success contracts.

## Baseline file

```jsonc
{
  "version": 1,
  "generator": "api-drift@0.1.0",
  "updatedAt": "2026-10-23T02:40:00.000Z",
  "endpoints": {
    "GET api.github.com /repos/nodejs/node 2xx": {
      "example": "https://api.github.com/repos/nodejs/node",   // query string removed
      "samples": 3,
      "firstSeen": "...", "lastSeen": "...",
      "frozen": true,                                          // auto mode stopped learning
      "shape": { "kind": "object", ... }
    }
  }
}
```

Serialisation is deterministic: endpoints sorted, entry metadata before the shape, shapes rebuilt
in canonical field order by `normalizeShape`. `parseBaseline` validates every node (unknown kinds,
empty unions, wrong versions throw `BaselineError`) and normalises hand-edited files (merging
duplicate union slots, sorting sets). The runtime `fileStore`, `localStorageStore` entries and the
CLI all share this format.

## Runtime

```text
fetch() ──► original Response ──► caller (unchanged, no await added)
                │
                └─ inspect(): JSON? HEAD/204? content-length? sampleRate? include/exclude? key?
                     │
                     └─ res.clone() ─► readTextCapped(maxPayloadBytes) ─► later() ─► process(key)
                                                                                      │
                     per-key promise chain (no store races) ◄───────────────────────┘
                     infer ─► store.get ─► learning? merge + store.set : diff ─► dedup ─► reporters
```

- `clone()` happens synchronously before the caller can read the body. Our branch is read with a
  byte cap; when it overflows, the reader is cancelled **without awaiting**: cancelling one branch
  of a tee only settles when the other branch is also consumed or cancelled, so awaiting it could
  hang forever on a caller that never reads the body.
- CPU work (parse, infer, diff) runs on a later macrotask so it never competes with the caller's
  own continuation.
- Work is serialised per endpoint key with a promise chain, so concurrent responses never lose
  updates in async stores.
- **Modes:** `learn` always merges; `watch` never writes; `auto` merges until the entry has
  `freezeAfter.samples` samples or `freezeAfter.duration` has passed since `firstSeen`, then marks
  the entry `frozen` and diffs from then on.
- **Dedup:** each reportable change is fingerprinted (FNV-1a of endpoint, path, kind, before,
  after); a fingerprint seen within `cooldown` is dropped. An event is emitted only when at least
  one change survives.
- **Errors:** every step runs inside try/catch or a promise `catch` that routes to `onError`
  (default: a single `console.warn`). Skips (`too-large`, `invalid-json`) go to `onWarning`.
- `flush()` waits for in-flight inspections and async reporters, then flushes the store.

## Node and CLI

- **Config** is JSONC (comments and trailing commas stripped by a string-aware scanner) validated
  with field-level messages. `${VAR}` / `${VAR:-default}` are substituted in URLs, headers and
  bodies; values taken from the environment (6+ chars) are collected as secrets and masked in
  keys and errors, and reports show the URL as written. Empty headers are not sent.
- **runSnapshot / runCheck** call endpoints with bounded concurrency, `samples` calls each, a
  timeout, one retry on network errors, and a capped body read. A failed endpoint keeps its
  previous baseline entries on a non-merge snapshot.
- **check** compares by key; when the key is missing but the same route exists with another status
  class it reports `status-changed`; otherwise the endpoint is `new`. `--update` merges what was
  observed into the baseline.
- **Exit codes:** 0 nothing at or above `--fail-on`; 1 drift; 2 usage, config, baseline or network
  errors. `main()` never calls `process.exit`, which keeps it testable in-process.
- **Output** uses `api-drift/report` renderers with a `Style`: ANSI colours when the stream is a
  TTY (or `FORCE_COLOR`, or GitHub Actions), Unicode symbols except on legacy Windows consoles.

## Testing strategy

- **Property tests** with a seeded PRNG and a small JSON generator (no fast-check): commutativity,
  associativity, structural idempotence, order independence, diff soundness, and baseline
  round-trips.
- **Matrices** for formats, endpoint templating and every change kind (fires and does not fire).
- **Type generation** is compiled with the real TypeScript compiler against the very payloads it
  was learned from (and must reject a broken one); Zod output is executed against a small zod
  stand-in.
- **Runtime** tests use real `Response` objects and a programmable local server on port 5184
  (started once in vitest's global setup).
- **CLI** tests bundle `src/cli.ts` with esbuild once, then spawn it in temporary directories
  against the local server: init, snapshot, check (all formats and exit codes), env substitution
  and masking, import-har, types, explain, diff.

## Extension points

- **Store:** any object with `get(key)`, `set(key, entry)`, `list()` (sync or async), optionally
  `delete` and `flush`. Entries are `BaselineEntry` objects; validate untrusted ones with
  `normalizeEntry`.
- **Reporter:** any `(event: DriftEvent) => void | Promise<void>`.
- **Keys:** `keyFor(request)` to group differently (for example GraphQL by operation name).
- **Rendering:** `api-drift/report` renderers take a `Style`; build one with `createStyle`.
