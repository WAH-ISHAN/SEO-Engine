/**
 * A forgiving HTML tokenizer.
 *
 * Written from scratch rather than pulled from npm so the crawler has no runtime
 * dependencies and no supply-chain surface. It follows the shape of the HTML5
 * tokenizer where that matters for extraction (raw-text elements, attribute quoting,
 * comments, doctype) and deliberately ignores the parts that only matter for
 * rendering.
 */

export type Token =
  | { kind: 'doctype'; value: string; start: number; end: number }
  | { kind: 'comment'; value: string; start: number; end: number }
  | { kind: 'text'; value: string; start: number; end: number }
  | {
      kind: 'startTag';
      name: string;
      attrs: Record<string, string>;
      selfClosing: boolean;
      start: number;
      end: number;
    }
  | { kind: 'endTag'; name: string; start: number; end: number };

/** Elements whose content is not parsed as markup. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

export function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const len = html.length;
  let i = 0;

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i), i, len);
      break;
    }
    if (lt > i) pushText(html.slice(i, lt), i, lt);

    // Comment / doctype / CDATA
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end === -1 ? len : end + 3;
      tokens.push({ kind: 'comment', value: html.slice(lt + 4, end === -1 ? len : end), start: lt, end: stop });
      i = stop;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      const stop = end === -1 ? len : end + 3;
      pushText(html.slice(lt + 9, end === -1 ? len : end), lt, stop);
      i = stop;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? len : end + 1;
      tokens.push({ kind: 'doctype', value: html.slice(lt + 2, end === -1 ? len : end), start: lt, end: stop });
      i = stop;
      continue;
    }

    // End tag
    if (html.startsWith('</', lt)) {
      const m = /^<\/\s*([a-zA-Z][^\s>/]*)\s*>?/.exec(html.slice(lt));
      if (!m) {
        pushText('<', lt, lt + 1);
        i = lt + 1;
        continue;
      }
      const stop = lt + m[0].length;
      tokens.push({ kind: 'endTag', name: m[1].toLowerCase(), start: lt, end: stop });
      i = stop;
      continue;
    }

    // Start tag
    if (!/[a-zA-Z]/.test(html[lt + 1] ?? '')) {
      pushText('<', lt, lt + 1);
      i = lt + 1;
      continue;
    }
    const tag = readStartTag(html, lt);
    if (!tag) {
      pushText('<', lt, lt + 1);
      i = lt + 1;
      continue;
    }
    tokens.push(tag);
    i = tag.end;

    // Raw text content
    if (!tag.selfClosing && RAW_TEXT.has(tag.name)) {
      const closeRe = new RegExp(`</${tag.name}[\\s>]`, 'i');
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const contentEnd = m ? i + m.index : len;
      if (contentEnd > i) pushText(html.slice(i, contentEnd), i, contentEnd);
      if (m) {
        const gt = html.indexOf('>', contentEnd);
        const stop = gt === -1 ? len : gt + 1;
        tokens.push({ kind: 'endTag', name: tag.name, start: contentEnd, end: stop });
        i = stop;
      } else {
        i = len;
      }
    }
  }
  return tokens;

  function pushText(value: string, start: number, end: number): void {
    if (value.length === 0) return;
    tokens.push({ kind: 'text', value, start, end });
  }
}

function readStartTag(html: string, start: number): Extract<Token, { kind: 'startTag' }> | null {
  let i = start + 1;
  const nameStart = i;
  while (i < html.length && /[^\s/>]/.test(html[i])) i++;
  const name = html.slice(nameStart, i).toLowerCase();
  if (!name) return null;

  const attrs: Record<string, string> = {};
  let selfClosing = false;

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) break;
    if (html[i] === '>') {
      i++;
      break;
    }
    if (html[i] === '/') {
      selfClosing = true;
      i++;
      continue;
    }

    const attrStart = i;
    while (i < html.length && /[^\s=/>]/.test(html[i])) i++;
    let attrName = html.slice(attrStart, i).toLowerCase();
    if (!attrName) {
      i++;
      continue;
    }
    while (i < html.length && /\s/.test(html[i])) i++;

    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        i++;
        const close = html.indexOf(q, i);
        const stop = close === -1 ? html.length : close;
        value = html.slice(i, stop);
        i = stop + 1;
      } else {
        const vs = i;
        while (i < html.length && /[^\s>]/.test(html[i])) i++;
        value = html.slice(vs, i);
      }
    }
    if (!(attrName in attrs)) attrs[attrName] = decodeEntities(value);
  }

  if (VOID_ELEMENTS.has(name)) selfClosing = true;
  return { kind: 'startTag', name, attrs, selfClosing, start, end: i };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', laquo: '«', raquo: '»', deg: '°', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  dagger: '†', permil: '‰', prime: '′', times: '×', divide: '÷',
  minus: '−', plusmn: '±', frac12: '½', frac14: '¼', sup2: '²',
  sup3: '³', micro: 'µ', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
