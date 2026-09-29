import { createHash } from 'node:crypto';

const STOPWORD_LIST =
  'a about above after again against all am an and any are as at be because been before being below between both ' +
  'but by can cannot could did do does doing down during each few for from further had has have having he her here ' +
  'hers herself him himself his how i if in into is it its itself let me more most must my myself no nor not of off ' +
  'on once only or other ought our ours ourselves out over own same shall she should so some such than that the ' +
  'their theirs them themselves then there these they this those through to too under until up very was we were ' +
  'what when where which while who whom why will with would you your yours yourself yourselves';

const STOPWORDS = new Set(STOPWORD_LIST.split(' ').filter(Boolean));

export function isStopword(w: string): boolean {
  return STOPWORDS.has(w);
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .split(/[^a-z0-9À-ɏ]+/)
    .filter((t) => t.length > 1);
}

export function contentWords(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Light suffix stripper. Enough to cluster topics; not a linguistic claim. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  w = w.replace(/(ational|tional|ization|iveness|fulness|ousness)$/, '');
  w = w.replace(/(ations|izers|ments|ingly)$/, '');
  w = w.replace(/ies$/, 'y');
  w = w.replace(/sses$/, 'ss');
  w = w.replace(/(ing|edly|edness)$/, '');
  w = w.replace(/ed$/, '');
  w = w.replace(/(ly|ness|ment|able|ible|ance|ence)$/, '');
  w = w.replace(/s$/, '');
  return w.length >= 3 ? w : word;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** 64-bit simhash over word trigrams, hex encoded. Near-duplicates share most bits. */
export function simhash(text: string): string {
  const words = contentWords(text);
  const grams: string[] = [];
  for (let i = 0; i + 2 < words.length; i++) grams.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  if (grams.length === 0) grams.push(...words);
  const v = new Array<number>(64).fill(0);
  for (const g of grams) {
    const h = createHash('md5').update(g).digest();
    for (let b = 0; b < 64; b++) {
      const bit = (h[b >> 3] >> (7 - (b & 7))) & 1;
      v[b] += bit ? 1 : -1;
    }
  }
  let out = '';
  for (let nib = 0; nib < 16; nib++) {
    let n = 0;
    for (let b = 0; b < 4; b++) n = (n << 1) | (v[nib * 4 + b] > 0 ? 1 : 0);
    out += n.toString(16);
  }
  return out;
}

export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Jaccard similarity over term sets. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export interface TermStat {
  term: string;
  count: number;
  density: number;
}

export function termFrequency(text: string, topN = 30): TermStat[] {
  const words = contentWords(text).map(stem);
  const total = words.length || 1;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count, density: count / total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/** Sentence segmentation, approximate. Used for answer extraction and readability. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const m = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

/** Flesch reading ease. A readability signal, not a content-quality verdict. */
export function fleschReadingEase(text: string): number {
  const sents = sentences(text);
  const words = tokenize(text);
  if (sents.length === 0 || words.length === 0) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 206.835 - 1.015 * (words.length / sents.length) - 84.6 * (syl / words.length);
}

const QUESTION_STARTERS =
  /^(what|who|whose|when|where|why|how|which|can|does|do|is|are|should|will|would|could|did|has|have|am|was|were)\b/i;

export function looksLikeQuestion(s: string): boolean {
  const t = s.trim();
  if (t.length > 200) return false;
  if (t.endsWith('?')) return true;
  return QUESTION_STARTERS.test(t) && t.split(/\s+/).length >= 3;
}

export function truncate(s: string, n: number): string {
  const t = normalizeWhitespace(s);
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** Title-cases a slug for use as a readable fallback label. */
export function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\.\w+$/, '')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
