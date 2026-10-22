/**
 * api-drift/core: the browser-safe engine. Pure functions only: no Node
 * built-ins, no globals beyond `URL`, `TextDecoder` and `atob`.
 *
 *   infer          value -> Shape
 *   merge          Shape + Shape -> Shape
 *   diff           Shape vs Shape -> Change[]
 *   generateTypes  Baseline -> TypeScript / Zod source
 *   importHar      HAR export -> Baseline
 *
 * Renderers (terminal text, markdown, trees) live in `api-drift/report`.
 */
export { VERSION } from '../version';
export * from './shape';
export { infer, isPrivateKey, DEFAULT_LIMITS } from './infer';
export type { InferOptions, InferWarning } from './infer';
export { merge, mergeAll } from './merge';
export type { MergeOptions } from './merge';
export {
  diff,
  sortChanges,
  makeChange,
  changeFingerprint,
  countBySeverity,
  maxSeverity,
  severityRank,
  DEFAULT_SEVERITY,
} from './diff';
export type { Change, ChangeKind, DiffOptions, SeverityCounts } from './diff';
export { describe } from './describe';
export type { DescribeOptions } from './describe';
export { detectFormat, isCodeLike, isBase64, isIPv6, FORMAT_PATTERNS } from './formats';
export {
  endpointKey,
  templatePath,
  isIdSegment,
  isDynamicKey,
  statusClass,
  parseEndpointKey,
  routeOf,
  redactUrl,
} from './endpoint';
export type { EndpointInfo, KeyOptions, ParsedKey } from './endpoint';
export { compileMatchers } from './match';
export type { Matcher } from './match';
export {
  createBaseline,
  learn,
  learnShape,
  learnEntry,
  mergeBaselines,
  diffBaselines,
  parseBaseline,
  serializeBaseline,
  normalizeShape,
  normalizeEntry,
  isBaseline,
  BaselineError,
} from './baseline';
export type { Baseline, BaselineEntry, EndpointDiff, LearnOptions } from './baseline';
export { importHar } from './har';
export type { HarLike, HarImportOptions, HarImportResult, HarImportStats, HarSkipReason } from './har';
export { generateTypes, shapeToSource, typeNameForKey } from './typegen';
export type { TypegenOptions } from './typegen';
export { fnv1a, stableStringify, parseDuration } from './util';
