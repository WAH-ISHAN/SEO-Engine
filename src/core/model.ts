/**
 * Central normalized data model.
 *
 * Every engine (SEO / AEO / AIO / GEO / schema / links) reads from this model and
 * nothing else. No engine is allowed to keep its own private copy of website data;
 * that rule is what makes this one platform instead of four tools sharing a repo.
 */

// ---------------------------------------------------------------------------
// Node + relationship vocabulary
// ---------------------------------------------------------------------------

export const NODE_TYPES = [
  'Website', 'Domain', 'URL', 'Page', 'Section', 'Topic', 'Keyword', 'Question',
  'Entity', 'Person', 'Organization', 'Product', 'Service', 'Location', 'Article',
  'Author', 'Image', 'Video', 'Schema', 'Link', 'Redirect', 'Issue',
  'Recommendation', 'Change', 'ValidationResult',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  'contains', 'belongs_to', 'links_to', 'mentions', 'describes', 'answers',
  'supports', 'related_to', 'authored_by', 'published_by', 'offers',
  'located_in', 'references', 'canonical_of', 'redirects_to',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Inverse pairs, used to answer "what points at me" without a second index. */
export const EDGE_INVERSE: Partial<Record<EdgeType, EdgeType>> = {
  contains: 'belongs_to',
  belongs_to: 'contains',
};

export interface GraphNode<P = Record<string, unknown>> {
  id: string;
  type: NodeType;
  /** Human label for dashboards. Never used for identity. */
  label: string;
  props: P;
  /** ms epoch of first and last observation. */
  firstSeen: number;
  lastSeen: number;
}

export interface GraphEdge<P = Record<string, unknown>> {
  id: string;
  type: EdgeType;
  from: string;
  to: string;
  props: P;
  /** Where this relationship was observed. Edges without evidence are not stored. */
  evidence: Evidence[];
}

// ---------------------------------------------------------------------------
// Evidence: the hard separation between observation and inference
// ---------------------------------------------------------------------------

/**
 * `observed`  - read directly out of the crawled bytes. Reproducible.
 * `derived`   - computed deterministically from observations (counts, graph metrics).
 * `inferred`  - a heuristic judgement by this platform. Never presented as fact.
 */
export type EvidenceKind = 'observed' | 'derived' | 'inferred';

export interface Evidence {
  kind: EvidenceKind;
  /** Which subsystem produced it, e.g. 'parser.head', 'site-graph.pagerank'. */
  source: string;
  /** The URL / file / selector the evidence lives at. */
  locator: string;
  /** Verbatim excerpt from the source, truncated. Only for `observed`. */
  excerpt?: string;
  /** Machine-readable value backing the claim. */
  value?: unknown;
  /** Human sentence describing what was seen. */
  note?: string;
}

export function observed(source: string, locator: string, opts: Partial<Evidence> = {}): Evidence {
  return { kind: 'observed', source, locator, ...opts };
}
export function derived(source: string, locator: string, opts: Partial<Evidence> = {}): Evidence {
  return { kind: 'derived', source, locator, ...opts };
}
export function inferred(source: string, locator: string, opts: Partial<Evidence> = {}): Evidence {
  return { kind: 'inferred', source, locator, ...opts };
}

// ---------------------------------------------------------------------------
// Website / page shapes
// ---------------------------------------------------------------------------

export interface WebsiteProps {
  origin: string;
  domain: string;
  crawledAt: number;
  pageCount: number;
}

export type IndexabilityReason =
  | 'ok'
  | 'robots-meta-noindex'
  | 'x-robots-noindex'
  | 'robots-txt-disallow'
  | 'non-canonical'
  | 'http-error'
  | 'redirect'
  | 'non-html';

export interface HeadingNode {
  level: number;   // 1..6
  text: string;
  /** Index into the page's flat heading list of the nearest enclosing heading. */
  parent: number | null;
}

export interface ImageRef {
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  loading: string | null;
  inMainContent: boolean;
}

export interface VideoRef {
  src: string;
  kind: 'video' | 'iframe';
  title: string | null;
}

export interface LinkRef {
  /** Absolute, normalized. */
  href: string;
  rawHref: string;
  anchor: string;
  rel: string[];
  internal: boolean;
  /** true when the anchor sits inside the detected main content region. */
  inMainContent: boolean;
  nofollow: boolean;
}

export interface SchemaBlock {
  /** 'json-ld' | 'microdata' | 'rdfa' */
  syntax: 'json-ld' | 'microdata' | 'rdfa';
  types: string[];
  raw: unknown;
  /** Byte offset in the source document, for evidence locators. */
  offset: number;
  parseError?: string;
}

export interface PageProps {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** Full redirect chain that led here, first hop first. */
  redirectChain: string[];
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string[];
  xRobotsTag: string[];
  lang: string | null;
  headings: HeadingNode[];
  h1s: string[];
  /** Main-content text, whitespace-normalized. */
  text: string;
  wordCount: number;
  /** Whole-document text including nav/footer, used for duplicate detection. */
  fullTextHash: string;
  contentHash: string;
  /** Shingle fingerprint for near-duplicate detection. */
  simhash: string;
  links: LinkRef[];
  images: ImageRef[];
  videos: VideoRef[];
  schemas: SchemaBlock[];
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  hreflang: { lang: string; href: string }[];
  /** Semantic landmark elements present. */
  landmarks: string[];
  /** Depth from the homepage over internal links. Infinity when unreachable. */
  depth: number;
  indexable: boolean;
  indexabilityReasons: IndexabilityReason[];
  bytes: number;
  fetchedAt: number;
  responseTimeMs: number;
  /** Detected page template/section, e.g. '/blog/*'. */
  sectionPath: string;
  /** Detected CMS / framework / SEO plugin fingerprints. */
  fingerprints: string[];
  mobileViewport: string | null;
  /** True when the served HTML contains the main content (not JS-only). */
  contentInInitialHtml: boolean;
}

export interface EntityProps {
  name: string;
  entityType: string;      // Organization | Person | Product | Service | Location | ...
  description: string | null;
  urls: string[];
  aliases: string[];
  sameAs: string[];
  /** Where each fact came from. Facts without evidence are not recorded. */
  evidence: Evidence[];
  /** Source syntax that produced the entity. */
  origin: 'schema' | 'content' | 'metadata';
  confidence: number;
}

export interface QuestionProps {
  text: string;
  normalized: string;
  /** Page URL where the question is posed. */
  sourceUrl: string;
  /** Where it was found: heading, FAQ schema, list, inline. */
  origin: 'heading' | 'faq-schema' | 'qa-schema' | 'inline';
  answerText: string | null;
  answerWordCount: number;
  /** Distance in characters between the question and its answer start. */
  answerProximity: number | null;
  hasDirectAnswer: boolean;
}

export interface TopicProps {
  label: string;
  /** Stemmed term set that defines the topic cluster. */
  terms: string[];
  urls: string[];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'TECHNICAL_SEO', 'ON_PAGE_SEO', 'CONTENT', 'INFORMATION_ARCHITECTURE',
  'INTERNAL_LINKING', 'ENTITY', 'STRUCTURED_DATA', 'AEO', 'AIO', 'GEO',
  'PERFORMANCE', 'ACCESSIBILITY',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type EngineId =
  | 'seo' | 'aeo' | 'aio' | 'geo' | 'schema' | 'internal-link'
  | 'site-graph' | 'entity' | 'content';

/**
 * A Signal is what an engine emits. Several engines may emit signals for the same
 * underlying defect; the recommendation engine folds them into one recommendation
 * keyed by `problemKey`.
 */
export interface Signal {
  engine: EngineId;
  /** Canonical fingerprint of the underlying problem. Identical keys merge. */
  problemKey: string;
  category: Category;
  /** Short stable rule id, e.g. 'SEO.TITLE_MISSING'. */
  rule: string;
  title: string;
  detail: string;
  severity: Severity;
  /** 0..1 - how sure the platform is that this is really a problem. */
  confidence: number;
  affectedUrls: string[];
  evidence: Evidence[];
  /** Observed present state, in the engine's own words. */
  currentState: string;
  /** What the engine believes correct looks like. */
  recommendedState: string;
  /** problemKeys that must be resolved before this one can be. */
  dependsOn?: string[];
  /** Machine payload used by the implementation engine. */
  fix?: FixSpec;
  /** Rule id of the validator that proves the fix landed. */
  validationRule: string;
}

export interface Issue {
  id: string;
  rule: string;
  category: Category;
  severity: Severity;
  title: string;
  detail: string;
  affectedUrls: string[];
  evidence: Evidence[];
  engines: EngineId[];
  firstSeen: number;
  lastSeen: number;
}

export interface Recommendation {
  id: string;
  problemKey: string;
  category: Category;
  /** Every engine that independently detected this problem. */
  contributingSignals: { engine: EngineId; rule: string; severity: Severity; confidence: number }[];
  issue: string;
  detail: string;
  evidence: Evidence[];
  affectedUrls: string[];
  severity: Severity;
  confidence: number;
  /** Priority score, 0..100. Ordering only - not a ranking prediction. */
  priority: number;
  dependencies: string[];
  currentState: string;
  recommendedState: string;
  implementationMethod: string;
  validationMethod: string;
  validationRule: string;
  rollbackMethod: string;
  fix?: FixSpec;
  /** Capabilities already present that this recommendation must not clobber. */
  respectsExisting: string[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export type FixKind =
  | 'meta.title' | 'meta.description' | 'meta.canonical' | 'meta.robots'
  | 'meta.viewport' | 'meta.lang' | 'meta.og'
  | 'heading.h1'
  | 'image.alt'
  | 'schema.add' | 'schema.fix' | 'schema.remove'
  | 'link.add-internal' | 'link.fix-broken' | 'link.anchor'
  | 'robots.txt' | 'sitemap.xml'
  | 'redirect.add'
  | 'url.change'
  | 'content.manual';

export interface FixSpec {
  kind: FixKind;
  /** The URL whose output must change. */
  url: string;
  /** Present value, for pre-flight verification before writing. */
  before: unknown;
  /** Proposed value. Generated only from observed page facts. */
  after: unknown;
  /** Human rationale tied to evidence. */
  rationale: string;
  /** When true the engine will never auto-apply, only propose. */
  requiresHuman: boolean;
}

export type ChangeStatus =
  | 'proposed' | 'previewed' | 'approved' | 'rejected'
  | 'applied' | 'validated' | 'failed' | 'rolled-back';

export interface Change {
  id: string;
  recommendationId: string;
  status: ChangeStatus;
  fix: FixSpec;
  /** Unified diff, when the change maps to repository files. */
  patch: string | null;
  targetFiles: string[];
  /** Everything needed to put the site back exactly as it was. */
  rollback: RollbackPlan;
  createdAt: number;
  appliedAt: number | null;
  approvedBy: string | null;
  notes: string[];
}

export interface RollbackPlan {
  method: 'file-restore' | 'reverse-patch' | 'manual';
  /** path -> original bytes (utf8). Captured before any write. */
  files: Record<string, string | null>;
  instructions: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationStatus = 'PASS' | 'WARNING' | 'FAIL';

export interface ValidationCheck {
  rule: string;
  status: ValidationStatus;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ValidationResult {
  id: string;
  changeId: string | null;
  recommendationId: string | null;
  url: string;
  status: ValidationStatus;
  checks: ValidationCheck[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ranAt: number;
}

// ---------------------------------------------------------------------------
// Inventory - what the site already does. Detection precedes recommendation.
// ---------------------------------------------------------------------------

export interface CapabilityInventory {
  /** e.g. 'sitemap.xml', 'canonical-tags', 'json-ld:Organization', 'next.js-metadata' */
  present: Record<string, InventoryFact>;
  absent: string[];
  conflicts: InventoryConflict[];
}

export interface InventoryFact {
  capability: string;
  /** How widely it is deployed, 0..1 of eligible pages. */
  coverage: number;
  detail: string;
  evidence: Evidence[];
}

export interface InventoryConflict {
  capability: string;
  detail: string;
  urls: string[];
  evidence: Evidence[];
}
