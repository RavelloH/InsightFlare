// ---------------------------------------------------------------------------
//  Path Markov chain — per-site path transition graph
//
//  Replaces the previous uniform path picker with a first-order Markov chain.
//  The default graph is derived from `profile.paths` ordering:
//    - paths[0] is the canonical entry node.
//    - From any path P, forward transitions toward later paths get higher
//      weight than backward transitions (mimics natural site flow).
//    - Each node has a small probability to bounce back to entry, and a
//      small probability to "stay" (refresh / re-read).
//
//  `profile.pathFlow` can override this default for sites whose structure
//  is genuinely funnel-shaped (e-commerce checkout) or branching (forum).
// ---------------------------------------------------------------------------

import type { DemoSiteProfile } from "@/lib/demo/data/site-profiles";
import { normalizePath } from "@/lib/demo/generators/utils";
import { weightedPickIndex } from "@/lib/demo/realtime/dimension-pickers";
interface PathEdge {
  to: string;
  weight: number;
}
export interface PathGraph {
  entry: string;
  nodes: Map<string, PathEdge[]>;
  /** Universe of path labels (entry + outgoing targets) */
  paths: string[];
}
const GRAPH_CACHE = new Map<string, PathGraph>();
const STAY_PROB = 0.06;
const HOME_PROB = 0.08;
/**
 * Build (or fetch from cache) the path transition graph for a site.
 *
 * If `profile.pathFlow` is provided, transitions are taken verbatim from it.
 * Otherwise, transitions are derived from `profile.paths` ordering: each node
 * gets edges to every other node with weight inversely proportional to the
 * forward index distance, favouring small forward jumps.
 *
 * The `extraPaths` argument (typically the long-tail paths expanded for a
 * window) is appended to the graph as low-weight reachable destinations.
 */
export function buildPathTransitionGraph(
  profile: DemoSiteProfile,
  extraPaths: readonly string[] = [],
): PathGraph {
  const cacheKey = `${profile.id}:${extraPaths.length}`;
  const cached = GRAPH_CACHE.get(cacheKey);
  if (cached) return cached;

  const orderedBase = uniqueNormalizedPaths(profile.paths);
  const entry = orderedBase[0] ?? "/";
  const extraNormalized = uniqueNormalizedPaths(extraPaths).filter(
    (p) => !orderedBase.includes(p),
  );
  const universe = [...orderedBase, ...extraNormalized];

  const nodes = new Map<string, PathEdge[]>();
  if (profile.pathFlow) {
    for (const [from, edges] of Object.entries(profile.pathFlow)) {
      const normalizedFrom = normalizePath(from) || "/";
      const normalizedEdges = edges
        .map((edge) => ({
          to: normalizePath(edge.to) || "/",
          weight: Math.max(0, Number(edge.weight) || 0),
        }))
        .filter((edge) => edge.weight > 0);
      if (normalizedEdges.length > 0) {
        nodes.set(normalizedFrom, normalizedEdges);
      }
    }
  }

  // Fill defaults for every path that didn't appear in pathFlow.
  for (let i = 0; i < universe.length; i += 1) {
    const from = universe[i] ?? "/";
    if (nodes.has(from)) continue;
    const edges: PathEdge[] = [];
    for (let j = 0; j < universe.length; j += 1) {
      if (j === i) continue;
      const to = universe[j] ?? "/";
      // Forward jumps from base paths (j > i) are preferred over backward.
      // Distance attenuates the weight, plus an extraPaths penalty.
      const forward = j > i;
      const distance = Math.abs(j - i);
      const baseWeight = 1 / (1 + distance * 0.7);
      const directionFactor = forward ? 1 : 0.45;
      const extraPenalty = j >= orderedBase.length ? 0.35 : 1;
      edges.push({
        to,
        weight: baseWeight * directionFactor * extraPenalty,
      });
    }
    nodes.set(from, edges);
  }

  const graph: PathGraph = { entry, nodes, paths: universe };
  if (GRAPH_CACHE.size > 60) GRAPH_CACHE.clear();
  GRAPH_CACHE.set(cacheKey, graph);
  return graph;
}
function uniqueNormalizedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const normalized = normalizePath(String(raw || "")) || "/";
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
/**
 * Pick the next path given the current one. When `currentPath` is empty (the
 * very first hit of a session) returns the entry node — this matches real
 * sessions where the first pageview is typically the canonical entry.
 */
export function nextPath(
  graph: PathGraph,
  currentPath: string,
  rng: () => number,
): string {
  if (!currentPath) return graph.entry;

  const u = rng();
  if (u < STAY_PROB) return currentPath;
  if (u < STAY_PROB + HOME_PROB) return graph.entry;

  const edges =
    graph.nodes.get(currentPath) ?? graph.nodes.get(graph.entry) ?? [];
  if (edges.length === 0) return graph.entry;

  const index = weightedPickIndex(
    rng,
    edges.map((edge) => edge.weight),
  );
  return edges[index]?.to ?? graph.entry;
}
