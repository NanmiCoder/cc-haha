import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Concept, ResourceDocument } from '../../../src/features/managed-resources/types/resourceTypes.js'
import { createResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import {
  CONTEXT_LIMITS,
  createContextResolver,
  resolveContextSelection,
  utf8ByteLength,
  type ContextResolution,
} from './contextResolver.js'
import { resolveConceptClosure, type ConceptDependencyNode } from './conceptDependencyService.js'

const AT = '2026-01-01T00:00:00.000Z'

/** Deterministic, schema-valid (uuidv4) ids so the fixture reads like the graph. */
function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

const D = uid(0xd)
const A = uid(0xa)
const B = uid(0xb)
const C = uid(0xc)

function concept(id: string, overrides: Partial<Concept> = {}): Concept {
  return {
    id,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    title: `Title ${id.slice(-2)}`,
    summary: '',
    bodyMarkdown: `Body ${id.slice(-2)}`,
    tagIds: [],
    dependsOnIds: [],
    referenceIds: [],
    ...overrides,
  }
}

function documentWith(concepts: Concept[], hosts: ResourceDocument['hosts'] = []): ResourceDocument {
  return {
    schemaVersion: 2,
    revision: 1,
    hosts,
    tags: [],
    concepts,
    dataConnections: [],
    credentials: [],
    knownHostKeys: [],
  }
}

/**
 * The acceptance fixture: C depends on A and B; A and B both depend on D.
 *
 * `dependsOnIds` order is A then B on C, so stored order and id order agree —
 * the ordering tests below use a fixture where they disagree.
 */
function acceptanceDocument(): ResourceDocument {
  return documentWith([
    concept(D),
    concept(A, { dependsOnIds: [D] }),
    concept(B, { dependsOnIds: [D] }),
    concept(C, { dependsOnIds: [A, B] }),
  ])
}

function expectOk(result: ContextResolution) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`)
  return result
}

function expectError(result: ContextResolution) {
  if (result.ok) throw new Error('expected a resolution error')
  return result.error
}

describe('M5 contextResolver: acceptance fixture', () => {
  it('emits dependencies postorder, dedupes D, and keeps root marking', () => {
    const result = expectOk(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 1 }, { id: A, revision: 1 }] },
        acceptanceDocument(),
      ),
    )

    expect(result.concepts.map(entry => entry.title)).toEqual([
      'Title 0d',
      'Title 0a',
      'Title 0b',
      'Title 0c',
    ])
    expect(result.concepts.map(entry => entry.id)).toEqual([D, A, B, C])
    expect(result.concepts.map(entry => entry.includedAs)).toEqual([
      'dependency',
      'root',
      'dependency',
      'root',
    ])
    expect(result.concepts.map(entry => entry.depth)).toEqual([2, 1, 1, 0])
    // D appears exactly once even though both A and B depend on it.
    expect(result.concepts.filter(entry => entry.id === D)).toHaveLength(1)
  })

  it('marks an explicitly selected dependency entry as dependency-only', () => {
    // Same closure, roots [A] with C selected as a dependency entry: A keeps the
    // root marking because it was selected as a root, C is dependency-only.
    const result = expectOk(
      resolveContextSelection(
        { conceptRoots: [{ id: A, revision: 1 }], conceptDependencies: [{ id: C, revision: 1 }] },
        acceptanceDocument(),
      ),
    )

    expect(result.concepts.map(entry => entry.id)).toEqual([D, A, B, C])
    expect(result.concepts.map(entry => entry.includedAs)).toEqual([
      'dependency',
      'root',
      'dependency',
      'dependency',
    ])
  })

  it('selects roots in user order and never expands references', () => {
    const referenced = concept(uid(0xee), {
      title: 'Referenced',
      bodyMarkdown: 'REFERENCE-BODY-MUST-NOT-BE-INLINED',
    })
    const document = documentWith([
      concept(D),
      concept(A, { dependsOnIds: [D] }),
      concept(B, { dependsOnIds: [D] }),
      concept(C, { dependsOnIds: [A, B], referenceIds: [referenced.id] }),
      referenced,
    ])

    const rootsInReverseOrder = expectOk(
      resolveContextSelection(
        { conceptRoots: [{ id: A, revision: 1 }, { id: C, revision: 1 }] },
        document,
      ),
    )
    expect(rootsInReverseOrder.concepts.map(entry => entry.id)).toEqual([D, A, B, C])

    expect(rootsInReverseOrder.references).toEqual([
      { id: referenced.id, title: 'Referenced' },
    ])
    expect(Object.keys(rootsInReverseOrder.references[0]!)).toEqual(['id', 'title'])
    expect(rootsInReverseOrder.composedBlock).not.toContain('REFERENCE-BODY-MUST-NOT-BE-INLINED')
    expect(rootsInReverseOrder.composedBlock).toContain(`- Referenced (${referenced.id})`)
  })

  it('is deterministic across repeated runs and independent of node array order', () => {
    const forward = expectOk(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 1 }, { id: A, revision: 1 }] },
        acceptanceDocument(),
      ),
    )
    const repeated = expectOk(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 1 }, { id: A, revision: 1 }] },
        acceptanceDocument(),
      ),
    )
    const shuffled = expectOk(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 1 }, { id: A, revision: 1 }] },
        documentWith([...acceptanceDocument().concepts].reverse()),
      ),
    )

    expect(repeated.composedBlock).toBe(forward.composedBlock)
    expect(repeated.byteSize).toBe(forward.byteSize)
    expect(shuffled.concepts.map(entry => entry.id)).toEqual(forward.concepts.map(entry => entry.id))
  })

  it('emits siblings in stored dependsOnIds order, not id or title order', () => {
    // Stored order says B first, while B's id and title both sort after A's.
    const document = documentWith([
      concept(A, { title: 'AAA-first-if-sorted-by-title' }),
      concept(B, { title: 'ZZZ-first-if-sorted-by-title' }),
      concept(C, { dependsOnIds: [B, A] }),
    ])

    const result = expectOk(
      resolveContextSelection({ conceptRoots: [{ id: C, revision: 1 }] }, document),
    )
    expect(result.concepts.map(entry => entry.id)).toEqual([B, A, C])

    // The `id` order escape hatch is the only place a sort is allowed.
    const nodes: ConceptDependencyNode[] = document.concepts.map(entry => ({
      id: entry.id,
      dependsOnIds: entry.dependsOnIds,
      referenceIds: entry.referenceIds,
      title: entry.title,
    }))
    const idOrdered = resolveConceptClosure({ nodes, rootIds: [C], dependencyOrder: 'id' })
    expect(idOrdered.ok).toBe(true)
    if (idOrdered.ok) expect(idOrdered.entries.map(entry => entry.id)).toEqual([A, B, C])
  })
})

describe('M5 contextResolver: structured errors', () => {
  it('reports the full cycle path for a genuinely stored cycle', async () => {
    const document = documentWith([
      concept(A, { dependsOnIds: [C] }),
      concept(C, { dependsOnIds: [A] }),
    ])

    const error = expectError(
      resolveContextSelection({ conceptRoots: [{ id: C, revision: 1 }] }, document),
    )
    expect(error.code).toBe('CONCEPT_CYCLE')
    if (error.code !== 'CONCEPT_CYCLE') throw new Error('unreachable')
    expect(error.cycle).toEqual([C, A, C])
    expect(error.params.path).toBe(`${C} -> ${A} -> ${C}`)

    const closure = resolveConceptClosure({
      nodes: document.concepts.map(entry => ({
        id: entry.id,
        dependsOnIds: entry.dependsOnIds,
        referenceIds: entry.referenceIds,
        title: entry.title,
      })),
      rootIds: [C],
    })
    expect(closure).toEqual({ ok: false, cycle: [C, A, C] })
  })

  it('flags a missing root, a missing reference and a missing host', () => {
    const missingRoot = expectError(
      resolveContextSelection({ conceptRoots: [{ id: uid(0xff), revision: 1 }] }, acceptanceDocument()),
    )
    expect(missingRoot).toEqual({
      code: 'CONTEXT_RESOURCE_MISSING',
      params: { id: uid(0xff), kind: 'root' },
    })

    const danglingReference = documentWith([
      concept(C, { referenceIds: [uid(0xfe)] }),
    ])
    const missingReference = expectError(
      resolveContextSelection({ conceptRoots: [{ id: C, revision: 1 }] }, danglingReference),
    )
    expect(missingReference).toEqual({
      code: 'CONTEXT_RESOURCE_MISSING',
      params: { id: uid(0xfe), kind: 'reference' },
    })

    const missingHost = expectError(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 1 }], hostIds: [uid(0xfd)] },
        acceptanceDocument(),
      ),
    )
    expect(missingHost).toEqual({
      code: 'CONTEXT_RESOURCE_MISSING',
      params: { id: uid(0xfd), kind: 'host' },
    })
  })

  it('flags a revision that no longer matches the selected one', () => {
    const error = expectError(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 7 }] },
        acceptanceDocument(),
      ),
    )
    expect(error).toEqual({
      code: 'CONTEXT_REVISION_CHANGED',
      params: { id: C, expectedRevision: 7, actualRevision: 1 },
    })

    const dependencyError = expectError(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 1 }], conceptDependencies: [{ id: A, revision: 4 }] },
        acceptanceDocument(),
      ),
    )
    expect(dependencyError).toEqual({
      code: 'CONTEXT_REVISION_CHANGED',
      params: { id: A, expectedRevision: 4, actualRevision: 1 },
    })
  })

  it('blocks a chain deeper than 16 hops, and keeps the 16-hop chain working', () => {
    const chain = (length: number): Concept[] => {
      const ids = Array.from({ length: length + 1 }, (_, index) => uid(0x100 + index))
      return ids.map((id, index) =>
        concept(id, { dependsOnIds: index < ids.length - 1 ? [ids[index + 1]!] : [] }),
      )
    }

    const withinLimit = expectOk(
      resolveContextSelection({ conceptRoots: [{ id: uid(0x100), revision: 1 }] }, documentWith(chain(16))),
    )
    expect(withinLimit.concepts).toHaveLength(17)
    expect(Math.max(...withinLimit.concepts.map(entry => entry.depth))).toBe(16)

    const error = expectError(
      resolveContextSelection({ conceptRoots: [{ id: uid(0x100), revision: 1 }] }, documentWith(chain(17))),
    )
    expect(error.code).toBe('CONTEXT_LIMIT_EXCEEDED')
    if (error.code !== 'CONTEXT_LIMIT_EXCEEDED') throw new Error('unreachable')
    expect(error.limitName).toBe('depth')
    expect(error.params).toEqual({ limit: 16, actual: 17 })
    expect(error.sources).toEqual([
      {
        kind: 'concept',
        id: uid(0x111),
        title: 'Title 11',
        sizeBytes: utf8ByteLength('Title 11\nBody 11'),
        depth: 17,
      },
    ])
  })

  it('blocks more than 100 concepts, and keeps exactly 100 working', () => {
    const fanOut = (dependencyCount: number): ResourceDocument => {
      const dependencyIds = Array.from({ length: dependencyCount }, (_, index) => uid(0x200 + index))
      return documentWith([
        concept(uid(0x1ff), { dependsOnIds: dependencyIds }),
        ...dependencyIds.map(id => concept(id)),
      ])
    }

    const boundary = expectOk(
      resolveContextSelection(
        { conceptRoots: [{ id: uid(0x1ff), revision: 1 }] },
        fanOut(CONTEXT_LIMITS.maxConcepts - 1),
      ),
    )
    expect(boundary.concepts).toHaveLength(CONTEXT_LIMITS.maxConcepts)

    const error = expectError(
      resolveContextSelection(
        { conceptRoots: [{ id: uid(0x1ff), revision: 1 }] },
        fanOut(CONTEXT_LIMITS.maxConcepts),
      ),
    )
    expect(error.code).toBe('CONTEXT_LIMIT_EXCEEDED')
    if (error.code !== 'CONTEXT_LIMIT_EXCEEDED') throw new Error('unreachable')
    expect(error.limitName).toBe('concepts')
    expect(error.params).toEqual({ limit: 100, actual: 101 })
    expect(error.sources).toHaveLength(101)
    // Every source carries its own removable size.
    expect(error.sources.every(source => source.sizeBytes > 0)).toBe(true)
  })

  it('composes with hosts and blocks more than 20 of them', async () => {
    const hosts = Array.from({ length: CONTEXT_LIMITS.maxHosts + 1 }, (_, index) => ({
      id: uid(0x300 + index),
      revision: 1,
      createdAt: AT,
      updatedAt: AT,
      name: `Host ${index}`,
      address: `10.0.0.${index + 1}`,
      port: 22,
      username: 'root',
      auth: { type: 'password' as const, credentialId: null },
      tagIds: [],
      initialDirectory: null,
      applications: [],
      notes: '',
    }))

    const boundary = expectOk(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 1 }], hostIds: hosts.slice(0, 20).map(host => host.id) },
        documentWith([concept(C)], hosts),
      ),
    )
    expect(boundary.hosts).toHaveLength(20)
    expect(boundary.hosts[0]).toEqual({ id: hosts[0]!.id, name: 'Host 0', address: '10.0.0.1', port: 22 })

    const error = expectError(
      resolveContextSelection(
        { conceptRoots: [{ id: C, revision: 1 }], hostIds: hosts.map(host => host.id) },
        documentWith([concept(C)], hosts),
      ),
    )
    expect(error.code).toBe('CONTEXT_LIMIT_EXCEEDED')
    if (error.code !== 'CONTEXT_LIMIT_EXCEEDED') throw new Error('unreachable')
    expect(error.limitName).toBe('hosts')
    expect(error.params).toEqual({ limit: 20, actual: 21 })
    expect(error.sources).toHaveLength(21)
    expect(error.sources.every(source => source.kind === 'host')).toBe(true)
  })

  it('blocks a composed block over 64 KiB and reports the removable concepts', () => {
    const big = 'x'.repeat(40 * 1024)
    const document = documentWith([
      concept(C, { bodyMarkdown: big, dependsOnIds: [A] }),
      concept(A, { bodyMarkdown: big }),
    ])

    const error = expectError(
      resolveContextSelection({ conceptRoots: [{ id: C, revision: 1 }] }, document),
    )
    expect(error.code).toBe('CONTEXT_LIMIT_EXCEEDED')
    if (error.code !== 'CONTEXT_LIMIT_EXCEEDED') throw new Error('unreachable')
    expect(error.limitName).toBe('bytes')
    expect(error.params.limit).toBe(64 * 1024)
    expect(error.params.actual).toBeGreaterThan(64 * 1024)
    expect(error.sources.map(source => source.id).sort()).toEqual([A, C].sort())

    // Under the limit the whole block is composed, never truncated.
    const small = documentWith([
      concept(C, { bodyMarkdown: 'x'.repeat(30 * 1024), dependsOnIds: [A] }),
      concept(A, { bodyMarkdown: 'x'.repeat(30 * 1024) }),
    ])
    const ok = expectOk(
      resolveContextSelection({ conceptRoots: [{ id: C, revision: 1 }] }, small),
    )
    expect(ok.byteSize).toBeLessThanOrEqual(64 * 1024)
    expect(ok.composedBlock).toContain('x'.repeat(1024))
  })
})

describe('M5 contextResolver: repository-backed resolver', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-context-resolver-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('reads the library through the store and re-reads after a write', async () => {
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const resolver = createContextResolver({ store })

    const stored = await store.transact<null>({
      mutate: draft => {
        draft.concepts = [
          concept(A, { dependsOnIds: [D] }),
          concept(D),
          concept(B, { dependsOnIds: [D] }),
          concept(C, { dependsOnIds: [A, B] }),
        ]
        return { commit: true, value: null }
      },
    })
    expect(stored.status).toBe('committed')
    expect(stored.status === 'committed' && stored.document.concepts).toHaveLength(4)

    const first = await resolver.resolve({
      conceptRoots: [{ id: C, revision: 1 }, { id: A, revision: 1 }],
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.concepts.map(entry => entry.id)).toEqual([D, A, B, C])

    // Bump C's revision directly in the stored document; the resolver must see
    // the new revision rather than a cached one.
    const bumped = await store.transact<null>({
      mutate: draft => {
        draft.concepts = draft.concepts.map(entry =>
          entry.id === C ? { ...entry, revision: 2, summary: 'edited' } : entry,
        )
        return { commit: true, value: null }
      },
    })
    expect(bumped.status).toBe('committed')

    const stale = await resolver.resolve({ conceptRoots: [{ id: C, revision: 1 }] })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error).toEqual({
      code: 'CONTEXT_REVISION_CHANGED',
      params: { id: C, expectedRevision: 1, actualRevision: 2 },
    })

    const fresh = await resolver.resolve({ conceptRoots: [{ id: C, revision: 2 }] })
    expect(fresh.ok).toBe(true)
  })
})
