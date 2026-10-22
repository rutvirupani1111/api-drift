import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { createBaseline, diffBaselines, isBaseline, parseBaseline, type Baseline } from '../core/baseline';
import { diff } from '../core/diff';
import { importHar } from '../core/har';
import { infer } from '../core/infer';
import type { Matcher } from '../core/match';
import { buildReport, renderJson, renderMarkdown, renderText, type DriftReport, type EndpointResult, type FailOn } from '../core/report';
import { padVisible, type Style } from '../core/style';
import { explainEntry } from '../core/tree';
import { generateTypes } from '../core/typegen';
import { sortedKeys } from '../core/util';
import { readBaseline, writeBaseline, writeFileAtomic } from '../node/baseline-io';
import { ConfigError, configTemplate, DEFAULT_BASELINE_FILE, DEFAULT_CONFIG_FILE, libraryOptions, loadConfig } from '../node/config';
import type { FetchLike } from '../node/http';
import { parseJsonc } from '../node/jsonc';
import { countFields, runCheck, runSnapshot } from '../node/runner';
import { terminalStyle } from '../node/terminal';
import { VERSION } from '../version';
import { parseArgs, suggest, type FlagSpec, type ParsedArgs } from './args';

export interface CliIO {
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown; isTTY?: boolean };
  cwd: string;
  env: Record<string, string | undefined>;
  /** Override fetch (tests). */
  fetch?: FetchLike;
}

interface Ctx {
  io: CliIO;
  args: ParsedArgs;
  style: Style;
  err: Style;
  out(line?: string): void;
  warn(line: string): void;
  fail(message: string, hint?: string): number;
  path(p: string): string;
}

interface Command {
  name: string;
  usage: string;
  summary: string;
  description?: string;
  flags: FlagSpec;
  options: Array<[string, string]>;
  examples?: string[];
  run(ctx: Ctx): Promise<number>;
}

const FORMATS = ['pretty', 'json', 'markdown'];
const FAIL_ON = ['breaking', 'risky', 'info', 'never'];

const CONFIG_OPT: [string, string] = ['-c, --config <file>', `Config file (default: ${DEFAULT_CONFIG_FILE})`];
const BASELINE_OPT: [string, string] = ['-b, --baseline <file>', `Baseline file (default: from the config, else ${DEFAULT_BASELINE_FILE})`];
const COMMON_ALIAS = { c: 'config', b: 'baseline', f: 'format', o: 'out', n: 'samples', q: 'quiet', e: 'endpoint' };

function flag(ctx: Ctx, name: string): string | undefined {
  const v = ctx.args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

function list(ctx: Ctx, name: string): string[] {
  const v = ctx.args.flags[name];
  return Array.isArray(v) ? v : [];
}

function samplesFlag(ctx: Ctx): number | undefined | false {
  const raw = flag(ctx, 'samples');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : false;
}

function choice(ctx: Ctx, name: string, allowed: string[], fallback: string): string | undefined {
  const v = flag(ctx, name) ?? fallback;
  return allowed.includes(v) ? v : undefined;
}

/** Baseline path: --baseline, else the config's baseline (if a config exists), else the default. */
async function baselinePathFor(ctx: Ctx, explicit?: string): Promise<string> {
  if (explicit) return resolve(ctx.io.cwd, explicit);
  const configPath = resolve(ctx.io.cwd, flag(ctx, 'config') ?? DEFAULT_CONFIG_FILE);
  if (existsSync(configPath)) return (await loadConfig(configPath, ctx.io.cwd)).baselinePath;
  return resolve(ctx.io.cwd, DEFAULT_BASELINE_FILE);
}

async function requireBaseline(ctx: Ctx, file: string): Promise<Baseline | number> {
  const b = await readBaseline(file);
  if (!b) return ctx.fail(`No baseline at ${ctx.path(file)}`, 'Run `api-drift snapshot` or `api-drift import-har <file>` first.');
  return b;
}

function exitFor(report: DriftReport): number {
  return report.failed ? 1 : report.summary.errors ? 2 : 0;
}

function printReport(ctx: Ctx, report: DriftReport, format: string, title: string): void {
  if (format === 'json') ctx.io.stdout.write(renderJson(report));
  else if (format === 'markdown') ctx.io.stdout.write(renderMarkdown(report));
  else ctx.out(renderText(report, { style: ctx.style, title }));
}

function toMatcher(s: string): Matcher {
  const m = /^\/(.+)\/([a-z]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : s;
}

// ---------------------------------------------------------------- commands

const init: Command = {
  name: 'init',
  usage: 'init [url...] [options]',
  summary: 'Create api-drift.config.json with commented examples',
  description: 'Write a starter config. URLs given on the command line become its endpoints.',
  flags: { string: ['config'], boolean: ['force'], alias: COMMON_ALIAS },
  options: [CONFIG_OPT, ['--force', 'Overwrite an existing config file']],
  examples: ['api-drift init', 'api-drift init https://api.github.com/repos/nodejs/node https://registry.npmjs.org/react/latest'],
  async run(ctx) {
    const file = resolve(ctx.io.cwd, flag(ctx, 'config') ?? DEFAULT_CONFIG_FILE);
    if (existsSync(file) && !ctx.args.flags.force) {
      return ctx.fail(`${ctx.path(file)} already exists`, 'Use --force to overwrite it.');
    }
    for (const u of ctx.args.positional) {
      if (!/^https?:\/\//i.test(u)) return ctx.fail(`Not an http(s) URL: ${u}`);
    }
    await writeFileAtomic(file, configTemplate(ctx.args.positional));
    const { style: s } = ctx;
    ctx.out(`${s.paint('ok', s.sym.ok)} Created ${s.paint('bold', ctx.path(file))}`);
    ctx.out('');
    ctx.out(s.paint('title', 'Next steps'));
    ctx.out(`  1. List the endpoints you depend on in ${ctx.path(file)}`);
    ctx.out(`  2. ${s.paint('accent', 'npx api-drift snapshot')}   record the baseline (commit it)`);
    ctx.out(`  3. ${s.paint('accent', 'npx api-drift check')}      compare live responses against it`);
    return 0;
  },
};

const snapshot: Command = {
  name: 'snapshot',
  usage: 'snapshot [options]',
  summary: 'Call every endpoint and record the baseline',
  description: 'Calls every endpoint in the config, infers the response contracts and writes the baseline file.',
  flags: { string: ['config', 'baseline', 'samples', 'format'], multiple: ['only'], boolean: ['merge', 'quiet'], alias: COMMON_ALIAS },
  options: [
    CONFIG_OPT,
    BASELINE_OPT,
    ['-n, --samples <n>', 'Calls per endpoint (overrides the config)'],
    ['--only <name>', 'Only endpoints whose name, URL or key contains this (repeatable)'],
    ['--merge', 'Merge into the existing baseline instead of replacing it'],
    ['-f, --format <fmt>', 'pretty (default) or json'],
    ['-q, --quiet', 'Only print errors and the final line'],
  ],
  examples: ['api-drift snapshot', 'api-drift snapshot --samples 5 --only github'],
  async run(ctx) {
    const samples = samplesFlag(ctx);
    if (samples === false) return ctx.fail('--samples must be an integer between 1 and 100');
    const format = choice(ctx, 'format', ['pretty', 'json'], 'pretty');
    if (!format) return ctx.fail('--format must be pretty or json');
    const result = await runSnapshot({
      cwd: ctx.io.cwd,
      config: flag(ctx, 'config'),
      baseline: flag(ctx, 'baseline'),
      samples,
      only: list(ctx, 'only'),
      env: ctx.io.env,
      fetch: ctx.io.fetch,
      merge: !!ctx.args.flags.merge,
    });
    const failed = result.endpoints.filter((e) => e.status === 'error').length;
    if (format === 'json') {
      ctx.io.stdout.write(`${JSON.stringify({ baseline: ctx.path(result.baselinePath), written: result.written, endpoints: result.endpoints }, null, 2)}\n`);
      return failed ? 2 : 0;
    }
    const { style: s } = ctx;
    const dot = s.paint('muted', ` ${s.sym.dot} `);
    const n = result.endpoints.length;
    if (!ctx.args.flags.quiet) {
      ctx.out(`${s.paint('title', 'api-drift snapshot')}${dot}${n} endpoint${n === 1 ? '' : 's'}${samples ? `${dot}${samples} sample${samples === 1 ? '' : 's'} each` : ''}`);
      ctx.out('');
    }
    const width = Math.min(Math.max(...result.endpoints.map((e) => e.key.length)), 60);
    for (const e of result.endpoints) {
      if (ctx.args.flags.quiet && e.status === 'ok') continue;
      const facts = [e.httpStatus !== undefined ? String(e.httpStatus) : '', `${Math.round(e.durationMs)} ms`];
      if (e.status === 'ok') {
        facts.push(`${e.fields} field${e.fields === 1 ? '' : 's'}`);
        ctx.out(`${s.paint('ok', s.sym.ok)} ${padVisible(s.paint('bold', e.key), width)}  ${s.paint('muted', facts.filter(Boolean).join(` ${s.sym.dot} `))}`);
      } else {
        const kept = e.kept ? s.paint('muted', ' (previous baseline kept)') : '';
        ctx.out(`${s.paint('error', s.sym.error)} ${padVisible(s.paint('bold', e.key), width)}  ${s.paint('error', `error: ${e.error}`)}${kept}`);
      }
    }
    if (!ctx.args.flags.quiet) ctx.out('');
    const count = Object.keys(result.baseline.endpoints).length;
    if (result.written) {
      ctx.out(`Baseline written to ${s.paint('bold', ctx.path(result.baselinePath))} (${count} endpoint${count === 1 ? '' : 's'})`);
    } else {
      ctx.out(s.paint('error', `Nothing written: every endpoint failed. ${ctx.path(result.baselinePath)} was left untouched.`));
    }
    return failed ? 2 : 0;
  },
};

const check: Command = {
  name: 'check',
  usage: 'check [options]',
  summary: 'Call endpoints again and report drift against the baseline',
  description: 'Calls every endpoint in the config, diffs each response against the baseline and prints a report.',
  flags: {
    string: ['config', 'baseline', 'format', 'fail-on', 'samples', 'json-file'],
    multiple: ['only'],
    boolean: ['update', 'quiet'],
    alias: COMMON_ALIAS,
  },
  options: [
    CONFIG_OPT,
    BASELINE_OPT,
    ['-f, --format <fmt>', 'pretty (default), json, or markdown (for $GITHUB_STEP_SUMMARY and PR comments)'],
    ['--fail-on <level>', 'Exit 1 at this severity: breaking (default), risky, info, never'],
    ['-n, --samples <n>', 'Calls per endpoint (overrides the config)'],
    ['--only <name>', 'Only endpoints whose name, URL or key contains this (repeatable)'],
    ['--update', 'Merge what was observed into the baseline (accept the drift)'],
    ['--json-file <file>', 'Also write the JSON report to this file'],
    ['-q, --quiet', 'Pretty format: hide endpoints without drift'],
  ],
  examples: [
    'api-drift check',
    'api-drift check --fail-on risky',
    'api-drift check --format markdown >> "$GITHUB_STEP_SUMMARY"',
  ],
  async run(ctx) {
    const format = choice(ctx, 'format', FORMATS, 'pretty');
    if (!format) return ctx.fail(`--format must be one of ${FORMATS.join(', ')}`);
    const failOn = flag(ctx, 'fail-on');
    if (failOn !== undefined && !FAIL_ON.includes(failOn)) return ctx.fail(`--fail-on must be one of ${FAIL_ON.join(', ')}`);
    const samples = samplesFlag(ctx);
    if (samples === false) return ctx.fail('--samples must be an integer between 1 and 100');
    const { report, updated, baselinePath } = await runCheck({
      cwd: ctx.io.cwd,
      config: flag(ctx, 'config'),
      baseline: flag(ctx, 'baseline'),
      samples,
      only: list(ctx, 'only'),
      env: ctx.io.env,
      fetch: ctx.io.fetch,
      failOn: failOn as FailOn | undefined,
      update: !!ctx.args.flags.update,
    });
    const jsonFile = flag(ctx, 'json-file');
    if (jsonFile) await writeFileAtomic(resolve(ctx.io.cwd, jsonFile), renderJson(report));
    const shown = ctx.args.flags.quiet && format === 'pretty' ? { ...report, endpoints: report.endpoints.filter((e) => e.status !== 'ok') } : report;
    printReport(ctx, shown, format, 'api-drift check');
    if (updated && format === 'pretty') ctx.out(ctx.style.paint('muted', `Baseline updated: ${ctx.path(baselinePath)}`));
    return exitFor(report);
  },
};

const importHarCmd: Command = {
  name: 'import-har',
  usage: 'import-har <file.har> [options]',
  summary: 'Build a baseline from a browser HAR export',
  description:
    'Record a session in your browser (DevTools > Network > Export HAR), then turn every JSON response into a contract. Responses are grouped by endpoint key and merged.',
  flags: { string: ['out', 'baseline', 'config', 'keep-query', 'format'], multiple: ['include', 'exclude'], boolean: ['merge'], alias: COMMON_ALIAS },
  options: [
    ['-o, --out <file>', `Baseline to write (default: from the config, else ${DEFAULT_BASELINE_FILE})`],
    ['--merge', 'Merge into the existing baseline instead of replacing it'],
    ['--include <pattern>', 'Only these hosts / host+path prefixes / /regex/ (repeatable)'],
    ['--exclude <pattern>', 'Skip these (repeatable)'],
    ['--keep-query <a,b>', 'Query parameters that distinguish endpoints'],
    ['-f, --format <fmt>', 'pretty (default) or json'],
  ],
  examples: ['api-drift import-har session.har', 'api-drift import-har session.har --include api.example.com --merge'],
  async run(ctx) {
    const [file] = ctx.args.positional;
    if (!file) return ctx.fail('Missing HAR file', 'Usage: api-drift import-har <file.har>');
    const format = choice(ctx, 'format', ['pretty', 'json'], 'pretty');
    if (!format) return ctx.fail('--format must be pretty or json');
    const src = resolve(ctx.io.cwd, file);
    let text: string;
    try {
      text = await readFile(src, 'utf8');
    } catch {
      return ctx.fail(`Cannot read ${ctx.path(src)}`);
    }
    const out = await baselinePathFor(ctx, flag(ctx, 'out') ?? flag(ctx, 'baseline'));
    const existing = ctx.args.flags.merge ? await readBaseline(out) : undefined;
    let lib = {};
    const configPath = resolve(ctx.io.cwd, flag(ctx, 'config') ?? DEFAULT_CONFIG_FILE);
    if (existsSync(configPath)) lib = libraryOptions((await loadConfig(configPath, ctx.io.cwd)).config).infer;
    let result;
    try {
      result = importHar(text.replace(/^﻿/, ''), {
        ...lib,
        include: list(ctx, 'include').map(toMatcher),
        exclude: list(ctx, 'exclude').map(toMatcher),
        keepQuery: flag(ctx, 'keep-query')?.split(',').map((s) => s.trim()).filter(Boolean),
        baseline: existing ?? createBaseline(),
      });
    } catch (e) {
      return ctx.fail(`${ctx.path(src)} is not a HAR file: ${(e as Error).message}`);
    }
    const { stats, learnedKeys, baseline } = result;
    if (stats.learned > 0) await writeBaseline(out, baseline);
    if (format === 'json') {
      ctx.io.stdout.write(`${JSON.stringify({ baseline: ctx.path(out), written: stats.learned > 0, stats, endpoints: learnedKeys }, null, 2)}\n`);
      return stats.learned > 0 ? 0 : 2;
    }
    const { style: s } = ctx;
    const dot = s.paint('muted', ` ${s.sym.dot} `);
    ctx.out(`${s.paint('title', 'api-drift import-har')}${dot}${ctx.path(src)}`);
    ctx.out('');
    const reasons = Object.entries(stats.reasons).map(([r, c]) => `${c} ${r}`).join(', ');
    ctx.out(
      `${s.paint(stats.learned ? 'ok' : 'error', stats.learned ? s.sym.ok : s.sym.error)} ${stats.learned} JSON response${stats.learned === 1 ? '' : 's'} learned from ${stats.entries} entr${stats.entries === 1 ? 'y' : 'ies'}` +
        (stats.skipped ? s.paint('muted', ` (${stats.skipped} skipped: ${reasons})`) : ''),
    );
    const keys = sortedKeys(learnedKeys);
    if (keys.length) {
      ctx.out('');
      const width = Math.min(Math.max(...keys.map((k) => k.length)), 64);
      for (const k of keys) {
        const fields = countFields(baseline.endpoints[k].shape);
        const n = learnedKeys[k];
        ctx.out(`  ${padVisible(k, width)}  ${s.paint('muted', `${n} response${n === 1 ? '' : 's'} ${s.sym.dot} ${fields} field${fields === 1 ? '' : 's'}`)}`);
      }
    }
    ctx.out('');
    if (stats.learned === 0) return ctx.fail('No JSON responses found; nothing written', 'Export with response bodies (Chrome: "Export HAR (with sensitive data)" keeps bodies).');
    const total = Object.keys(baseline.endpoints).length;
    ctx.out(`Baseline written to ${s.paint('bold', ctx.path(out))} (${total} endpoint${total === 1 ? '' : 's'})`);
    return 0;
  },
};

async function readJsonFile(ctx: Ctx, file: string): Promise<unknown> {
  const text = await readFile(resolve(ctx.io.cwd, file), 'utf8');
  return parseJsonc(text);
}

const diffCmd: Command = {
  name: 'diff',
  usage: 'diff <a> <b> [options]',
  summary: 'Diff two baselines or two JSON payloads',
  description:
    'Compare two baseline files endpoint by endpoint, or two raw JSON payloads. With --endpoint, compare one endpoint of a baseline against a payload.',
  flags: { string: ['format', 'fail-on', 'endpoint'], alias: COMMON_ALIAS },
  options: [
    ['-f, --format <fmt>', 'pretty (default), json or markdown'],
    ['--fail-on <level>', 'Exit 1 at this severity: breaking (default), risky, info, never'],
    ['-e, --endpoint <key>', 'Baseline endpoint to compare when the other side is a payload'],
  ],
  examples: ['api-drift diff old-baseline.json .api-drift/baseline.json', 'api-drift diff before.json after.json --fail-on never'],
  async run(ctx) {
    const [a, b] = ctx.args.positional;
    if (!a || !b) return ctx.fail('diff needs two files', 'Usage: api-drift diff <a> <b>');
    const format = choice(ctx, 'format', FORMATS, 'pretty');
    if (!format) return ctx.fail(`--format must be one of ${FORMATS.join(', ')}`);
    const failOn = (flag(ctx, 'fail-on') ?? 'breaking') as FailOn;
    if (!FAIL_ON.includes(failOn)) return ctx.fail(`--fail-on must be one of ${FAIL_ON.join(', ')}`);
    let left: unknown;
    let right: unknown;
    try {
      left = await readJsonFile(ctx, a);
      right = await readJsonFile(ctx, b);
    } catch (e) {
      return ctx.fail(`Cannot read input: ${(e as Error).message}`);
    }
    let endpoints: EndpointResult[];
    const endpointKey = flag(ctx, 'endpoint');
    if (isBaseline(left) && isBaseline(right)) {
      endpoints = diffBaselines(parseBaseline(left), parseBaseline(right)).map((d) => ({
        key: d.key,
        status: d.status === 'added' ? 'new' : d.status,
        changes: d.status === 'added' ? [] : d.changes,
      }));
    } else if (isBaseline(left) !== isBaseline(right)) {
      const base = parseBaseline(isBaseline(left) ? left : right);
      const payload = isBaseline(left) ? right : left;
      const keys = sortedKeys(base.endpoints);
      const matches = endpointKey ? keys.filter((k) => k === endpointKey || k.includes(endpointKey)) : keys.length === 1 ? keys : [];
      if (matches.length !== 1) {
        return ctx.fail(
          endpointKey ? `--endpoint "${endpointKey}" matches ${matches.length} endpoints` : 'One side is a baseline: say which endpoint with --endpoint',
          keys.slice(0, 10).map((k) => `  ${k}`).join('\n'),
        );
      }
      const entry = base.endpoints[matches[0]];
      const current = infer(payload);
      const changes = isBaseline(left) ? diff(entry.shape, current) : diff(current, entry.shape);
      endpoints = [{ key: matches[0], status: changes.length ? 'drift' : 'ok', changes }];
    } else {
      const changes = diff(infer(left), infer(right));
      endpoints = [{ key: `${basename(a)} ${ctx.style.sym.arrow} ${basename(b)}`, status: changes.length ? 'drift' : 'ok', changes }];
    }
    const report = buildReport(endpoints, { failOn });
    printReport(ctx, report, format, 'api-drift diff');
    return report.failed ? 1 : 0;
  },
};

const types: Command = {
  name: 'types',
  usage: 'types [options]',
  summary: 'Generate TypeScript interfaces or Zod schemas',
  description: 'Generate source code from the learned contracts. Zod output is plain text: no zod dependency is needed to generate it.',
  flags: { string: ['baseline', 'config', 'out'], multiple: ['endpoint'], boolean: ['zod'], alias: COMMON_ALIAS },
  options: [
    BASELINE_OPT,
    CONFIG_OPT,
    ['-o, --out <file>', 'Write to a file instead of stdout'],
    ['--zod', 'Emit Zod schemas instead of interfaces'],
    ['-e, --endpoint <text>', 'Only endpoints whose key contains this (repeatable)'],
  ],
  examples: ['api-drift types --out src/api-types.ts', 'api-drift types --zod --out src/api-schemas.ts'],
  async run(ctx) {
    const file = await baselinePathFor(ctx, flag(ctx, 'baseline'));
    const baseline = await requireBaseline(ctx, file);
    if (typeof baseline === 'number') return baseline;
    const filters = list(ctx, 'endpoint');
    const picked = createBaseline();
    for (const k of sortedKeys(baseline.endpoints)) {
      if (!filters.length || filters.some((f) => k.includes(f))) picked.endpoints[k] = baseline.endpoints[k];
    }
    const n = Object.keys(picked.endpoints).length;
    if (n === 0) return ctx.fail('No endpoint matches the --endpoint filter');
    let lib = {};
    const configPath = resolve(ctx.io.cwd, flag(ctx, 'config') ?? DEFAULT_CONFIG_FILE);
    if (existsSync(configPath)) lib = libraryOptions((await loadConfig(configPath, ctx.io.cwd)).config).diff;
    const source = generateTypes(picked, { zod: !!ctx.args.flags.zod, ...lib });
    const out = flag(ctx, 'out');
    if (!out) {
      ctx.io.stdout.write(source);
      return 0;
    }
    const target = resolve(ctx.io.cwd, out);
    await writeFileAtomic(target, source);
    const { style: s } = ctx;
    ctx.out(`${s.paint('ok', s.sym.ok)} Wrote ${ctx.args.flags.zod ? 'Zod schemas' : 'TypeScript types'} for ${n} endpoint${n === 1 ? '' : 's'} to ${s.paint('bold', ctx.path(target))}`);
    return 0;
  },
};

const explain: Command = {
  name: 'explain',
  usage: 'explain [endpoint] [options]',
  summary: 'Print an inferred contract as a tree',
  description: 'Without an argument, list the endpoints in the baseline. With one, print its contract. Any unique part of the key (or example URL) works.',
  flags: { string: ['baseline', 'config', 'format', 'depth'], alias: COMMON_ALIAS },
  options: [BASELINE_OPT, CONFIG_OPT, ['-f, --format <fmt>', 'pretty (default) or json (the raw shape)'], ['--depth <n>', 'Only expand this many levels']],
  examples: ['api-drift explain', 'api-drift explain /repos/:id', 'api-drift explain "GET api.github.com /repos/nodejs/node 2xx"'],
  async run(ctx) {
    const file = await baselinePathFor(ctx, flag(ctx, 'baseline'));
    const baseline = await requireBaseline(ctx, file);
    if (typeof baseline === 'number') return baseline;
    const format = choice(ctx, 'format', ['pretty', 'json'], 'pretty');
    if (!format) return ctx.fail('--format must be pretty or json');
    const depthRaw = flag(ctx, 'depth');
    const depth = depthRaw === undefined ? undefined : Number(depthRaw);
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) return ctx.fail('--depth must be a positive integer');
    const keys = sortedKeys(baseline.endpoints);
    const { style: s } = ctx;
    const query = ctx.args.positional.join(' ').trim();
    if (!query) {
      if (format === 'json') {
        ctx.io.stdout.write(`${JSON.stringify(keys, null, 2)}\n`);
        return 0;
      }
      ctx.out(`${s.paint('title', ctx.path(file))}${s.paint('muted', ` ${s.sym.dot} `)}${keys.length} endpoint${keys.length === 1 ? '' : 's'}`);
      ctx.out('');
      const width = Math.min(Math.max(0, ...keys.map((k) => k.length)), 64);
      for (const k of keys) {
        const e = baseline.endpoints[k];
        const facts = [`${e.samples} sample${e.samples === 1 ? '' : 's'}`, `${countFields(e.shape)} fields`];
        if (e.frozen) facts.push('frozen');
        ctx.out(`  ${padVisible(k, width)}  ${s.paint('muted', facts.join(` ${s.sym.dot} `))}`);
      }
      ctx.out('');
      ctx.out(s.paint('muted', 'Show one contract: api-drift explain <endpoint>  (any unique part of the key works)'));
      return 0;
    }
    const q = query.toLowerCase();
    let matches = keys.filter((k) => k === query);
    if (!matches.length) matches = keys.filter((k) => k.toLowerCase().includes(q));
    if (!matches.length) matches = keys.filter((k) => (baseline.endpoints[k].example ?? '').toLowerCase().includes(q));
    if (matches.length !== 1) {
      const pool = matches.length ? matches : keys;
      return ctx.fail(
        matches.length ? `"${query}" matches ${matches.length} endpoints; be more specific` : `No endpoint matches "${query}"`,
        pool.slice(0, 15).map((k) => `  ${k}`).join('\n'),
      );
    }
    const entry = baseline.endpoints[matches[0]];
    if (format === 'json') {
      ctx.io.stdout.write(`${JSON.stringify({ key: matches[0], ...entry }, null, 2)}\n`);
      return 0;
    }
    ctx.out(explainEntry(matches[0], entry, { style: s, maxDepth: depth }));
    return 0;
  },
};

const COMMANDS: Command[] = [init, snapshot, check, importHarCmd, diffCmd, types, explain];

// ---------------------------------------------------------------- help

function mainHelp(s: Style): string {
  const width = 22;
  const lines = [
    `${s.paint('title', 'api-drift')} ${s.paint('muted', VERSION)}`,
    'Know when the APIs you depend on change, before your users do.',
    '',
    s.paint('title', 'Usage'),
    `  api-drift ${s.paint('accent', '<command>')} [options]`,
    '',
    s.paint('title', 'Commands'),
    ...COMMANDS.map((c) => `  ${padVisible(s.paint('accent', c.usage.replace(' [options]', '')), width)}  ${c.summary}`),
    '',
    s.paint('title', 'Global options'),
    `  ${padVisible('-h, --help', width)}  Show help (also: api-drift help <command>)`,
    `  ${padVisible('-v, --version', width)}  Print the version`,
    `  ${padVisible('--no-color', width)}  Disable colours (NO_COLOR and FORCE_COLOR are honoured)`,
    '',
    s.paint('title', 'Exit codes'),
    `  0 no drift at or above --fail-on ${s.sym.dot} 1 drift found ${s.sym.dot} 2 usage, config or network error`,
    '',
    s.paint('muted', 'Quick start: api-drift init <url>  then  api-drift snapshot  then  api-drift check'),
  ];
  return lines.join('\n');
}

function commandHelp(c: Command, s: Style): string {
  const width = Math.max(...c.options.map(([o]) => o.length), 10);
  const lines = [`${s.paint('title', 'api-drift')} ${s.paint('accent', c.usage)}`, '', c.description ?? c.summary, '', s.paint('title', 'Options')];
  for (const [o, d] of c.options) lines.push(`  ${o.padEnd(width)}  ${d}`);
  lines.push(`  ${'-h, --help'.padEnd(width)}  Show this help`);
  if (c.examples?.length) {
    lines.push('', s.paint('title', 'Examples'));
    for (const e of c.examples) lines.push(`  ${s.paint('muted', '$')} ${e}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- entry

/** Run the CLI. Resolves with the exit code; never calls process.exit. */
export async function main(argv: readonly string[], partial: Partial<CliIO> = {}): Promise<number> {
  const io: CliIO = {
    stdout: partial.stdout ?? process.stdout,
    stderr: partial.stderr ?? process.stderr,
    cwd: partial.cwd ?? process.cwd(),
    env: partial.env ?? process.env,
    fetch: partial.fetch,
  };
  const colorArg = argv.includes('--no-color') ? false : argv.includes('--color') ? true : undefined;
  const style = terminalStyle(io.stdout, io.env, colorArg);
  const err = terminalStyle(io.stderr, io.env, colorArg);
  const rest = argv.filter((a) => a !== '--color' && a !== '--no-color');
  const writeOut = (line = '') => io.stdout.write(`${line}\n`);
  const writeErr = (line: string) => io.stderr.write(`${line}\n`);

  const first = rest[0];
  if (first === '--version' || first === '-v' || first === 'version') {
    writeOut(VERSION);
    return 0;
  }
  if (!first || first === '--help' || first === '-h') {
    writeOut(mainHelp(style));
    return 0;
  }
  if (first === 'help') {
    const c = COMMANDS.find((x) => x.name === rest[1]);
    writeOut(c ? commandHelp(c, style) : mainHelp(style));
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === first);
  if (!command) {
    const guess = suggest(first, COMMANDS.map((c) => c.name));
    writeErr(`${err.paint('error', err.sym.error)} Unknown command "${first}".${guess ? ` Did you mean ${err.paint('accent', guess)}?` : ''}`);
    writeErr(err.paint('muted', 'Run api-drift --help to see every command.'));
    return 2;
  }
  const spec: FlagSpec = {
    ...command.flags,
    boolean: [...(command.flags.boolean ?? []), 'help'],
    alias: { ...command.flags.alias, h: 'help' },
  };
  const args = parseArgs(rest.slice(1), spec);
  const ctx: Ctx = {
    io,
    args,
    style,
    err,
    out: writeOut,
    warn: (line) => writeErr(`${err.paint('risky', err.sym.risky)} ${line}`),
    fail(message, hint) {
      writeErr(`${err.paint('error', err.sym.error)} ${message}`);
      if (hint) writeErr(err.paint('muted', hint));
      return 2;
    },
    path: (p) => {
      const r = relative(io.cwd, p);
      return (r && !r.startsWith('..') ? r : p).replace(/\\/g, '/');
    },
  };
  if (args.flags.help) {
    writeOut(commandHelp(command, style));
    return 0;
  }
  if (args.unknown.length || args.errors.length) {
    const known = [...(spec.string ?? []), ...(spec.boolean ?? []), ...(spec.multiple ?? [])];
    for (const u of args.unknown) {
      const guess = suggest(u.replace(/^-+/, ''), known);
      writeErr(`${err.paint('error', err.sym.error)} Unknown option ${u} for ${command.name}.${guess ? ` Did you mean --${guess}?` : ''}`);
    }
    for (const e of args.errors) writeErr(`${err.paint('error', err.sym.error)} ${e}`);
    writeErr(err.paint('muted', `Run api-drift ${command.name} --help for usage.`));
    return 2;
  }
  try {
    return await command.run(ctx);
  } catch (e) {
    if (e instanceof ConfigError || (e as Error)?.name === 'BaselineError') return ctx.fail((e as Error).message);
    return ctx.fail(`Unexpected error: ${(e as Error)?.stack ?? String(e)}`);
  }
}
