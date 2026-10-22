/**
 * Parse JSON with comments (`//`, `/* *\/`) and trailing commas, the dialect of
 * `api-drift.config.json` (like tsconfig.json). Strings are left untouched.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      // keep newlines so JSON.parse positions still point at the right line
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  // Remove trailing commas before } or ] (outside strings: strings were copied verbatim
  // above, so re-scan with a string-aware pass).
  let result = '';
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (c === '"') {
      const start = j++;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      result += out.slice(start, j + 1);
      continue;
    }
    if (c === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    result += c;
  }
  return JSON.parse(result.replace(/^﻿/, ''));
}
