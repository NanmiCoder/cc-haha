import type {
  Concept,
  Host,
  ResourceDocument,
} from '../../../src/features/managed-resources/types/resourceTypes.js'
import { resolveConceptClosure, type ConceptDependencyNode } from './conceptDependencyService.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'

/**
 * M5 context resolution limits. Every one of them blocks the *whole*
 * operation — nothing is ever silently truncated, because a partially composed
 * knowledge block is worse than a refused send.
 */
export const CONTEXT_LIMITS = {
  /** Dependency hops from a selected root (root = 0). */
  maxConceptDepth: 16,
  maxConcepts: 100,
  maxHosts: 20,
  /** UTF-8 bytes of the composed block. */
  maxContextBytes: 64 * 1024,
} as const

export type ContextLimitName = 'depth' | 'concepts' | 'hosts' | 'bytes'

/** `EntityVersionRef`-shaped selection entry: the revision the user saw. */
export type ContextEntityRef = {
  id: string
  revision: number
}

export type ContextResolutionInput = {
  conceptRoots: ContextEntityRef[]
  conceptDependencies?: ContextEntityRef[]
  hostIds?: string[]
}

export type ContextSourceSize = {
  kind: 'concept' | 'reference' | 'host'
  id: string
  title?: string
  /** UTF-8 bytes this source contributes to the composed block. */
  sizeBytes: number
  /** Only set for the depth breach, where the hop count is the offending value. */
  depth?: number
}

export type ResolvedContextConcept = {
  id: string
  title: string
  includedAs: 'root' | 'dependency'
  depth: number
  bodyMarkdown: string
  sizeBytes: number
}

export type ResolvedContextReference = {
  id: string
  title: string
}

export type ResolvedContextHost = {
  id: string
  name: string
  address: string
  port: number
}

export type ContextResolutionError =
  | {
      code: 'CONTEXT_RESOURCE_MISSING'
      params: { id: string; kind: 'root' | 'dependency' | 'reference' | 'host' }
    }
  | {
      code: 'CONTEXT_REVISION_CHANGED'
      params: { id: string; expectedRevision: number; actualRevision: number }
    }
  | {
      code: 'CONCEPT_CYCLE'
      params: { path: string }
      cycle: string[]
    }
  | {
      code: 'CONTEXT_LIMIT_EXCEEDED'
      limitName: ContextLimitName
      params: { limit: number; actual: number }
      /** Removable sources with their sizes, largest contributor set first. */
      sources: ContextSourceSize[]
    }
  /** Extra, non-contract code for an unreadable/corrupt library. */
  | {
      code: 'CONTEXT_STORE_UNAVAILABLE'
      params: { status: string }
    }

export type ContextResolution =
  | {
      ok: true
      concepts: ResolvedContextConcept[]
      references: ResolvedContextReference[]
      hosts: ResolvedContextHost[]
      byteSize: number
      composedBlock: string
    }
  | { ok: false; error: ContextResolutionError }

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function conceptNode(concept: Concept): ConceptDependencyNode {
  return {
    id: concept.id,
    dependsOnIds: concept.dependsOnIds,
    referenceIds: concept.referenceIds,
    title: concept.title,
  }
}

function conceptSize(concept: Concept): number {
  return utf8ByteLength(`${concept.title}\n${concept.bodyMarkdown}`)
}

function hostSize(host: Host): number {
  return utf8ByteLength(`${host.name} ${host.address}:${host.port}`)
}

function referenceSize(title: string, id: string): number {
  return utf8ByteLength(`${title} (${id})`)
}

/**
 * Compose the deterministic text block whose UTF-8 size the 64 KiB limit is
 * measured against. References contribute their title and id only — never
 * their body.
 */
export function composeContextBlock(
  concepts: ResolvedContextConcept[],
  references: ResolvedContextReference[],
  hosts: ResolvedContextHost[],
): string {
  const lines: string[] = []
  for (const concept of concepts) {
    lines.push(`# ${concept.title} (${concept.id}) [${concept.includedAs}]`)
    lines.push(concept.bodyMarkdown)
    lines.push('')
  }
  if (references.length > 0) {
    lines.push('## References')
    for (const reference of references) lines.push(`- ${reference.title} (${reference.id})`)
    lines.push('')
  }
  if (hosts.length > 0) {
    lines.push('## Hosts')
    for (const host of hosts) lines.push(`- ${host.name} (${host.id}) ${host.address}:${host.port}`)
    lines.push('')
  }
  return lines.join('\n')
}

function sortSourcesBySize(sources: ContextSourceSize[]): ContextSourceSize[] {
  return [...sources].sort((a, b) => {
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
}

function limitError(
  limitName: ContextLimitName,
  limit: number,
  actual: number,
  sources: ContextSourceSize[],
): ContextResolution {
  return {
    ok: false,
    error: {
      code: 'CONTEXT_LIMIT_EXCEEDED',
      limitName,
      params: { limit, actual },
      sources: sortSourcesBySize(sources),
    },
  }
}

/**
 * Resolve a context selection against an already-loaded resource document.
 *
 * Pure and deterministic: no I/O, no clock, no locale-dependent ordering, and
 * the same input always produces the same entry order and byte size.
 */
export function resolveContextSelection(
  input: ContextResolutionInput,
  document: ResourceDocument,
): ContextResolution {
  const conceptsById = new Map<string, Concept>()
  for (const concept of document.concepts) conceptsById.set(concept.id, concept)

  const rootRefs = input.conceptRoots ?? []
  const dependencyRefs = input.conceptDependencies ?? []

  // 1. Selected refs must exist and still carry the revision the caller saw.
  //    Roots are checked first so the report matches the selection order.
  for (const ref of rootRefs) {
    const concept = conceptsById.get(ref.id)
    if (!concept) {
      return { ok: false, error: { code: 'CONTEXT_RESOURCE_MISSING', params: { id: ref.id, kind: 'root' } } }
    }
    if (concept.revision !== ref.revision) {
      return {
        ok: false,
        error: {
          code: 'CONTEXT_REVISION_CHANGED',
          params: { id: ref.id, expectedRevision: ref.revision, actualRevision: concept.revision },
        },
      }
    }
  }
  for (const ref of dependencyRefs) {
    const concept = conceptsById.get(ref.id)
    if (!concept) {
      return {
        ok: false,
        error: { code: 'CONTEXT_RESOURCE_MISSING', params: { id: ref.id, kind: 'dependency' } },
      }
    }
    if (concept.revision !== ref.revision) {
      return {
        ok: false,
        error: {
          code: 'CONTEXT_REVISION_CHANGED',
          params: { id: ref.id, expectedRevision: ref.revision, actualRevision: concept.revision },
        },
      }
    }
  }

  // 2. Closure: roots in selection order, dependencies in stored postorder.
  const closure = resolveConceptClosure({
    nodes: document.concepts.map(conceptNode),
    rootIds: rootRefs.map(ref => ref.id),
    dependencyIds: dependencyRefs.map(ref => ref.id),
  })
  if (!closure.ok) {
    return {
      ok: false,
      error: {
        code: 'CONCEPT_CYCLE',
        cycle: closure.cycle,
        params: { path: closure.cycle.join(' -> ') },
      },
    }
  }

  const concepts: ResolvedContextConcept[] = closure.entries.map(entry => {
    const concept = conceptsById.get(entry.id)!
    return {
      id: entry.id,
      title: entry.title,
      includedAs: entry.includedAs,
      depth: entry.depth,
      bodyMarkdown: concept.bodyMarkdown,
      sizeBytes: conceptSize(concept),
    }
  })

  const hostById = new Map<string, Host>()
  for (const host of document.hosts) hostById.set(host.id, host)

  const conceptSources = (): ContextSourceSize[] =>
    concepts.map(concept => ({
      kind: 'concept' as const,
      id: concept.id,
      title: concept.title,
      sizeBytes: concept.sizeBytes,
      depth: concept.depth,
    }))

  // 3. Depth: an over-deep closure is refused whole, and the offenders are the
  //    entries past the limit.
  const tooDeep = concepts.filter(concept => concept.depth > CONTEXT_LIMITS.maxConceptDepth)
  if (tooDeep.length > 0) {
    const deepest = tooDeep.reduce((max, concept) => Math.max(max, concept.depth), 0)
    return limitError(
      'depth',
      CONTEXT_LIMITS.maxConceptDepth,
      deepest,
      tooDeep.map(concept => ({
        kind: 'concept',
        id: concept.id,
        title: concept.title,
        sizeBytes: concept.sizeBytes,
        depth: concept.depth,
      })),
    )
  }

  // 4. Concept count.
  if (concepts.length > CONTEXT_LIMITS.maxConcepts) {
    return limitError('concepts', CONTEXT_LIMITS.maxConcepts, concepts.length, conceptSources())
  }

  // 5. Hosts.
  const hosts: ResolvedContextHost[] = []
  for (const hostId of input.hostIds ?? []) {
    const host = hostById.get(hostId)
    if (!host) {
      return { ok: false, error: { code: 'CONTEXT_RESOURCE_MISSING', params: { id: hostId, kind: 'host' } } }
    }
    if (hosts.some(existing => existing.id === host.id)) continue
    hosts.push({ id: host.id, name: host.name, address: host.address, port: host.port })
  }
  if (hosts.length > CONTEXT_LIMITS.maxHosts) {
    return limitError(
      'hosts',
      CONTEXT_LIMITS.maxHosts,
      hosts.length,
      hosts.map(host => ({
        kind: 'host' as const,
        id: host.id,
        title: host.name,
        sizeBytes: hostSize(hostById.get(host.id)!),
      })),
    )
  }

  // 6. References: title + id metadata only, in first-seen order, deduped.
  const references: ResolvedContextReference[] = []
  const seenReferences = new Set<string>()
  for (const concept of concepts) {
    const source = conceptsById.get(concept.id)!
    for (const referenceId of source.referenceIds) {
      if (seenReferences.has(referenceId)) continue
      const target = conceptsById.get(referenceId)
      if (!target) {
        return {
          ok: false,
          error: { code: 'CONTEXT_RESOURCE_MISSING', params: { id: referenceId, kind: 'reference' } },
        }
      }
      seenReferences.add(referenceId)
      references.push({ id: target.id, title: target.title })
    }
  }

  // 7. Composed block size.
  const composedBlock = composeContextBlock(concepts, references, hosts)
  const byteSize = utf8ByteLength(composedBlock)
  if (byteSize > CONTEXT_LIMITS.maxContextBytes) {
    return limitError('bytes', CONTEXT_LIMITS.maxContextBytes, byteSize, [
      ...conceptSources(),
      ...references.map(reference => ({
        kind: 'reference' as const,
        id: reference.id,
        title: reference.title,
        sizeBytes: referenceSize(reference.title, reference.id),
      })),
      ...hosts.map(host => ({
        kind: 'host' as const,
        id: host.id,
        title: host.name,
        sizeBytes: hostSize(hostById.get(host.id)!),
      })),
    ])
  }

  return { ok: true, concepts, references, hosts, byteSize, composedBlock }
}

export type ContextResolver = {
  resolve(input: ContextResolutionInput): Promise<ContextResolution>
}

/**
 * Repository-backed resolver. Reads the library through the document store —
 * never through a cached copy — so a revision checked here is the revision on
 * disk. Cycle detection lives in the closure walk above; the *write* side keeps
 * its own three-colour check inside `ResourceDocumentStore.transact`.
 */
export function createContextResolver(options: { store: ResourceDocumentStore }): ContextResolver {
  return {
    async resolve(input: ContextResolutionInput): Promise<ContextResolution> {
      const loaded = await options.store.load()
      if (loaded.status !== 'ready') {
        return { ok: false, error: { code: 'CONTEXT_STORE_UNAVAILABLE', params: { status: loaded.status } } }
      }
      return resolveContextSelection(input, loaded.document)
    },
  }
}
