import { observed, type Evidence, type PageProps, type QuestionProps } from '../core/model.js';
import type { NormalizedSite } from '../normalizer/normalize.js';
import type { ParsedPage } from '../parser/page.js';
import { byTag, textContent, type DomNode } from '../parser/dom.js';
import { normalizeType, propArray, propString } from '../parser/structured-data.js';
import {
  contentWords, fleschReadingEase, looksLikeQuestion, normalizeWhitespace, sentences, stem,
  termFrequency, truncate,
} from '../core/text.js';

/**
 * The content engine produces the content-level facts that AEO, AIO and GEO all need:
 * questions and their answers, definitions, comparisons, how-to structure, and page
 * composition. Extracting these once, here, is what keeps the three engines from
 * drifting into three different readings of the same page.
 */

export interface PageContentModel {
  url: string;
  questions: QuestionProps[];
  /** Term being defined, plus the sentence that defines it. */
  definitions: { term: string; definition: string; evidence: Evidence }[];
  /** Detected content shape. A page can be several at once. */
  formats: ContentFormat[];
  /** Step lists that read as procedures. */
  howToSteps: { heading: string; steps: string[]; evidence: Evidence }[];
  comparisons: { subjects: string[]; evidence: Evidence }[];
  /** Outbound links to sources outside the site, used as a citation signal. */
  externalReferences: { href: string; anchor: string; inMainContent: boolean }[];
  /** Blocks of content that directly answer a question in under 60 words. */
  answerBlocks: { question: string; answer: string; wordCount: number; evidence: Evidence }[];
  readability: number;
  wordCount: number;
  paragraphCount: number;
  avgSentenceWords: number;
  topTerms: string[];
  /** Dates the page states about itself, from schema or <time>. */
  publishedDate: string | null;
  modifiedDate: string | null;
  /** Author names the page states about itself. */
  authors: string[];
  /** First-person / original-research markers, reported as observations. */
  originalityMarkers: { marker: string; excerpt: string }[];
  hasTableOfContents: boolean;
  headingDepth: number;
}

export type ContentFormat =
  | 'faq' | 'how-to' | 'comparison' | 'definition' | 'listicle' | 'guide'
  | 'product' | 'article' | 'landing' | 'index';

export interface ContentModel {
  byUrl: Map<string, PageContentModel>;
  /** All questions found anywhere on the site, deduplicated by normalized text. */
  questionIndex: Map<string, { question: QuestionProps; urls: string[] }>;
  stats: {
    pagesWithQuestions: number;
    totalQuestions: number;
    answeredQuestions: number;
    pagesWithDefinitions: number;
    pagesWithExternalReferences: number;
    avgReadability: number;
  };
}

export function buildContentModel(site: NormalizedSite): ContentModel {
  const byUrl = new Map<string, PageContentModel>();
  for (const page of site.pages) {
    const parsed = site.parsedByUrl.get(page.url);
    if (!parsed) continue;
    byUrl.set(page.url, analyzePage(page, parsed));
  }

  const questionIndex = new Map<string, { question: QuestionProps; urls: string[] }>();
  for (const model of byUrl.values()) {
    for (const q of model.questions) {
      const existing = questionIndex.get(q.normalized);
      if (existing) {
        if (!existing.urls.includes(q.sourceUrl)) existing.urls.push(q.sourceUrl);
        // Keep the best-answered instance as the representative.
        if (q.hasDirectAnswer && !existing.question.hasDirectAnswer) existing.question = q;
      } else {
        questionIndex.set(q.normalized, { question: q, urls: [q.sourceUrl] });
      }
    }
  }

  const models = [...byUrl.values()];
  const allQuestions = models.flatMap((m) => m.questions);
  return {
    byUrl,
    questionIndex,
    stats: {
      pagesWithQuestions: models.filter((m) => m.questions.length > 0).length,
      totalQuestions: allQuestions.length,
      answeredQuestions: allQuestions.filter((q) => q.hasDirectAnswer).length,
      pagesWithDefinitions: models.filter((m) => m.definitions.length > 0).length,
      pagesWithExternalReferences: models.filter((m) => m.externalReferences.length > 0).length,
      avgReadability: models.length ? models.reduce((a, m) => a + m.readability, 0) / models.length : 0,
    },
  };
}

function analyzePage(page: PageProps, parsed: ParsedPage): PageContentModel {
  const main = parsed.main.node;
  const text = page.text;
  const paragraphs = byTag(main, 'p').map((p) => normalizeWhitespace(textContent(p))).filter((t) => t.length > 0);
  const sents = sentences(text);

  const questions = [...questionsFromSchema(page), ...questionsFromHeadings(page, parsed), ...questionsFromLists(page, main)];
  const deduped = dedupeQuestions(questions);

  const formats = detectFormats(page, parsed, deduped);
  const schemaDates = datesFromSchema(page);

  return {
    url: page.url,
    questions: deduped,
    definitions: extractDefinitions(page, main),
    formats,
    howToSteps: extractHowTo(page, parsed),
    comparisons: extractComparisons(page, parsed),
    externalReferences: page.links.filter((l) => !l.internal).map((l) => ({
      href: l.href, anchor: l.anchor, inMainContent: l.inMainContent,
    })),
    answerBlocks: deduped
      .filter((q) => q.hasDirectAnswer && q.answerText)
      .map((q) => ({
        question: q.text,
        answer: q.answerText!,
        wordCount: q.answerWordCount,
        evidence: observed('content-engine.answer', page.url, {
          excerpt: truncate(`${q.text} -> ${q.answerText}`, 240),
          note: `Question is followed by a ${q.answerWordCount}-word answer`,
        }),
      })),
    readability: Math.round(fleschReadingEase(text)),
    wordCount: page.wordCount,
    paragraphCount: paragraphs.length,
    avgSentenceWords: sents.length ? Math.round(page.wordCount / sents.length) : 0,
    topTerms: termFrequency(text, 12).map((t) => t.term),
    publishedDate: schemaDates.published,
    modifiedDate: schemaDates.modified,
    authors: authorsFromSchema(page),
    originalityMarkers: findOriginalityMarkers(page, text),
    hasTableOfContents: hasToc(main),
    headingDepth: page.headings.length ? Math.max(...page.headings.map((h) => h.level)) : 0,
  };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function questionsFromSchema(page: PageProps): QuestionProps[] {
  const out: QuestionProps[] = [];
  for (const block of page.schemas) {
    if (!block.raw || typeof block.raw !== 'object') continue;
    const obj = block.raw as Record<string, unknown>;
    const types = block.types.map(normalizeType);
    const isFaq = types.includes('FAQPage');
    const isQa = types.includes('QAPage');
    if (!isFaq && !isQa && !types.includes('Question')) continue;

    const items = types.includes('Question') ? [obj] : propArray(obj, 'mainEntity');
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const q = item as Record<string, unknown>;
      const qText = propString(q, 'name', 'text');
      if (!qText) continue;
      const accepted = propArray(q, 'acceptedAnswer', 'suggestedAnswer')[0];
      const answer = accepted && typeof accepted === 'object'
        ? propString(accepted as Record<string, unknown>, 'text', 'name')
        : typeof accepted === 'string' ? accepted : null;
      const answerText = answer ? normalizeWhitespace(stripTags(answer)) : null;
      out.push({
        text: normalizeWhitespace(qText),
        normalized: normalizeQuestion(qText),
        sourceUrl: page.url,
        origin: isQa ? 'qa-schema' : 'faq-schema',
        answerText,
        answerWordCount: answerText ? answerText.split(/\s+/).filter(Boolean).length : 0,
        answerProximity: 0,
        hasDirectAnswer: !!answerText && answerText.length > 20,
      });
    }
  }
  return out;
}

function questionsFromHeadings(page: PageProps, parsed: ParsedPage): QuestionProps[] {
  const out: QuestionProps[] = [];
  const headingEls = byTag(parsed.main.node, 'h2', 'h3', 'h4', 'h5', 'h6');

  for (const el of headingEls) {
    const text = normalizeWhitespace(textContent(el));
    if (!text || !looksLikeQuestion(text)) continue;
    const answer = textAfter(el);
    const words = answer ? answer.split(/\s+/).filter(Boolean).length : 0;
    out.push({
      text,
      normalized: normalizeQuestion(text),
      sourceUrl: page.url,
      origin: 'heading',
      answerText: answer ? truncate(answer, 600) : null,
      answerWordCount: words,
      answerProximity: answer ? 0 : null,
      // An answer that starts immediately after the question and says something
      // substantive is a direct answer; a heading followed by nothing is not.
      hasDirectAnswer: words >= 12,
    });
  }
  return out;
}

/** Text of the siblings following a heading, up to the next heading. */
function textAfter(heading: DomNode): string | null {
  const parent = heading.parent;
  if (!parent) return null;
  const idx = parent.children.indexOf(heading);
  const parts: string[] = [];
  for (let i = idx + 1; i < parent.children.length; i++) {
    const sib = parent.children[i];
    if (sib.type === 'element' && /^h[1-6]$/.test(sib.tag)) break;
    const t = normalizeWhitespace(textContent(sib));
    if (t) parts.push(t);
    if (parts.join(' ').length > 800) break;
  }
  const joined = normalizeWhitespace(parts.join(' '));
  return joined.length > 0 ? joined : null;
}

/** Definition-list and accordion markup often carries Q&A without schema. */
function questionsFromLists(page: PageProps, main: DomNode): QuestionProps[] {
  const out: QuestionProps[] = [];
  for (const dl of byTag(main, 'dl')) {
    const children = dl.children.filter((c) => c.type === 'element');
    for (let i = 0; i < children.length; i++) {
      if (children[i].tag !== 'dt') continue;
      const q = normalizeWhitespace(textContent(children[i]));
      if (!looksLikeQuestion(q)) continue;
      const dd = children[i + 1]?.tag === 'dd' ? children[i + 1] : null;
      const a = dd ? normalizeWhitespace(textContent(dd)) : null;
      out.push(makeQuestion(page.url, q, a, 'inline'));
    }
  }
  for (const details of byTag(main, 'details')) {
    const summary = byTag(details, 'summary')[0];
    if (!summary) continue;
    const q = normalizeWhitespace(textContent(summary));
    if (!looksLikeQuestion(q)) continue;
    const full = normalizeWhitespace(textContent(details));
    const a = full.startsWith(q) ? full.slice(q.length).trim() : full;
    out.push(makeQuestion(page.url, q, a || null, 'inline'));
  }
  return out;
}

function makeQuestion(url: string, q: string, a: string | null, origin: QuestionProps['origin']): QuestionProps {
  const words = a ? a.split(/\s+/).filter(Boolean).length : 0;
  return {
    text: q,
    normalized: normalizeQuestion(q),
    sourceUrl: url,
    origin,
    answerText: a ? truncate(a, 600) : null,
    answerWordCount: words,
    answerProximity: a ? 0 : null,
    hasDirectAnswer: words >= 12,
  };
}

export function normalizeQuestion(q: string): string {
  return contentWords(q).map(stem).sort().join(' ');
}

function dedupeQuestions(qs: QuestionProps[]): QuestionProps[] {
  const byKey = new Map<string, QuestionProps>();
  for (const q of qs) {
    const prev = byKey.get(q.normalized);
    if (!prev) {
      byKey.set(q.normalized, q);
      continue;
    }
    // Schema-backed answers win; otherwise the longer answer wins.
    const prefer =
      (q.origin.endsWith('schema') && !prev.origin.endsWith('schema')) ||
      q.answerWordCount > prev.answerWordCount;
    if (prefer) byKey.set(q.normalized, q);
  }
  return [...byKey.values()];
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

// ---------------------------------------------------------------------------
// Definitions, how-to, comparisons
// ---------------------------------------------------------------------------

const DEFINITION_RE =
  /\b([A-Z][\w-]*(?:\s+[\w-]+){0,4})\s+(?:is|are|refers to|means|is defined as|describes)\s+(?:a|an|the|any|two|when)?\s*([^.!?]{20,240}[.!?])/g;

function extractDefinitions(page: PageProps, main: DomNode): PageContentModel['definitions'] {
  const out: PageContentModel['definitions'] = [];
  const seen = new Set<string>();
  const text = normalizeWhitespace(textContent(main));

  for (const m of text.matchAll(DEFINITION_RE)) {
    const term = normalizeWhitespace(m[1]);
    if (term.length < 3 || term.split(/\s+/).length > 5) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      term,
      definition: normalizeWhitespace(m[0]),
      evidence: observed('content-engine.definition', page.url, {
        excerpt: truncate(m[0], 220),
        note: `Page states a definition of "${term}"`,
      }),
    });
    if (out.length >= 25) break;
  }
  return out;
}

function extractHowTo(page: PageProps, parsed: ParsedPage): PageContentModel['howToSteps'] {
  const out: PageContentModel['howToSteps'] = [];

  for (const block of page.schemas) {
    if (!block.types.map(normalizeType).includes('HowTo')) continue;
    const obj = block.raw as Record<string, unknown>;
    const steps = propArray(obj, 'step')
      .map((s) => (typeof s === 'string' ? s : propString(s as Record<string, unknown>, 'name', 'text')))
      .filter((s): s is string => !!s);
    if (steps.length) {
      out.push({
        heading: propString(obj, 'name') ?? page.title ?? page.url,
        steps,
        evidence: observed('schema.howto', page.url, {
          note: `HowTo structured data declares ${steps.length} steps`,
          excerpt: truncate(JSON.stringify(obj), 220),
        }),
      });
    }
  }

  for (const ol of byTag(parsed.main.node, 'ol')) {
    const items = byTag(ol, 'li').map((li) => normalizeWhitespace(textContent(li))).filter(Boolean);
    if (items.length < 3) continue;
    const proceduralItems = items.filter((t) => /^(?:step\s*\d|\d+[.)]\s)|^[A-Z][a-z]+\s+(?:the|your|a|an)\b/.test(t));
    if (proceduralItems.length < Math.ceil(items.length / 2)) continue;
    const heading = nearestHeading(ol) ?? page.title ?? page.url;
    if (out.some((h) => h.heading === heading)) continue;
    out.push({
      heading,
      steps: items.slice(0, 30),
      evidence: observed('content-engine.howto', page.url, {
        note: `Ordered list of ${items.length} items reads as a procedure`,
        excerpt: truncate(items.slice(0, 3).join(' | '), 220),
      }),
    });
  }
  return out;
}

function nearestHeading(n: DomNode): string | null {
  let cur: DomNode | null = n;
  while (cur) {
    const parent: DomNode | null = cur.parent;
    if (!parent) return null;
    const idx = parent.children.indexOf(cur);
    for (let i = idx - 1; i >= 0; i--) {
      const sib = parent.children[i];
      if (sib.type === 'element' && /^h[1-6]$/.test(sib.tag)) return normalizeWhitespace(textContent(sib));
    }
    cur = parent;
  }
  return null;
}

const COMPARISON_RE = /\b(.{2,40}?)\s+(?:vs\.?|versus|compared to|or)\s+(.{2,40}?)\b/i;

function extractComparisons(page: PageProps, parsed: ParsedPage): PageContentModel['comparisons'] {
  const out: PageContentModel['comparisons'] = [];
  const headings = [page.title ?? '', ...page.headings.map((h) => h.text)];
  for (const h of headings) {
    const m = COMPARISON_RE.exec(h);
    if (!m) continue;
    if (!/\bvs\.?\b|\bversus\b|\bcompared to\b/i.test(h)) continue;
    out.push({
      subjects: [normalizeWhitespace(m[1]), normalizeWhitespace(m[2])],
      evidence: observed('content-engine.comparison', page.url, {
        excerpt: truncate(h, 160),
        note: 'Heading frames a comparison between two subjects',
      }),
    });
  }
  // A comparison table is the other common shape.
  const tables = byTag(parsed.main.node, 'table');
  for (const t of tables) {
    const headers = byTag(t, 'th').map((th) => normalizeWhitespace(textContent(th))).filter(Boolean);
    if (headers.length >= 3 && byTag(t, 'tr').length >= 3) {
      out.push({
        subjects: headers.slice(1, 5),
        evidence: observed('content-engine.comparison', page.url, {
          excerpt: truncate(headers.join(' | '), 200),
          note: `Table compares ${headers.length - 1} subjects across ${byTag(t, 'tr').length - 1} rows`,
        }),
      });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page composition
// ---------------------------------------------------------------------------

function detectFormats(page: PageProps, parsed: ParsedPage, questions: QuestionProps[]): ContentFormat[] {
  const formats: ContentFormat[] = [];
  const schemaTypes = page.schemas.flatMap((s) => s.types.map(normalizeType));

  if (schemaTypes.includes('FAQPage') || questions.length >= 3) formats.push('faq');
  if (schemaTypes.includes('HowTo') || /^how to\b/i.test(page.title ?? '')) formats.push('how-to');
  if (/\bvs\.?\b|\bversus\b|\bcomparison\b/i.test(page.title ?? '')) formats.push('comparison');
  if (schemaTypes.some((t) => ['Product', 'Offer', 'SoftwareApplication'].includes(t))) formats.push('product');
  if (schemaTypes.some((t) => ['Article', 'BlogPosting', 'NewsArticle'].includes(t))) formats.push('article');
  if (/^\d+\s+(?:best|top|ways|tips|reasons|examples)/i.test(page.title ?? '')) formats.push('listicle');
  if (/\b(guide|handbook|tutorial|walkthrough)\b/i.test(page.title ?? '') || page.wordCount > 1800) {
    formats.push('guide');
  }
  if (/\b(is|are|means|definition)\b/i.test(page.title ?? '') && /^what (is|are)\b/i.test(page.title ?? '')) {
    formats.push('definition');
  }
  const linkDensity = page.wordCount > 0 ? page.links.length / page.wordCount : 1;
  if (page.wordCount < 200 && page.links.filter((l) => l.internal && l.inMainContent).length >= 8) {
    formats.push('index');
  } else if (page.wordCount < 400 && linkDensity > 0.05 && parsed.main.method !== 'body') {
    formats.push('landing');
  }
  return formats.length ? [...new Set(formats)] : ['article'];
}

function datesFromSchema(page: PageProps): { published: string | null; modified: string | null } {
  for (const block of page.schemas) {
    if (!block.raw || typeof block.raw !== 'object') continue;
    const obj = block.raw as Record<string, unknown>;
    const published = propString(obj, 'datePublished', 'dateCreated');
    const modified = propString(obj, 'dateModified');
    if (published || modified) return { published, modified };
  }
  const ogTime = page.openGraph['article:published_time'] ?? null;
  const ogMod = page.openGraph['article:modified_time'] ?? null;
  return { published: ogTime, modified: ogMod };
}

function authorsFromSchema(page: PageProps): string[] {
  const names: string[] = [];
  for (const block of page.schemas) {
    if (!block.raw || typeof block.raw !== 'object') continue;
    const obj = block.raw as Record<string, unknown>;
    for (const a of propArray(obj, 'author')) {
      const n = typeof a === 'string' ? a : propString(a as Record<string, unknown>, 'name');
      if (n) names.push(normalizeWhitespace(n));
    }
  }
  return [...new Set(names)];
}

const ORIGINALITY_PATTERNS: { marker: string; re: RegExp }[] = [
  { marker: 'first-person research', re: /\b(?:we (?:tested|measured|surveyed|analyzed|interviewed|benchmarked)|our (?:research|study|survey|analysis|testing|data|benchmark))\b/i },
  { marker: 'sample size stated', re: /\b(?:n\s*=\s*\d+|\d[\d,]{1,}\s+(?:respondents|participants|customers|users|samples|sites)\s+(?:were|we))\b/i },
  { marker: 'methodology described', re: /\b(?:methodology|how we (?:tested|ranked|scored|collected)|our method)\b/i },
  { marker: 'dated observation', re: /\b(?:as of|last updated|updated on)\s+(?:[A-Z][a-z]+\s+\d{1,2},?\s+)?\d{4}\b/i },
  { marker: 'named case study', re: /\bcase study\b/i },
];

function findOriginalityMarkers(page: PageProps, text: string): { marker: string; excerpt: string }[] {
  const out: { marker: string; excerpt: string }[] = [];
  for (const { marker, re } of ORIGINALITY_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 60);
    out.push({ marker, excerpt: truncate(text.slice(start, m.index + m[0].length + 80), 200) });
  }
  return out;
}

function hasToc(main: DomNode): boolean {
  for (const nav of byTag(main, 'nav', 'ul', 'ol')) {
    const anchors = byTag(nav, 'a').filter((a) => (a.attrs['href'] ?? '').startsWith('#'));
    if (anchors.length >= 3) return true;
  }
  return false;
}
