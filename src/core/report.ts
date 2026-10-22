import { VERSION } from '../version';
import { countBySeverity, maxSeverity, type Change, type SeverityCounts } from './diff';
import type { Severity } from './shape';
import { padVisible, plainStyle, visibleWidth, type Style } from './style';

/** Exit threshold: fail when a change at or above this severity is found. */
export type FailOn = Severity | 'never';

export type EndpointStatus = 'ok' | 'drift' | 'new' | 'error' | 'removed';

export interface EndpointResult {
  key: string;
  /** Friendly name from the config. */
  name?: string;
  method?: string;
  /** URL as configured (template form, never with substituted secrets). */
  url?: string;
  status: EndpointStatus;
  httpStatus?: number;
  durationMs?: number;
  changes: Change[];
  error?: string;
}

export interface ReportSummary extends SeverityCounts {
  endpoints: number;
  ok: number;
  drifted: number;
  new: number;
  errors: number;
}

/** A machine-readable drift report (`check --format json`). */
export interface DriftReport {
  version: 1;
  tool: string;
  createdAt: string;
  failOn: FailOn;
  /** True when no change reached `failOn` and no endpoint errored. */
  ok: boolean;
  /** True when a change reached `failOn`. */
  failed: boolean;
  baseline?: string;
  summary: ReportSummary;
  endpoints: EndpointResult[];
}

const ORDER: Record<Severity, number> = { info: 1, risky: 2, breaking: 3 };

/** True when the counts contain a change at or above `failOn`. */
export function failsOn(counts: SeverityCounts, failOn: FailOn): boolean {
  if (failOn === 'never') return false;
  const min = ORDER[failOn];
  return (counts.breaking > 0 && min <= 3) || (counts.risky > 0 && min <= 2) || (counts.info > 0 && min <= 1);
}

export function buildReport(
  endpoints: EndpointResult[],
  options: { failOn?: FailOn; baseline?: string; createdAt?: string } = {},
): DriftReport {
  const failOn = options.failOn ?? 'breaking';
  const all = endpoints.flatMap((e) => e.changes);
  const counts = countBySeverity(all);
  const summary: ReportSummary = {
    endpoints: endpoints.length,
    ok: endpoints.filter((e) => e.status === 'ok').length,
    drifted: endpoints.filter((e) => e.status === 'drift').length,
    new: endpoints.filter((e) => e.status === 'new').length,
    errors: endpoints.filter((e) => e.status === 'error').length,
    ...counts,
  };
  const failed = failsOn(counts, failOn);
  return {
    version: 1,
    tool: `api-drift@${VERSION}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    failOn,
    ok: !failed && summary.errors === 0,
    failed,
    baseline: options.baseline,
    summary,
    endpoints,
  };
}

function countsText(c: SeverityCounts, style: Style, sep: string): string {
  return [
    style.paint(c.breaking ? 'breaking' : 'muted', `${c.breaking} breaking`),
    style.paint(c.risky ? 'risky' : 'muted', `${c.risky} risky`),
    style.paint(c.info ? 'info' : 'muted', `${c.info} info`),
  ].join(sep);
}

function endpointSymbol(e: EndpointResult, style: Style): string {
  if (e.status === 'error') return style.paint('error', style.sym.error);
  if (e.status === 'new') return style.paint('info', style.sym.info);
  const top = maxSeverity(e.changes);
  if (!top) return style.paint('ok', style.sym.ok);
  return style.paint(top, style.sym[top]);
}

/** Render changes as aligned rows: `✖ breaking  $.path  message`. */
export function renderChanges(changes: readonly Change[], options: { style?: Style; indent?: string; max?: number } = {}): string[] {
  const style = options.style ?? plainStyle;
  const indent = options.indent ?? '  ';
  const max = options.max ?? 50;
  const shown = changes.slice(0, max);
  const pathWidth = Math.min(Math.max(0, ...shown.map((c) => visibleWidth(c.path))), 42);
  const lines = shown.map((c) => {
    const sev = style.paint(c.severity, `${style.sym[c.severity]} ${c.severity.padEnd(8)}`);
    return `${indent}${sev}  ${padVisible(style.paint('path', c.path), pathWidth)}  ${c.message}`;
  });
  if (changes.length > max) lines.push(`${indent}${style.paint('muted', `… and ${changes.length - max} more`)}`);
  return lines;
}

/** Human-readable report for terminals (pass a coloured Style on a TTY). */
export function renderText(report: DriftReport, options: { style?: Style; title?: string; maxChanges?: number } = {}): string {
  const style = options.style ?? plainStyle;
  const dot = ` ${style.sym.dot} `;
  const s = report.summary;
  const head = [style.paint('title', options.title ?? 'api-drift check'), `${s.endpoints} endpoint${s.endpoints === 1 ? '' : 's'}`];
  if (report.baseline) head.push(`baseline ${report.baseline}`);
  const out: string[] = [head.join(style.paint('muted', dot)), ''];
  const labelOf = (e: EndpointResult) => (e.name ? `${e.key}  ${style.paint('muted', `(${e.name})`)}` : e.key);
  const width = Math.min(Math.max(0, ...report.endpoints.map((e) => visibleWidth(labelOf(e)))), 64);
  for (const e of report.endpoints) {
    const facts: string[] = [];
    if (e.httpStatus !== undefined) facts.push(String(e.httpStatus));
    if (e.durationMs !== undefined) facts.push(`${Math.round(e.durationMs)} ms`);
    let tail = '';
    if (e.status === 'ok') tail = style.paint('ok', 'no drift');
    else if (e.status === 'new') tail = style.paint('info', 'new endpoint, not in baseline');
    else if (e.status === 'removed') tail = style.paint('muted', 'not observed');
    else if (e.status === 'error') tail = style.paint('error', `error: ${e.error ?? 'unknown error'}`);
    else tail = countsText(countBySeverity(e.changes), style, style.paint('muted', dot));
    const factText = facts.length ? `  ${style.paint('muted', facts.join(dot))}` : '';
    out.push(`${endpointSymbol(e, style)} ${padVisible(style.paint('bold', labelOf(e)), width)}  ${tail}${factText}`);
    if (e.changes.length && e.status !== 'new') out.push(...renderChanges(e.changes, { style, indent: '    ', max: options.maxChanges }));
  }
  out.push('');
  const verdict = report.failed
    ? style.paint('breaking', `FAIL${report.failOn === 'never' ? '' : ` (--fail-on ${report.failOn})`}`)
    : s.errors
      ? style.paint('error', `ERROR (${s.errors} endpoint${s.errors === 1 ? '' : 's'} could not be checked)`)
      : style.paint('ok', 'PASS');
  const tally = [countsText(s, style, style.paint('muted', dot))];
  if (s.new) tally.push(style.paint('info', `${s.new} new`));
  if (s.errors) tally.push(style.paint('error', `${s.errors} error${s.errors === 1 ? '' : 's'}`));
  out.push(`${tally.join(style.paint('muted', dot))}   ${verdict}`);
  return out.join('\n');
}

/** Escape text for a markdown table cell (pipes, newlines, and `<...>` that GitHub would treat as HTML). */
const cell = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

const MD_SYMBOL: Record<EndpointStatus | Severity, string> = {
  breaking: '✖',
  risky: '▲',
  info: '●',
  ok: '✔',
  drift: '▲',
  new: '●',
  error: '✖',
  removed: '○',
};

/** Markdown report for `$GITHUB_STEP_SUMMARY` and pull-request comments. */
export function renderMarkdown(report: DriftReport, options: { title?: string; maxChanges?: number } = {}): string {
  const s = report.summary;
  const max = options.maxChanges ?? 100;
  const verdict = report.failed ? '✖ Failed' : s.errors ? '✖ Errors' : '✔ Passed';
  const out: string[] = [
    `## ${options.title ?? 'API drift report'}: ${verdict}`,
    '',
    `**${s.breaking} breaking** · **${s.risky} risky** · ${s.info} info · ${s.endpoints} endpoint${s.endpoints === 1 ? '' : 's'} checked` +
      (s.new ? ` · ${s.new} new` : '') +
      (s.errors ? ` · ${s.errors} error${s.errors === 1 ? '' : 's'}` : ''),
    '',
    '| | Endpoint | Result |',
    '| --- | --- | --- |',
  ];
  for (const e of report.endpoints) {
    const top = maxSeverity(e.changes);
    const sym = e.status === 'drift' && top ? MD_SYMBOL[top] : MD_SYMBOL[e.status];
    let result = 'no drift';
    if (e.status === 'error') result = `error: ${cell(e.error ?? 'unknown')}`;
    else if (e.status === 'new') result = 'new endpoint (not in baseline)';
    else if (e.status === 'removed') result = 'not observed';
    else if (e.changes.length) {
      const c = countBySeverity(e.changes);
      result = [c.breaking && `${c.breaking} breaking`, c.risky && `${c.risky} risky`, c.info && `${c.info} info`].filter(Boolean).join(', ');
    }
    out.push(`| ${sym} | ${code(e.key)}${e.name ? ` ${cell(e.name)}` : ''} | ${result} |`);
  }
  for (const e of report.endpoints) {
    if (e.status !== 'drift' || e.changes.length === 0) continue;
    out.push('', `### ${MD_SYMBOL[maxSeverity(e.changes) ?? 'info']} ${code(e.key)}`, '', '| Severity | Path | Change |', '| --- | --- | --- |');
    for (const c of e.changes.slice(0, max)) {
      const sev = c.severity === 'info' ? 'info' : `**${c.severity}**`;
      out.push(`| ${MD_SYMBOL[c.severity]} ${sev} | ${code(c.path)} | ${cell(c.message)} |`);
    }
    if (e.changes.length > max) out.push(`| | | … and ${e.changes.length - max} more |`);
  }
  const foot = [`fail-on: ${report.failOn}`, report.tool, report.createdAt];
  if (report.baseline) foot.unshift(`baseline ${code(report.baseline)}`);
  out.push('', `<sub>${foot.join(' · ')}</sub>`, '');
  return out.join('\n');
}

/** Pretty JSON for `--format json`. */
export function renderJson(report: DriftReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
