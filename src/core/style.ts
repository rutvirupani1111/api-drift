/**
 * Terminal styling without dependencies. Renderers take a `Style`, so the same
 * code produces ANSI colours on a TTY and plain text everywhere else.
 */

export type StyleRole =
  | 'breaking'
  | 'risky'
  | 'info'
  | 'ok'
  | 'error'
  | 'muted'
  | 'bold'
  | 'title'
  | 'type'
  | 'accent'
  | 'path';

export interface Symbols {
  breaking: string;
  risky: string;
  info: string;
  ok: string;
  error: string;
  arrow: string;
  dot: string;
  /** Tree connectors. */
  branch: string;
  last: string;
  pipe: string;
  space: string;
  range: string;
}

export interface Style {
  color: boolean;
  unicode: boolean;
  paint(role: StyleRole, text: string): string;
  sym: Symbols;
}

const UNICODE: Symbols = {
  breaking: '✖',
  risky: '▲',
  info: '●',
  ok: '✔',
  error: '✖',
  arrow: '→',
  dot: '·',
  branch: '├─ ',
  last: '└─ ',
  pipe: '│  ',
  space: '   ',
  range: '–',
};

const ASCII: Symbols = {
  breaking: 'x',
  risky: '!',
  info: 'i',
  ok: '+',
  error: 'x',
  arrow: '->',
  dot: '-',
  branch: '|- ',
  last: "'- ",
  pipe: '|  ',
  space: '   ',
  range: '-',
};

const CODES: Record<StyleRole, [number, number]> = {
  breaking: [31, 39],
  risky: [33, 39],
  info: [94, 39],
  ok: [32, 39],
  error: [31, 39],
  muted: [90, 39],
  bold: [1, 22],
  title: [1, 22],
  type: [36, 39],
  accent: [35, 39],
  path: [1, 22],
};

export function createStyle(options: { color?: boolean; unicode?: boolean } = {}): Style {
  const color = options.color ?? false;
  const unicode = options.unicode ?? true;
  return {
    color,
    unicode,
    sym: unicode ? UNICODE : ASCII,
    paint: (role, text) => {
      if (!color || text === '') return text;
      const [open, close] = CODES[role];
      return `\u001b[${open}m${text}\u001b[${close}m`;
    },
  };
}

/** No colours, Unicode symbols. */
export const plainStyle: Style = createStyle();

const ANSI = /\u001b\[[\d;]*m/g;

/** Printable width of a string (ANSI escapes removed). */
export function visibleWidth(s: string): number {
  return s.replace(ANSI, '').length;
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** Pad to a printable width, ignoring ANSI escapes. */
export function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}
