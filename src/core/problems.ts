import { problemKey } from './ids.js';
import type { Category, EngineId, Evidence, FixSpec, Severity, Signal } from './model.js';

/**
 * The shared problem vocabulary.
 *
 * A problem family names an underlying defect, independent of which engine noticed it.
 * When the SEO engine sees "no structured data on this page" and the AIO engine sees
 * "this page's subject is not machine-readable", both emit the same family for the same
 * URL, and the recommendation engine merges them into one item carrying both signals.
 * Adding a new family is how you add a genuinely new problem; reusing one is how you
 * connect a new perspective to an existing problem.
 */
export const PROBLEM_FAMILIES = {
  // Technical
  ROBOTS_MISSING: 'ROBOTS_MISSING',
  ROBOTS_BLOCKS_CONTENT: 'ROBOTS_BLOCKS_CONTENT',
  SITEMAP_MISSING: 'SITEMAP_MISSING',
  SITEMAP_STALE: 'SITEMAP_STALE',
  SITEMAP_BAD_ENTRIES: 'SITEMAP_BAD_ENTRIES',
  PAGE_NOINDEX: 'PAGE_NOINDEX',
  CANONICAL_MISSING: 'CANONICAL_MISSING',
  CANONICAL_BROKEN: 'CANONICAL_BROKEN',
  CANONICAL_CONFLICT: 'CANONICAL_CONFLICT',
  ROBOTS_DIRECTIVE_CONFLICT: 'ROBOTS_DIRECTIVE_CONFLICT',
  HTTP_ERROR: 'HTTP_ERROR',
  BROKEN_INTERNAL_LINK: 'BROKEN_INTERNAL_LINK',
  REDIRECT_CHAIN: 'REDIRECT_CHAIN',
  INTERNAL_LINK_TO_REDIRECT: 'INTERNAL_LINK_TO_REDIRECT',
  URL_STRUCTURE: 'URL_STRUCTURE',
  MIXED_CONTENT: 'MIXED_CONTENT',
  CONTENT_NOT_IN_HTML: 'CONTENT_NOT_IN_HTML',

  // On-page
  TITLE_MISSING: 'TITLE_MISSING',
  TITLE_DUPLICATE: 'TITLE_DUPLICATE',
  TITLE_LENGTH: 'TITLE_LENGTH',
  DESCRIPTION_MISSING: 'DESCRIPTION_MISSING',
  DESCRIPTION_DUPLICATE: 'DESCRIPTION_DUPLICATE',
  DESCRIPTION_LENGTH: 'DESCRIPTION_LENGTH',
  H1_MISSING: 'H1_MISSING',
  H1_MULTIPLE: 'H1_MULTIPLE',
  HEADING_ORDER: 'HEADING_ORDER',
  LANG_MISSING: 'LANG_MISSING',
  VIEWPORT_MISSING: 'VIEWPORT_MISSING',
  SOCIAL_METADATA_MISSING: 'SOCIAL_METADATA_MISSING',

  // Content
  THIN_CONTENT: 'THIN_CONTENT',
  DUPLICATE_CONTENT: 'DUPLICATE_CONTENT',
  CANNIBALIZATION: 'CANNIBALIZATION',
  CONTENT_STALE: 'CONTENT_STALE',
  READABILITY: 'READABILITY',

  // Architecture and links
  ORPHAN_PAGE: 'ORPHAN_PAGE',
  WEAK_INTERNAL_LINKING: 'WEAK_INTERNAL_LINKING',
  EXCESSIVE_DEPTH: 'EXCESSIVE_DEPTH',
  ISOLATED_SECTION: 'ISOLATED_SECTION',
  MISSING_TOPIC_LINK: 'MISSING_TOPIC_LINK',
  ANCHOR_TEXT_QUALITY: 'ANCHOR_TEXT_QUALITY',
  ANCHOR_TEXT_OVER_OPTIMIZED: 'ANCHOR_TEXT_OVER_OPTIMIZED',

  // Structured data and entities
  STRUCTURED_DATA_ABSENT: 'STRUCTURED_DATA_ABSENT',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  SCHEMA_INCOMPLETE: 'SCHEMA_INCOMPLETE',
  SCHEMA_DUPLICATE: 'SCHEMA_DUPLICATE',
  SCHEMA_CONTRADICTS_CONTENT: 'SCHEMA_CONTRADICTS_CONTENT',
  ORGANIZATION_IDENTITY_MISSING: 'ORGANIZATION_IDENTITY_MISSING',
  ENTITY_UNDEFINED: 'ENTITY_UNDEFINED',
  ENTITY_INCONSISTENT: 'ENTITY_INCONSISTENT',
  ENTITY_RELATIONSHIP_MISSING: 'ENTITY_RELATIONSHIP_MISSING',
  AUTHOR_ATTRIBUTION_MISSING: 'AUTHOR_ATTRIBUTION_MISSING',

  // Answer / AI readability
  QUESTION_UNANSWERED: 'QUESTION_UNANSWERED',
  ANSWER_NOT_DIRECT: 'ANSWER_NOT_DIRECT',
  DEFINITION_MISSING: 'DEFINITION_MISSING',
  QUESTION_COVERAGE_GAP: 'QUESTION_COVERAGE_GAP',
  AMBIGUOUS_REFERENCE: 'AMBIGUOUS_REFERENCE',
  SEMANTIC_STRUCTURE_WEAK: 'SEMANTIC_STRUCTURE_WEAK',
  FACTS_UNSOURCED: 'FACTS_UNSOURCED',
  CONTENT_DATES_MISSING: 'CONTENT_DATES_MISSING',

  // Generative-search readiness
  TOPIC_INCOMPLETE: 'TOPIC_INCOMPLETE',
  EXPERTISE_SIGNALS_MISSING: 'EXPERTISE_SIGNALS_MISSING',
  ORIGINAL_INFORMATION_MISSING: 'ORIGINAL_INFORMATION_MISSING',
  COMPARISON_COVERAGE_GAP: 'COMPARISON_COVERAGE_GAP',
  BRAND_INCONSISTENT: 'BRAND_INCONSISTENT',

  // Performance and accessibility
  SLOW_RESPONSE: 'SLOW_RESPONSE',
  PAGE_WEIGHT: 'PAGE_WEIGHT',
  IMAGE_ALT_MISSING: 'IMAGE_ALT_MISSING',
  IMAGE_DIMENSIONS_MISSING: 'IMAGE_DIMENSIONS_MISSING',
  FORM_CONTROL_UNLABELED: 'FORM_CONTROL_UNLABELED',
} as const;

export type ProblemFamily = (typeof PROBLEM_FAMILIES)[keyof typeof PROBLEM_FAMILIES];

export interface SignalInit {
  engine: EngineId;
  family: ProblemFamily;
  /** What the problem applies to. Same family + same scope = same recommendation. */
  scope: string;
  rule: string;
  category: Category;
  title: string;
  detail: string;
  severity: Severity;
  confidence: number;
  affectedUrls: string[];
  evidence: Evidence[];
  currentState: string;
  recommendedState: string;
  validationRule: string;
  dependsOn?: { family: ProblemFamily; scope: string }[];
  fix?: FixSpec;
}

export function signal(init: SignalInit): Signal {
  return {
    engine: init.engine,
    problemKey: problemKey(init.family, init.scope),
    category: init.category,
    rule: init.rule,
    title: init.title,
    detail: init.detail,
    severity: init.severity,
    confidence: init.confidence,
    affectedUrls: [...new Set(init.affectedUrls)],
    evidence: init.evidence,
    currentState: init.currentState,
    recommendedState: init.recommendedState,
    validationRule: init.validationRule,
    dependsOn: init.dependsOn?.map((d) => problemKey(d.family, d.scope)),
    fix: init.fix,
  };
}

/** Recovers the family from a problem key, for grouping and display. */
export function familyOf(key: string): string {
  return key.split('::')[0] ?? key;
}
