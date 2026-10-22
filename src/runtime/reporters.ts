import { severityRank } from '../core/diff';
import type { Severity } from '../core/shape';
import type { DriftEvent, Reporter } from './types';

/** Marks wrapped fetch functions so internal requests can bypass instrumentation. */
export const ORIGINAL_FETCH: unique symbol = Symbol.for('api-drift.original-fetch') as never;

type AnyFetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** The un-instrumented version of a (possibly wrapped) fetch function. */
export function unwrapFetch<F>(fetchFn: F): F {
  let f = fetchFn as F & { [ORIGINAL_FETCH]?: F };
  while (f && f[ORIGINAL_FETCH]) f = f[ORIGINAL_FETCH] as F & { [ORIGINAL_FETCH]?: F };
  return f;
}

interface NodeLikeProcess {
  stderr?: { isTTY?: boolean };
  env?: Record<string, string | undefined>;
}

function terminalColor(): boolean {
  const proc = (globalThis as { process?: NodeLikeProcess }).process;
  if (!proc?.env) return false;
  if (proc.env.NO_COLOR) return false;
  if (proc.env.FORCE_COLOR !== undefined) return proc.env.FORCE_COLOR !== '0';
  return !!proc.stderr?.isTTY && proc.env.TERM !== 'dumb';
}

export interface ConsoleReporterOptions {
  /** Force colours on/off. Default: on for a Node TTY, off elsewhere. */
  color?: boolean;
  unicode?: boolean;
  /** Ignore events below this severity. Default `info`. */
  minSeverity?: Severity;
  /** Where to write. Default `console.warn`. */
  log?: (message: string) => void;
}

const COLOR: Record<Severity, number> = { breaking: 31, risky: 33, info: 94 };

/** Pretty multi-line output: a headline per event plus one aligned row per change. */
export function consoleReporter(options: ConsoleReporterOptions = {}): Reporter {
  const min = severityRank(options.minSeverity ?? 'info');
  return (event) => {
    if (severityRank(event.severity) < min) return;
    const color = options.color ?? terminalColor();
    const sym = options.unicode === false ? { breaking: 'x', risky: '!', info: 'i' } : { breaking: '✖', risky: '▲', info: '●' };
    const dot = options.unicode === false ? '-' : '·';
    const paint = (code: number, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
    const { breaking, risky, info } = event.counts;
    const counts = [breaking && `${breaking} breaking`, risky && `${risky} risky`, info && `${info} info`].filter(Boolean).join(` ${dot} `);
    const lines = [`${paint(90, '[api-drift]')} ${paint(COLOR[event.severity], sym[event.severity])} ${paint(1, event.key)} ${paint(90, dot)} ${counts}`];
    const shown = event.changes.slice(0, 20);
    const width = Math.min(Math.max(0, ...shown.map((c) => c.path.length)), 42);
    for (const c of shown) {
      lines.push(`  ${paint(COLOR[c.severity], `${sym[c.severity]} ${c.severity.padEnd(8)}`)}  ${paint(1, c.path.padEnd(width))}  ${c.message}`);
    }
    if (event.changes.length > 20) lines.push(`  … and ${event.changes.length - 20} more`);
    (options.log ?? ((m: string) => console.warn(m)))(lines.join('\n'));
  };
}

export interface WebhookReporterOptions {
  /** Payload shape. Default `json` (the raw event). */
  format?: 'slack' | 'discord' | 'json';
  /** Fetch implementation. Default: the un-instrumented global fetch. */
  fetch?: AnyFetch;
  headers?: Record<string, string>;
  /** Ignore events below this severity. Default `info`. */
  minSeverity?: Severity;
  /** Abort the webhook call after this many ms. Default 10000. */
  timeout?: number;
}

const TAG: Record<Severity, string> = { breaking: 'BREAKING', risky: 'RISKY', info: 'INFO' };

function chatText(event: DriftEvent, bold: (s: string) => string, max: number): string {
  const lines = [`${bold('api-drift')}: ${TAG[event.severity]} drift on \`${event.key}\``];
  for (const c of event.changes.slice(0, max)) lines.push(`• ${TAG[c.severity]} \`${c.path}\` ${c.message}`);
  if (event.changes.length > max) lines.push(`… and ${event.changes.length - max} more`);
  return lines.join('\n');
}

/** Build the request body a webhook reporter sends for an event. */
export function webhookPayload(event: DriftEvent, format: 'slack' | 'discord' | 'json'): unknown {
  if (format === 'slack') return { text: chatText(event, (s) => `*${s}*`, 15) };
  if (format === 'discord') {
    let content = chatText(event, (s) => `**${s}**`, 15);
    if (content.length > 1990) content = `${content.slice(0, 1989)}…`;
    return { content };
  }
  return event;
}

/** POST each drift event to a webhook (Slack, Discord or plain JSON). Throws on non-2xx. */
export function webhookReporter(url: string, options: WebhookReporterOptions = {}): Reporter {
  const format = options.format ?? 'json';
  const min = severityRank(options.minSeverity ?? 'info');
  return async (event) => {
    if (severityRank(event.severity) < min) return;
    const fetchFn = options.fetch ?? unwrapFetch((globalThis as unknown as { fetch?: AnyFetch }).fetch);
    if (!fetchFn) throw new Error('api-drift: fetch is not available for webhookReporter');
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(webhookPayload(event, format)),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(options.timeout ?? 10_000) : undefined,
    });
    if (!res.ok) throw new Error(`api-drift: webhook responded with HTTP ${res.status}`);
  };
}
