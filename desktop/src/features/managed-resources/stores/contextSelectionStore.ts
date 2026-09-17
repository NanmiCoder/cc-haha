/**
 * M6-A context selection controller — the ONE state model both composers use.
 *
 * The Home composer (`EmptySession`) and the Chat composer (`ChatInput`) each
 * render their own buttons, but they read and write this single store: one
 * picker, one selection, one highlight index. Two state machines would let the
 * two surfaces disagree about what is selected.
 *
 * The selected id set is never stored. `resolvedIds()` re-derives it on every
 * read from the live sources (a source tag expands to its current members, plus
 * the direct ids), so removing one source can never drop an id that another
 * source still contributes.
 */
import { create } from 'zustand'
import type {
  Concept,
  DataConnection,
  ConversationContextSelectionV2,
  Host,
  ResourceTag,
  SourceTag as ConversationSourceTag,
  TagNamespace,
} from '../types/resourceTypes.js'
import type { HostManagementError } from '../api/hostManagementApi.js'
import {
  isConceptKnowledgeSupported,
  isDataConnectionsSupported,
  isHostManagementSupported,
} from '../api/desktopHostCapabilities.js'
import { getDesktopHost } from '../../../lib/desktopHost/index.js'
import {
  createDraftToken,
  migrateDraftToSession,
  type DirectId,
  type PickResult,
  type SourceTag,
} from '../composer/contextPicker.js'

/** All four M9 context picker resource surfaces. */
export type ContextKind = 'host' | 'concept' | 'database' | 'redis'

/** A draft belongs to no session yet; a session pick belongs to one session. */
export type ContextScope = 'draft' | 'session'

export type ContextUnavailableCommand = 'db' | 'rd'

export type ResolvedContextIds = {
  host: string[]
  concept: string[]
  database: string[]
  redis: string[]
  /** Compatibility aggregation retained for M6 queue snapshots. */
  dataConnection: string[]
}

export type ContextSelectionCatalog = {
  hosts: Host[]
  concepts: Concept[]
  dataConnections: DataConnection[]
  hostTags: ResourceTag[]
  conceptTags: ResourceTag[]
  databaseTags: ResourceTag[]
  redisTags: ResourceTag[]
}

export const EMPTY_CONTEXT_CATALOG: ContextSelectionCatalog = {
  hosts: [],
  concepts: [],
  dataConnections: [],
  hostTags: [],
  conceptTags: [],
  databaseTags: [],
  redisTags: [],
}

export type ContextPickerTagOption = {
  kind: 'tag'
  tag: SourceTag
  label: string
  memberIds: string[]
  selected: boolean
}

export type ContextPickerResourceOption = {
  kind: 'resource'
  id: DirectId
  label: string
  /** Address / summary — shown next to a host or concept name. */
  hint: string
  selected: boolean
}

export type ContextPickerOption = ContextPickerTagOption | ContextPickerResourceOption

/** Deep copy handed to the send path in M6-B; mutating it cannot touch the store. */
export type ContextSelectionSnapshot = {
  draftId: string
  scope: ContextScope
  sessionId: string | null
  includePasswords: boolean
  sourceTags: Array<SourceTag & { label: string; memberIds: string[] }>
  directIds: DirectId[]
  resolved: ResolvedContextIds
}

function sameSourceTag(a: SourceTag, b: SourceTag): boolean {
  return a.namespace === b.namespace && a.id === b.id
}

function sameDirectId(a: DirectId, b: DirectId): boolean {
  return a.namespace === b.namespace && a.id === b.id
}

/** Locale-independent, deterministic ordering (never `localeCompare`). */
function uniqueSorted(ids: Iterable<string>): string[] {
  const unique = [...new Set(ids)]
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return unique
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

function matchesQuery(query: string, ...fields: string[]): boolean {
  if (!query) return true
  return fields.some((field) => field.toLowerCase().includes(query))
}

/** Members a source tag contributes right now, read from the live catalog. */
export function tagMemberIds(tag: SourceTag, catalog: ContextSelectionCatalog): string[] {
  if (tag.namespace === 'host') {
    return catalog.hosts.filter((host) => host.tagIds.includes(tag.id)).map((host) => host.id)
  }
  if (tag.namespace === 'concept') {
    return catalog.concepts.filter((concept) => concept.tagIds.includes(tag.id)).map((concept) => concept.id)
  }
  return catalog.dataConnections
    .filter((connection) => connection.kind === tag.namespace && connection.tagIds.includes(tag.id))
    .map((connection) => connection.id)
}

function directIdsByKind(pick: PickResult): ResolvedContextIds {
  const host: string[] = []
  const concept: string[] = []
  const database: string[] = []
  const redis: string[] = []
  for (const direct of pick.directIds) {
    if (direct.namespace === 'host') host.push(direct.id)
    else if (direct.namespace === 'concept') concept.push(direct.id)
    else if (direct.namespace === 'database') database.push(direct.id)
    else redis.push(direct.id)
  }
  return { host, concept, database, redis, dataConnection: [...database, ...redis] }
}

/**
 * The derived set. Pure function of (sources, catalog) — never a stored set, so
 * an id kept alive by any remaining source survives removing another one.
 */
export function deriveResolvedIds(
  pick: PickResult,
  catalog: ContextSelectionCatalog,
): ResolvedContextIds {
  const host: string[] = []
  const concept: string[] = []
  const database: string[] = []
  const redis: string[] = []
  for (const tag of pick.sourceTags) {
    if (tag.namespace === 'host') host.push(...tagMemberIds(tag, catalog))
    else if (tag.namespace === 'concept') concept.push(...tagMemberIds(tag, catalog))
    else if (tag.namespace === 'database') database.push(...tagMemberIds(tag, catalog))
    else redis.push(...tagMemberIds(tag, catalog))
  }
  const direct = directIdsByKind(pick)
  host.push(...direct.host)
  concept.push(...direct.concept)
  database.push(...direct.database)
  redis.push(...direct.redis)
  const resolvedDatabase = uniqueSorted(database)
  const resolvedRedis = uniqueSorted(redis)
  return {
    host: uniqueSorted(host),
    concept: uniqueSorted(concept),
    database: resolvedDatabase,
    redis: resolvedRedis,
    dataConnection: uniqueSorted([...resolvedDatabase, ...resolvedRedis]),
  }
}

function tagsForKind(kind: ContextKind, catalog: ContextSelectionCatalog): ResourceTag[] {
  if (kind === 'host') return catalog.hostTags
  if (kind === 'concept') return catalog.conceptTags
  if (kind === 'database') return catalog.databaseTags
  return catalog.redisTags
}

function tagLabel(tag: SourceTag, catalog: ContextSelectionCatalog): string {
  return tagsForKind(tag.namespace, catalog).find((candidate) => candidate.id === tag.id)?.name ?? tag.id
}

function resourcesForKind(kind: ContextKind, catalog: ContextSelectionCatalog): Array<Host | Concept | DataConnection> {
  if (kind === 'host') return catalog.hosts
  if (kind === 'concept') return catalog.concepts
  return catalog.dataConnections.filter((connection) => connection.kind === kind)
}

function resourceLabel(kind: ContextKind, source: Host | Concept | DataConnection): string {
  if (kind === 'host') return (source as Host).name
  if (kind === 'concept') return (source as Concept).title
  return (source as DataConnection).name
}

function resourceHint(kind: ContextKind, source: Host | Concept | DataConnection): string {
  if (kind === 'host') return (source as Host).address
  if (kind === 'concept') return (source as Concept).summary
  const connection = source as DataConnection
  return `${connection.address}:${connection.port}`
}

function versionedConceptSelection(
  resolvedConceptIds: string[],
  concepts: Concept[],
): { roots: Array<{ id: string; revision: number }>; dependencies: Array<{ id: string; revision: number }> } {
  const byId = new Map(concepts.map(concept => [concept.id, concept]))
  const rootSet = new Set(resolvedConceptIds)
  const dependencies: Array<{ id: string; revision: number }> = []
  const emitted = new Set<string>()
  const visiting = new Set<string>()

  const visit = (id: string): void => {
    if (emitted.has(id) || visiting.has(id)) return
    const concept = byId.get(id)
    if (!concept) return
    visiting.add(id)
    for (const dependencyId of concept.dependsOnIds) visit(dependencyId)
    visiting.delete(id)
    emitted.add(id)
    if (!rootSet.has(id)) dependencies.push({ id, revision: concept.revision })
  }
  for (const rootId of resolvedConceptIds) visit(rootId)

  return {
    roots: resolvedConceptIds
      .map(id => byId.get(id))
      .filter((concept): concept is Concept => Boolean(concept))
      .map(concept => ({ id: concept.id, revision: concept.revision })),
    dependencies,
  }
}

function emptyPick(): PickResult {
  return { sourceTags: [], directIds: [], draftId: createDraftToken() }
}

export type ContextSelectionState = {
  scope: ContextScope
  sessionId: string | null
  pick: PickResult
  catalog: ContextSelectionCatalog
  catalogLoading: boolean
  catalogError: HostManagementError | null
  includePasswords: boolean

  /** Open picker surface: `null` when the popover is closed. */
  pickerKind: ContextKind | null
  /** `/db` `/rd` empty state — set instead of `pickerKind`. */
  unavailableCommand: ContextUnavailableCommand | null
  pickerFilter: string
  highlightedIndex: number

  // Derived reads
  resolvedIds: () => ResolvedContextIds
  memberIdsForTag: (tag: SourceTag) => string[]
  labelForTag: (tag: SourceTag) => string
  selectedCount: (kind: ContextKind) => number
  hasSelection: () => boolean
  options: () => ContextPickerOption[]
  snapshot: () => ContextSelectionSnapshot
  toConversationContextSelection: () => ConversationContextSelectionV2

  // Selection actions
  setScope: (scope: ContextScope, sessionId: string | null) => void
  setCatalog: (catalog: ContextSelectionCatalog) => void
  loadCatalog: () => Promise<void>
  addSourceTag: (tag: SourceTag) => void
  removeSourceTag: (tag: SourceTag) => void
  addDirectId: (id: DirectId) => void
  removeDirectId: (id: DirectId) => void
  toggleOption: (option: ContextPickerOption) => void
  setIncludePasswords: (include: boolean) => void
  clearSelection: () => void
  /** Draft → session move in one atomic state update. */
  migrateToSession: (sessionId: string) => void

  // Picker UI
  openPicker: (kind: ContextKind) => void
  openUnavailable: (command: ContextUnavailableCommand) => void
  setPickerFilter: (filter: string) => void
  setHighlightedIndex: (index: number) => void
  moveHighlight: (delta: number) => void
  closePicker: () => void
}

export const useContextSelectionStore = create<ContextSelectionState>((set, get) => ({
  scope: 'draft',
  sessionId: null,
  pick: emptyPick(),
  catalog: EMPTY_CONTEXT_CATALOG,
  catalogLoading: false,
  catalogError: null,
  includePasswords: false,

  pickerKind: null,
  unavailableCommand: null,
  pickerFilter: '',
  highlightedIndex: 0,

  resolvedIds: () => deriveResolvedIds(get().pick, get().catalog),

  memberIdsForTag: (tag) => tagMemberIds(tag, get().catalog),

  labelForTag: (tag) => tagLabel(tag, get().catalog),

  selectedCount: (kind) => get().resolvedIds()[kind].length,

  hasSelection: () => {
    const { pick } = get()
    return pick.sourceTags.length > 0 || pick.directIds.length > 0
  },

  options: () => {
    const { pickerKind, pickerFilter, pick, catalog } = get()
    if (!pickerKind) return []
    const query = normalizeQuery(pickerFilter)

    const tags = tagsForKind(pickerKind, catalog)
    const tagOptions: ContextPickerOption[] = tags
      .filter((tag) => matchesQuery(query, tag.name))
      .map((tag) => {
        const source: SourceTag = { namespace: pickerKind, id: tag.id }
        return {
          kind: 'tag' as const,
          tag: source,
          label: tag.name,
          memberIds: tagMemberIds(source, catalog),
          selected: pick.sourceTags.some((selected) => sameSourceTag(selected, source)),
        }
      })

    const resources = resourcesForKind(pickerKind, catalog)
    const resourceOptions: ContextPickerOption[] = resources
      .filter((resource) => matchesQuery(query, resourceLabel(pickerKind, resource), resourceHint(pickerKind, resource)))
      .map((resource) => {
        const id: DirectId = { namespace: pickerKind, id: resource.id }
        return {
          kind: 'resource' as const,
          id,
          label: resourceLabel(pickerKind, resource),
          hint: resourceHint(pickerKind, resource),
          selected: pick.directIds.some((selected) => sameDirectId(selected, id)),
        }
      })

    return [...tagOptions, ...resourceOptions]
  },

  snapshot: () => {
    const { pick, scope, sessionId, catalog, includePasswords } = get()
    const sources = pick.sourceTags.map((tag) => ({
      namespace: tag.namespace,
      id: tag.id,
      label: tagLabel(tag, catalog),
      memberIds: [...tagMemberIds(tag, catalog)],
    }))
    const directs = pick.directIds.map((id) => ({ namespace: id.namespace, id: id.id }))
    const resolved = deriveResolvedIds(pick, catalog)
    return {
      draftId: pick.draftId,
      scope,
      sessionId,
      includePasswords,
      sourceTags: sources,
      directIds: directs,
      resolved: {
        host: [...resolved.host],
        concept: [...resolved.concept],
        database: [...resolved.database],
        redis: [...resolved.redis],
        dataConnection: [...resolved.dataConnection],
      },
    }
  },

  toConversationContextSelection: () => {
    const { pick, catalog, includePasswords } = get()
    const sourceTags: ConversationSourceTag[] = pick.sourceTags.map((tag) => ({
      namespace: tag.namespace as TagNamespace,
      id: tag.id,
      labelAtSelection: tagLabel(tag, catalog),
      memberIds: [...tagMemberIds(tag, catalog)],
    }))
    const direct = directIdsByKind(pick)
    const resolved = deriveResolvedIds(pick, catalog)
    const hostById = new Map(catalog.hosts.map(host => [host.id, host]))
    const concepts = versionedConceptSelection(resolved.concept, catalog.concepts)
    const connectionById = new Map(catalog.dataConnections.map(connection => [connection.id, connection]))
    const refsFor = (ids: string[]) => ids
      .map(id => connectionById.get(id))
      .filter((connection): connection is DataConnection => Boolean(connection))
      .map(connection => ({ id: connection.id, revision: connection.revision }))
    return {
      schemaVersion: 2,
      hostRefs: resolved.host
        .map(id => hostById.get(id))
        .filter((host): host is Host => Boolean(host))
        .map(host => ({ id: host.id, revision: host.revision })),
      conceptRootRefs: concepts.roots,
      dependencyRefs: concepts.dependencies,
      databaseRefs: refsFor(resolved.database),
      redisRefs: refsFor(resolved.redis),
      credentialRefs: [],
      sourceTags,
      directHostIds: direct.host,
      directConceptIds: direct.concept,
      directDatabaseIds: direct.database,
      directRedisIds: direct.redis,
      includePasswords,
    }
  },

  setScope: (scope, sessionId) => {
    const current = get()
    if (current.scope === scope && current.sessionId === sessionId) return
    // A pick belongs to one conversation. Moving from one real session to
    // another must start empty: keeping the previous pick would let the next
    // message in the new session stage the old session's host/concept
    // selection, which nothing downstream can detect (the ticket would be
    // staged for the new session with a fresh requestId and a valid revision).
    // Draft <-> session moves keep the pick: that is the documented M6
    // "one controller" migration, not a session switch.
    const switchedSessions =
      current.sessionId !== null && sessionId !== null && current.sessionId !== sessionId
    set(switchedSessions ? { scope, sessionId, pick: emptyPick(), includePasswords: false } : { scope, sessionId })
  },

  setCatalog: (catalog) => set({ catalog }),

  loadCatalog: async () => {
    const desktop = getDesktopHost()
    if (
      !isHostManagementSupported(desktop)
      || !isConceptKnowledgeSupported(desktop)
      || !isDataConnectionsSupported(desktop)
    ) {
      set({ catalogLoading: false, catalogError: null })
      return
    }
    set({ catalogLoading: true, catalogError: null })
    const [hosts, concepts, dataConnections, hostTags, conceptTags, databaseTags, redisTags] = await Promise.all([
      desktop.hostManagement.listHosts(),
      desktop.conceptKnowledge.listConcepts(),
      desktop.dataConnections.list(),
      desktop.hostManagement.listTags('host'),
      desktop.hostManagement.listTags('concept'),
      desktop.hostManagement.listTags('database'),
      desktop.hostManagement.listTags('redis'),
    ])
    const failure = [hosts, concepts, dataConnections, hostTags, conceptTags, databaseTags, redisTags]
      .find((result) => !result.ok)
    if (failure && !failure.ok) {
      set({ catalogLoading: false, catalogError: failure.error })
      return
    }
    if (
      !hosts.ok || !concepts.ok || !dataConnections.ok
      || !hostTags.ok || !conceptTags.ok || !databaseTags.ok || !redisTags.ok
    ) return
    set({
      catalogLoading: false,
      catalogError: null,
      catalog: {
        hosts: hosts.data,
        concepts: concepts.data,
        dataConnections: dataConnections.data,
        hostTags: hostTags.data,
        conceptTags: conceptTags.data,
        databaseTags: databaseTags.data,
        redisTags: redisTags.data,
      },
    })
  },

  addSourceTag: (tag) => {
    set((state) => ({
      pick: state.pick.sourceTags.some((existing) => sameSourceTag(existing, tag))
        ? state.pick
        : { ...state.pick, sourceTags: [...state.pick.sourceTags, tag] },
    }))
  },

  removeSourceTag: (tag) => {
    set((state) => {
      const pick = { ...state.pick, sourceTags: state.pick.sourceTags.filter((existing) => !sameSourceTag(existing, tag)) }
      return {
        pick,
        ...(pick.sourceTags.length === 0 && pick.directIds.length === 0 ? { includePasswords: false } : {}),
      }
    })
  },

  addDirectId: (id) => {
    set((state) => ({
      pick: state.pick.directIds.some((existing) => sameDirectId(existing, id))
        ? state.pick
        : { ...state.pick, directIds: [...state.pick.directIds, id] },
    }))
  },

  removeDirectId: (id) => {
    set((state) => {
      const pick = { ...state.pick, directIds: state.pick.directIds.filter((existing) => !sameDirectId(existing, id)) }
      return {
        pick,
        ...(pick.sourceTags.length === 0 && pick.directIds.length === 0 ? { includePasswords: false } : {}),
      }
    })
  },

  toggleOption: (option) => {
    const store = get()
    if (option.kind === 'tag') {
      if (option.selected) store.removeSourceTag(option.tag)
      else store.addSourceTag(option.tag)
      return
    }
    if (option.selected) store.removeDirectId(option.id)
    else store.addDirectId(option.id)
  },

  setIncludePasswords: (include) => set({ includePasswords: include }),

  clearSelection: () => set({ pick: emptyPick(), includePasswords: false, highlightedIndex: 0 }),

  migrateToSession: (sessionId) => {
    // One `set` call: the scope, the session and the validated pick move
    // together, so no render can observe a session-scoped empty draft.
    set((state) => {
      const result = migrateDraftToSession(state.pick, sessionId)
      return {
        scope: 'session' as ContextScope,
        sessionId,
        pick: result.kind === 'migrated' ? result.pick : state.pick,
      }
    })
  },

  openPicker: (kind) => set({ pickerKind: kind, unavailableCommand: null, pickerFilter: '', highlightedIndex: 0 }),
  openUnavailable: (command) => set({ pickerKind: null, unavailableCommand: command, pickerFilter: '', highlightedIndex: 0 }),
  setPickerFilter: (filter) => set({ pickerFilter: filter, highlightedIndex: 0 }),
  setHighlightedIndex: (index) => set({ highlightedIndex: Math.max(0, index) }),
  moveHighlight: (delta) => {
    const total = get().options().length
    if (total === 0) {
      set({ highlightedIndex: 0 })
      return
    }
    const current = get().highlightedIndex
    set({ highlightedIndex: (current + delta + total) % total })
  },
  closePicker: () => set({ pickerKind: null, unavailableCommand: null, pickerFilter: '', highlightedIndex: 0 }),
}))

/** Back to the initial, empty controller — used by tests, never a partial reset. */
export function resetContextSelectionStore(): void {
  useContextSelectionStore.setState({
    scope: 'draft',
    sessionId: null,
    pick: emptyPick(),
    catalog: EMPTY_CONTEXT_CATALOG,
    catalogLoading: false,
    catalogError: null,
    includePasswords: false,
    pickerKind: null,
    unavailableCommand: null,
    pickerFilter: '',
    highlightedIndex: 0,
  })
}
