import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  configTemplate,
  libraryOptions,
  loadConfig,
  maskSecrets,
  resolveEndpoints,
  substituteEnv,
  validateConfig,
  type DriftConfig,
} from '../src/node/config';
import { parseJsonc } from '../src/node/jsonc';
import { supportsColor, supportsUnicode } from '../src/node/terminal';
import { tempDir } from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('parseJsonc', () => {
  it('strips comments and trailing commas but not string contents', () => {
    const text = `﻿{
      // line comment
      "url": "https://x.test/a//b", /* block
      comment */ "note": "/* not a comment */",
      "list": [1, 2, 3,],
      "escaped": "quote \\" // still string",
    }`;
    expect(parseJsonc(text)).toEqual({
      url: 'https://x.test/a//b',
      note: '/* not a comment */',
      list: [1, 2, 3],
      escaped: 'quote " // still string',
    });
  });

  it('keeps JSON errors pointing at the right line', () => {
    expect(() => parseJsonc('{\n/* c\n */\n "a": }')).toThrow();
  });
});

describe('validateConfig', () => {
  const valid = { endpoints: [{ url: 'https://x.test' }] };

  it('accepts a minimal config', () => {
    expect(validateConfig(valid)).toEqual(valid);
  });

  it.each([
    [[], 'must be a JSON object'],
    [{}, '"endpoints" must be an array'],
    [{ endpoints: [{}] }, 'endpoints[0].url must be a non-empty string'],
    [{ endpoints: [{ url: 'x', method: 'GET /' }] }, 'endpoints[0].method must be an HTTP method'],
    [{ endpoints: [{ url: 'x', samples: 0 }] }, 'endpoints[0].samples must be an integer between 1 and 100'],
    [{ endpoints: [{ url: 'x', headers: { a: 1 } }] }, 'endpoints[0].headers must map header names to strings'],
    [{ ...valid, failOn: 'sometimes' }, '"failOn" must be one of breaking, risky, info, never'],
    [{ ...valid, diff: { severity: { vanished: 'info' } } }, 'unknown change kind "vanished"'],
    [{ ...valid, diff: { severity: { added: 'loud' } } }, '"diff.severity.added" must be one of'],
    [{ ...valid, defaults: { timeout: -1 } }, 'defaults.timeout must be a positive number'],
  ])('rejects %j', (raw, message) => {
    expect(() => validateConfig(raw, 'cfg')).toThrow(ConfigError);
    expect(() => validateConfig(raw, 'cfg')).toThrow(message);
  });

  it('libraryOptions converts enumExclude strings and maxPayloadBytes', () => {
    const lib = libraryOptions({ endpoints: [], maxPayloadBytes: 5, infer: { enumExclude: '^tier$' }, diff: { ignore: ['$.a'] } });
    expect(lib.infer.maxPayloadBytes).toBe(5);
    expect(lib.infer.enumExclude).toBeInstanceOf(RegExp);
    expect(lib.diff.ignore).toEqual(['$.a']);
  });
});

describe('environment substitution', () => {
  it('substitutes, applies defaults and collects secrets', () => {
    const secrets = new Set<string>();
    const out = substituteEnv('Bearer ${TOKEN} ${REGION:-eu} ${SHORT}', { TOKEN: 'sk_live_123456', SHORT: 'ab' }, secrets, 'x');
    expect(out).toBe('Bearer sk_live_123456 eu ab');
    expect([...secrets]).toEqual(['sk_live_123456']);
  });

  it('names the missing variable', () => {
    expect(() => substituteEnv('${NOPE}', {}, new Set(), 'endpoint "a".url')).toThrow(
      'Environment variable NOPE is not set (used in endpoint "a".url)',
    );
  });

  it('masks secrets, longest first', () => {
    expect(maskSecrets('key=abcdef123 and abcdef', new Set(['abcdef', 'abcdef123']))).toBe('key=*** and ***');
  });

  it('resolveEndpoints applies defaults, headers, bodies and --only', () => {
    const config: DriftConfig = {
      defaults: { headers: { Accept: 'application/json' }, timeout: 500, samples: 2 },
      endpoints: [
        { name: 'Users', url: 'https://api.test/users?key=${API_KEY}', headers: { 'X-Team': '${TEAM:-core}' } },
        { name: 'Create', method: 'post', url: 'https://api.test/orders', body: { note: '${TEAM:-core}' }, samples: 1 },
      ],
    };
    const secrets = new Set<string>();
    const [users, create] = resolveEndpoints(config, { API_KEY: 'secret-value-1' }, secrets);
    expect(users).toMatchObject({
      method: 'GET',
      url: 'https://api.test/users?key=secret-value-1',
      displayUrl: 'https://api.test/users?key=${API_KEY}',
      headers: { accept: 'application/json', 'x-team': 'core' },
      samples: 2,
      timeout: 500,
    });
    expect(create).toMatchObject({ method: 'POST', body: '{"note":"core"}', samples: 1 });
    expect(create.headers['content-type']).toBe('application/json');
    expect(secrets.has('secret-value-1')).toBe(true);
    expect(resolveEndpoints(config, { API_KEY: 'k' }, new Set(), ['creat']).map((e) => e.name)).toEqual(['Create']);
    const optionalAuth = resolveEndpoints({ endpoints: [{ url: 'https://a.test', headers: { Authorization: '${AUTH:-}' } }] }, {}, new Set());
    expect(optionalAuth[0].headers).toEqual({});
    expect(() => resolveEndpoints({ endpoints: [{ url: 'ftp://x' }] }, {}, new Set())).toThrow('not an absolute http(s) URL');
  });
});

describe('configTemplate and loadConfig', () => {
  it('the template is valid JSONC and a valid config', () => {
    expect(validateConfig(parseJsonc(configTemplate()))).toMatchObject({ failOn: 'breaking' });
    const withUrls = validateConfig(parseJsonc(configTemplate(['https://a.test/x', 'https://b.test/y'])));
    expect(withUrls.endpoints.map((e) => e.url)).toEqual(['https://a.test/x', 'https://b.test/y']);
  });

  it('resolves the baseline relative to the config file', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    mkdirSync(join(t.dir, 'conf'));
    writeFileSync(join(t.dir, 'conf', 'drift.json'), '{ "baseline": "out/b.json", "endpoints": [] }');
    const loaded = await loadConfig('conf/drift.json', t.dir);
    expect(loaded.baselinePath).toBe(join(t.dir, 'conf', 'out', 'b.json'));
  });

  it('explains a missing or broken config', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    await expect(loadConfig(undefined, t.dir)).rejects.toThrow('Run `api-drift init`');
    writeFileSync(join(t.dir, 'api-drift.config.json'), '{ nope');
    await expect(loadConfig(undefined, t.dir)).rejects.toThrow('is not valid JSON');
  });
});

describe('terminal detection', () => {
  it('honours NO_COLOR, FORCE_COLOR, GitHub Actions and TTYs', () => {
    expect(supportsColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(supportsColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(supportsColor({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(false);
    expect(supportsColor({ isTTY: false }, { GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(supportsColor({ isTTY: true }, {})).toBe(true);
    expect(supportsColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(supportsColor(undefined, {})).toBe(false);
  });

  it('uses ASCII symbols only on legacy Windows consoles', () => {
    expect(supportsUnicode({}, 'linux')).toBe(true);
    expect(supportsUnicode({}, 'win32')).toBe(false);
    expect(supportsUnicode({ WT_SESSION: '1' }, 'win32')).toBe(true);
    expect(supportsUnicode({ API_DRIFT_ASCII: '1' }, 'darwin')).toBe(false);
  });
});
