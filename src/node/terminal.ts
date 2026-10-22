import { createStyle, type Style } from '../core/style';

type Env = Record<string, string | undefined>;

/** Colour support: NO_COLOR, FORCE_COLOR, GitHub Actions, then TTY detection. */
export function supportsColor(stream: { isTTY?: boolean } | undefined, env: Env = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (env.GITHUB_ACTIONS === 'true') return true;
  return !!stream?.isTTY && env.TERM !== 'dumb';
}

/** Unicode symbols are safe everywhere except legacy Windows consoles. */
export function supportsUnicode(env: Env = process.env, platform: string = process.platform): boolean {
  if (env.API_DRIFT_ASCII === '1') return false;
  if (platform !== 'win32') return env.TERM !== 'linux';
  return Boolean(
    env.WT_SESSION ||
      env.TERMINUS_SUBLIME ||
      env.ConEmuTask === '{cmd::Cmder}' ||
      env.TERM_PROGRAM === 'vscode' ||
      env.TERM === 'xterm-256color' ||
      env.TERM === 'xterm' ||
      env.TERM === 'alacritty' ||
      env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
      env.CI ||
      env.MSYSTEM,
  );
}

/** A Style tuned for a stream and environment. `color` forces colours on or off. */
export function terminalStyle(stream: { isTTY?: boolean } | undefined, env: Env = process.env, color?: boolean): Style {
  return createStyle({ color: color ?? supportsColor(stream, env), unicode: supportsUnicode(env) });
}
