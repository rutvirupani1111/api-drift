/** A tiny argv parser: `--flag value`, `--flag=value`, `-f value`, `--no-flag`, `--`. */

export interface FlagSpec {
  string?: readonly string[];
  boolean?: readonly string[];
  /** String flags that may repeat; comma-separated values are split. */
  multiple?: readonly string[];
  /** Short or long alias -> canonical flag name. */
  alias?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
  unknown: string[];
  errors: string[];
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const strings = new Set([...(spec.string ?? []), ...(spec.multiple ?? [])]);
  const booleans = new Set(spec.boolean ?? []);
  const multiple = new Set(spec.multiple ?? []);
  const alias = spec.alias ?? {};
  const out: ParsedArgs = { positional: [], flags: {}, unknown: [], errors: [] };

  const set = (name: string, value: string) => {
    if (multiple.has(name)) {
      const list = (out.flags[name] as string[] | undefined) ?? [];
      list.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
      out.flags[name] = list;
    } else out.flags[name] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      out.positional.push(arg);
      continue;
    }
    const body = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
    const eq = body.indexOf('=');
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    let name = alias[rawName] ?? rawName;
    if (name.startsWith('no-') && booleans.has(name.slice(3))) {
      out.flags[name.slice(3)] = false;
      continue;
    }
    name = alias[name] ?? name;
    if (booleans.has(name)) {
      out.flags[name] = inline === undefined ? true : !/^(false|0|no)$/i.test(inline);
      continue;
    }
    if (strings.has(name)) {
      const value = inline ?? argv[i + 1];
      if (value === undefined || (inline === undefined && value.startsWith('-') && value !== '-')) {
        out.errors.push(`--${name} needs a value`);
        continue;
      }
      if (inline === undefined) i++;
      set(name, value);
      continue;
    }
    out.unknown.push(arg.split('=')[0]);
  }
  return out;
}

/** Levenshtein distance, for "did you mean" hints. */
export function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** The closest candidate within edit distance 2, if any. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const c of candidates) {
    const d = distance(input, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}
