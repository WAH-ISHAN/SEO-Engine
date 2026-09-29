import { derived, observed, type EdgeType, type Evidence } from '../core/model.js';
import type { GraphStore } from '../core/store.js';
import type { NormalizedSite } from '../normalizer/normalize.js';
import { normalizeWhitespace } from '../core/text.js';
import { extractBylines, extractFromMetadata, extractFromSchema, type EntityClass, type ExtractedEntity } from './extract.js';

/**
 * The entity graph: who and what the site talks about, and how those things relate.
 *
 * Entities are merged across pages only on strong identity signals (schema @id, an
 * identical sameAs URL, or an exact name within the same class). Fuzzy name matching
 * is deliberately not used: merging two different people because their names look
 * similar would fabricate a relationship, which this platform will not do.
 */

export interface ResolvedEntity {
  id: string;
  name: string;
  nodeClass: EntityClass;
  entityTypes: string[];
  description: string | null;
  urls: string[];
  aliases: string[];
  sameAs: string[];
  /** Pages where this entity was observed. */
  mentionedOn: string[];
  evidence: Evidence[];
  confidence: number;
  origins: ('schema' | 'content' | 'metadata')[];
  /** Relationships asserted by the site, each carrying its own evidence. */
  relations: { relation: EdgeType; targetId: string; targetName: string; evidence: Evidence[] }[];
}

export interface EntityGraph {
  entities: ResolvedEntity[];
  byId: Map<string, ResolvedEntity>;
  /** The entity that appears to represent the site operator, when one is declared. */
  primaryOrganization: ResolvedEntity | null;
  /** Entity names that appear on pages with no structured-data backing anywhere. */
  unbackedMentions: { name: string; urls: string[] }[];
  stats: { total: number; bySchemaBacked: number; byClass: Record<string, number> };
}

export function buildEntityGraph(site: NormalizedSite, store: GraphStore): EntityGraph {
  const extracted: ExtractedEntity[] = [];
  for (const page of site.pages) {
    extracted.push(...extractFromSchema(page));
    extracted.push(...extractFromMetadata(page));
    const html = site.htmlByUrl.get(page.url);
    if (html) extracted.push(...extractBylines(page, html));
  }

  const resolved = new Map<string, ResolvedEntity>();
  const identityIndex = new Map<string, string>();

  for (const e of extracted) {
    const keys = identityKeys(e);
    let id = keys.map((k) => identityIndex.get(k)).find((x): x is string => !!x);
    if (!id) {
      id = `entity:${e.nodeClass}:${normalizeName(e.name)}`;
      resolved.set(id, {
        id,
        name: e.name,
        nodeClass: e.nodeClass,
        entityTypes: [e.entityType],
        description: e.description,
        urls: [...e.urls],
        aliases: [...e.aliases],
        sameAs: [...e.sameAs],
        mentionedOn: [e.sourceUrl],
        evidence: [...e.evidence],
        confidence: e.confidence,
        origins: [e.origin],
        relations: [],
      });
    } else {
      const cur = resolved.get(id)!;
      if (!cur.entityTypes.includes(e.entityType)) cur.entityTypes.push(e.entityType);
      // Prefer a described entity over an undescribed one, but never invent a value.
      if (!cur.description && e.description) cur.description = e.description;
      cur.urls = unique([...cur.urls, ...e.urls]);
      cur.aliases = unique([...cur.aliases, ...e.aliases]);
      cur.sameAs = unique([...cur.sameAs, ...e.sameAs]);
      cur.mentionedOn = unique([...cur.mentionedOn, e.sourceUrl]);
      cur.evidence = [...cur.evidence, ...e.evidence].slice(0, 25);
      if (!cur.origins.includes(e.origin)) cur.origins.push(e.origin);
      // Corroboration across pages raises confidence but never above the ceiling for
      // the strongest single source.
      cur.confidence = Math.min(0.98, Math.max(cur.confidence, e.confidence) + 0.01 * (cur.mentionedOn.length - 1));
    }
    for (const k of keys) identityIndex.set(k, id);
  }

  // Resolve claims into edges once every entity exists.
  for (const e of extracted) {
    const sourceId = identityKeys(e).map((k) => identityIndex.get(k)).find((x): x is string => !!x);
    if (!sourceId) continue;
    const source = resolved.get(sourceId);
    if (!source) continue;

    for (const claim of e.claims) {
      const targetId = findTarget(resolved, identityIndex, claim.target, claim.targetClass);
      if (!targetId) {
        // The claim names something the site never defines. Record it against the
        // source entity as evidence, but do not create a phantom entity node.
        source.evidence.push(observed('entity.claim', e.sourceUrl, {
          note: `${claim.relation} names "${claim.target}", which has no entity definition anywhere on this site`,
          value: claim.target,
        }));
        continue;
      }
      if (targetId === sourceId) continue;
      const existing = source.relations.find((r) => r.relation === claim.relation && r.targetId === targetId);
      if (existing) existing.evidence.push(...claim.evidence);
      else {
        source.relations.push({
          relation: claim.relation as EdgeType,
          targetId,
          targetName: resolved.get(targetId)!.name,
          evidence: claim.evidence,
        });
      }
    }
  }

  // Materialize into the shared store.
  const at = Date.now();
  for (const ent of resolved.values()) {
    const nodeType = classToNodeType(ent.nodeClass);
    const node = store.upsertNode(nodeType, ent.id, ent.name, {
      name: ent.name,
      entityType: ent.entityTypes.join(','),
      description: ent.description,
      urls: ent.urls,
      aliases: ent.aliases,
      sameAs: ent.sameAs,
      evidence: ent.evidence,
      origin: ent.origins[0],
      confidence: ent.confidence,
      nodeClass: ent.nodeClass,
    }, at);

    for (const url of ent.mentionedOn) {
      const page = store.findNode('Page', url);
      if (page) {
        store.addEdge('mentions', page.id, node.id, [
          derived('entity-engine', url, { note: `Entity "${ent.name}" is defined on this page` }),
        ]);
      }
    }
  }
  for (const ent of resolved.values()) {
    const from = store.findNode(classToNodeType(ent.nodeClass), ent.id);
    if (!from) continue;
    for (const rel of ent.relations) {
      const target = resolved.get(rel.targetId);
      if (!target) continue;
      const to = store.findNode(classToNodeType(target.nodeClass), target.id);
      if (to) store.addEdge(rel.relation, from.id, to.id, rel.evidence);
    }
  }

  const entities = [...resolved.values()].sort((a, b) => b.mentionedOn.length - a.mentionedOn.length);
  const byClass: Record<string, number> = {};
  for (const e of entities) byClass[e.nodeClass] = (byClass[e.nodeClass] ?? 0) + 1;

  return {
    entities,
    byId: resolved,
    primaryOrganization: pickPrimaryOrganization(entities, site),
    unbackedMentions: findUnbackedMentions(entities),
    stats: {
      total: entities.length,
      bySchemaBacked: entities.filter((e) => e.origins.includes('schema')).length,
      byClass,
    },
  };
}

function identityKeys(e: ExtractedEntity): string[] {
  const keys: string[] = [`name:${e.nodeClass}:${normalizeName(e.name)}`];
  if (e.schemaId) keys.push(`id:${e.schemaId}`);
  for (const s of e.sameAs) keys.push(`sameas:${s.toLowerCase()}`);
  return keys;
}

function findTarget(
  resolved: Map<string, ResolvedEntity>,
  index: Map<string, string>,
  target: string,
  cls: EntityClass,
): string | null {
  const direct = index.get(`name:${cls}:${normalizeName(target)}`);
  if (direct) return direct;
  const byId = index.get(`id:${target}`) ?? index.get(`sameas:${target.toLowerCase()}`);
  if (byId) return byId;
  // Allow a class-agnostic exact-name match, which covers a Service named in an
  // Organization's offers and defined elsewhere as a Product.
  for (const [id, ent] of resolved) {
    if (normalizeName(ent.name) === normalizeName(target)) return id;
  }
  return null;
}

function normalizeName(n: string): string {
  return normalizeWhitespace(n)
    .toLowerCase()
    .replace(/[‘’'".,]/g, '')
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|co)\b\.?$/g, '')
    .trim();
}

function classToNodeType(c: EntityClass) {
  switch (c) {
    case 'Organization': return 'Organization' as const;
    case 'Person': return 'Person' as const;
    case 'Product': return 'Product' as const;
    case 'Service': return 'Service' as const;
    case 'Location': return 'Location' as const;
    case 'Article': return 'Article' as const;
    default: return 'Entity' as const;
  }
}

function pickPrimaryOrganization(entities: ResolvedEntity[], site: NormalizedSite): ResolvedEntity | null {
  const orgs = entities.filter((e) => e.nodeClass === 'Organization');
  if (orgs.length === 0) return null;
  const origin = site.origin;
  // The organization that claims the site's own origin as its url is the operator.
  const owner = orgs.find((o) => o.urls.some((u) => u === origin || u === `${origin}/`));
  if (owner) return owner;
  const schemaBacked = orgs.filter((o) => o.origins.includes('schema'));
  const pool = schemaBacked.length ? schemaBacked : orgs;
  return pool.sort((a, b) => b.mentionedOn.length - a.mentionedOn.length)[0] ?? null;
}

function findUnbackedMentions(entities: ResolvedEntity[]): { name: string; urls: string[] }[] {
  return entities
    .filter((e) => !e.origins.includes('schema'))
    .map((e) => ({ name: e.name, urls: e.mentionedOn }))
    .sort((a, b) => b.urls.length - a.urls.length);
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
