import type { BaselineEntry } from './baseline';
import { describe } from './describe';
import { countOf, variantsOf, type Shape } from './shape';
import { padVisible, plainStyle, visibleWidth, type Style } from './style';

export interface TreeOptions {
  style?: Style;
  /** Observations needed before a closed set of strings is shown as an enum. Default 20. */
  enumMinSamples?: number;
  /** Stop expanding below this depth. Default: unlimited. */
  maxDepth?: number;
  /** Cap for the name column width. Default 44. */
  maxNameWidth?: number;
}

interface Row {
  lead: string;
  name: string;
  optional: boolean;
  type: string;
  notes: string[];
}

interface Child {
  name: string;
  shape: Shape;
  optional: boolean;
  notes: string[];
}

function notesFor(shape: Shape, style: Style): string[] {
  const notes: string[] = [];
  for (const v of variantsOf(shape)) {
    if (v.kind === 'array') {
      notes.push(v.minItems === v.maxItems ? `${v.minItems} item${v.minItems === 1 ? '' : 's'}` : `${v.minItems}${style.sym.range}${v.maxItems} items`);
    } else if ((v.kind === 'integer' || v.kind === 'number') && v.min !== undefined && v.max !== undefined) {
      notes.push(v.min === v.max ? `= ${v.min}` : `${v.min}..${v.max}`);
    } else if (v.kind === 'object' && v.truncated) {
      notes.push('truncated');
    }
  }
  return notes;
}

/** Children of a node: object properties, id-keyed entries, and (through arrays) item properties. */
function childrenOf(shape: Shape, style: Style): Child[] {
  const out: Child[] = [];
  for (const v of variantsOf(shape)) {
    if (v.kind === 'object') {
      for (const k of Object.keys(v.properties)) {
        const p = v.properties[k];
        const present = countOf(p);
        const optional = present < v.count;
        const notes = notesFor(p, style);
        if (optional) notes.unshift(`optional ${present}/${v.count}`);
        out.push({ name: k, shape: p, optional, notes });
      }
      if (v.additional) out.push({ name: '[key]', shape: v.additional, optional: false, notes: ['id-keyed', ...notesFor(v.additional, style)] });
    } else if (v.kind === 'array' && v.items) {
      out.push(...childrenOf(v.items, style));
    }
  }
  return out;
}

/** Render a shape as an aligned tree, one property per line. */
export function renderShapeTree(shape: Shape, options: TreeOptions = {}): string {
  const style = options.style ?? plainStyle;
  const d = (s: Shape) => describe(s, { enumMinSamples: options.enumMinSamples });
  const maxDepth = options.maxDepth ?? Infinity;
  const rows: Row[] = [{ lead: '', name: '$', optional: false, type: d(shape), notes: notesFor(shape, style) }];
  const visit = (node: Shape, lead: string, depth: number) => {
    if (depth >= maxDepth) return;
    const kids = childrenOf(node, style);
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1;
      rows.push({
        lead: lead + (last ? style.sym.last : style.sym.branch),
        name: kid.name,
        optional: kid.optional,
        type: d(kid.shape),
        notes: kid.notes,
      });
      visit(kid.shape, lead + (last ? style.sym.space : style.sym.pipe), depth + 1);
    });
  };
  visit(shape, '', 0);
  const width = Math.min(
    Math.max(...rows.map((r) => visibleWidth(r.lead) + r.name.length + (r.optional ? 1 : 0))),
    options.maxNameWidth ?? 44,
  );
  return rows
    .map((r) => {
      const left = style.paint('muted', r.lead) + r.name + (r.optional ? style.paint('risky', '?') : '');
      const notes = r.notes.length ? `  ${style.paint('muted', r.notes.join(` ${style.sym.dot} `))}` : '';
      return `${padVisible(left, width)}  ${style.paint('type', r.type)}${notes}`;
    })
    .join('\n');
}

const shortTime = (iso: string) => iso.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, 'Z');

/** Render one baseline entry: a header line, a metadata line and the tree. */
export function explainEntry(key: string, entry: BaselineEntry, options: TreeOptions = {}): string {
  const style = options.style ?? plainStyle;
  const meta = [
    `${entry.samples} sample${entry.samples === 1 ? '' : 's'}`,
    entry.frozen ? 'frozen' : 'learning',
    `first seen ${shortTime(entry.firstSeen)}`,
    `last seen ${shortTime(entry.lastSeen)}`,
  ];
  const lines = [style.paint('title', key), style.paint('muted', meta.join(` ${style.sym.dot} `))];
  if (entry.example) lines.push(style.paint('muted', entry.example));
  return `${lines.join('\n')}\n\n${renderShapeTree(entry.shape, options)}`;
}
