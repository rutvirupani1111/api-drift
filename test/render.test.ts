import { describe, expect, it } from 'vitest';
import { createBaseline, learn } from '../src/core/baseline';
import { describe as describeShape } from '../src/core/describe';
import { diff } from '../src/core/diff';
import { infer } from '../src/core/infer';
import { mergeAll } from '../src/core/merge';
import { buildReport, failsOn, renderJson, renderMarkdown, renderText, type EndpointResult } from '../src/core/report';
import { createStyle, padVisible, stripAnsi, visibleWidth } from '../src/core/style';
import { explainEntry, renderShapeTree } from '../src/core/tree';

const repo = mergeAll(
  [
    { id: 1, name: 'node', license: { key: 'mit', spdx_id: 'MIT' }, topics: ['js', 'runtime'], homepage: 'https://nodejs.org', nick: 'n' },
    { id: 2, name: 'deno', license: null, topics: [], homepage: null },
  ].map((v) => infer(v)),
)!;

describe('describe', () => {
  it('renders compact types', () => {
    expect(describeShape(infer('2026-10-23T00:00:00Z'))).toBe('string<date-time>');
    expect(describeShape(mergeAll([infer('2026-10-23'), infer('')])!)).toBe('string<date|empty>');
    expect(describeShape(mergeAll([infer(1), infer(null)])!)).toBe('integer | null');
    expect(describeShape(infer([[1]]))).toBe('integer[][]');
    expect(describeShape(infer([1, 'a']))).toBe('(integer | string)[]');
    expect(describeShape(infer([]))).toBe('unknown[]');
    expect(describeShape(infer({ '123': 1 }))).toBe('Record<string, integer>');
    const many = mergeAll(Array.from({ length: 20 }, (_, i) => infer(i % 2 ? 'on' : 'off')))!;
    expect(describeShape(many)).toBe('"off" | "on"');
    expect(describeShape(many, { enumMinSamples: 21 })).toBe('string');
  });
});

describe('renderShapeTree', () => {
  it('draws an aligned tree with optional ratios and array bounds', () => {
    expect(renderShapeTree(repo)).toBe(
      [
        '$              object',
        '├─ homepage    string<uri> | null',
        '├─ id          integer',
        '├─ license     object | null',
        '│  ├─ key      string',
        '│  └─ spdx_id  string',
        '├─ name        string',
        '├─ nick?       string  optional 1/2',
        '└─ topics      string[]  0–2 items',
      ].join('\n'),
    );
  });

  it('expands array items and id-keyed maps, and honours maxDepth', () => {
    const tree = renderShapeTree(infer({ items: [{ sku: 'a' }], byId: { '42': { ok: true } } }));
    expect(tree).toContain('[key]');
    expect(tree).toContain('sku');
    expect(renderShapeTree(infer({ a: { b: { c: 1 } } }), { maxDepth: 1 })).not.toContain(' b ');
  });

  it('falls back to ASCII connectors and adds colour only when asked', () => {
    const ascii = renderShapeTree(repo, { style: createStyle({ unicode: false }) });
    expect(ascii).toContain("'- topics");
    expect(ascii).toContain('|- id');
    const coloured = renderShapeTree(repo, { style: createStyle({ color: true }) });
    expect(coloured).toContain('\u001b[36m');
    expect(stripAnsi(coloured)).toBe(renderShapeTree(repo));
  });

  it('explainEntry adds a header with samples and learning state', () => {
    const b = learn(createBaseline(), 'GET api.test /x 2xx', { a: 1 }, { at: '2026-10-23T02:40:00Z', example: 'https://api.test/x?k=1' });
    const text = explainEntry('GET api.test /x 2xx', b.endpoints['GET api.test /x 2xx']);
    expect(text.split('\n').slice(0, 3)).toEqual([
      'GET api.test /x 2xx',
      '1 sample · learning · first seen 2026-10-23 02:40Z · last seen 2026-10-23 02:40Z',
      'https://api.test/x',
    ]);
  });
});

describe('style', () => {
  it('measures and pads printable width', () => {
    const s = createStyle({ color: true });
    const red = s.paint('breaking', 'abc');
    expect(red).not.toBe('abc');
    expect(visibleWidth(red)).toBe(3);
    expect(stripAnsi(padVisible(red, 6))).toBe('abc   ');
    expect(createStyle().paint('breaking', 'abc')).toBe('abc');
  });
});

describe('reports', () => {
  const changes = diff(infer({ a: 1, b: 'x', c: 'y|z' }), infer({ b: null, c: 'y|z', d: 1 }));
  const endpoints: EndpointResult[] = [
    { key: 'GET api.test /a 2xx', name: 'A', status: 'drift', changes, httpStatus: 200, durationMs: 41.6 },
    { key: 'GET api.test /ok 2xx', status: 'ok', changes: [], httpStatus: 200, durationMs: 12 },
    { key: 'GET api.test /new 2xx', status: 'new', changes: [] },
    { key: 'GET api.test /down', status: 'error', changes: [], error: 'fetch failed (ECONNREFUSED)' },
  ];

  it('summarises counts and the verdict', () => {
    const r = buildReport(endpoints, { failOn: 'breaking', createdAt: '2026-10-23T00:00:00.000Z', baseline: '.api-drift/baseline.json' });
    expect(r.summary).toEqual({ endpoints: 4, ok: 1, drifted: 1, new: 1, errors: 1, breaking: 1, risky: 1, info: 1 });
    expect(r.failed).toBe(true);
    expect(r.ok).toBe(false);
    expect(buildReport(endpoints, { failOn: 'never' }).failed).toBe(false);
  });

  it.each([
    [{ breaking: 1, risky: 0, info: 0 }, 'breaking', true],
    [{ breaking: 0, risky: 1, info: 0 }, 'breaking', false],
    [{ breaking: 0, risky: 1, info: 0 }, 'risky', true],
    [{ breaking: 0, risky: 0, info: 3 }, 'risky', false],
    [{ breaking: 0, risky: 0, info: 3 }, 'info', true],
    [{ breaking: 5, risky: 5, info: 5 }, 'never', false],
  ] as const)('failsOn(%o, %s) = %s', (counts, level, expected) => {
    expect(failsOn(counts, level)).toBe(expected);
  });

  it('renders readable text with symbols and a verdict', () => {
    const text = renderText(buildReport(endpoints, { failOn: 'breaking', baseline: '.api-drift/baseline.json' }));
    expect(text).toContain('api-drift check · 4 endpoints · baseline .api-drift/baseline.json');
    expect(text).toContain('✖ GET api.test /a 2xx  (A)  1 breaking · 1 risky · 1 info  200 · 42 ms');
    expect(text).toContain('    ✖ breaking  $.a  field is missing (was present in the baseline sample)');
    expect(text).toContain('✔ GET api.test /ok 2xx      no drift');
    expect(text).toContain('● GET api.test /new 2xx     new endpoint, not in baseline');
    expect(text).toContain('✖ GET api.test /down        error: fetch failed (ECONNREFUSED)');
    expect(text.trim().split('\n').pop()).toBe('1 breaking · 1 risky · 1 info · 1 new · 1 error   FAIL (--fail-on breaking)');
  });

  it('caps long change lists', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...changes[2], path: `$.f${i}` }));
    const text = renderText(buildReport([{ key: 'k', status: 'drift', changes: many }]), { maxChanges: 10 });
    expect(text).toContain('… and 50 more');
  });

  it('renders markdown tables with escaped pipes', () => {
    const md = renderMarkdown(buildReport(endpoints, { failOn: 'breaking', createdAt: 'T' }));
    expect(md.startsWith('## API drift report: ✖ Failed')).toBe(true);
    expect(md).toContain('| ✖ | `GET api.test /a 2xx` A | 1 breaking, 1 risky, 1 info |');
    expect(md).toContain('| ✖ **breaking** | `$.a` | field is missing (was present in the baseline sample) |');
    expect(md).toContain('can now be null (was string)');
    expect(md).toContain('| ✖ | `GET api.test /down` | error: fetch failed (ECONNREFUSED) |');
    const union = mergeAll([infer({ v: 1 }), infer({ v: 'a' })])!;
    const piped = renderMarkdown(buildReport([{ key: 'k', status: 'drift', changes: diff(union, infer({ v: null })) }]));
    expect(piped).toContain('can now be null (was integer \\| string)');
    const tagged = renderMarkdown(buildReport([{ key: 'k', status: 'drift', changes: diff(infer({ at: '2026-10-23' }), infer({ at: 5 })) }]));
    expect(tagged).toContain('type changed from string&lt;date&gt; to integer');
  });

  it('passes when nothing fails', () => {
    const md = renderMarkdown(buildReport([endpoints[1]]));
    expect(md.startsWith('## API drift report: ✔ Passed')).toBe(true);
    expect(renderText(buildReport([endpoints[1]])).trim().split('\n').pop()).toContain('PASS');
  });

  it('renders JSON that parses back', () => {
    const r = buildReport(endpoints);
    expect(JSON.parse(renderJson(r))).toEqual(r);
  });
});
