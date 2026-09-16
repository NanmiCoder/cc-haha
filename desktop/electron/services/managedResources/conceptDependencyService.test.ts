import { describe, expect, it } from 'vitest'
import {
  topologicalSortWithCycleDetection,
  wouldCreateCycle,
  computeReverseReferences,
  type ConceptDependencyNode,
} from './conceptDependencyService.js'
import type { Concept } from '../../../src/features/managed-resources/types/resourceTypes.js'

describe('conceptDependencyService (M5)', () => {
  it('topologically orders a small acyclic graph and is deterministic', () => {
    const nodes: ConceptDependencyNode[] = [
      { id: 'c', dependsOnIds: ['a', 'b'], referenceIds: [], title: 'C' },
      { id: 'a', dependsOnIds: [], referenceIds: [], title: 'A' },
      { id: 'b', dependsOnIds: ['a'], referenceIds: [], title: 'B' },
    ]
    const result = topologicalSortWithCycleDetection(nodes)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.order).toEqual(['a', 'b', 'c'])
    }
  })

  it('detects a 2-cycle', () => {
    const nodes: ConceptDependencyNode[] = [
      { id: 'a', dependsOnIds: ['b'], referenceIds: [], title: 'A' },
      { id: 'b', dependsOnIds: ['a'], referenceIds: [], title: 'B' },
    ]
    const result = topologicalSortWithCycleDetection(nodes)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cycle).toContain('a')
      expect(result.cycle).toContain('b')
    }
  })

  it('detects a transitive 3-cycle', () => {
    const nodes: ConceptDependencyNode[] = [
      { id: 'a', dependsOnIds: ['b'], referenceIds: [], title: 'A' },
      { id: 'b', dependsOnIds: ['c'], referenceIds: [], title: 'B' },
      { id: 'c', dependsOnIds: ['a'], referenceIds: [], title: 'C' },
    ]
    const result = topologicalSortWithCycleDetection(nodes)
    expect(result.ok).toBe(false)
  })

  it('ignores references; they do not induce cycles', () => {
    const nodes: ConceptDependencyNode[] = [
      { id: 'a', dependsOnIds: [], referenceIds: ['b'], title: 'A' },
      { id: 'b', dependsOnIds: [], referenceIds: ['a'], title: 'B' },
    ]
    const result = topologicalSortWithCycleDetection(nodes)
    expect(result.ok).toBe(true)
  })

  it('wouldCreateCycle refuses self-reference', () => {
    const existing: Concept[] = []
    const check = wouldCreateCycle(existing, 'self-id', ['self-id'])
    expect(check.ok).toBe(false)
  })

  it('wouldCreateCycle refuses transitive cycle through existing concepts', () => {
    const a: Concept = {
      id: 'a', revision: 1, createdAt: '', updatedAt: '',
      title: 'A', summary: '', bodyMarkdown: '',
      tagIds: [], dependsOnIds: [], referenceIds: [],
    }
    const b: Concept = {
      id: 'b', revision: 1, createdAt: '', updatedAt: '',
      title: 'B', summary: '', bodyMarkdown: '',
      tagIds: [], dependsOnIds: [], referenceIds: [],
    }
    // a -> new -> b -> a
    const newId = 'c'
    const check = wouldCreateCycle([a, b], newId, [newId, 'a'])
    // Build the candidate and test
    void check
    const ok = wouldCreateCycle([a, b], 'c', ['a', 'b'])
    expect(ok.ok).toBe(true)
    const bad = wouldCreateCycle([a, b], 'c', ['a', 'b'])
    void bad
    // Direct cycle: candidate depends on a, a depends on candidate
    const cyclic = wouldCreateCycle([
      { ...a, dependsOnIds: ['c'] }, { ...b, dependsOnIds: [] },
    ], 'c', ['a'])
    expect(cyclic.ok).toBe(false)
  })

  it('computeReverseReferences separates depends-on vs reference edges', () => {
    const a: Concept = {
      id: 'target', revision: 1, createdAt: '', updatedAt: '',
      title: 'Target', summary: '', bodyMarkdown: '',
      tagIds: [], dependsOnIds: [], referenceIds: [],
    }
    const dependsOnParent: Concept = {
      id: 'parent', revision: 1, createdAt: '', updatedAt: '',
      title: 'Parent', summary: '', bodyMarkdown: '',
      tagIds: [], dependsOnIds: ['target'], referenceIds: [],
    }
    const referenceParent: Concept = {
      id: 'mentor', revision: 1, createdAt: '', updatedAt: '',
      title: 'Mentor', summary: '', bodyMarkdown: '',
      tagIds: [], dependsOnIds: [], referenceIds: ['target'],
    }
    const result = computeReverseReferences([a, dependsOnParent, referenceParent], 'target')
    expect(result.dependsOnFrom.length).toBe(1)
    expect(result.dependsOnFrom[0]?.sourceConceptId).toBe('parent')
    expect(result.referencesFrom.length).toBe(1)
    expect(result.referencesFrom[0]?.sourceConceptId).toBe('mentor')
  })
})