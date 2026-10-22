import { VERSION } from '../version';
import { isBaseline, type Baseline } from './baseline';
import { parseEndpointKey } from './endpoint';
import { FORMAT_PATTERNS } from './formats';
import {
  countOf,
  DEFAULT_ENUM_MIN_SAMPLES,
  isEnum,
  variantsOf,
  type LeafShape,
  type ObjectShape,
  type Shape,
  type StringShape,
} from './shape';
import { compareStrings, pascalCase } from './util';

export interface TypegenOptions {
  /** Emit Zod schemas (as source text) instead of TypeScript interfaces. */
  zod?: boolean;
  /** Observations needed before a closed set of strings becomes a literal union. Default 20. */
  enumMinSamples?: number;
  /** File header comment; `false` to omit. */
  header?: string | false;
  /** Override the base type name for an endpoint key. */
  nameFor?: (key: string) => string;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const propName = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
/** In a JS object literal `__proto__: x` sets the prototype; a computed key defines a property. */
const literalKey = (k: string) => (k === '__proto__' ? '["__proto__"]' : propName(k));

/** `GET api.github.com /repos/:id/pulls 2xx` -> `GetReposByIdPulls`. */
export function typeNameForKey(key: string): string {
  const p = parseEndpointKey(key);
  let name: string;
  if (p) {
    const segs = p.path
      .split('?')[0]
      .split('/')
      .filter(Boolean)
      .map((s) => (s === ':id' ? 'ById' : pascalCase(s)));
    name = pascalCase(p.method.toLowerCase()) + segs.join('');
    if (p.status && p.status !== '2xx') name += `Status${p.status}`;
  } else {
    name = pascalCase(key);
  }
  if (!name) name = 'Endpoint';
  return /^\d/.test(name) ? `T${name}` : name;
}

class Gen {
  decls: string[] = [];
  used = new Set<string>();
  constructor(
    readonly zod: boolean,
    readonly enumMin: number,
  ) {}

  claim(name: string): string {
    let n = name;
    for (let i = 2; this.used.has(n); i++) n = `${name}${i}`;
    this.used.add(n);
    return n;
  }

  /** Reserve a declaration slot: TS emits parents first, Zod emits children first. */
  declare(build: () => string): void {
    if (this.zod) {
      this.decls.push(build());
    } else {
      const i = this.decls.push('') - 1;
      this.decls[i] = build();
    }
  }

  expr(shape: Shape, prefix: string): string {
    const variants = variantsOf(shape);
    const nonNull = variants.filter((v) => v.kind !== 'null');
    if (!this.zod) {
      const parts = nonNull.map((v) => this.tsLeaf(v, prefix));
      if (nonNull.length < variants.length) parts.push('null');
      return parts.join(' | ');
    }
    if (nonNull.length === 0) return 'z.null()';
    const parts = nonNull.map((v) => this.zLeaf(v, prefix));
    const base = parts.length === 1 ? parts[0] : `z.union([${parts.join(', ')}])`;
    return nonNull.length < variants.length ? `${base}.nullable()` : base;
  }

  enumValues(s: StringShape): string[] | undefined {
    return isEnum(s, this.enumMin) ? s.values : undefined;
  }

  tsLeaf(v: LeafShape, prefix: string): string {
    switch (v.kind) {
      case 'null':
        return 'null';
      case 'boolean':
        return 'boolean';
      case 'integer':
      case 'number':
        return 'number';
      case 'string': {
        const values = this.enumValues(v);
        return values ? values.map((x) => JSON.stringify(x)).join(' | ') : 'string';
      }
      case 'array': {
        if (!v.items) return 'unknown[]';
        const inner = this.expr(v.items, `${prefix}Item`);
        return inner.includes(' ') ? `Array<${inner}>` : `${inner}[]`;
      }
      case 'object':
        return this.object(v, prefix, prefix);
      default:
        return 'unknown';
    }
  }

  zLeaf(v: LeafShape, prefix: string): string {
    switch (v.kind) {
      case 'boolean':
        return 'z.boolean()';
      case 'integer':
        return 'z.number().int()';
      case 'number':
        return 'z.number()';
      case 'string': {
        const values = this.enumValues(v);
        return values ? `z.enum([${values.map((x) => JSON.stringify(x)).join(', ')}])` : zString(v);
      }
      case 'array':
        return `z.array(${v.items ? this.expr(v.items, `${prefix}Item`) : 'z.unknown()'})`;
      case 'object':
        return this.object(v, prefix, prefix);
      default:
        return 'z.unknown()';
    }
  }

  /** Declare a named interface/schema for an object and return its name. */
  object(o: ObjectShape, declName: string, prefix: string): string {
    const keys = Object.keys(o.properties);
    if (keys.length === 0) {
      const value = o.additional ? this.expr(o.additional, `${prefix}Value`) : this.zod ? 'z.unknown()' : 'unknown';
      return this.zod ? `z.record(z.string(), ${value})` : `Record<string, ${value}>`;
    }
    const name = this.claim(declName);
    this.declare(() => {
      const lines: string[] = [];
      for (const k of keys) {
        const p = o.properties[k];
        const optional = countOf(p) < o.count;
        const child = this.expr(p, prefix + pascalCase(k));
        if (this.zod) lines.push(`  ${literalKey(k)}: ${child}${optional ? '.optional()' : ''},`);
        else {
          const doc = docFor(p);
          if (doc) lines.push(`  /** ${doc} */`);
          lines.push(`  ${propName(k)}${optional ? '?' : ''}: ${child};`);
        }
      }
      const extra = o.additional ? this.expr(o.additional, `${prefix}Value`) : undefined;
      if (this.zod) {
        const schema = `z.object({\n${lines.join('\n')}\n})${extra ? `.catchall(${extra})` : ''}`;
        return `export const ${name} = ${schema};\nexport type ${name} = z.infer<typeof ${name}>;`;
      }
      return extra
        ? `export type ${name} = {\n${lines.join('\n')}\n} & Record<string, ${extra}>;`
        : `export interface ${name} {\n${lines.join('\n')}\n}`;
    });
    return name;
  }
}

function docFor(shape: Shape): string | undefined {
  for (const v of variantsOf(shape)) {
    if (v.kind === 'string') {
      const real = v.formats.filter((f) => f !== 'empty' && f !== 'plain');
      if (real.length === 1 && !v.formats.includes('plain')) {
        return `Format: ${real[0]}${v.formats.includes('empty') ? ' (or empty)' : ''}`;
      }
    }
  }
  return undefined;
}

function zString(v: StringShape): string {
  const real = v.formats.filter((f) => f !== 'empty');
  const hasEmpty = v.formats.includes('empty');
  if (real.length === 0) return hasEmpty ? "z.literal('')" : 'z.string()';
  if (real.length > 1 || real[0] === 'plain') return 'z.string()';
  const pattern = (FORMAT_PATTERNS as Record<string, RegExp>)[real[0]];
  const base = pattern ? `z.string().regex(/${pattern.source}/${pattern.flags})` : 'z.string()';
  return hasEmpty ? `z.union([${base}, z.literal('')])` : base;
}

function emitRoot(g: Gen, shape: Shape, base: string, comment: string): void {
  const rootName = `${base}Response`;
  const variants = variantsOf(shape);
  const only = variants.length === 1 ? variants[0] : undefined;
  const start = g.decls.length;
  if (only?.kind === 'object' && Object.keys(only.properties).length > 0) {
    g.object(only, rootName, base);
  } else {
    const name = g.claim(rootName);
    g.declare(() => {
      const expr = g.expr(shape, base);
      return g.zod
        ? `export const ${name} = ${expr};\nexport type ${name} = z.infer<typeof ${name}>;`
        : `export type ${name} = ${expr};`;
    });
  }
  // Attach the endpoint comment to the root declaration (first for TS, last for Zod).
  const idx = g.zod ? g.decls.length - 1 : start;
  g.decls[idx] = `/** ${comment} */\n${g.decls[idx]}`;
}

/** Generate a single TypeScript type (or Zod schema) for one shape. */
export function shapeToSource(shape: Shape, name: string, options: TypegenOptions = {}): string {
  const g = new Gen(!!options.zod, options.enumMinSamples ?? DEFAULT_ENUM_MIN_SAMPLES);
  emitRoot(g, shape, name, name);
  return g.decls.join('\n\n');
}

/**
 * Generate TypeScript interfaces (or Zod schemas) for every endpoint of a
 * baseline. Output is source text; no zod dependency is needed to generate it.
 */
export function generateTypes(input: Baseline | Record<string, Shape>, options: TypegenOptions = {}): string {
  const entries: Array<{ key: string; shape: Shape; samples: number }> = isBaseline(input)
    ? Object.keys(input.endpoints).map((key) => ({ key, shape: input.endpoints[key].shape, samples: input.endpoints[key].samples }))
    : Object.keys(input).map((key) => ({ key, shape: input[key], samples: countOf(input[key]) }));
  entries.sort((a, b) => compareStrings(a.key, b.key));
  const nameFor = options.nameFor ?? typeNameForKey;
  const names = entries.map((e) => nameFor(e.key));
  // Same route on different hosts: prefix with the host to keep names apart.
  const dupes = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const g = new Gen(!!options.zod, options.enumMinSamples ?? DEFAULT_ENUM_MIN_SAMPLES);
  entries.forEach((e, i) => {
    let base = names[i];
    if (dupes.has(base)) base = pascalCase(parseEndpointKey(e.key)?.host ?? '') + base;
    emitRoot(g, e.shape, base, `${e.key} (${e.samples} sample${e.samples === 1 ? '' : 's'})`);
  });
  const header =
    options.header === false
      ? []
      : [options.header ?? `// Generated by api-drift ${VERSION} from observed responses. Do not edit by hand.`];
  if (options.zod) header.push("import { z } from 'zod';");
  return `${[...header, ...(header.length ? [''] : []), g.decls.join('\n\n')].join('\n').replace(/^\n+/, '')}\n`;
}
