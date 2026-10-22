import { describe } from './describe';
import {
  countOf,
  DEFAULT_ENUM_MIN_SAMPLES,
  isEnum,
  slotOf,
  variantsOf,
  type ArrayShape,
  type IntegerShape,
  type LeafShape,
  type NumberShape,
  type ObjectShape,
  type Severity,
  type Shape,
  type StringShape,
} from './shape';
import { compilePathPattern, fnv1a, joinPath, own, sortedKeys, unionSorted } from './util';

export type ChangeKind =
  // breaking
  | 'removed'
  | 'type-changed'
  | 'status-changed'
  // risky
  | 'nullable'
  | 'optional'
  | 'enum-added'
  | 'format-changed'
  | 'number-narrowed'
  | 'number-widened'
  | 'emptied'
  // info
  | 'added'
  | 'added-optional'
  | 'enum-removed'
  | 'format-gained'
  | 'type-learned'
  | 'negative'
  | 'endpoint-added'
  | 'endpoint-removed';

export interface Change {
  /** JSONPath-like location: `$.data.items[].price`, `$.versions.*`. */
  path: string;
  kind: ChangeKind;
  severity: Severity;
  /** Human description of the baseline at `path` (e.g. `string<date-time>`, `required`). */
  before?: string;
  /** Human description of what was observed instead. */
  after?: string;
  /** One readable sentence explaining the change. */
  message: string;
}

export interface DiffOptions {
  /** Observations needed before a closed set of strings is treated as an enum. Default 20. */
  enumMinSamples?: number;
  /** Baseline observations needed before integer/decimal/sign changes are reported. Default 10. */
  minSamples?: number;
  /** Paths to ignore: exact paths (and their children), `*` wildcards, or RegExps. */
  ignore?: ReadonlyArray<string | RegExp>;
  /** Override the severity of a change kind, or `ignore` it entirely. */
  severity?: Partial<Record<ChangeKind, Severity | 'ignore'>>;
}

const KINDS_BY_SEVERITY: Record<Severity, string> = {
  breaking: 'removed type-changed status-changed',
  risky: 'nullable optional enum-added format-changed number-narrowed number-widened emptied',
  info: 'added added-optional enum-removed format-gained type-learned negative endpoint-added endpoint-removed',
};

/** The default severity of every change kind. */
export const DEFAULT_SEVERITY = {} as Readonly<Record<ChangeKind, Severity>>;
for (const sev of Object.keys(KINDS_BY_SEVERITY) as Severity[]) {
  for (const kind of KINDS_BY_SEVERITY[sev].split(' ')) (DEFAULT_SEVERITY as Record<string, Severity>)[kind] = sev;
}

const RANK: Record<Severity, number> = { info: 1, risky: 2, breaking: 3 };

/** `breaking` = 3, `risky` = 2, `info` = 1. */
export function severityRank(severity: Severity): number {
  return RANK[severity];
}

/** The most severe change in a list, or undefined when the list is empty. */
export function maxSeverity(changes: readonly Change[]): Severity | undefined {
  let best: Severity | undefined;
  for (const c of changes) if (!best || RANK[c.severity] > RANK[best]) best = c.severity;
  return best;
}

export interface SeverityCounts {
  breaking: number;
  risky: number;
  info: number;
}

export function countBySeverity(changes: readonly Change[]): SeverityCounts {
  const out: SeverityCounts = { breaking: 0, risky: 0, info: 0 };
  for (const c of changes) out[c.severity]++;
  return out;
}

/** Stable identity of a change, used for deduplication. `scope` is usually the endpoint key. */
export function changeFingerprint(change: Change, scope = ''): string {
  return fnv1a([scope, change.path, change.kind, change.before ?? '', change.after ?? ''].join('\u0000'));
}

interface Ctx {
  enumMin: number;
  minSamples: number;
  ignore: Array<(path: string) => boolean>;
  severity: Partial<Record<ChangeKind, Severity | 'ignore'>>;
  out: Change[];
  d: (s: Shape) => string;
}

/** Record a change, honouring ignore rules and severity overrides. */
function emit(ctx: Ctx, path: string, kind: ChangeKind, message: string, before?: string, after?: string): void {
  if (ctx.ignore.some((f) => f(path))) return;
  const severity = ctx.severity[kind] ?? DEFAULT_SEVERITY[kind];
  if (severity === 'ignore') return;
  const change: Change = { path, kind, severity, message };
  if (before !== undefined) change.before = before;
  if (after !== undefined) change.after = after;
  ctx.out.push(change);
}

function makeCtx(options: DiffOptions): Ctx {
  const enumMin = options.enumMinSamples ?? DEFAULT_ENUM_MIN_SAMPLES;
  return {
    enumMin,
    minSamples: options.minSamples ?? 10,
    ignore: (options.ignore ?? []).map(compilePathPattern),
    severity: options.severity ?? {},
    out: [],
    d: (s) => describe(s, { enumMinSamples: enumMin }),
  };
}

/**
 * Compare an observed shape against a baseline and list what changed.
 * Only evidence in `current` that the baseline did not allow is reported, so
 * a sample that was part of the baseline never produces breaking or risky changes.
 * Results are ordered breaking first, then risky, then info.
 */
export function diff(baseline: Shape, current: Shape, options: DiffOptions = {}): Change[] {
  const ctx = makeCtx(options);
  walk(baseline, current, '$', ctx);
  return sortChanges(ctx.out);
}

/** Order changes by severity (breaking first), keeping traversal order within a severity. */
export function sortChanges(changes: Change[]): Change[] {
  return changes.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

/** Build a single change (honouring ignore/severity options), e.g. for endpoint-level events. */
export function makeChange(
  kind: ChangeKind,
  path: string,
  message: string,
  before?: string,
  after?: string,
  options: DiffOptions = {},
): Change | undefined {
  const ctx = makeCtx(options);
  emit(ctx, path, kind, message, before, after);
  return ctx.out[0];
}

const an = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

function walk(b: Shape, c: Shape, path: string, ctx: Ctx): void {
  const bVariants = variantsOf(b);
  if (bVariants.every((v) => v.kind === 'unknown')) return;
  const bySlot = new Map<number, LeafShape>();
  for (const v of bVariants) bySlot.set(slotOf(v.kind), v);
  const cVariants = variantsOf(c);
  const added: LeafShape[] = [];
  let addedNull = false;
  for (const cv of cVariants) {
    if (cv.kind === 'unknown') continue;
    const bv = bySlot.get(slotOf(cv.kind));
    if (bv) compareSame(bv, cv, path, ctx);
    else if (cv.kind === 'null') addedNull = true;
    else added.push(cv);
  }
  if (addedNull) emit(ctx, path, 'nullable', `can now be null (was ${ctx.d(b)})`, ctx.d(b), ctx.d(c));
  if (added.length === 0) return;
  const known = bVariants.filter((v) => v.kind !== 'null' && v.kind !== 'unknown');
  const after = added.map(ctx.d).join(' | ');
  if (known.length === 0) {
    emit(ctx, path, 'type-learned', `now ${after} (baseline only saw null)`, ctx.d(b), ctx.d(c));
    return;
  }
  const before = known.map(ctx.d).join(' | ');
  const stillThere = known.some((bv) => cVariants.some((cv) => slotOf(cv.kind) === slotOf(bv.kind)));
  let message = `type changed from ${before} to ${after}`;
  if (stillThere) message = `now also ${after} (was ${before})`;
  else if (known.length === 1 && added.length === 1) {
    const from = known[0].kind;
    const to = added[0].kind;
    const container = (k: string) => k === 'array' || k === 'object';
    if (container(from) || container(to)) {
      message = `was ${an(container(from) ? from : before)}, now ${an(container(to) ? to : after)}`;
    }
  }
  emit(ctx, path, 'type-changed', message, ctx.d(b), ctx.d(c));
}

function compareSame(b: LeafShape, c: LeafShape, path: string, ctx: Ctx): void {
  switch (b.kind) {
    case 'integer':
    case 'number':
      return compareNumeric(b, c as IntegerShape | NumberShape, path, ctx);
    case 'string':
      return compareString(b, c as StringShape, path, ctx);
    case 'array':
      return compareArray(b, c as ArrayShape, path, ctx);
    case 'object':
      return compareObject(b, c as ObjectShape, path, ctx);
    default:
      return;
  }
}

function compareNumeric(b: IntegerShape | NumberShape, c: IntegerShape | NumberShape, path: string, ctx: Ctx): void {
  if (b.count < ctx.minSamples) return;
  if (b.kind === 'integer' && c.kind === 'number') {
    emit(ctx, path, 'number-widened', `decimals appeared (baseline saw only integers in ${b.count} values)`, 'integer', 'number');
  } else if (b.kind === 'number' && b.integral === 0 && c.kind === 'integer') {
    emit(ctx, path, 'number-narrowed', `now an integer (baseline saw only decimals in ${b.count} values)`, 'number', 'integer');
  }
  if (!b.negative && c.negative) {
    emit(ctx, path, 'negative', `negative values appeared (none in ${b.count} baseline values)`, 'non-negative', 'negative');
  }
}

const formatLabel = (formats: readonly string[]) => formats.map((f) => (f === 'plain' ? 'string' : f)).join(' | ');

function listValues(values: readonly string[]): string {
  const shown = values.slice(0, 6).map((v) => JSON.stringify(v));
  return values.length > 6 ? `${shown.join(', ')}, …` : shown.join(', ');
}

function compareString(b: StringShape, c: StringShape, path: string, ctx: Ctx): void {
  const bf = b.formats;
  const cf = c.formats;
  if (bf.includes('plain') || bf.every((f) => f === 'empty')) {
    const real = cf.filter((f) => f !== 'empty');
    if (real.length === 1 && real[0] !== 'plain' && !bf.includes(real[0])) {
      emit(ctx, path, 'format-gained', `values now look like ${real[0]}`, formatLabel(bf), real[0]);
    }
  } else {
    const fresh = cf.filter((f) => !bf.includes(f));
    if (fresh.length > 0) {
      const message =
        fresh.length === 1 && fresh[0] === 'empty'
          ? `can now be an empty string (was always ${formatLabel(bf)})`
          : `format changed from ${formatLabel(bf)} to ${formatLabel(cf)}`;
      emit(ctx, path, 'format-changed', message, formatLabel(bf), formatLabel(cf));
    }
  }
  if (!isEnum(b, ctx.enumMin)) return;
  const known = b.values ?? [];
  if (c.values) {
    for (const v of c.values) {
      if (!known.includes(v)) {
        emit(ctx, path, 'enum-added', `new enum value ${JSON.stringify(v)} (known: ${listValues(known)})`, listValues(known), JSON.stringify(v));
      }
    }
    if (isEnum(c, ctx.enumMin)) {
      for (const v of known) {
        if (!c.values.includes(v)) emit(ctx, path, 'enum-removed', `enum value ${JSON.stringify(v)} no longer observed`, JSON.stringify(v), undefined);
      }
    }
  } else {
    emit(ctx, path, 'enum-added', `values outside the known enum (known: ${listValues(known)})`, listValues(known), 'other values');
  }
}

function compareArray(b: ArrayShape, c: ArrayShape, path: string, ctx: Ctx): void {
  if (b.minItems > 0 && c.maxItems === 0) {
    emit(ctx, path, 'emptied', `now empty (baseline always had at least ${b.minItems} item${b.minItems === 1 ? '' : 's'})`, `${b.minItems}+ items`, '0 items');
  }
  if (b.items && c.items) walk(b.items, c.items, `${path}[]`, ctx);
  else if (!b.items && c.items) {
    emit(ctx, path, 'type-learned', `now has items (${ctx.d(c.items)}); baseline only saw empty arrays`, 'unknown[]', ctx.d(c));
  }
}

function compareObject(b: ObjectShape, c: ObjectShape, path: string, ctx: Ctx): void {
  for (const k of unionSorted(sortedKeys(b.properties), sortedKeys(c.properties))) {
    const bp = own(b.properties, k);
    const cp = own(c.properties, k);
    const p = joinPath(path, k);
    if (bp && cp) {
      const present = countOf(cp);
      if (countOf(bp) >= b.count && present < c.count) {
        emit(ctx, p, 'optional', `sometimes missing: absent in ${c.count - present} of ${c.count} samples (was always present)`, 'required', `optional (${present}/${c.count})`);
      }
      walk(bp, cp, p, ctx);
    } else if (bp) {
      if (countOf(bp) >= b.count) {
        const was = b.count === 1 ? 'the baseline sample' : `all ${b.count} baseline samples`;
        emit(ctx, p, 'removed', `field is missing (was present in ${was})`, ctx.d(bp), 'missing');
      }
    } else if (cp && !b.truncated) {
      const present = countOf(cp);
      if (present >= c.count) emit(ctx, p, 'added', `new field (${ctx.d(cp)})`, undefined, ctx.d(cp));
      else emit(ctx, p, 'added-optional', `new optional field (${ctx.d(cp)}, in ${present} of ${c.count} samples)`, undefined, ctx.d(cp));
    }
  }
  if (b.additional && c.additional) walk(b.additional, c.additional, `${path}.*`, ctx);
  else if (!b.additional && c.additional) {
    emit(ctx, `${path}.*`, 'added', `new id-keyed entries (${ctx.d(c.additional)})`, undefined, ctx.d(c.additional));
  }
}
