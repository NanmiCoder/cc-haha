import { create } from 'zustand'
import type { Concept, ResourceTag } from '../types/resourceTypes.js'
import type {
  CreateConceptInput,
  HostManagementError,
  HostManagementErrorReference,
  UpdateConceptInput,
} from '../api/hostManagementApi.js'
import { getDesktopHost } from '../../../lib/desktopHost/index.js'

/** Concept-namespace tags; the host tag modal never loads these. */
export const CONCEPT_TAG_NAMESPACE = 'concept' as const

export type ConceptDeleteBlocked = {
  conceptId: string
  /** Real referrers, enriched by the main process (title, not a bare id). */
  references: HostManagementErrorReference[]
  /**
   * True when the only blocking edges are `referenceIds`, which
   * `deleteConcept(id, revision, true)` is allowed to remove. A `dependsOnIds`
   * edge is never removable from here.
   */
  canRemoveReferenceEdges: boolean
}

export type ConceptKnowledgeState = {
  concepts: Concept[]
  tags: ResourceTag[]
  selectedConceptId: string | null
  searchQuery: string
  loading: boolean
  saving: boolean
  error: HostManagementError | null
  deleteBlocked: ConceptDeleteBlocked | null

  filteredConcepts: () => Concept[]
  selectedConcept: () => Concept | null
  tagsFor: (tagIds: string[]) => ResourceTag[]

  setSearchQuery: (query: string) => void
  setSelectedConceptId: (conceptId: string | null) => void
  clearError: () => void
  dismissDeleteBlocked: () => void

  fetchConcepts: () => Promise<void>
  fetchTags: () => Promise<void>
  createTag: (name: string) => Promise<{ success: true; tag: ResourceTag } | { success: false; error: HostManagementError }>
  saveConcept: (
    input: CreateConceptInput | UpdateConceptInput,
  ) => Promise<{ success: true; concept: Concept } | { success: false; error: HostManagementError }>
  deleteConcept: (
    id: string,
    expectedRevision: number,
    removeReferenceEdges?: boolean,
  ) => Promise<{ success: boolean; error?: HostManagementError }>
}

export const useConceptKnowledgeStore = create<ConceptKnowledgeState>((set, get) => ({
  concepts: [],
  tags: [],
  selectedConceptId: null,
  searchQuery: '',
  loading: false,
  saving: false,
  error: null,
  deleteBlocked: null,

  filteredConcepts: () => {
    const { concepts, tags, searchQuery } = get()
    const query = searchQuery.trim().toLowerCase()
    if (!query) return concepts
    return concepts.filter((concept) => {
      if (concept.title.toLowerCase().includes(query)) return true
      if (concept.summary.toLowerCase().includes(query)) return true
      if (concept.bodyMarkdown.toLowerCase().includes(query)) return true
      return tags
        .filter((tag) => concept.tagIds.includes(tag.id))
        .some((tag) => tag.name.toLowerCase().includes(query))
    })
  },

  selectedConcept: () => {
    const { concepts, selectedConceptId } = get()
    if (!selectedConceptId) return null
    return concepts.find((concept) => concept.id === selectedConceptId) ?? null
  },

  tagsFor: (tagIds) => {
    const { tags } = get()
    return tags.filter((tag) => tagIds.includes(tag.id))
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedConceptId: (conceptId) => set({ selectedConceptId: conceptId }),
  clearError: () => set({ error: null }),
  dismissDeleteBlocked: () => set({ deleteBlocked: null }),

  fetchConcepts: async () => {
    set({ loading: true, error: null })
    const desktop = getDesktopHost()
    const result = await desktop.conceptKnowledge.listConcepts()
    if (!result.ok) {
      set({ loading: false, error: result.error })
      return
    }
    const { selectedConceptId } = get()
    set({
      concepts: result.data,
      loading: false,
      selectedConceptId:
        selectedConceptId && result.data.some((concept) => concept.id === selectedConceptId)
          ? selectedConceptId
          : null,
    })
  },

  fetchTags: async () => {
    const desktop = getDesktopHost()
    const result = await desktop.hostManagement.listTags(CONCEPT_TAG_NAMESPACE)
    if (!result.ok) {
      set({ error: result.error })
      return
    }
    set({ tags: result.data.filter((tag) => tag.namespace === CONCEPT_TAG_NAMESPACE) })
  },

  createTag: async (name) => {
    const desktop = getDesktopHost()
    const result = await desktop.hostManagement.saveTag({
      mode: 'create',
      namespace: CONCEPT_TAG_NAMESPACE,
      name,
      colorToken: null,
    })
    if (!result.ok) {
      set({ error: result.error })
      return { success: false as const, error: result.error }
    }
    const tag = result.data
    set((state) => ({
      tags: state.tags.some((existing) => existing.id === tag.id)
        ? state.tags
        : [...state.tags, tag],
    }))
    return { success: true as const, tag }
  },

  saveConcept: async (input) => {
    set({ saving: true, error: null })
    const desktop = getDesktopHost()
    const result = await desktop.conceptKnowledge.saveConcept(input)
    if (!result.ok) {
      set({ saving: false, error: result.error })
      return { success: false as const, error: result.error }
    }
    const saved = result.data
    set((state) => ({
      saving: false,
      concepts: state.concepts.some((concept) => concept.id === saved.id)
        ? state.concepts.map((concept) => (concept.id === saved.id ? saved : concept))
        : [...state.concepts, saved],
      selectedConceptId: saved.id,
      error: null,
    }))
    return { success: true as const, concept: saved }
  },

  deleteConcept: async (id, expectedRevision, removeReferenceEdges) => {
    set({ saving: true, error: null })
    const desktop = getDesktopHost()
    const result = await desktop.conceptKnowledge.deleteConcept(id, expectedRevision, removeReferenceEdges)
    if (!result.ok) {
      const blockedReferences = result.error.references ?? []
      const isBlocked = result.error.code === 'RESOURCE_IN_USE' && blockedReferences.length > 0
      set({
        saving: false,
        error: result.error,
        deleteBlocked: isBlocked
          ? {
              conceptId: id,
              references: blockedReferences,
              canRemoveReferenceEdges: !blockedReferences.some(
                (reference) => reference.description === 'dependsOnIds',
              ),
            }
          : null,
      })
      return { success: false as const, error: result.error }
    }
    set((state) => ({
      saving: false,
      concepts: state.concepts.filter((concept) => concept.id !== id),
      selectedConceptId: state.selectedConceptId === id ? null : state.selectedConceptId,
      error: null,
      deleteBlocked: null,
    }))
    return { success: true as const }
  },
}))
