import { decodeEntities, tokenize, VOID_ELEMENTS, type Token } from './tokenizer.js';

/**
 * A minimal DOM built from the token stream, with the implicit-close rules that
 * real-world HTML relies on. Enough structure to reason about document semantics;
 * no layout, no scripting, no CSS.
 */

export interface DomNode {
  type: 'element' | 'text' | 'comment' | 'document';
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  parent: DomNode | null;
  text: string;
  /** Byte offsets into the source HTML, for evidence locators. */
  start: number;
  end: number;
}

/** Tags that auto-close a currently open element of the same or related kind. */
const IMPLICIT_CLOSE: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  p: ['p'],
  option: ['option'],
  optgroup: ['optgroup', 'option'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['tbody', 'tfoot'],
  tbody: ['thead', 'tbody', 'tfoot'],
  tfoot: ['thead', 'tbody'],
};

/** A <p> is implicitly closed by any of these block starts. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul',
]);

export function parseHtml(html: string): DomNode {
  const doc: DomNode = {
    type: 'document', tag: '#document', attrs: {}, children: [], parent: null,
    text: '', start: 0, end: html.length,
  };
  const stack: DomNode[] = [doc];
  const top = () => stack[stack.length - 1];

  for (const t of tokenize(html)) {
    switch (t.kind) {
      case 'text': {
        const value = decodeEntities(t.value);
        if (value.trim().length === 0 && !/[\s]/.test(value)) break;
        append(top(), {
          type: 'text', tag: '#text', attrs: {}, children: [], parent: top(),
          text: value, start: t.start, end: t.end,
        });
        break;
      }
      case 'comment':
        append(top(), {
          type: 'comment', tag: '#comment', attrs: {}, children: [], parent: top(),
          text: t.value, start: t.start, end: t.end,
        });
        break;
      case 'doctype':
        break;
      case 'startTag': {
        closeImplied(stack, t.name);
        const el: DomNode = {
          type: 'element', tag: t.name, attrs: t.attrs, children: [], parent: top(),
          text: '', start: t.start, end: t.end,
        };
        append(top(), el);
        if (!t.selfClosing && !VOID_ELEMENTS.has(t.name)) stack.push(el);
        break;
      }
      case 'endTag': {
        if (VOID_ELEMENTS.has(t.name)) break;
        let idx = -1;
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].tag === t.name) {
            idx = k;
            break;
          }
        }
        if (idx > 0) {
          for (let k = stack.length - 1; k >= idx; k--) stack[k].end = t.end;
          stack.length = idx;
        }
        break;
      }
    }
  }
  return doc;
}

function append(parent: DomNode, child: DomNode): void {
  child.parent = parent;
  parent.children.push(child);
}

function closeImplied(stack: DomNode[], name: string): void {
  const openTop = stack[stack.length - 1];
  if (openTop.type !== 'element') return;
  if (openTop.tag === 'p' && CLOSES_P.has(name)) {
    stack.pop();
    return;
  }
  const closes = IMPLICIT_CLOSE[name];
  if (!closes) return;
  while (stack.length > 1) {
    const t = stack[stack.length - 1];
    if (t.type === 'element' && closes.includes(t.tag)) stack.pop();
    else break;
  }
}

// ---------------------------------------------------------------------------
// Traversal + selection
// ---------------------------------------------------------------------------

export function walk(node: DomNode, visit: (n: DomNode) => void | false): void {
  const stack: DomNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (visit(n) === false) continue;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
}

export function findAll(root: DomNode, pred: (n: DomNode) => boolean): DomNode[] {
  const out: DomNode[] = [];
  walk(root, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

export function byTag(root: DomNode, ...tags: string[]): DomNode[] {
  const set = new Set(tags);
  return findAll(root, (n) => n.type === 'element' && set.has(n.tag));
}

export function firstByTag(root: DomNode, ...tags: string[]): DomNode | null {
  const set = new Set(tags);
  let found: DomNode | null = null;
  walk(root, (n) => {
    if (found) return false;
    if (n.type === 'element' && set.has(n.tag)) {
      found = n;
      return false;
    }
    return undefined;
  });
  return found;
}

export function attr(n: DomNode | null, name: string): string | null {
  if (!n) return null;
  const v = n.attrs[name.toLowerCase()];
  return v === undefined ? null : v;
}

export function classList(n: DomNode): string[] {
  return (n.attrs['class'] ?? '').split(/\s+/).filter(Boolean);
}

export function hasAncestor(n: DomNode, pred: (a: DomNode) => boolean): boolean {
  let p = n.parent;
  while (p) {
    if (pred(p)) return true;
    p = p.parent;
  }
  return false;
}

const NON_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre', 'br', 'hr',
  'dt', 'dd', 'figcaption', 'table', 'form', 'ul', 'ol', 'dl',
]);

/** Visible text, with block boundaries turned into spaces so words do not fuse. */
export function textContent(node: DomNode): string {
  const parts: string[] = [];
  const rec = (n: DomNode) => {
    if (n.type === 'text') {
      parts.push(n.text);
      return;
    }
    if (n.type !== 'element' && n.type !== 'document') return;
    if (NON_TEXT_TAGS.has(n.tag)) return;
    if (n.attrs['hidden'] !== undefined || /display:\s*none/i.test(n.attrs['style'] ?? '')) return;
    const block = BLOCK_TAGS.has(n.tag);
    if (block) parts.push('\n');
    for (const c of n.children) rec(c);
    if (block) parts.push('\n');
  };
  rec(node);
  return parts.join('').replace(/[ \t]+/g, ' ').replace(/\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Raw concatenated text of raw-text elements such as script or style. */
export function rawText(node: DomNode): string {
  return node.children.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

export function outerHtmlApprox(n: DomNode, source: string, max = 300): string {
  const slice = source.slice(n.start, Math.min(n.end > n.start ? n.end : n.start + max, n.start + max));
  return slice.replace(/\s+/g, ' ').trim();
}

/** Depth-first index path, usable as a stable-ish CSS-like locator for evidence. */
export function locatorFor(n: DomNode): string {
  const parts: string[] = [];
  let cur: DomNode | null = n;
  while (cur && cur.parent) {
    const siblings = cur.parent.children.filter((c) => c.type === 'element' && c.tag === cur!.tag);
    const idx = siblings.indexOf(cur);
    const id = cur.attrs['id'];
    if (id) {
      parts.unshift(`#${id}`);
      break;
    }
    parts.unshift(siblings.length > 1 ? `${cur.tag}:nth-of-type(${idx + 1})` : cur.tag);
    cur = cur.parent;
  }
  return parts.join(' > ');
}
