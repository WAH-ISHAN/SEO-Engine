import type { SchemaBlock } from '../core/model.js';
import { attr, byTag, findAll, rawText, textContent, type DomNode } from './dom.js';

/**
 * Structured-data extraction for all three syntaxes that appear in the wild.
 * Extraction only - validation lives in the schema engine, so detection stays
 * separate from judgement.
 */

export function extractStructuredData(doc: DomNode): SchemaBlock[] {
  return [...extractJsonLd(doc), ...extractMicrodata(doc), ...extractRdfa(doc)];
}

function extractJsonLd(doc: DomNode): SchemaBlock[] {
  const out: SchemaBlock[] = [];
  for (const s of byTag(doc, 'script')) {
    const type = (attr(s, 'type') ?? '').toLowerCase();
    if (!type.includes('ld+json')) continue;
    const raw = rawText(s).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(stripJsonComments(raw));
      for (const obj of flattenGraph(parsed)) {
        out.push({ syntax: 'json-ld', types: typesOf(obj), raw: obj, offset: s.start });
      }
    } catch (err) {
      out.push({
        syntax: 'json-ld', types: [], raw, offset: s.start,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** JSON-LD often arrives wrapped in @graph or as a top-level array. Flatten both. */
function flattenGraph(parsed: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o['@graph'])) {
      for (const x of o['@graph'] as unknown[]) visit(x);
      const rest = { ...o };
      delete rest['@graph'];
      if (Object.keys(rest).some((k) => k !== '@context')) out.push(rest);
      return;
    }
    out.push(o);
  };
  visit(parsed);
  return out;
}

function stripJsonComments(s: string): string {
  // Some CMS plugins emit CDATA wrappers or trailing semicolons.
  return s
    .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\/\s*$/g, '')
    .replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')
    .trim()
    .replace(/;\s*$/, '');
}

export function typesOf(obj: Record<string, unknown>): string[] {
  const t = obj['@type'];
  if (typeof t === 'string') return [normalizeType(t)];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string').map(normalizeType);
  return [];
}

export function normalizeType(t: string): string {
  return t.replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '').trim();
}

// ---------------------------------------------------------------------------
// Microdata
// ---------------------------------------------------------------------------

function extractMicrodata(doc: DomNode): SchemaBlock[] {
  const scopes = findAll(
    doc,
    (n) => n.type === 'element' && n.attrs['itemscope'] !== undefined && !insideItemScope(n),
  );
  return scopes.map((s) => {
    const obj = readItem(s);
    return { syntax: 'microdata' as const, types: typesOf(obj), raw: obj, offset: s.start };
  });
}

function insideItemScope(n: DomNode): boolean {
  let p = n.parent;
  while (p) {
    if (p.type === 'element' && p.attrs['itemscope'] !== undefined) return true;
    p = p.parent;
  }
  return false;
}

function readItem(scope: DomNode): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const itemtype = attr(scope, 'itemtype');
  if (itemtype) {
    const types = itemtype.split(/\s+/).map(normalizeType).filter(Boolean);
    obj['@type'] = types.length === 1 ? types[0] : types;
  }
  const id = attr(scope, 'itemid');
  if (id) obj['@id'] = id;

  const collect = (n: DomNode) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      const prop = attr(c, 'itemprop');
      if (prop) {
        const value = c.attrs['itemscope'] !== undefined ? readItem(c) : microdataValue(c);
        for (const key of prop.split(/\s+/).filter(Boolean)) {
          if (obj[key] === undefined) obj[key] = value;
          else if (Array.isArray(obj[key])) (obj[key] as unknown[]).push(value);
          else obj[key] = [obj[key], value];
        }
        if (c.attrs['itemscope'] !== undefined) continue;
      }
      collect(c);
    }
  };
  collect(scope);
  return obj;
}

function microdataValue(n: DomNode): string {
  switch (n.tag) {
    case 'meta': return attr(n, 'content') ?? '';
    case 'a': case 'area': case 'link': return attr(n, 'href') ?? '';
    case 'img': case 'audio': case 'embed': case 'iframe': case 'source': case 'track': case 'video':
      return attr(n, 'src') ?? '';
    case 'object': return attr(n, 'data') ?? '';
    case 'data': case 'meter': return attr(n, 'value') ?? textContent(n);
    case 'time': return attr(n, 'datetime') ?? textContent(n);
    default: return textContent(n);
  }
}

// ---------------------------------------------------------------------------
// RDFa Lite
// ---------------------------------------------------------------------------

function extractRdfa(doc: DomNode): SchemaBlock[] {
  const scopes = findAll(
    doc,
    (n) => n.type === 'element' && n.attrs['typeof'] !== undefined && !insideTypeof(n),
  );
  return scopes.map((s) => {
    const obj = readRdfa(s);
    return { syntax: 'rdfa' as const, types: typesOf(obj), raw: obj, offset: s.start };
  });
}

function insideTypeof(n: DomNode): boolean {
  let p = n.parent;
  while (p) {
    if (p.type === 'element' && p.attrs['typeof'] !== undefined) return true;
    p = p.parent;
  }
  return false;
}

function readRdfa(scope: DomNode): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const t = attr(scope, 'typeof');
  if (t) {
    const types = t.split(/\s+/).map(normalizeType).filter(Boolean);
    obj['@type'] = types.length === 1 ? types[0] : types;
  }
  const collect = (n: DomNode) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      const prop = attr(c, 'property');
      if (prop) {
        const value = c.attrs['typeof'] !== undefined ? readRdfa(c) : rdfaValue(c);
        for (const key of prop.split(/\s+/).map((k) => k.replace(/^schema:/, ''))) {
          if (obj[key] === undefined) obj[key] = value;
          else if (Array.isArray(obj[key])) (obj[key] as unknown[]).push(value);
          else obj[key] = [obj[key], value];
        }
        if (c.attrs['typeof'] !== undefined) continue;
      }
      collect(c);
    }
  };
  collect(scope);
  return obj;
}

function rdfaValue(n: DomNode): string {
  return attr(n, 'content') ?? attr(n, 'href') ?? attr(n, 'src') ?? attr(n, 'datetime') ?? textContent(n);
}

// ---------------------------------------------------------------------------
// Helpers shared with the schema engine
// ---------------------------------------------------------------------------

/** Reads a schema property that may be a string, object, or array. */
export function prop(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  }
  return undefined;
}

export function propString(obj: Record<string, unknown>, ...names: string[]): string | null {
  const v = prop(obj, ...names);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length) {
    const first = v[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') return propString(first as Record<string, unknown>, 'name', '@id', 'url');
  }
  if (v && typeof v === 'object') {
    return propString(v as Record<string, unknown>, 'name', '@id', 'url', '@value');
  }
  return null;
}

export function propArray(obj: Record<string, unknown>, ...names: string[]): unknown[] {
  const v = prop(obj, ...names);
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
