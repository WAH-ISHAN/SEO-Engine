import { createHash } from 'node:crypto';

/** Stable short hash. Used everywhere identity must survive across runs. */
export function hash(...parts: (string | number | undefined | null)[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(String(p ?? '~null~')).update('|');
  return h.digest('hex').slice(0, 16);
}

export function nodeId(type: string, key: string): string {
  return `${type.toLowerCase()}:${hash(type, key)}`;
}

export function edgeId(type: string, from: string, to: string, disc = ''): string {
  return `e:${hash(type, from, to, disc)}`;
}

/**
 * Problem keys must be identical across engines for the same underlying defect,
 * so they are built from (rule-family, scope) and never from the detecting engine.
 */
export function problemKey(family: string, scope: string): string {
  return `${family}::${hash(scope)}`;
}
