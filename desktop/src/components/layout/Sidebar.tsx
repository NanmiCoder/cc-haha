import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Download, Folder, FolderOpen, MoreHorizontal, Pin, PinOff, RefreshCw, RotateCcw, SquarePen, Trash2, Upload, X } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { GlobalSearchModal } from '../search/GlobalSearchModal'
import { Skeleton } from '../shared/Skeleton'
import { Tooltip } from '../shared/Tooltip'
import type { SessionListItem } from '../../types/session'
import { useTabStore, SETTINGS_TAB_ID, SCHEDULED_TAB_ID } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { desktopUiPreferencesApi, type SidebarProjectPreferences } from '../../api/desktopUiPreferences'
import { getDesktopHost } from '../../lib/desktopHost'
import { publicAssetPath } from '../../lib/publicAsset'
import {
  type SidebarProjectOrganization,
  type SidebarProjectSortBy,
  type ProjectGroup,
  PROJECT_GROUP_SCROLL_COUNT,
  groupByProject,
  applyProjectOrder,
  moveProjectKey,
  getProjectDropPosition,
  readStoredProjectOrder,
  readStoredProjectPins,
  readStoredProjectHidden,
  readStoredProjectOrganization,
  readStoredProjectSortBy,
  buildSidebarProjectPreferences,
  readCachedSidebarProjectPreferences,
  writeCachedSidebarProjectPreferences,
  normalizeSidebarProjectPreferences,
  projectPathMatches,
  hasSidebarProjectPreferences,
  getVisibleProjectSessions,
  isWorktreeSession,
  domSafeProjectKey,
  positionProjectMenu,
  isDocumentVisible,
} from './sidebarUtils'
import { projectsApi } from '../../api/projects'
import {
  GitHubIcon,
  PlusIcon,
  ClockIcon,
  SearchIcon,
  SidebarToggleIcon,
  ProjectHeaderActions,
  ProjectHeaderMenu,
  ProjectMenuItem,
  SessionRowMeta,
  NavItem,
} from './sidebarComponents'

const desktopHost = getDesktopHost()
const isDesktopRuntime = desktopHost.isDesktop
const canUseNativeDialogs = desktopHost.capabilities.dialogs
const isWindows = typeof navigator !== 'undefined' && /Win/.test(navigator.platform)
const SESSION_LIST_AUTO_REFRESH_MS = 30_000
const SESSION_LIST_FOCUS_REFRESH_MIN_MS = 5_000

type SidebarHeaderMenuType = 'main' | 'organize' | 'sort' | 'create'

type SidebarProps = {
  isMobile?: boolean
  onRequestClose?: () => void
}

export function Sidebar({ isMobile = false, onRequestClose }: SidebarProps) {
  const t = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const isLoading = useSessionStore((s) => s.isLoading)
  const error = useSessionStore((s) => s.error)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const deleteSessions = useSessionStore((s) => s.deleteSessions)
  const isBatchMode = useSessionStore((s) => s.isBatchMode)
  const selectedSessionIds = useSessionStore((s) => s.selectedSessionIds)
  const enterBatchMode = useSessionStore((s) => s.enterBatchMode)
  const exitBatchMode = useSessionStore((s) => s.exitBatchMode)
  const toggleSessionSelected = useSessionStore((s) => s.toggleSessionSelected)
  const selectSessions = useSessionStore((s) => s.selectSessions)
  const deselectSessions = useSessionStore((s) => s.deselectSessions)
  const renameSession = useSessionStore((s) => s.renameSession)
  const addToast = useUIStore((s) => s.addToast)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const openModal = useUIStore((s) => s.openModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const activeModal = useUIStore((s) => s.activeModal)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const chatSessions = useChatStore((s) => s.sessions)
  const closeTab = useTabStore((s) => s.closeTab)
  const disconnectSession = useChatStore((s) => s.disconnectSession)
  const [searchQuery, setSearchQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [projectContextMenu, setProjectContextMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [projectHeaderMenu, setProjectHeaderMenu] = useState<{ type: SidebarHeaderMenuType; x: number; y: number } | null>(null)
  const [projectHeaderSubmenu, setProjectHeaderSubmenu] = useState<{ type: 'organize' | 'sort'; x: number; y: number } | null>(null)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [pendingBatchDeleteSessionIds, setPendingBatchDeleteSessionIds] = useState<string[] | null>(null)
  const [isBatchDeleting, setIsBatchDeleting] = useState(false)
  const [isBatchExporting, setIsBatchExporting] = useState(false)
  const [pendingClearProjectKey, setPendingClearProjectKey] = useState<string | null>(null)
  const [isClearingProject, setIsClearingProject] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [lastSelectedSessionId, setLastSelectedSessionId] = useState<string | null>(null)
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(new Set())
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set())
  const [projectOrder, setProjectOrder] = useState<string[]>(() => readStoredProjectOrder())
  const [pinnedProjectKeys, setPinnedProjectKeys] = useState<Set<string>>(() => readStoredProjectPins())
  const [hiddenProjectKeys, setHiddenProjectKeys] = useState<Set<string>>(() => readStoredProjectHidden())
  const [projectOrganization, setProjectOrganizationState] = useState<SidebarProjectOrganization>(() => readStoredProjectOrganization())
  const [projectSortBy, setProjectSortByState] = useState<SidebarProjectSortBy>(() => readStoredProjectSortBy())
  const [draggingProjectKey, setDraggingProjectKey] = useState<string | null>(null)
  const [projectDropTarget, setProjectDropTarget] = useState<{ key: string; position: 'before' | 'after' } | null>(null)
  const suppressProjectClickRef = useRef<string | null>(null)
  const sidebarPreferenceRevisionRef = useRef(0)
  const refreshSessionsNow = useSessionListAutoRefresh(fetchSessions)

  useEffect(() => {
    if (!contextMenu) return
    if (!sidebarOpen) setContextMenu(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen])

  useEffect(() => {
    if (!contextMenu && !projectContextMenu && !projectHeaderMenu && !projectHeaderSubmenu) return
    const close = () => {
      setContextMenu(null)
      setProjectContextMenu(null)
      setProjectHeaderMenu(null)
      setProjectHeaderSubmenu(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu, projectContextMenu, projectHeaderMenu, projectHeaderSubmenu])

  const filteredSessions = useMemo(() => {
    let result = sessions
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter((s) => s.title.toLowerCase().includes(q))
    }
    return result
  }, [sessions, searchQuery])

  const projectGroups = useMemo(() => groupByProject(filteredSessions, projectSortBy), [filteredSessions, projectSortBy])
  const orderedProjectGroups = useMemo(
    () => applyProjectOrder(projectGroups, projectOrder, pinnedProjectKeys, projectOrganization, projectSortBy),
    [projectGroups, projectOrder, pinnedProjectKeys, projectOrganization, projectSortBy],
  )
  const visibleProjectGroups = useMemo(() => {
    if (hiddenProjectKeys.size === 0) return orderedProjectGroups
    return orderedProjectGroups.filter((project) => (
      !hiddenProjectKeys.has(project.key)
    ))
  }, [hiddenProjectKeys, orderedProjectGroups])
  const showInitialLoading = isLoading && sessions.length === 0
  const filteredSessionIds = useMemo(() => filteredSessions.map((session) => session.id), [filteredSessions])
  const selectedCount = selectedSessionIds.size
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tab of tabs) {
      if (tab.type === 'session' && tab.status === 'running') ids.add(tab.sessionId)
    }
    for (const [sessionId, sessionState] of Object.entries(chatSessions)) {
      if (sessionState.chatState !== 'idle') ids.add(sessionId)
    }
    return ids
  }, [chatSessions, tabs])
  const pendingBatchDeleteSessions = useMemo(
    () => (pendingBatchDeleteSessionIds ?? [])
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is SessionListItem => Boolean(session)),
    [pendingBatchDeleteSessionIds, sessionsById],
  )
  const expanded = isMobile ? true : sidebarOpen
  const closeMobileDrawer = useCallback(() => {
    if (isMobile) onRequestClose?.()
  }, [isMobile, onRequestClose])

  const applySidebarProjectPreferences = useCallback((preferences: SidebarProjectPreferences) => {
    setProjectOrder(preferences.projectOrder)
    setPinnedProjectKeys(new Set(preferences.pinnedProjects))
    setHiddenProjectKeys(new Set(preferences.hiddenProjects))
    setProjectOrganizationState(preferences.projectOrganization)
    setProjectSortByState(preferences.projectSortBy)
  }, [])

  const persistSidebarProjectPreferences = useCallback((preferences: SidebarProjectPreferences) => {
    const normalized = normalizeSidebarProjectPreferences(preferences)
    sidebarPreferenceRevisionRef.current += 1
    writeCachedSidebarProjectPreferences(normalized)
    void desktopUiPreferencesApi.updateSidebarPreferences(normalized).catch(() => undefined)
  }, [])

  const restoreHiddenProjectForWorkDir = useCallback((workDir: string | null | undefined) => {
    if (!workDir) return
    setHiddenProjectKeys((current) => {
      const next = new Set([...current].filter((projectKey) => !projectPathMatches(projectKey, workDir)))
      if (next.size === current.size) return current
      persistSidebarProjectPreferences(buildSidebarProjectPreferences(
        projectOrder,
        pinnedProjectKeys,
        next,
        projectOrganization,
        projectSortBy,
      ))
      return next
    })
  }, [persistSidebarProjectPreferences, pinnedProjectKeys, projectOrder, projectOrganization, projectSortBy])

  useEffect(() => {
    let cancelled = false
    const startRevision = sidebarPreferenceRevisionRef.current

    void desktopUiPreferencesApi.getPreferences()
      .then((response) => {
        if (cancelled || startRevision !== sidebarPreferenceRevisionRef.current) return

        const localPreferences = readCachedSidebarProjectPreferences()
        const serverPreferences = normalizeSidebarProjectPreferences(response.preferences.sidebar)
        const effectivePreferences = response.exists ? serverPreferences : localPreferences

        applySidebarProjectPreferences(effectivePreferences)
        writeCachedSidebarProjectPreferences(effectivePreferences)

        if (!response.exists && hasSidebarProjectPreferences(localPreferences)) {
          void desktopUiPreferencesApi.updateSidebarPreferences(localPreferences).catch(() => undefined)
        }
      })
      .catch(() => {
        // The sidebar remains usable with the local cache if the server is still booting.
      })

    return () => {
      cancelled = true
    }
  }, [applySidebarProjectPreferences])

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault()
    if (isBatchMode) return
    setContextMenu({ id, x: e.clientX, y: e.clientY })
  }, [isBatchMode])

  const handleProjectDragStart = useCallback((event: React.DragEvent, projectKey: string) => {
    if (isBatchMode) {
      event.preventDefault()
      return
    }
    suppressProjectClickRef.current = projectKey
    setDraggingProjectKey(projectKey)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', projectKey)
  }, [isBatchMode])

  const handleProjectDragOver = useCallback((event: React.DragEvent<HTMLElement>, projectKey: string) => {
    const sourceProjectKey = draggingProjectKey || event.dataTransfer.getData('text/plain')
    if (!sourceProjectKey || sourceProjectKey === projectKey) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const position = getProjectDropPosition(event)
    setProjectDropTarget((current) => (
      current?.key === projectKey && current.position === position
        ? current
        : { key: projectKey, position }
    ))
  }, [draggingProjectKey])

  const clearProjectDragState = useCallback(() => {
    setDraggingProjectKey(null)
    setProjectDropTarget(null)
    window.setTimeout(() => {
      suppressProjectClickRef.current = null
    }, 0)
  }, [])

  const handleProjectDrop = useCallback((event: React.DragEvent<HTMLElement>, targetProjectKey: string) => {
    event.preventDefault()
    const sourceProjectKey = draggingProjectKey || event.dataTransfer.getData('text/plain')
    const dropPosition = projectDropTarget?.key === targetProjectKey
      ? projectDropTarget.position
      : getProjectDropPosition(event)
    if (!sourceProjectKey || sourceProjectKey === targetProjectKey) {
      clearProjectDragState()
      return
    }

    const nextOrder = moveProjectKey(
      orderedProjectGroups.map((project) => project.key),
      sourceProjectKey,
      targetProjectKey,
      dropPosition,
    )
    setProjectOrder(nextOrder)
    persistSidebarProjectPreferences(buildSidebarProjectPreferences(nextOrder, pinnedProjectKeys, hiddenProjectKeys, projectOrganization, projectSortBy))
    clearProjectDragState()
  }, [clearProjectDragState, draggingProjectKey, hiddenProjectKeys, orderedProjectGroups, persistSidebarProjectPreferences, pinnedProjectKeys, projectDropTarget, projectOrganization, projectSortBy])

  const createSessionForWorkDir = useCallback(async (workDir?: string) => {
    try {
      const sessionId = await useSessionStore.getState().createSession(workDir)
      restoreHiddenProjectForWorkDir(workDir)
      useTabStore.getState().openTab(sessionId, t('sidebar.newSession'))
      useChatStore.getState().connectToSession(sessionId)
      closeMobileDrawer()
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.sessionListFailed'),
      })
    }
  }, [addToast, closeMobileDrawer, restoreHiddenProjectForWorkDir, t])

  const openProjectHeaderMenu = useCallback((event: React.MouseEvent, type: SidebarHeaderMenuType) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const width = type === 'create' ? 250 : 270
    setProjectContextMenu(null)
    setContextMenu(null)
    setProjectHeaderSubmenu(null)
    setProjectHeaderMenu({
      type,
      x: Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10)),
      y: rect.bottom + 8,
    })
  }, [])

  const openProjectHeaderSubmenu = useCallback((event: React.MouseEvent, type: 'organize' | 'sort') => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const width = type === 'sort' ? 230 : 260
    setProjectHeaderSubmenu({
      type,
      x: Math.max(10, Math.min(rect.right + 8, window.innerWidth - width - 10)),
      y: Math.max(10, Math.min(rect.top - 8, window.innerHeight - 170)),
    })
  }, [])

  const updateProjectOrganization = useCallback((organization: SidebarProjectOrganization) => {
    setProjectHeaderMenu(null)
    setProjectHeaderSubmenu(null)
    setProjectOrganizationState(organization)
    const nextOrder = organization === 'project' || organization === 'time' ? [] : projectOrder
    if (nextOrder !== projectOrder) setProjectOrder(nextOrder)
    persistSidebarProjectPreferences(buildSidebarProjectPreferences(
      nextOrder,
      pinnedProjectKeys,
      hiddenProjectKeys,
      organization,
      projectSortBy,
    ))
  }, [hiddenProjectKeys, persistSidebarProjectPreferences, pinnedProjectKeys, projectOrder, projectSortBy])

  const updateProjectSortBy = useCallback((sortBy: SidebarProjectSortBy) => {
    setProjectHeaderMenu(null)
    setProjectHeaderSubmenu(null)
    setProjectSortByState(sortBy)
    const nextOrder: string[] = []
    setProjectOrder(nextOrder)
    persistSidebarProjectPreferences(buildSidebarProjectPreferences(
      nextOrder,
      pinnedProjectKeys,
      hiddenProjectKeys,
      projectOrganization,
      sortBy,
    ))
  }, [hiddenProjectKeys, persistSidebarProjectPreferences, pinnedProjectKeys, projectOrganization])

  const createSessionFromExistingFolder = useCallback(async () => {
    setProjectHeaderMenu(null)
    setProjectHeaderSubmenu(null)
    if (!canUseNativeDialogs) {
      addToast({
        type: 'error',
        message: t('sidebar.chooseProjectFolderUnavailable'),
      })
      return
    }
    try {
      const selected = await getDesktopHost().dialogs.open({
        directory: true,
        multiple: false,
        title: t('sidebar.useExistingFolder'),
      })
      if (typeof selected === 'string' && selected.trim()) {
        await createSessionForWorkDir(selected)
      }
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.sessionListFailed'),
      })
    }
  }, [addToast, createSessionForWorkDir, t])

  const togglePinnedProject = useCallback((projectKey: string) => {
    setProjectContextMenu(null)
    setPinnedProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(projectKey)) {
        next.delete(projectKey)
      } else {
        next.add(projectKey)
      }
      persistSidebarProjectPreferences(buildSidebarProjectPreferences(projectOrder, next, hiddenProjectKeys, projectOrganization, projectSortBy))
      return next
    })
  }, [hiddenProjectKeys, persistSidebarProjectPreferences, projectOrder, projectOrganization, projectSortBy])

  const restoreAllHiddenProjects = useCallback(() => {
    setProjectHeaderMenu(null)
    setProjectHeaderSubmenu(null)
    setHiddenProjectKeys((current) => {
      if (current.size === 0) return current
      const next = new Set<string>()
      persistSidebarProjectPreferences(buildSidebarProjectPreferences(
        projectOrder,
        pinnedProjectKeys,
        next,
        projectOrganization,
        projectSortBy,
      ))
      return next
    })
  }, [persistSidebarProjectPreferences, pinnedProjectKeys, projectOrder, projectOrganization, projectSortBy])

  const toggleHiddenProject = useCallback((project: ProjectGroup) => {
    const wasHidden = hiddenProjectKeys.has(project.key)
    setProjectContextMenu(null)
    setHiddenProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(project.key)) {
        next.delete(project.key)
      } else {
        next.add(project.key)
      }
      persistSidebarProjectPreferences(buildSidebarProjectPreferences(projectOrder, pinnedProjectKeys, next, projectOrganization, projectSortBy))
      return next
    })
    if (!wasHidden) {
      addToast({
        type: 'info',
        message: t('sidebar.projectHidden', { project: project.title }),
      })
    }
  }, [addToast, hiddenProjectKeys, persistSidebarProjectPreferences, pinnedProjectKeys, projectOrder, projectOrganization, projectSortBy, t])

  const requestClearProjectSessions = useCallback((project: ProjectGroup) => {
    setProjectContextMenu(null)
    setPendingClearProjectKey(project.key)
  }, [])

  const confirmClearProjectSessions = useCallback(async () => {
    if (!pendingClearProjectKey) return
    const project = orderedProjectGroups.find((g) => g.key === pendingClearProjectKey)
    if (!project) {
      setPendingClearProjectKey(null)
      return
    }
    const workDir = project.workDir
    if (!workDir) {
      addToast({
        type: 'error',
        message: t('sidebar.clearProjectSessionsNoWorkDir', { project: project.title }),
      })
      setPendingClearProjectKey(null)
      return
    }
    setIsClearingProject(true)
    try {
      // Disconnect any open sessions for this project so the websocket
      // server-side handles don't keep referencing files we're about to
      // delete. closeTab handles missing tabs gracefully.
      for (const session of project.sessions) {
        try { closeTab(session.id) } catch { /* ignore */ }
        try { disconnectSession(session.id) } catch { /* ignore */ }
      }
      const result = await projectsApi.clearSessions(workDir)
      // Re-fetch sessions so the project either disappears (if dir removed)
      // or shows up empty (preserved memory/ etc.).
      await fetchSessions()
      addToast({
        type: 'success',
        message: t('sidebar.clearProjectSessionsSuccess', {
          project: project.title,
          count: result.deletedSessions,
        }),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: t('sidebar.clearProjectSessionsFailure', {
          project: project.title,
          error: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setIsClearingProject(false)
      setPendingClearProjectKey(null)
    }
  }, [addToast, closeTab, disconnectSession, fetchSessions, orderedProjectGroups, pendingClearProjectKey, t])

  const openProjectInFinder = useCallback(async (project: ProjectGroup) => {
    setProjectContextMenu(null)
    try {
      if (!project.workDir) {
        throw new Error(t('sidebar.openInFinderUnavailable'))
      }
      const store = useOpenTargetStore.getState()
      await store.ensureTargets()
      const latest = useOpenTargetStore.getState()
      const target = latest.targets.find((item) => item.id === 'finder')
        ?? latest.targets.find((item) => item.kind === 'file_manager')
      if (!target) {
        throw new Error(t('sidebar.openInFinderUnavailable'))
      }
      await latest.openTarget(target.id, project.workDir)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.openInFinderFailed'),
      })
    }
  }, [addToast, t])

  const handleDelete = useCallback((id: string) => {
    setContextMenu(null)
    setPendingDeleteSessionId(id)
  }, [])

  const handleCopySessionPath = useCallback(async (sessionId: string) => {
    setContextMenu(null)
    const session = sessions.find((s) => s.id === sessionId)
    if (!session?.filePath) {
      addToast({ type: 'error', message: t('sidebar.copySessionPathUnavailable') })
      return
    }
    try {
      await desktopHost.clipboard.writeText(session.filePath)
      addToast({ type: 'success', message: t('sidebar.copySessionPathSuccess') })
    } catch {
      addToast({ type: 'error', message: t('common.copyFailed') })
    }
  }, [addToast, sessions, t])

  const handleRevealSession = useCallback(async (sessionId: string) => {
    setContextMenu(null)
    const session = sessions.find((s) => s.id === sessionId)
    if (!session?.filePath) {
      addToast({ type: 'error', message: t('sidebar.copySessionPathUnavailable') })
      return
    }
    const reveal = desktopHost.shell.showItemInFolder
    if (!reveal) {
      addToast({ type: 'error', message: t('sidebar.revealSessionUnsupported') })
      return
    }
    try {
      await reveal(session.filePath)
    } catch (error) {
      addToast({
        type: 'error',
        message: t('sidebar.revealSessionFailure', {
          error: error instanceof Error ? error.message : String(error),
        }),
      })
    }
  }, [addToast, sessions, t])

  const handleExportSession = useCallback(async (sessionId: string) => {
    setContextMenu(null)
    const session = sessions.find((s) => s.id === sessionId)
    const workDir = session?.workDir || session?.projectRoot || session?.projectPath
    if (!workDir) {
      addToast({ type: 'error', message: t('sidebar.exportSessionNoWorkDir') })
      return
    }
    try {
      const result = await projectsApi.exportSession(workDir, sessionId)
      addToast({
        type: 'success',
        message: t('sidebar.exportSessionSuccess', { filename: result.filename }),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: t('sidebar.exportSessionFailure', {
          error: error instanceof Error ? error.message : String(error),
        }),
      })
    }
  }, [addToast, sessions, t])

  const importFileInputRef = useRef<HTMLInputElement | null>(null)
  const importTargetWorkDirRef = useRef<string | null>(null)

  const triggerImportSession = useCallback((project: ProjectGroup) => {
    setProjectContextMenu(null)
    if (!project.workDir) {
      addToast({ type: 'error', message: t('sidebar.importSessionNoWorkDir') })
      return
    }
    importTargetWorkDirRef.current = project.workDir
    importFileInputRef.current?.click()
  }, [addToast, t])

  const handleImportFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const workDir = importTargetWorkDirRef.current
    // Always reset the input so picking the same file twice still fires change.
    event.target.value = ''
    importTargetWorkDirRef.current = null
    if (!file || !workDir) return
    try {
      const result = await projectsApi.importSession(workDir, file)
      await fetchSessions()
      addToast({
        type: 'success',
        message: t('sidebar.importSessionSuccess', {
          lines: result.nonEmptyLines,
        }),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: t('sidebar.importSessionFailure', {
          error: error instanceof Error ? error.message : String(error),
        }),
      })
    }
  }, [addToast, fetchSessions, t])

  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteSessionId) return
    await deleteSession(pendingDeleteSessionId)
    disconnectSession(pendingDeleteSessionId)
    closeTab(pendingDeleteSessionId)
    setPendingDeleteSessionId(null)
  }, [closeTab, deleteSession, disconnectSession, pendingDeleteSessionId])

  const handleBatchSessionClick = useCallback((event: React.MouseEvent, id: string) => {
    if (event.shiftKey && lastSelectedSessionId) {
      const start = filteredSessionIds.indexOf(lastSelectedSessionId)
      const end = filteredSessionIds.indexOf(id)
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start]
        selectSessions(filteredSessionIds.slice(from, to + 1))
        setLastSelectedSessionId(id)
        return
      }
    }

    toggleSessionSelected(id)
    setLastSelectedSessionId(id)
  }, [filteredSessionIds, lastSelectedSessionId, selectSessions, toggleSessionSelected])

  const handleExitBatchMode = useCallback(() => {
    exitBatchMode()
    setLastSelectedSessionId(null)
    setPendingBatchDeleteSessionIds(null)
  }, [exitBatchMode])

  const handleBatchExport = useCallback(async () => {
    const ids = [...selectedSessionIds]
    if (ids.length === 0) return

    if (ids.length === 1) {
      await handleExportSession(ids[0]!)
      handleExitBatchMode()
      return
    }

    // Multiple sessions: collect blobs, pack into zip
    setIsBatchExporting(true)
    addToast({ type: 'info', message: t('sidebar.batchExporting', { count: ids.length }) })
    try {
      const { zipSync } = await import('fflate')
      const entries: Record<string, Uint8Array> = {}
      for (const sessionId of ids) {
        const session = sessions.find((s) => s.id === sessionId)
        const workDir = session?.workDir || session?.projectRoot || session?.projectPath
        if (!workDir) continue
        try {
          const { filename, blob } = await projectsApi.exportSessionBlob(workDir, sessionId)
          const buffer = await blob.arrayBuffer()
          entries[filename] = new Uint8Array(buffer)
        } catch {
          // skip failed individual exports
        }
      }
      const exportedCount = Object.keys(entries).length
      if (exportedCount === 0) {
        addToast({ type: 'error', message: t('sidebar.exportSessionFailure', { error: 'No sessions exported' }) })
        return
      }
      const zipData = zipSync(entries)
      const zipBlob = new Blob([zipData], { type: 'application/zip' })
      const zipFilename = `sessions-export-${new Date().toISOString().slice(0, 10)}.zip`
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const objectUrl = URL.createObjectURL(zipBlob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = zipFilename
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
      }
      addToast({
        type: 'success',
        message: t('sidebar.exportSessionSuccess', { filename: `${zipFilename} (${exportedCount} sessions)` }),
      })
      handleExitBatchMode()
    } catch (error) {
      addToast({
        type: 'error',
        message: t('sidebar.exportSessionFailure', {
          error: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setIsBatchExporting(false)
    }
  }, [addToast, handleExitBatchMode, handleExportSession, selectedSessionIds, sessions, t])

  const requestBatchDelete = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setPendingBatchDeleteSessionIds([...new Set(ids)])
  }, [])

  const confirmBatchDelete = useCallback(async () => {
    const ids = pendingBatchDeleteSessionIds ?? []
    if (ids.length === 0) return

    setIsBatchDeleting(true)
    try {
      const result = await deleteSessions(ids)
      for (const sessionId of result.successes) {
        disconnectSession(sessionId)
        closeTab(sessionId)
      }

      if (result.failures.length > 0) {
        addToast({
          type: 'error',
          message: t('sidebar.batchDeleteFailed', { count: result.failures.length }),
        })
      } else {
        addToast({
          type: 'success',
          message: t('sidebar.batchDeleteSucceeded', { count: result.successes.length }),
        })
        handleExitBatchMode()
      }
      setPendingBatchDeleteSessionIds(null)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.batchDeleteFailed', { count: ids.length }),
      })
    } finally {
      setIsBatchDeleting(false)
    }
  }, [addToast, closeTab, deleteSessions, disconnectSession, handleExitBatchMode, pendingBatchDeleteSessionIds, t])

  const toggleGroupSelection = useCallback((ids: string[]) => {
    const allSelected = ids.every((id) => selectedSessionIds.has(id))
    if (allSelected) {
      deselectSessions(ids)
    } else {
      selectSessions(ids)
    }
  }, [deselectSessions, selectSessions, selectedSessionIds])

  const toggleProjectCollapsed = useCallback((projectKey: string) => {
    if (suppressProjectClickRef.current === projectKey) {
      suppressProjectClickRef.current = null
      return
    }
    setCollapsedProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(projectKey)) {
        next.delete(projectKey)
      } else {
        next.add(projectKey)
      }
      return next
    })
  }, [])

  const toggleProjectSessionExpansion = useCallback((projectKey: string) => {
    setExpandedProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(projectKey)) {
        next.delete(projectKey)
      } else {
        next.add(projectKey)
      }
      return next
    })
  }, [])

  const handleStartRename = useCallback((id: string, currentTitle: string) => {
    setContextMenu(null)
    setRenamingId(id)
    setRenameValue(currentTitle)
  }, [])

  const handleFinishRename = useCallback(async () => {
    if (renamingId && renameValue.trim()) {
      await renameSession(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue, renameSession])

  useEffect(() => {
    if (!isBatchMode) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return

      if (event.key === 'Escape') {
        handleExitBatchMode()
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectSessions(filteredSessionIds)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [filteredSessionIds, handleExitBatchMode, isBatchMode, selectSessions])

  return (
    <aside
      className="sidebar-panel relative h-full flex flex-col bg-[var(--color-surface-sidebar)] border-r border-[var(--color-border)] select-none"
      data-state={expanded ? 'open' : 'closed'}
      aria-label="Sidebar"
    >
      <div
        data-testid="sidebar-title-region"
        data-desktop-drag-region
        className={`px-3 pb-2 ${isDesktopRuntime && !isWindows ? 'pt-[44px]' : 'pt-3'}`}
      >
        <div className={`flex ${expanded ? 'items-center justify-between gap-3' : 'flex-col items-center gap-2'}`}>
          <div className={`flex min-w-0 items-center ${expanded ? 'gap-2.5' : 'justify-center'}`}>
            <img src={publicAssetPath('app-icon.png')} alt="" className="h-8 w-8 flex-shrink-0" />
            <span
              className={`sidebar-copy ${expanded ? 'sidebar-copy--visible' : 'sidebar-copy--hidden'} text-[13px] font-semibold tracking-tight text-[var(--color-text-primary)]`}
              style={{ fontFamily: 'var(--font-headline)' }}
            >
              Code <span className="text-[var(--color-primary-container)]">Council</span>
            </span>
          </div>
          <div className={`flex items-center ${expanded ? 'gap-1.5' : 'flex-col gap-2'}`}>
            <a
              href="https://github.com/706412584/cc-haha"
              target="_blank"
              rel="noopener noreferrer"
              className={`sidebar-copy ${expanded ? 'sidebar-copy--visible' : 'sidebar-copy--hidden'} inline-flex items-center justify-center rounded-md p-1 text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]`}
              title="GitHub"
              tabIndex={expanded ? undefined : -1}
              aria-hidden={!expanded}
            >
              <GitHubIcon />
            </a>
            {isMobile ? (
              <button
                type="button"
                onClick={closeMobileDrawer}
                className="sidebar-toggle-button flex h-11 w-11 items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-sidebar)]"
                aria-label={t('sidebar.collapse')}
                title={t('sidebar.collapse')}
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={toggleSidebar}
                data-testid={expanded ? 'sidebar-collapse-button' : 'sidebar-expand-button'}
                className={`sidebar-toggle-button ${expanded ? 'sidebar-toggle-button--open h-8 w-8' : 'sidebar-toggle-button--collapsed h-8 w-8'} flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-sidebar)]`}
                aria-label={expanded ? t('sidebar.collapse') : t('sidebar.expand')}
                title={expanded ? t('sidebar.collapse') : t('sidebar.expand')}
              >
                <SidebarToggleIcon collapsed={!expanded} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className={`px-3 pb-3 flex flex-col ${expanded ? 'gap-0.5' : 'items-center gap-2'}`}>
        <Tooltip content={t('sidebar.newSession')} shortcut="⌘N">
          <NavItem
            active={false}
            collapsed={!expanded}
            label={t('sidebar.newSession')}
            touchFriendly={isMobile}
            onClick={() => {
              const currentTabId = useTabStore.getState().activeTabId
              const currentSession = currentTabId
                ? useSessionStore.getState().sessions.find((s) => s.id === currentTabId)
                : null
              void createSessionForWorkDir(currentSession?.workDir || currentSession?.projectRoot || undefined)
            }}
            icon={<PlusIcon />}
          >
            {t('sidebar.newSession')}
          </NavItem>
        </Tooltip>
        {!isMobile && (
          <NavItem
            active={activeTabId === SCHEDULED_TAB_ID}
            collapsed={!expanded}
            label={t('sidebar.scheduled')}
            touchFriendly={isMobile}
            onClick={() => {
              useTabStore.getState().openTab(SCHEDULED_TAB_ID, t('sidebar.scheduled'), 'scheduled')
              closeMobileDrawer()
            }}
            icon={<ClockIcon />}
          >
            {t('sidebar.scheduled')}
          </NavItem>
        )}
      </div>

      {expanded ? (
        <>
          <div
            data-testid="sidebar-search-controls-section"
            className="sidebar-section sidebar-section--visible relative z-20 flex-none px-3 pb-2"
            style={{ overflow: 'visible' }}
          >
            <button
              type="button"
              onClick={() => openModal('globalSearch')}
              className="mb-1.5 flex h-9 w-full min-w-0 items-center gap-2 rounded-[14px] border border-[var(--color-sidebar-search-border)] bg-[var(--color-sidebar-search-bg)] pl-3 pr-2 text-left text-[13px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-sidebar-item-hover)] focus-visible:border-[var(--color-border-focus)] focus-visible:outline-none"
              aria-label={t('search.global.trigger')}
              title={t('search.global.trigger')}
            >
              <span className="pointer-events-none flex shrink-0 items-center text-[var(--color-text-tertiary)]">
                <SearchIcon />
              </span>
              <span className="min-w-0 flex-1 truncate pl-2">{t('search.global.trigger')}</span>
              <kbd className="pointer-events-none shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1 font-mono text-[10px] leading-tight text-[var(--color-text-tertiary)]">⌘K</kbd>
            </button>
            <div className="flex items-center gap-1.5">
              <div className="flex h-9 min-w-0 flex-1 items-center rounded-[14px] border border-[var(--color-sidebar-search-border)] bg-[var(--color-sidebar-search-bg)] pl-3 pr-3 transition-colors focus-within:border-[var(--color-border-focus)]">
                <span className="pointer-events-none flex shrink-0 items-center text-[var(--color-text-tertiary)]">
                  <SearchIcon />
                </span>
                <input
                  id="sidebar-search"
                  type="text"
                  placeholder={t('sidebar.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent pl-2 pr-0 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() => void refreshSessionsNow()}
                disabled={isLoading}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[12px] border border-[var(--color-sidebar-search-border)] bg-[var(--color-sidebar-search-bg)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-default disabled:opacity-65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                aria-label={t('sidebar.refreshSessions')}
                title={t('sidebar.refreshSessions')}
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} strokeWidth={1.9} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={isBatchMode ? handleExitBatchMode : enterBatchMode}
                className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[12px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                  isBatchMode
                    ? 'border-[var(--color-brand)] bg-[var(--color-sidebar-item-active)] text-[var(--color-brand)]'
                    : 'border-[var(--color-sidebar-search-border)] bg-[var(--color-sidebar-search-bg)] text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)]'
                }`}
                aria-label={isBatchMode ? t('sidebar.batchExit') : t('sidebar.batchManage')}
                title={isBatchMode ? t('sidebar.batchExit') : t('sidebar.batchManage')}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {isBatchMode ? 'close' : 'delete_sweep'}
                </span>
              </button>
            </div>
          </div>

          <div
            data-testid="sidebar-session-list-section"
            className="sidebar-section sidebar-section--visible flex flex-1 min-h-0 flex-col"
          >
            {isBatchMode && (
              <div className="mx-3 mb-2 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 text-xs font-medium text-[var(--color-text-primary)]">
                    {t('sidebar.batchSelectedCount', { count: selectedCount })}
                  </span>
                  <button
                    type="button"
                    onClick={handleExitBatchMode}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                    aria-label={t('sidebar.batchExit')}
                    title={t('sidebar.batchExit')}
                  >
                    <span className="material-symbols-outlined text-[17px]">close</span>
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (filteredSessionIds.every((id) => selectedSessionIds.has(id))) {
                        deselectSessions(filteredSessionIds)
                      } else {
                        selectSessions(filteredSessionIds)
                      }
                    }}
                    disabled={filteredSessionIds.length === 0}
                    className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                  >
                    {filteredSessionIds.length > 0 && filteredSessionIds.every((id) => selectedSessionIds.has(id))
                      ? t('sidebar.batchDeselectAll')
                      : t('sidebar.batchSelectAll')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleBatchExport()}
                    disabled={selectedCount === 0 || isBatchExporting}
                    className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                  >
                    {isBatchExporting ? t('sidebar.batchExporting', { count: selectedCount }) : t('sidebar.batchExportSelected', { count: selectedCount })}
                  </button>
                  <button
                    type="button"
                    onClick={() => requestBatchDelete([...selectedSessionIds])}
                    disabled={selectedCount === 0}
                    className="rounded-md bg-[var(--color-error)] px-2 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {t('sidebar.batchDeleteSelected', { count: selectedCount })}
                  </button>
                </div>
              </div>
            )}
            <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto px-3 pb-20">
              {error && (
                <div className="mx-1 mt-2 rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error)]/5 px-3 py-2">
                  <div className="text-xs font-medium text-[var(--color-error)]">{t('sidebar.sessionListFailed')}</div>
                  <div className="mt-1 text-[11px] text-[var(--color-text-secondary)] break-words">{error}</div>
                  <button
                    onClick={() => fetchSessions()}
                    className="mt-2 text-[11px] font-medium text-[var(--color-brand)] hover:underline"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              )}
              {showInitialLoading ? (
                <div className="px-1 py-2 space-y-1">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
                      <Skeleton variant="rect" width={18} height={18} className="shrink-0" />
                      <Skeleton variant="text" height={13} className="flex-1" />
                    </div>
                  ))}
                </div>
              ) : filteredSessions.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-[var(--color-text-tertiary)]">
                  {searchQuery ? t('sidebar.noMatching') : t('sidebar.noSessions')}
                </div>
              )}
              {orderedProjectGroups.length > 0 && (
                <ProjectHeaderActions
                  title={t('sidebar.projects')}
                  menuLabel={t('sidebar.projectMenu')}
                  createLabel={t('sidebar.newProject')}
                  onOpenMenu={(event) => openProjectHeaderMenu(event, 'main')}
                  onOpenCreate={(event) => openProjectHeaderMenu(event, 'create')}
                />
              )}
              {visibleProjectGroups.map((project) => {
                const projectCollapsed = collapsedProjectKeys.has(project.key)
                const sessionsExpanded = expandedProjectKeys.has(project.key)
                const visibleItems = projectCollapsed
                  ? []
                  : getVisibleProjectSessions(project.sessions, sessionsExpanded, activeTabId)
                const hiddenCount = project.sessions.length - visibleItems.length
                const groupIds = project.sessions.map((session) => session.id)
                const groupSelectedCount = groupIds.filter((id) => selectedSessionIds.has(id)).length
                const hasInternalScroll = sessionsExpanded && project.sessions.length > PROJECT_GROUP_SCROLL_COUNT
                const isProjectDragging = draggingProjectKey === project.key
                const isProjectPinned = pinnedProjectKeys.has(project.key)
                const dropBefore = projectDropTarget?.key === project.key && projectDropTarget.position === 'before'
                const dropAfter = projectDropTarget?.key === project.key && projectDropTarget.position === 'after'
                return (
                  <section
                    key={project.key}
                    data-testid={`sidebar-project-group-${domSafeProjectKey(project.key)}`}
                    onDragOver={(event) => handleProjectDragOver(event, project.key)}
                    onDrop={(event) => handleProjectDrop(event, project.key)}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setProjectDropTarget((current) => current?.key === project.key ? null : current)
                      }
                    }}
                    className={`group/project relative mb-3.5 transition-opacity ${isProjectDragging ? 'opacity-50' : ''}`}
                  >
                    {dropBefore && (
                      <div className="pointer-events-none absolute -top-1 left-1 right-1 z-10 h-0.5 rounded-full bg-[var(--color-brand)]" />
                    )}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        draggable={!isBatchMode}
                        onDragStart={(event) => handleProjectDragStart(event, project.key)}
                        onDragEnd={clearProjectDragState}
                        onClick={() => toggleProjectCollapsed(project.key)}
                        data-state={projectCollapsed ? 'closed' : 'open'}
                        className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-xl px-1.5 py-2 text-left transition-[background,color] active:cursor-grabbing hover:bg-[var(--color-sidebar-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                        aria-expanded={!projectCollapsed}
                        aria-label={t(projectCollapsed ? 'sidebar.expandProject' : 'sidebar.collapseProject', { project: project.title })}
                        title={project.subtitle || project.title}
                      >
                        <span
                          data-testid={`sidebar-project-icon-${domSafeProjectKey(project.key)}`}
                          data-icon-state={projectCollapsed ? 'closed' : 'open'}
                          className={`flex h-5 w-5 flex-shrink-0 items-center justify-center transition-colors ${
                            projectCollapsed
                              ? 'text-[var(--color-text-secondary)]'
                              : 'text-[var(--color-text-primary)]'
                          }`}
                        >
                          {projectCollapsed ? (
                            <Folder className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
                          ) : (
                            <FolderOpen className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
                          )}
                        </span>
                        <span className={`min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 transition-colors ${
                          projectCollapsed
                            ? 'text-[var(--color-text-secondary)]'
                            : 'text-[var(--color-text-primary)]'
                        }`}>
                          {project.title}
                        </span>
                        {isProjectPinned && (
                          <Pin className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={1.8} aria-hidden="true" />
                        )}
                      </button>
                      <div className="flex flex-shrink-0 items-center gap-1">
                        {isBatchMode && (
                          <button
                            type="button"
                            onClick={() => toggleGroupSelection(groupIds)}
                            className={`rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                              groupSelectedCount > 0
                                ? 'text-[var(--color-brand)] hover:bg-[var(--color-brand)]/10'
                                : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]'
                            }`}
                            aria-label={t('sidebar.batchSelectGroup', { group: project.title })}
                          >
                            {groupSelectedCount === groupIds.length
                              ? t('sidebar.batchDeselectAll')
                              : t('sidebar.batchSelectAll')}
                          </button>
                        )}
                        {!isBatchMode && (
                          <div className="pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                setContextMenu(null)
                                setProjectContextMenu({ key: project.key, x: event.clientX, y: event.clientY })
                              }}
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                              aria-label={t('sidebar.projectActions', { project: project.title })}
                              title={t('sidebar.projectActions', { project: project.title })}
                            >
                              <MoreHorizontal className="h-[17px] w-[17px]" strokeWidth={2} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                void createSessionForWorkDir(project.workDir)
                              }}
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                              aria-label={t('sidebar.newSessionInProject', { project: project.title })}
                              title={t('sidebar.newSessionInProject', { project: project.title })}
                            >
                              <SquarePen className="h-[16px] w-[16px]" strokeWidth={2} aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    {!projectCollapsed && (
                      <div className="mt-0.5 pl-6">
                        <div
                          className={hasInternalScroll ? 'max-h-[420px] overflow-y-auto pr-1' : undefined}
                          data-testid={`sidebar-project-session-list-${domSafeProjectKey(project.key)}`}
                        >
                          {visibleItems.map((session) => (
                            <div key={session.id} className="relative mb-0.5 last:mb-0">
                              {renamingId === session.id ? (
                                <input
                                  autoFocus
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={handleFinishRename}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleFinishRename()
                                    if (e.key === 'Escape') {
                                      setRenamingId(null)
                                      setRenameValue('')
                                    }
                                  }}
                                  className="w-full rounded-[var(--radius-md)] border border-[var(--color-border-focus)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none"
                                />
                              ) : (
                                <button
                                  onClick={(event) => {
                                    if (isBatchMode) {
                                      handleBatchSessionClick(event, session.id)
                                      return
                                    }
                                    useTabStore.getState().openTab(session.id, session.title)
                                    useChatStore.getState().connectToSession(session.id)
                                    closeMobileDrawer()
                                  }}
                                  onContextMenu={(e) => handleContextMenu(e, session.id)}
                                  className={`
                                    group/session w-full rounded-lg px-2.5 ${isMobile ? 'py-3' : 'py-1.5'} text-left text-[13px] transition-[background,filter,color] duration-200
                                    ${selectedSessionIds.has(session.id)
                                      ? 'sidebar-session-row--selected bg-[var(--color-sidebar-item-active)] text-[var(--color-text-primary)]'
                                      : session.id === activeTabId
                                      ? 'sidebar-session-row--active bg-[var(--color-sidebar-item-active)] text-[var(--color-text-primary)]'
                                      : 'sidebar-session-row--idle text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)]'
                                    }
                                  `}
                                  aria-pressed={isBatchMode ? selectedSessionIds.has(session.id) : undefined}
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    {isBatchMode ? (
                                      <span
                                        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                                          selectedSessionIds.has(session.id)
                                            ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                                            : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                                        }`}
                                        aria-hidden="true"
                                      >
                                        {selectedSessionIds.has(session.id) && (
                                          <span className="material-symbols-outlined text-[12px]">check</span>
                                        )}
                                      </span>
                                    ) : null}
                                    <span className="min-w-0 flex-1 truncate font-medium tracking-normal">{session.title || 'Untitled'}</span>
                                    {!session.workDirExists && (
                                      <span
                                        className="flex-shrink-0 text-[10px] text-[var(--color-warning)]"
                                        title={session.workDir ?? ''}
                                      >
                                        {t('sidebar.missingDir')}
                                      </span>
                                    )}
                                    <SessionRowMeta
                                      isRunning={runningSessionIds.has(session.id)}
                                      isWorktree={isWorktreeSession(session)}
                                      modifiedAt={session.modifiedAt}
                                      t={t}
                                    />
                                  </span>
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                        {(hiddenCount > 0 || sessionsExpanded) && (
                          <div className="mt-2 flex justify-start px-2.5">
                            <button
                              type="button"
                              onClick={() => toggleProjectSessionExpansion(project.key)}
                              className="inline-flex items-center justify-start py-1 text-[13px] font-semibold text-[var(--color-text-tertiary)] opacity-75 transition-[color,opacity] hover:text-[var(--color-text-secondary)] hover:opacity-100 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                              aria-expanded={sessionsExpanded}
                            >
                              {sessionsExpanded
                                ? t('sidebar.showFewerSessions')
                                : t('sidebar.showMoreSessions')}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {dropAfter && (
                      <div className="pointer-events-none absolute -bottom-1 left-1 right-1 z-10 h-0.5 rounded-full bg-[var(--color-brand)]" />
                    )}
                  </section>
                )
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1" aria-hidden="true" />
      )}

      {!isMobile && (
        <div
          data-testid="sidebar-settings-dock"
          className={`sidebar-settings-dock absolute bottom-0 left-0 right-0 border-t border-[var(--color-border)] p-3 ${expanded ? '' : 'flex justify-center'}`}
        >
          <NavItem
            active={activeTabId === SETTINGS_TAB_ID}
            collapsed={!expanded}
            label={t('sidebar.settings')}
            touchFriendly={isMobile}
            onClick={() => {
              useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
              closeMobileDrawer()
            }}
            icon={<span className="material-symbols-outlined text-[18px]">settings</span>}
          >
            {t('sidebar.settings')}
          </NavItem>
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed z-50 min-w-[140px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1"
          style={{ left: contextMenu.x, top: contextMenu.y, boxShadow: 'var(--shadow-dropdown)' }}
        >
          <button
            onClick={() => {
              const session = sessions.find((s) => s.id === contextMenu.id)
              handleStartRename(contextMenu.id, session?.title || '')
            }}
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('common.rename')}
          </button>
          <button
            onClick={() => handleDelete(contextMenu.id)}
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-error)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('common.delete')}
          </button>
          <button
            onClick={() => handleExportSession(contextMenu.id)}
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('sidebar.exportSession')}
          </button>
          <button
            onClick={() => handleCopySessionPath(contextMenu.id)}
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('sidebar.copySessionPath')}
          </button>
          {desktopHost.shell.showItemInFolder && (
            <button
              onClick={() => handleRevealSession(contextMenu.id)}
              className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              {t('sidebar.revealSession')}
            </button>
          )}
        </div>
      )}

      {projectContextMenu && (() => {
        const project = orderedProjectGroups.find((group) => group.key === projectContextMenu.key)
        if (!project) return null
        const pinned = pinnedProjectKeys.has(project.key)
        const hidden = hiddenProjectKeys.has(project.key)
        return (
          <div
            role="menu"
            className="fixed z-50 min-w-[230px] overflow-hidden rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-2 shadow-[var(--shadow-dropdown)]"
            style={positionProjectMenu(projectContextMenu.x, projectContextMenu.y)}
            onClick={(event) => event.stopPropagation()}
          >
            <ProjectMenuItem
              icon={pinned ? <PinOff size={18} aria-hidden="true" /> : <Pin size={18} aria-hidden="true" />}
              onClick={() => togglePinnedProject(project.key)}
            >
              {t(pinned ? 'sidebar.unpinProject' : 'sidebar.pinProject')}
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={<FolderOpen size={18} aria-hidden="true" />}
              onClick={() => void openProjectInFinder(project)}
            >
              {t('sidebar.openInFinder')}
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={<Upload size={18} aria-hidden="true" />}
              onClick={() => triggerImportSession(project)}
            >
              {t('sidebar.importSession')}
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={<Download size={18} aria-hidden="true" />}
              onClick={() => {
                setProjectContextMenu(null)
                enterBatchMode()
                const projectSessionIds = sessions
                  .filter((s) => (s.workDir || s.projectRoot || s.projectPath) === project.workDir)
                  .map((s) => s.id)
                selectSessions(projectSessionIds)
              }}
            >
              {t('sidebar.exportProjectSessions')}
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={hidden ? <RotateCcw size={18} aria-hidden="true" /> : <X size={18} aria-hidden="true" />}
              onClick={() => toggleHiddenProject(project)}
              danger={!hidden}
            >
              {t(hidden ? 'sidebar.restoreProjectToSidebar' : 'sidebar.hideProjectFromSidebar')}
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={<Trash2 size={18} aria-hidden="true" />}
              onClick={() => requestClearProjectSessions(project)}
              danger
            >
              {t('sidebar.clearProjectSessions')}
            </ProjectMenuItem>
          </div>
        )
      })()}

      {projectHeaderMenu && (
        <ProjectHeaderMenu
          type={projectHeaderMenu.type}
          x={projectHeaderMenu.x}
          y={projectHeaderMenu.y}
          organization={projectOrganization}
          sortBy={projectSortBy}
          onOpenSubmenu={openProjectHeaderSubmenu}
          onSetOrganization={updateProjectOrganization}
          onSetSortBy={updateProjectSortBy}
          onCreateBlank={() => void createSessionForWorkDir()}
          onUseExistingFolder={() => void createSessionFromExistingFolder()}
          onRestoreHiddenProjects={restoreAllHiddenProjects}
          hiddenProjectCount={hiddenProjectKeys.size}
          t={t}
        />
      )}

      {projectHeaderSubmenu && (
        <ProjectHeaderMenu
          type={projectHeaderSubmenu.type}
          x={projectHeaderSubmenu.x}
          y={projectHeaderSubmenu.y}
          organization={projectOrganization}
          sortBy={projectSortBy}
          onOpenSubmenu={openProjectHeaderSubmenu}
          onSetOrganization={updateProjectOrganization}
          onSetSortBy={updateProjectSortBy}
          onCreateBlank={() => void createSessionForWorkDir()}
          onUseExistingFolder={() => void createSessionFromExistingFolder()}
          onRestoreHiddenProjects={restoreAllHiddenProjects}
          hiddenProjectCount={hiddenProjectKeys.size}
          t={t}
        />
      )}

      <ConfirmDialog
        open={pendingDeleteSessionId !== null}
        onClose={() => setPendingDeleteSessionId(null)}
        onConfirm={confirmDelete}
        title={t('common.delete')}
        body={pendingDeleteSessionId ? t('sidebar.confirmDelete') : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
      />
      <ConfirmDialog
        open={pendingBatchDeleteSessionIds !== null}
        onClose={() => {
          if (!isBatchDeleting) setPendingBatchDeleteSessionIds(null)
        }}
        onConfirm={confirmBatchDelete}
        title={t('common.delete')}
        body={(
          <div className="space-y-3">
            <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
              {t('sidebar.batchDeleteConfirm', { count: pendingBatchDeleteSessionIds?.length ?? 0 })}
            </p>
            <div>
              <div className="mb-1.5 text-xs font-medium text-[var(--color-text-primary)]">
                {t('sidebar.batchDeleteConfirmBody')}
              </div>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2">
                {pendingBatchDeleteSessions.slice(0, 5).map((session) => (
                  <li key={session.id} className="truncate text-xs text-[var(--color-text-secondary)]">
                    {session.title || 'Untitled'}
                  </li>
                ))}
                {(pendingBatchDeleteSessionIds?.length ?? 0) > 5 && (
                  <li className="text-xs text-[var(--color-text-tertiary)]">
                    {t('sidebar.batchDeleteMore', { count: (pendingBatchDeleteSessionIds?.length ?? 0) - 5 })}
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isBatchDeleting}
      />
      <ConfirmDialog
        open={pendingClearProjectKey !== null}
        onClose={() => {
          if (!isClearingProject) setPendingClearProjectKey(null)
        }}
        onConfirm={confirmClearProjectSessions}
        title={t('sidebar.clearProjectSessions')}
        body={(() => {
          const project = pendingClearProjectKey
            ? orderedProjectGroups.find((g) => g.key === pendingClearProjectKey)
            : null
          if (!project) return ''
          return (
            <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
              {t('sidebar.clearProjectSessionsConfirm', {
                project: project.title,
                count: project.sessions.length,
              })}
            </p>
          )
        })()}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isClearingProject}
      />
      <input
        ref={importFileInputRef}
        type="file"
        accept=".jsonl,application/x-ndjson,application/jsonl"
        className="hidden"
        onChange={handleImportFileChange}
      />
      <GlobalSearchModal open={activeModal === 'globalSearch'} onClose={closeModal} />
    </aside>
  )
}

function useSessionListAutoRefresh(fetchSessions: () => Promise<void>): () => Promise<void> {
  const inFlightRef = useRef<Promise<void> | null>(null)
  const lastStartedAtRef = useRef(0)

  const refreshSessions = useCallback((force = false) => {
    if (inFlightRef.current) return inFlightRef.current

    const now = Date.now()
    if (!force && now - lastStartedAtRef.current < SESSION_LIST_FOCUS_REFRESH_MIN_MS) {
      return Promise.resolve()
    }

    lastStartedAtRef.current = now
    const request = Promise.resolve()
      .then(() => fetchSessions())
      .catch(() => undefined)
      .finally(() => {
        if (inFlightRef.current === request) {
          inFlightRef.current = null
        }
      })
    inFlightRef.current = request
    return request
  }, [fetchSessions])

  useEffect(() => {
    void refreshSessions(true)

    const refreshIfVisible = () => {
      if (!isDocumentVisible()) return
      void refreshSessions()
    }

    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    const timer = window.setInterval(() => {
      if (!isDocumentVisible()) return
      void refreshSessions(true)
    }, SESSION_LIST_AUTO_REFRESH_MS)

    return () => {
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.clearInterval(timer)
    }
  }, [refreshSessions])

  return useCallback(() => refreshSessions(true), [refreshSessions])
}