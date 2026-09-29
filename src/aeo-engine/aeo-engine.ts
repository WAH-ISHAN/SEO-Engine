import { indexablePages, type AnalysisContext, type AnalysisEngine } from '../core/context.js';
import { derived, observed, type Signal } from '../core/model.js';
import { PROBLEM_FAMILIES as P, signal } from '../core/problems.js';
import { normalizeQuestion } from '../content-engine/content-engine.js';
import { similarity, truncate } from '../core/text.js';
import { normalizeType } from '../parser/structured-data.js';

/**
 * Answer Engine Optimization.
 *
 * The question this engine asks is narrow and checkable: when the site poses a
 * question, does it answer it, is the answer near the question, and is the answer
 * legible as an answer?
 *
 * What it will not do is manufacture questions the site does not ask or FAQ markup for
 * content that is not really a FAQ. Structured data is only ever proposed for question
 * and answer text that already exists in the page's visible content, because markup
 * that does not match what a reader sees is misleading regardless of what it achieves.
 */
export const aeoEngine: AnalysisEngine = {
  id: 'aeo',
  name: 'Answer Engine Optimization',
  analyze(ctx: AnalysisContext): Signal[] {
    return [
      ...unansweredQuestions(ctx),
      ...indirectAnswers(ctx),
      ...answerableContentWithoutMarkup(ctx),
      ...questionCoverage(ctx),
      ...definitionCoverage(ctx),
      ...answerStructure(ctx),
    ];
  },
};

function unansweredQuestions(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const offenders: { url: string; questions: string[] }[] = [];

  for (const page of indexablePages(ctx)) {
    const model = ctx.content.byUrl.get(page.url);
    if (!model || model.questions.length === 0) continue;
    const unanswered = model.questions.filter((q) => !q.hasDirectAnswer);
    if (unanswered.length === 0) continue;
    offenders.push({ url: page.url, questions: unanswered.map((q) => q.text) });
  }

  if (offenders.length === 0) return out;
  const total = offenders.reduce((a, o) => a + o.questions.length, 0);

  out.push(signal({
    engine: 'aeo', family: P.QUESTION_UNANSWERED, scope: 'site',
    rule: 'AEO.QUESTION_WITHOUT_ANSWER', category: 'AEO',
    title: `${total} question(s) are posed but not answered in place`,
    detail:
      'These headings or FAQ entries ask a question, but the text immediately following them is ' +
      'shorter than a usable answer. A reader who arrives at that heading does not get a response.',
    severity: 'medium', confidence: 0.75,
    affectedUrls: offenders.map((o) => o.url),
    evidence: offenders.slice(0, 8).map((o) => observed('content-engine.question', o.url, {
      excerpt: truncate(o.questions.join(' | '), 220),
      note: `${o.questions.length} question(s) with fewer than 12 words of following content`,
    })),
    currentState: `${total} questions across ${offenders.length} pages have no substantive answer beneath them.`,
    recommendedState: 'Every question the site asks is answered directly beneath it.',
    validationRule: 'VALIDATE.QUESTIONS_ANSWERED',
    fix: {
      kind: 'content.manual', url: offenders[0].url,
      before: offenders[0].questions, after: null,
      rationale:
        'Answering requires knowledge this platform does not have. It reports which questions lack ' +
        'answers; the answer text must come from someone who knows the subject.',
      requiresHuman: true,
    },
  }));
  return out;
}

function indirectAnswers(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const offenders: { url: string; question: string; words: number }[] = [];

  for (const page of indexablePages(ctx)) {
    const model = ctx.content.byUrl.get(page.url);
    if (!model) continue;
    for (const q of model.questions) {
      if (!q.hasDirectAnswer || !q.answerText) continue;
      // An answer that takes 120+ words to begin is a discussion, not an answer.
      if (q.answerWordCount > 120) {
        offenders.push({ url: page.url, question: q.text, words: q.answerWordCount });
      }
    }
  }
  if (offenders.length === 0) return out;

  out.push(signal({
    engine: 'aeo', family: P.ANSWER_NOT_DIRECT, scope: 'site',
    rule: 'AEO.ANSWER_NOT_CONCISE', category: 'AEO',
    title: `${offenders.length} answer(s) do not lead with a direct response`,
    detail:
      'The content following these questions runs long before it resolves them. Leading with a ' +
      'one- or two-sentence answer and then expanding serves both readers and extraction.',
    severity: 'low', confidence: 0.55,
    affectedUrls: [...new Set(offenders.map((o) => o.url))],
    evidence: offenders.slice(0, 8).map((o) => derived('content-engine.answer', o.url, {
      excerpt: truncate(o.question, 120),
      note: `${o.words} words follow before the next heading`,
      value: o.words,
    })),
    currentState: `${offenders.length} questions are followed by long passages rather than a direct answer.`,
    recommendedState: 'Each question is followed immediately by a concise answer, then supporting detail.',
    validationRule: 'VALIDATE.ANSWER_LEADS',
  }));
  return out;
}

/**
 * Pages that already contain genuine question-and-answer pairs in their visible
 * content, but do not expose them as structured data. This is the only circumstance in
 * which FAQ markup is proposed.
 */
function answerableContentWithoutMarkup(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const candidates: { url: string; pairs: { q: string; a: string }[] }[] = [];

  for (const page of indexablePages(ctx)) {
    const model = ctx.content.byUrl.get(page.url);
    if (!model) continue;
    const hasFaqSchema = page.schemas.some((s) =>
      s.types.map(normalizeType).some((t) => t === 'FAQPage' || t === 'QAPage'));
    if (hasFaqSchema) continue;

    const answered = model.questions.filter((q) => q.hasDirectAnswer && q.answerText && q.origin !== 'faq-schema');
    if (answered.length < 3) continue;
    candidates.push({
      url: page.url,
      pairs: answered.map((q) => ({ q: q.text, a: q.answerText! })),
    });
  }
  if (candidates.length === 0) return out;

  for (const c of candidates.slice(0, 25)) {
    out.push(signal({
      engine: 'aeo', family: P.STRUCTURED_DATA_ABSENT, scope: c.url,
      rule: 'AEO.FAQ_CONTENT_NOT_MARKED_UP', category: 'AEO',
      title: `Visible Q&A content on ${truncate(c.url, 60)} is not exposed as structured data`,
      detail:
        `This page already presents ${c.pairs.length} questions with answers in its visible content. ` +
        'Marking them up describes what is already there; the markup would contain the page\'s own ' +
        'question and answer text verbatim, with nothing added.',
      severity: 'low', confidence: 0.7,
      affectedUrls: [c.url],
      evidence: c.pairs.slice(0, 4).map((p) => observed('content-engine.answer', c.url, {
        excerpt: truncate(`${p.q} -> ${p.a}`, 200),
        note: 'Question and answer both present in the rendered page text',
      })),
      currentState: `${c.pairs.length} visible Q&A pairs, no FAQPage structured data.`,
      recommendedState: 'Existing visible Q&A content is described by matching FAQPage structured data.',
      validationRule: 'VALIDATE.SCHEMA_MATCHES_CONTENT',
      fix: {
        kind: 'schema.add', url: c.url,
        before: null,
        after: {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: c.pairs.map((p) => ({
            '@type': 'Question',
            name: p.q,
            acceptedAnswer: { '@type': 'Answer', text: p.a },
          })),
        },
        rationale:
          'Every question and answer string is copied from this page\'s own visible text. No content ' +
          'is generated, and the markup is only valid while the visible content still matches.',
        requiresHuman: true,
      },
    }));
  }
  return out;
}

/**
 * Questions the site answers on one page but never links to from the pages that raise
 * the same subject. This maps Question -> Answer -> Supporting Page.
 */
function questionCoverage(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const gaps: { question: string; answeredOn: string; shouldLinkFrom: string[] }[] = [];

  for (const [normalized, entry] of ctx.content.questionIndex) {
    if (!entry.question.hasDirectAnswer) continue;
    const answerUrl = entry.question.sourceUrl;

    // Pages about the same topic that neither answer nor link to the answer.
    const related: string[] = [];
    for (const page of indexablePages(ctx)) {
      if (page.url === answerUrl) continue;
      const model = ctx.content.byUrl.get(page.url);
      if (!model) continue;
      if (model.questions.some((q) => q.normalized === normalized)) continue;
      const overlap = similarity(model.topTerms, normalized.split(' '));
      if (overlap < 0.25) continue;
      const linksToAnswer = page.links.some((l) => l.href === answerUrl);
      if (!linksToAnswer) related.push(page.url);
    }
    if (related.length >= 2) {
      gaps.push({ question: entry.question.text, answeredOn: answerUrl, shouldLinkFrom: related.slice(0, 10) });
    }
  }
  if (gaps.length === 0) return out;

  for (const gap of gaps.slice(0, 20)) {
    out.push(signal({
      engine: 'aeo', family: P.MISSING_TOPIC_LINK, scope: `${gap.answeredOn}|answer-support`,
      rule: 'AEO.ANSWER_NOT_SUPPORTED_BY_RELATED_PAGES', category: 'AEO',
      title: `The answer to "${truncate(gap.question, 50)}" is not linked from related pages`,
      detail:
        `${gap.answeredOn} answers this question, but ${gap.shouldLinkFrom.length} pages covering the ` +
        'same subject do not link to it. The answer is isolated from the context that would lead to it.',
      severity: 'low', confidence: 0.55,
      affectedUrls: [gap.answeredOn, ...gap.shouldLinkFrom],
      evidence: [
        observed('content-engine.question', gap.answeredOn, {
          excerpt: truncate(gap.question, 160), note: 'Question is answered on this page',
        }),
        ...gap.shouldLinkFrom.slice(0, 4).map((u) => derived('aeo.coverage', u, {
          note: 'Covers a closely related term set but does not link to the answering page',
        })),
      ],
      currentState: `${gap.shouldLinkFrom.length} topically related pages do not link to the answer.`,
      recommendedState: 'Pages that raise a subject link to the page that answers it.',
      validationRule: 'VALIDATE.INTERNAL_LINK_EXISTS',
      fix: {
        kind: 'link.add-internal', url: gap.shouldLinkFrom[0],
        before: null,
        after: { href: gap.answeredOn, suggestedAnchor: truncate(gap.question, 60) },
        rationale:
          'Both pages already exist and cover overlapping terms. The anchor text is the question as ' +
          'the answering page itself states it. Placement needs an editor: the link should sit where ' +
          'the question naturally arises in the prose.',
        requiresHuman: true,
      },
    }));
  }
  return out;
}

function definitionCoverage(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx);

  // Pages whose title asks "what is X" but whose content never defines X.
  const offenders: { url: string; term: string }[] = [];
  for (const page of pages) {
    const title = page.title ?? '';
    const m = /^what\s+(?:is|are)\s+(?:an?\s+|the\s+)?(.+?)[\?\|\-]?$/i.exec(title.trim());
    if (!m) continue;
    const term = m[1].trim();
    if (!term || term.length < 3) continue;
    const model = ctx.content.byUrl.get(page.url);
    if (!model) continue;
    const defines = model.definitions.some((d) =>
      d.term.toLowerCase().includes(term.toLowerCase().split(/\s+/)[0]));
    if (!defines) offenders.push({ url: page.url, term });
  }
  if (offenders.length === 0) return out;

  out.push(signal({
    engine: 'aeo', family: P.DEFINITION_MISSING, scope: 'site',
    rule: 'AEO.DEFINITION_PAGE_WITHOUT_DEFINITION', category: 'AEO',
    title: `${offenders.length} page(s) promise a definition their content does not state`,
    detail:
      'The title asks "what is X" but no sentence in the main content plainly defines X. ' +
      'A definitional page should state the definition in one sentence before elaborating.',
    severity: 'medium', confidence: 0.6,
    affectedUrls: offenders.map((o) => o.url),
    evidence: offenders.slice(0, 8).map((o) => derived('content-engine.definition', o.url, {
      note: `Title asks about "${o.term}"; no definitional sentence was found in the main content`,
      value: o.term,
    })),
    currentState: `${offenders.length} definitional pages never state the definition directly.`,
    recommendedState: 'Definitional pages open with a plain one-sentence definition of the term.',
    validationRule: 'VALIDATE.DEFINITION_PRESENT',
    fix: {
      kind: 'content.manual', url: offenders[0].url, before: null, after: null,
      rationale:
        'The definition must be written by someone who knows the subject. This platform identifies ' +
        'the gap and will not author a definition of its own.',
      requiresHuman: true,
    },
  }));
  return out;
}

function answerStructure(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx).filter((p) => p.wordCount >= 600);

  const unstructured = pages.filter((p) => {
    const model = ctx.content.byUrl.get(p.url);
    if (!model) return false;
    const subheadings = p.headings.filter((h) => h.level >= 2).length;
    // Long content with almost no subheadings and no lists is a wall of text: hard to
    // navigate for a reader and hard to segment for anything else.
    return subheadings <= 1 && model.paragraphCount > 6;
  });
  if (unstructured.length === 0) return out;

  out.push(signal({
    engine: 'aeo', family: P.SEMANTIC_STRUCTURE_WEAK, scope: 'long-form-structure',
    rule: 'AEO.LONG_CONTENT_WITHOUT_STRUCTURE', category: 'AEO',
    title: `${unstructured.length} long page(s) have almost no subheadings`,
    detail:
      'Content over 600 words with one subheading or fewer offers no navigable structure. ' +
      'Subheadings let readers scan and let extractors identify which passage covers what.',
    severity: 'medium', confidence: 0.7,
    affectedUrls: unstructured.map((p) => p.url),
    evidence: unstructured.slice(0, 8).map((p) => derived('content-engine', p.url, {
      note: `${p.wordCount} words with ${p.headings.filter((h) => h.level >= 2).length} subheading(s)`,
      value: p.wordCount,
    })),
    currentState: `${unstructured.length} long pages present continuous text with no section headings.`,
    recommendedState: 'Long content is divided into titled sections that describe what each covers.',
    validationRule: 'VALIDATE.SUBHEADINGS_PRESENT',
  }));
  return out;
}
