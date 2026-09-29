/**
 * Unified-diff generation and the HTML edits the implementation engine performs.
 *
 * Every edit here is surgical: it locates the exact element to change and rewrites only
 * that element's serialization, leaving the rest of the document byte-identical. A
 * whole-document reserialization would silently reformat markup that nobody asked to
 * change, and would make diffs unreviewable.
 */

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Unified diff with three lines of context. */
export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const ops = diffLines(a, b);
  if (ops.every((o) => o.type === 'equal')) return '';

  const hunks: DiffHunk[] = [];
  let ai = 0;
  let bi = 0;
  let pending: DiffHunk | null = null;
  let trailingEqual = 0;

  for (const op of ops) {
    if (op.type === 'equal') {
      if (pending) {
        const take = Math.min(context, op.lines.length);
        for (let i = 0; i < take; i++) {
          pending.lines.push(` ${op.lines[i]}`);
          pending.oldLines++;
          pending.newLines++;
        }
        trailingEqual = op.lines.length - take;
        if (op.lines.length > context * 2) {
          hunks.push(pending);
          pending = null;
        }
      }
      ai += op.lines.length;
      bi += op.lines.length;
      if (!pending) trailingEqual = op.lines.length;
      continue;
    }

    if (!pending) {
      const lead = Math.min(context, trailingEqual);
      pending = {
        oldStart: ai - lead + 1,
        newStart: bi - lead + 1,
        oldLines: lead,
        newLines: lead,
        lines: [],
      };
      for (let i = lead; i > 0; i--) pending.lines.push(` ${a[ai - i]}`);
    }

    if (op.type === 'delete') {
      for (const l of op.lines) {
        pending.lines.push(`-${l}`);
        pending.oldLines++;
      }
      ai += op.lines.length;
    } else {
      for (const l of op.lines) {
        pending.lines.push(`+${l}`);
        pending.newLines++;
      }
      bi += op.lines.length;
    }
    trailingEqual = 0;
  }
  if (pending) hunks.push(pending);

  const header = `--- a/${path}\n+++ b/${path}\n`;
  return (
    header +
    hunks
      .map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`)
      .join('\n') +
    '\n'
  );
}

interface DiffOp {
  type: 'equal' | 'insert' | 'delete';
  lines: string[];
}

/** Myers-style LCS over lines, adequate for the document sizes involved here. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // Trim common prefix/suffix first so the LCS table stays small.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = [];
  if (start > 0) ops.push({ type: 'equal', lines: a.slice(0, start) });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length || midB.length) {
    const lcs = lcsTable(midA, midB);
    ops.push(...backtrack(midA, midB, lcs));
  }
  if (endA < n) ops.push({ type: 'equal', lines: a.slice(endA) });
  return coalesce(ops);
}

function lcsTable(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j] ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  return table;
}

function backtrack(a: string[], b: string[], table: Uint32Array): DiffOp[] {
  const w = b.length + 1;
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', lines: [a[i]] });
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      ops.push({ type: 'delete', lines: [a[i]] });
      i++;
    } else {
      ops.push({ type: 'insert', lines: [b[j]] });
      j++;
    }
  }
  while (i < a.length) ops.push({ type: 'delete', lines: [a[i++]] });
  while (j < b.length) ops.push({ type: 'insert', lines: [b[j++]] });
  return ops;
}

function coalesce(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.lines.push(...op.lines);
    else out.push({ type: op.type, lines: [...op.lines] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML edits
// ---------------------------------------------------------------------------

export interface HtmlEditResult {
  html: string;
  changed: boolean;
  /** Why the edit did not apply, when it did not. */
  reason?: string;
}

const HEAD_CLOSE = /<\/head\s*>/i;

/** Replaces the text of the first <title>, or inserts one into <head>. */
export function setTitle(html: string, value: string): HtmlEditResult {
  const re = /(<title\b[^>]*>)([\s\S]*?)(<\/title\s*>)/i;
  const m = re.exec(html);
  if (m) {
    if (m[2] === escapeHtmlText(value)) return { html, changed: false, reason: 'already the desired value' };
    return { html: html.replace(re, `$1${escapeHtmlText(value)}$3`), changed: true };
  }
  return insertIntoHead(html, `  <title>${escapeHtmlText(value)}</title>`);
}

/** Replaces a named meta tag's content, or inserts the tag. */
export function setMetaByName(html: string, name: string, content: string): HtmlEditResult {
  const existing = findMetaTag(html, 'name', name);
  if (existing) {
    const updated = setAttribute(existing.tag, 'content', content);
    if (updated === existing.tag) return { html, changed: false, reason: 'already the desired value' };
    return {
      html: html.slice(0, existing.start) + updated + html.slice(existing.end),
      changed: true,
    };
  }
  return insertIntoHead(html, `  <meta name="${escapeAttr(name)}" content="${escapeAttr(content)}">`);
}

export function setMetaByProperty(html: string, property: string, content: string): HtmlEditResult {
  const existing = findMetaTag(html, 'property', property);
  if (existing) {
    const updated = setAttribute(existing.tag, 'content', content);
    if (updated === existing.tag) return { html, changed: false, reason: 'already the desired value' };
    return { html: html.slice(0, existing.start) + updated + html.slice(existing.end), changed: true };
  }
  return insertIntoHead(html, `  <meta property="${escapeAttr(property)}" content="${escapeAttr(content)}">`);
}

/** Replaces the href of an existing rel=canonical, or inserts one. */
export function setCanonical(html: string, href: string): HtmlEditResult {
  const re = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i;
  const m = re.exec(html);
  if (m) {
    const updated = setAttribute(m[0], 'href', href);
    if (updated === m[0]) return { html, changed: false, reason: 'already the desired value' };
    return { html: html.slice(0, m.index) + updated + html.slice(m.index + m[0].length), changed: true };
  }
  return insertIntoHead(html, `  <link rel="canonical" href="${escapeAttr(href)}">`);
}

/** Sets lang on the <html> element. */
export function setHtmlLang(html: string, lang: string): HtmlEditResult {
  const re = /<html\b[^>]*>/i;
  const m = re.exec(html);
  if (!m) return { html, changed: false, reason: 'no <html> element found' };
  const updated = setAttribute(m[0], 'lang', lang);
  if (updated === m[0]) return { html, changed: false, reason: 'already the desired value' };
  return { html: html.slice(0, m.index) + updated + html.slice(m.index + m[0].length), changed: true };
}

/** Appends a JSON-LD block just before </head>. */
export function addJsonLd(html: string, data: unknown): HtmlEditResult {
  const json = JSON.stringify(data, null, 2)
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
  // A closing script tag inside the JSON would terminate the block early.
  if (/<\/script/i.test(json)) {
    return { html, changed: false, reason: 'refusing to inject JSON containing a closing script tag' };
  }
  return insertIntoHead(html, `  <script type="application/ld+json">\n${json}\n  </script>`);
}

/** Rewrites an anchor's href where it currently points at `from`. */
export function retargetLink(html: string, from: string, to: string): HtmlEditResult {
  const re = new RegExp(`(<a\\b[^>]*\\bhref\\s*=\\s*)(["'])${escapeRegex(from)}\\2`, 'i');
  const m = re.exec(html);
  if (!m) return { html, changed: false, reason: `no anchor with href="${from}" found in this file` };
  const replacement = `${m[1]}${m[2]}${escapeAttr(to)}${m[2]}`;
  return {
    html: html.slice(0, m.index) + replacement + html.slice(m.index + m[0].length),
    changed: true,
  };
}

function insertIntoHead(html: string, snippet: string): HtmlEditResult {
  const m = HEAD_CLOSE.exec(html);
  if (!m) return { html, changed: false, reason: 'no </head> in this document' };
  const indent = detectIndent(html, m.index);
  return {
    html: html.slice(0, m.index) + snippet.replace(/^ {2}/, indent) + '\n' + indent.slice(0, -2) + html.slice(m.index),
    changed: true,
  };
}

function detectIndent(html: string, closeIndex: number): string {
  const lineStart = html.lastIndexOf('\n', closeIndex) + 1;
  const ws = /^[ \t]*/.exec(html.slice(lineStart, closeIndex))?.[0] ?? '';
  return `${ws}  `;
}

function findMetaTag(html: string, attrName: string, attrValue: string):
  { tag: string; start: number; end: number } | null {
  const re = /<meta\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    const value = getAttribute(tag, attrName);
    if (value && value.toLowerCase() === attrValue.toLowerCase()) {
      return { tag, start: m.index!, end: m.index! + tag.length };
    }
  }
  return null;
}

export function getAttribute(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

function setAttribute(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\b${escapeRegex(name)}\\s*=\\s*)("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  if (re.test(tag)) {
    const current = getAttribute(tag, name);
    if (current === value) return tag;
    return tag.replace(re, `$1"${escapeAttr(value)}"`);
  }
  const selfClosing = /\/>$/.test(tag);
  const body = tag.slice(0, selfClosing ? -2 : -1).trimEnd();
  return `${body} ${name}="${escapeAttr(value)}"${selfClosing ? ' />' : '>'}`;
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
