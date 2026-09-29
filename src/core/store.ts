import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { edgeId, nodeId } from './ids.js';
import type {
  Change, EdgeType, Evidence, GraphEdge, GraphNode, Issue, NodeType,
  Recommendation, ValidationResult,
} from './model.js';

/**
 * The one normalized store. Raw crawl bytes live elsewhere (crawler/raw-store);
 * this holds only the normalized model that every engine reads.
 *
 * Backed by SQLite for durability and by in-memory indexes for traversal speed.
 * Both are kept in sync on write, so a run never has to round-trip to disk to walk
 * the graph.
 */
export class GraphStore {
  private db: DatabaseSync;
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private out = new Map<string, Set<string>>();
  private in = new Map<string, Set<string>>();
  private byType = new Map<NodeType, Set<string>>();

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
        props TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS nodes_type ON nodes(type);
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
        props TEXT NOT NULL, evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS edges_src ON edges(src, type);
      CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst, type);
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, site TEXT NOT NULL, taken_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_site ON snapshots(site, taken_at);
    `);
    this.load();
  }

  private load(): void {
    for (const r of this.db.prepare('SELECT * FROM nodes').all() as any[]) {
      const n: GraphNode = {
        id: r.id, type: r.type as NodeType, label: r.label,
        props: JSON.parse(r.props), firstSeen: r.first_seen, lastSeen: r.last_seen,
      };
      this.indexNode(n);
    }
    for (const r of this.db.prepare('SELECT * FROM edges').all() as any[]) {
      const e: GraphEdge = {
        id: r.id, type: r.type as EdgeType, from: r.src, to: r.dst,
        props: JSON.parse(r.props), evidence: JSON.parse(r.evidence),
      };
      this.indexEdge(e);
    }
  }

  private indexNode(n: GraphNode): void {
    this.nodes.set(n.id, n);
    let set = this.byType.get(n.type);
    if (!set) this.byType.set(n.type, (set = new Set()));
    set.add(n.id);
  }

  private indexEdge(e: GraphEdge): void {
    this.edges.set(e.id, e);
    let o = this.out.get(e.from);
    if (!o) this.out.set(e.from, (o = new Set()));
    o.add(e.id);
    let i = this.in.get(e.to);
    if (!i) this.in.set(e.to, (i = new Set()));
    i.add(e.id);
  }

  // -- writes ---------------------------------------------------------------

  /** Upserts a node. Identity comes from (type, key), never from props. */
  upsertNode<P extends Record<string, unknown>>(
    type: NodeType, key: string, label: string, props: P, at = Date.now(),
  ): GraphNode<P> {
    const id = nodeId(type, key);
    const existing = this.nodes.get(id);
    const node: GraphNode<P> = existing
      ? { ...(existing as GraphNode<P>), label, props: { ...(existing.props as P), ...props }, lastSeen: at }
      : { id, type, label, props, firstSeen: at, lastSeen: at };
    this.indexNode(node as GraphNode);
    this.db
      .prepare(
        `INSERT INTO nodes (id,type,label,props,first_seen,last_seen) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, props=excluded.props, last_seen=excluded.last_seen`,
      )
      .run(id, type, label, JSON.stringify(node.props), node.firstSeen, node.lastSeen);
    return node;
  }

  /** Adds a relationship. Edges require evidence; unevidenced edges are rejected. */
  addEdge(
    type: EdgeType, from: string, to: string, evidence: Evidence[],
    props: Record<string, unknown> = {}, discriminator = '',
  ): GraphEdge | null {
    if (evidence.length === 0) return null;
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    const id = edgeId(type, from, to, discriminator);
    const prev = this.edges.get(id);
    const edge: GraphEdge = prev
      ? { ...prev, props: { ...prev.props, ...props }, evidence: mergeEvidence(prev.evidence, evidence) }
      : { id, type, from, to, props, evidence };
    this.indexEdge(edge);
    this.db
      .prepare(
        `INSERT INTO edges (id,type,src,dst,props,evidence) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET props=excluded.props, evidence=excluded.evidence`,
      )
      .run(id, type, from, to, JSON.stringify(edge.props), JSON.stringify(edge.evidence));
    return edge;
  }

  // -- reads ----------------------------------------------------------------

  getNode<P = Record<string, unknown>>(id: string): GraphNode<P> | undefined {
    return this.nodes.get(id) as GraphNode<P> | undefined;
  }

  findNode<P = Record<string, unknown>>(type: NodeType, key: string): GraphNode<P> | undefined {
    return this.nodes.get(nodeId(type, key)) as GraphNode<P> | undefined;
  }

  nodesOfType<P = Record<string, unknown>>(type: NodeType): GraphNode<P>[] {
    const ids = this.byType.get(type);
    if (!ids) return [];
    const out: GraphNode<P>[] = [];
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n) out.push(n as GraphNode<P>);
    }
    return out;
  }

  outgoing(id: string, type?: EdgeType): GraphEdge[] {
    return [...(this.out.get(id) ?? [])]
      .map((e) => this.edges.get(e)!)
      .filter((e) => e && (!type || e.type === type));
  }

  incoming(id: string, type?: EdgeType): GraphEdge[] {
    return [...(this.in.get(id) ?? [])]
      .map((e) => this.edges.get(e)!)
      .filter((e) => e && (!type || e.type === type));
  }

  neighbors(id: string, type?: EdgeType): GraphNode[] {
    return this.outgoing(id, type)
      .map((e) => this.nodes.get(e.to))
      .filter((n): n is GraphNode => !!n);
  }

  allEdges(type?: EdgeType): GraphEdge[] {
    const out: GraphEdge[] = [];
    for (const e of this.edges.values()) if (!type || e.type === type) out.push(e);
    return out;
  }

  counts(): Record<string, number> {
    const c: Record<string, number> = {};
    for (const [t, s] of this.byType) c[t] = s.size;
    c._edges = this.edges.size;
    return c;
  }

  // -- record tables (issues / recommendations / changes / validations) ------

  putRecord(kind: string, id: string, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO records (kind,id,data,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(kind, id, JSON.stringify(data), Date.now());
  }

  getRecord<T>(kind: string, id: string): T | undefined {
    const r = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id) as any;
    return r ? (JSON.parse(r.data) as T) : undefined;
  }

  listRecords<T>(kind: string): T[] {
    return (this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY id').all(kind) as any[])
      .map((r) => JSON.parse(r.data) as T);
  }

  deleteRecord(kind: string, id: string): void {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  }

  saveIssue(i: Issue): void { this.putRecord('issue', i.id, i); }
  saveRecommendation(r: Recommendation): void { this.putRecord('recommendation', r.id, r); }
  saveChange(c: Change): void { this.putRecord('change', c.id, c); }
  saveValidation(v: ValidationResult): void { this.putRecord('validation', v.id, v); }

  issues(): Issue[] { return this.listRecords<Issue>('issue'); }
  recommendations(): Recommendation[] { return this.listRecords<Recommendation>('recommendation'); }
  changes(): Change[] { return this.listRecords<Change>('change'); }
  validations(): ValidationResult[] { return this.listRecords<ValidationResult>('validation'); }

  // -- snapshots ------------------------------------------------------------

  saveSnapshot(id: string, site: string, takenAt: number, data: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO snapshots (id,site,taken_at,data) VALUES (?,?,?,?)')
      .run(id, site, takenAt, JSON.stringify(data));
  }

  listSnapshots(site: string, limit = 50): { id: string; takenAt: number }[] {
    return (
      this.db
        .prepare('SELECT id, taken_at FROM snapshots WHERE site=? ORDER BY taken_at DESC LIMIT ?')
        .all(site, limit) as any[]
    ).map((r) => ({ id: r.id, takenAt: r.taken_at }));
  }

  getSnapshot<T>(id: string): T | undefined {
    const r = this.db.prepare('SELECT data FROM snapshots WHERE id=?').get(id) as any;
    return r ? (JSON.parse(r.data) as T) : undefined;
  }

  latestSnapshots<T>(site: string, n: number): { id: string; takenAt: number; data: T }[] {
    return (
      this.db
        .prepare('SELECT id, taken_at, data FROM snapshots WHERE site=? ORDER BY taken_at DESC LIMIT ?')
        .all(site, n) as any[]
    ).map((r) => ({ id: r.id, takenAt: r.taken_at, data: JSON.parse(r.data) as T }));
  }

  close(): void {
    this.db.close();
  }
}

function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const seen = new Set(a.map((e) => `${e.kind}|${e.source}|${e.locator}|${e.note ?? ''}`));
  const out = [...a];
  for (const e of b) {
    const k = `${e.kind}|${e.source}|${e.locator}|${e.note ?? ''}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out.slice(0, 40);
}
