import type { Concept } from '../../../src/features/managed-resources/types/resourceTypes.js'

export type ConceptDependencyNode = {
  id: string
  dependsOnIds: string[]
  referenceIds: string[]
  title: string
}

export type ConceptCycleResult =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] }

/**
 * Three-color DFS cycle detection. White = unvisited, gray = on the current
 * DFS stack, black = fully visited. A back-edge from a gray node to a
 * gray ancestor is a cycle.
 *
 * Returns a stable topological order over the input set when there is no
 * cycle. The order is deterministic across runs (lexicographic tiebreak
 * on ids) so M5 callers can cache and compare results.
 */
export function topologicalSortWithCycleDetection(
  nodes: ConceptDependencyNode[],
): ConceptCycleResult {
  const byId = new Map<string, ConceptDependencyNode>()
  for (const node of nodes) byId.set(node.id, node)

  const COLOR_WHITE = 0
  const COLOR_GRAY = 1
  const COLOR_BLACK = 2
  const color = new Map<string, number>()
  for (const id of byId.keys()) color.set(id, COLOR_WHITE)

  const order: string[] = []
  // Stable DFS — visit dependsOnIds in lexicographic order.
  const stack: { id: string; iterator: number; deps: string[] }[] = []

  function visit(id: string): ConceptCycleResult {
    const currentColor = color.get(id)
    if (currentColor === COLOR_GRAY) {
      // Back-edge — extract the cycle from the stack.
      const cycleStart = stack.findIndex(entry => entry.id === id)
      const cycle = stack.slice(cycleStart).map(entry => entry.id)
      cycle.push(id)
      return { ok: false, cycle }
    }
    if (currentColor === COLOR_BLACK) return { ok: true, order }
    color.set(id, COLOR_GRAY)
    const node = byId.get(id)
    if (!node) return { ok: true, order }
    // Each stack frame carries its own deps so nested frames use the right
    // neighbor set. The closure above `deps` was a single shared variable
    // and caused us to walk 'a's deps when we were inside 'b'.
    stack.push({ id, iterator: 0, deps: [...node.dependsOnIds].filter(dep => byId.has(dep)).sort() })
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (!top) break
      const topId = top.id
      const topNode = byId.get(topId)
      if (!topNode) {
        stack.pop()
        color.set(topId, COLOR_BLACK)
        order.push(topId)
        continue
      }
      if (top.iterator >= top.deps.length) {
        stack.pop()
        color.set(topId, COLOR_BLACK)
        order.push(topId)
        continue
      }
      const next = top.deps[top.iterator]
      if (typeof next !== 'string') {
        top.iterator += 1
        continue
      }
      top.iterator += 1
      const childColor = color.get(next)
      if (childColor === COLOR_GRAY) {
        const cycleStart = stack.findIndex(entry => entry.id === next)
        const cycle = stack.slice(cycleStart).map(entry => entry.id)
        cycle.push(next)
        return { ok: false, cycle }
      }
      if (childColor === COLOR_BLACK) continue
      color.set(next, COLOR_GRAY)
      stack.push({ id: next, iterator: 0, deps: [...(byId.get(next)?.dependsOnIds ?? []).filter(dep => byId.has(dep))].sort() })
    }
    return { ok: true, order }
  }

  // Visit roots in lexicographic order so the final order is deterministic.
  const sortedIds = [...byId.keys()].sort()
  for (const id of sortedIds) {
    if (color.get(id) !== COLOR_WHITE) continue
    const result = visit(id)
    if (!result.ok) return result
  }
  return { ok: true, order }
}

/**
 * Validate that adding `candidateDependsOnIds` to `existingConcept` does not
 * form a cycle in the dependsOn graph. The candidate's other concepts
 * must be supplied so we can detect transitive cycles.
 */
export function wouldCreateCycle(
  existingConcepts: Concept[],
  existingId: string | null,
  candidateDependsOnIds: string[],
): { ok: boolean; cycle?: string[] } {
  const workingSet: ConceptDependencyNode[] = existingConcepts.map(concept => ({
    id: concept.id,
    dependsOnIds: concept.dependsOnIds,
    referenceIds: concept.referenceIds,
    title: concept.title,
  }))
  const candidateId = existingId ?? `__pending_${Math.random().toString(36).slice(2, 10)}__`
  // Self-reference is always a cycle.
  if (candidateDependsOnIds.includes(candidateId)) {
    return { ok: false, cycle: [candidateId, candidateId] }
  }
  workingSet.push({
    id: candidateId,
    dependsOnIds: candidateDependsOnIds,
    referenceIds: [],
    title: '__pending__',
  })
  const result = topologicalSortWithCycleDetection(workingSet)
  if (result.ok) return { ok: true }
  return { ok: false, cycle: result.cycle }
}

// ==========================================
// M5 concept closure (root order, postorder, root marking, dedupe)
// ==========================================

export type ConceptClosureEntry = {
  id: string
  title: string
  /**
   * `root` wins whenever the id was selected as a root, even if the same node
   * was first reached as somebody else's dependency.
   */
  includedAs: 'root' | 'dependency'
  /** Dependency hops from the traversal root that emitted this entry (root = 0). */
  depth: number
}

export type ConceptClosureResult =
  | { ok: true; entries: ConceptClosureEntry[] }
  | { ok: false; cycle: string[] }

export type ConceptClosureInput = {
  nodes: ConceptDependencyNode[]
  /** Selected roots, in the order the user selected them. */
  rootIds: string[]
  /**
   * Explicitly selected dependency entries (the selection model's
   * `dependencyRefs`). Walked after the roots, and marked `dependency` unless
   * the same id is also a root.
   */
  dependencyIds?: string[]
  /**
   * `stored` (default) keeps the persisted `dependsOnIds` order. `id` sorts by
   * code unit (`<`/`>`), never by locale, and exists only for callers that hold
   * a genuinely unordered set.
   */
  dependencyOrder?: 'stored' | 'id'
}

/** Deterministic, locale-independent id order. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Sibling dependencies are emitted in stored order: `dependsOnIds` is a
 * persisted array, so its order is the operator's intent. Re-sorting it (the
 * old topological helper sorted lexicographically) reorders the composed block
 * for a graph nobody edited.
 */
export function storedOrderDependencyIds(dependsOnIds: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(dependsOnIds)) return []
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const id of dependsOnIds) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  return ordered
}

const COLOR_WHITE = 0
const COLOR_GRAY = 1
const COLOR_BLACK = 2

/**
 * Resolve the concept closure for a selection.
 *
 * - roots are walked in the order they were selected;
 * - every dependency is emitted depth-first postorder (a dependency before the
 *   node that depends on it);
 * - a node is emitted once, and keeps `root` marking when it is both a root and
 *   another node's dependency;
 * - `referenceIds` are not dependencies and never enter this walk.
 *
 * The three-colour DFS reports the full cycle path (first id repeated at the
 * end), so a caller can show `[A, B, C, A]` instead of a boolean.
 */
export function resolveConceptClosure(input: ConceptClosureInput): ConceptClosureResult {
  const byId = new Map<string, ConceptDependencyNode>()
  for (const node of input.nodes) byId.set(node.id, node)

  const rootSet = new Set(input.rootIds)
  const order = input.dependencyOrder ?? 'stored'
  const color = new Map<string, number>()
  for (const id of byId.keys()) color.set(id, COLOR_WHITE)

  const entries: ConceptClosureEntry[] = []
  const emitted = new Set<string>()

  const dependencyIdsOf = (id: string): string[] => {
    const deps = storedOrderDependencyIds(byId.get(id)?.dependsOnIds)
    return order === 'id' ? [...deps].sort(byCodeUnit) : deps
  }

  const emit = (id: string, depth: number): void => {
    if (emitted.has(id)) return
    emitted.add(id)
    entries.push({
      id,
      title: byId.get(id)?.title ?? id,
      includedAs: rootSet.has(id) ? 'root' : 'dependency',
      depth,
    })
  }

  type Frame = { id: string; deps: string[]; cursor: number; depth: number }
  const stack: Frame[] = []

  const traversalIds = [...input.rootIds, ...(input.dependencyIds ?? [])]
  for (const traversalId of traversalIds) {
    if (!byId.has(traversalId)) continue
    if (color.get(traversalId) !== COLOR_WHITE) continue
    color.set(traversalId, COLOR_GRAY)
    stack.push({ id: traversalId, deps: dependencyIdsOf(traversalId), cursor: 0, depth: 0 })
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      if (frame.cursor >= frame.deps.length) {
        stack.pop()
        color.set(frame.id, COLOR_BLACK)
        emit(frame.id, frame.depth)
        continue
      }
      const dependencyId = frame.deps[frame.cursor]!
      frame.cursor += 1
      const dependencyColor = color.get(dependencyId)
      if (dependencyColor === COLOR_GRAY) {
        const start = stack.findIndex(entry => entry.id === dependencyId)
        const cycle = stack.slice(start).map(entry => entry.id)
        cycle.push(dependencyId)
        return { ok: false, cycle }
      }
      if (dependencyColor === COLOR_BLACK) continue
      if (!byId.has(dependencyId)) continue
      color.set(dependencyId, COLOR_GRAY)
      stack.push({
        id: dependencyId,
        deps: dependencyIdsOf(dependencyId),
        cursor: 0,
        depth: frame.depth + 1,
      })
    }
  }

  return { ok: true, entries }
}

export type ReverseReference = {
  sourceConceptId: string
  sourceTitle: string
  referenceIds: string[]
}

/**
 * Compute reverse references: for every concept in `concepts`, list the
 * other concepts that mention it in their `dependsOnIds` or
 * `referenceIds`. Used by the delete-blocked dialog so the user can
 * decide which concepts to clean up first.
 */
export function computeReverseReferences(
  concepts: Concept[],
  targetId: string,
): { dependsOnFrom: ReverseReference[]; referencesFrom: ReverseReference[] } {
  const dependsOnFrom: ReverseReference[] = []
  const referencesFrom: ReverseReference[] = []
  for (const concept of concepts) {
    if (concept.id === targetId) continue
    if (concept.dependsOnIds.includes(targetId)) {
      dependsOnFrom.push({ sourceConceptId: concept.id, sourceTitle: concept.title, referenceIds: concept.dependsOnIds })
    }
    if (concept.referenceIds.includes(targetId)) {
      referencesFrom.push({ sourceConceptId: concept.id, sourceTitle: concept.title, referenceIds: concept.referenceIds })
    }
  }
  return { dependsOnFrom, referencesFrom }
}