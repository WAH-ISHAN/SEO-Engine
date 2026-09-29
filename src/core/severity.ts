import type { Category, Severity, Signal } from './model.js';

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100, high: 70, medium: 40, low: 18, info: 5,
};

/** Categories differ in how directly a defect blocks everything downstream. */
const CATEGORY_WEIGHT: Record<Category, number> = {
  TECHNICAL_SEO: 1.0,
  INFORMATION_ARCHITECTURE: 0.9,
  ON_PAGE_SEO: 0.85,
  STRUCTURED_DATA: 0.8,
  INTERNAL_LINKING: 0.78,
  CONTENT: 0.75,
  ENTITY: 0.72,
  AEO: 0.7,
  AIO: 0.68,
  GEO: 0.65,
  PERFORMANCE: 0.6,
  ACCESSIBILITY: 0.6,
};

export function severityRank(s: Severity): number {
  return SEVERITY_WEIGHT[s];
}

export function maxSeverity(list: Severity[]): Severity {
  let best: Severity = 'info';
  for (const s of list) if (SEVERITY_WEIGHT[s] > SEVERITY_WEIGHT[best]) best = s;
  return best;
}

/**
 * Escalate severity when several independent engines see the same defect.
 * Corroboration raises confidence in the finding, which raises its priority; it does
 * not change what was observed.
 */
export function corroboratedConfidence(confidences: number[]): number {
  if (confidences.length === 0) return 0;
  // Probability that at least one independent detector is right, capped.
  const miss = confidences.reduce((acc, c) => acc * (1 - clamp01(c)), 1);
  return Math.min(0.99, 1 - miss);
}

export interface PriorityInput {
  severity: Severity;
  confidence: number;
  category: Category;
  affectedUrlCount: number;
  totalPageCount: number;
  /** Number of other recommendations blocked by this one. */
  unblocks: number;
  /** True when this recommendation cannot proceed until a dependency is resolved. */
  blocked: boolean;
}

/**
 * Priority score, 0..100. Purely an ordering device for the work queue.
 * It is not a ranking prediction and must never be presented as one.
 */
export function priorityScore(p: PriorityInput): number {
  const base = SEVERITY_WEIGHT[p.severity] * CATEGORY_WEIGHT[p.category];
  const reach = p.totalPageCount > 0 ? p.affectedUrlCount / p.totalPageCount : 0;
  // Sublinear reach: fixing 100 pages matters more than 1, but not 100x more.
  const reachFactor = 0.6 + 0.4 * Math.sqrt(Math.min(1, reach));
  const unblockBonus = Math.min(15, p.unblocks * 4);
  const blockedPenalty = p.blocked ? 0.65 : 1;
  const score = (base * reachFactor * clamp01(p.confidence) + unblockBonus) * blockedPenalty;
  return Math.round(Math.max(0, Math.min(100, score)));
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * Health score for a dashboard section, 0..100.
 * Explicitly an internal hygiene measure: it describes how many of this platform's
 * checks the site currently passes. It is not a search ranking, a traffic estimate,
 * or a prediction of inclusion in any search or AI-generated result.
 */
export function healthScore(signals: Signal[], pageCount: number): number {
  if (pageCount === 0) return 0;
  let penalty = 0;
  for (const s of signals) {
    const reach = Math.min(1, s.affectedUrls.length / Math.max(1, pageCount));
    penalty += SEVERITY_WEIGHT[s.severity] * clamp01(s.confidence) * (0.35 + 0.65 * reach);
  }
  // Normalize against a saturation constant so scores stay comparable across sites.
  const normalized = penalty / (penalty + 220);
  return Math.round((1 - normalized) * 100);
}

export const SCORE_DISCLAIMER =
  'Scores measure how many of this platform\'s technical and content checks the site ' +
  'currently passes. They are not search rankings, traffic forecasts, or guarantees of ' +
  'inclusion in search results or AI-generated answers.';
