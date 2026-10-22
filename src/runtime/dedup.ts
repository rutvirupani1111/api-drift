import { changeFingerprint, type Change } from '../core/diff';

/**
 * Suppresses repeats: a change (endpoint + fingerprint) reported less than
 * `cooldownMs` ago is dropped. A cooldown of 0 disables deduplication.
 */
export function createDedup(cooldownMs: number, now: () => number) {
  const seen = new Map<string, number>();
  const prune = (t: number) => {
    for (const [k, at] of seen) if (t - at >= cooldownMs) seen.delete(k);
  };
  return {
    filter(scope: string, changes: readonly Change[]): Change[] {
      if (cooldownMs <= 0) return changes.slice();
      const t = now();
      const fresh: Change[] = [];
      for (const c of changes) {
        const fp = changeFingerprint(c, scope);
        const last = seen.get(fp);
        if (last !== undefined && t - last < cooldownMs) continue;
        seen.set(fp, t);
        fresh.push(c);
      }
      if (seen.size > 5000) prune(t);
      return fresh;
    },
    clear() {
      seen.clear();
    },
    get size() {
      return seen.size;
    },
  };
}
