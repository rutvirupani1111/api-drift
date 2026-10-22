/**
 * api-drift: know when the APIs you depend on change, before your users do.
 *
 * The runtime (`createDrift`: fetch instrumentation, learn/watch/auto modes,
 * stores, reporters, dedup) plus the engine it runs on (infer, merge, diff,
 * endpoint keys, baselines). Browser-, Deno-, Bun- and edge-safe.
 *
 * More entry points:
 *   api-drift/core    the full browser-safe engine, incl. type generation and HAR import
 *   api-drift/report  text / markdown / tree renderers
 *   api-drift/axios   axios interceptor
 *   api-drift/node    file store, JSONL reporter, config, runSnapshot / runCheck
 */
export { VERSION } from './version';
export * from './core/shape';
export { infer, isPrivateKey, DEFAULT_LIMITS } from './core/infer';
export type { InferOptions, InferWarning } from './core/infer';
export { merge, mergeAll } from './core/merge';
export type { MergeOptions } from './core/merge';
export { diff, changeFingerprint, countBySeverity, maxSeverity, severityRank, DEFAULT_SEVERITY } from './core/diff';
export type { Change, ChangeKind, DiffOptions, SeverityCounts } from './core/diff';
export { describe } from './core/describe';
export type { DescribeOptions } from './core/describe';
export { detectFormat } from './core/formats';
export { endpointKey, templatePath, isIdSegment, statusClass, parseEndpointKey, redactUrl } from './core/endpoint';
export type { EndpointInfo, KeyOptions, ParsedKey } from './core/endpoint';
export { compileMatchers } from './core/match';
export type { Matcher } from './core/match';
export {
  createBaseline,
  learn,
  learnShape,
  learnEntry,
  parseBaseline,
  serializeBaseline,
  normalizeShape,
  normalizeEntry,
  isBaseline,
  BaselineError,
} from './core/baseline';
export type { Baseline, BaselineEntry, LearnOptions } from './core/baseline';
export { createDrift } from './runtime/drift';
export type { CheckResult, Drift, DriftOptions, Mode, ObservedResponse, RequestDescriptor } from './runtime/drift';
export { memoryStore, localStorageStore, storeToBaseline, loadBaselineInto } from './runtime/stores';
export type { StorageLike } from './runtime/stores';
export { consoleReporter, webhookReporter, webhookPayload, unwrapFetch } from './runtime/reporters';
export type { ConsoleReporterOptions, WebhookReporterOptions } from './runtime/reporters';
export type { DriftEvent, DriftStore, DriftWarning, MaybePromise, Reporter } from './runtime/types';
