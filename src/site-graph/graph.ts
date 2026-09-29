/**
 * Generic directed-graph algorithms used by the site graph.
 * Kept free of website vocabulary so they stay testable in isolation.
 */

export interface AdjacencyGraph {
  nodes: string[];
  out: Map<string, Set<string>>;
  in: Map<string, Set<string>>;
}

export function buildGraph(nodes: string[], edges: [string, string][]): AdjacencyGraph {
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  for (const n of nodes) {
    out.set(n, new Set());
    inn.set(n, new Set());
  }
  for (const [a, b] of edges) {
    if (!out.has(a) || !out.has(b)) continue;
    if (a === b) continue;
    out.get(a)!.add(b);
    inn.get(b)!.add(a);
  }
  return { nodes, out, in: inn };
}

/** Shortest hop distance from the sources. Unreachable nodes get Infinity. */
export function bfsDepths(g: AdjacencyGraph, sources: string[]): Map<string, number> {
  const depth = new Map<string, number>();
  for (const n of g.nodes) depth.set(n, Infinity);
  const queue: string[] = [];
  for (const s of sources) {
    if (depth.has(s)) {
      depth.set(s, 0);
      queue.push(s);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const d = depth.get(cur)!;
    for (const nxt of g.out.get(cur) ?? []) {
      if (depth.get(nxt)! > d + 1) {
        depth.set(nxt, d + 1);
        queue.push(nxt);
      }
    }
  }
  return depth;
}

/**
 * PageRank over internal links. Used only to rank pages by internal prominence -
 * it is a property of this site's own link structure and says nothing about how any
 * search engine values the page.
 */
export function pageRank(g: AdjacencyGraph, damping = 0.85, iterations = 40, tolerance = 1e-7): Map<string, number> {
  const n = g.nodes.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;
  const init = 1 / n;
  for (const node of g.nodes) rank.set(node, init);

  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const node of g.nodes) {
      if ((g.out.get(node)?.size ?? 0) === 0) dangling += rank.get(node)!;
    }
    const base = (1 - damping) / n + (damping * dangling) / n;
    for (const node of g.nodes) next.set(node, base);

    for (const node of g.nodes) {
      const outs = g.out.get(node)!;
      if (outs.size === 0) continue;
      const share = (damping * rank.get(node)!) / outs.size;
      for (const t of outs) next.set(t, next.get(t)! + share);
    }

    let delta = 0;
    for (const node of g.nodes) delta += Math.abs(next.get(node)! - rank.get(node)!);
    for (const [k, v] of next) rank.set(k, v);
    if (delta < tolerance) break;
  }
  return rank;
}

/** Weakly connected components, treating edges as undirected. */
export function weaklyConnectedComponents(g: AdjacencyGraph): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of g.nodes) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of [...(g.out.get(cur) ?? []), ...(g.in.get(cur) ?? [])]) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    components.push(comp);
  }
  return components.sort((a, b) => b.length - a.length);
}

export function inDegree(g: AdjacencyGraph, node: string): number {
  return g.in.get(node)?.size ?? 0;
}

export function outDegree(g: AdjacencyGraph, node: string): number {
  return g.out.get(node)?.size ?? 0;
}

/** Nodes with no incoming edge from any other node. */
export function orphans(g: AdjacencyGraph, exclude: Set<string> = new Set()): string[] {
  return g.nodes.filter((n) => !exclude.has(n) && inDegree(g, n) === 0);
}
