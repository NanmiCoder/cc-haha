import { useState, useRef, useEffect, useCallback, useMemo, useId } from 'react'
import { useDismissable } from '@/hooks/useDismissable'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'
import { useChatStore, type RepositoryLaunchDraftState } from '../../stores/chatStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useTeamStore } from '../../stores/teamStore'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  formatWorkspaceReferencePrompt,
  useWorkspaceChatContextStore,
  type WorkspaceChatReference,
} from '../../stores/workspaceChatContextStore'
import { sessionsApi, type SessionGitInfo } from '../../api/sessions'
import { agentsApi } from '../../api/agents'
import { PermissionModeSelector } from '../controls/PermissionModeSelector'
import { ModelSelector, type ModelSelectorHandle } from '../controls/ModelSelector'
import type { AttachmentRef } from '../../types/chat'
import { AttachmentGallery } from './AttachmentGallery'
import { ComposerDropOverlay } from './ComposerDropOverlay'
import { ProjectContextChip } from '@/components/chat/ProjectContextChip'
import { RepositoryLaunchControls } from '@/components/chat/RepositoryLaunchControls'
import { FileSearchMenu, type FileSearchMenuHandle } from './FileSearchMenu'
import { LocalSlashCommandPanel, type LocalSlashCommandName } from './LocalSlashCommandPanel'
import { getSlashCommandOptionId, SlashCommandMenu } from './SlashCommandMenu'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import {
  appendAgentSlashCommands,
  buildAgentSlashCommands,
  getLocalizedFallbackCommands,
  filterSlashCommands,
  findSlashTrigger,
  groupSlashCommands,
  mergeSlashCommands,
  replaceSlashToken,
  resolveSlashUiAction,
} from './composerUtils'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { useElementWidth } from '../../hooks/useElementWidth'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import {
  filesToComposerAttachments,
  getDataTransferFiles,
  selectNativeFileAttachments,
  type ComposerAttachment,
} from '../../lib/composerAttachments'
import { useComposerFileDrop } from './useComposerFileDrop'
import { shouldSubmitOnEnter } from './sendShortcut'
import { MentionComposer, type MentionComposerHandle } from './MentionComposer'
import {
  findMentionRanges,
  insertMentionIntoText,
  type ComposerMention,
} from '../../lib/composerMentions'
import type { PermissionMode } from '../../types/settings'
import { getSessionWorkspaceState } from '../../lib/sessionWorkspace'
import { hasRunningSubagentTasks } from '../../lib/backgroundTasks'

type GitInfo = SessionGitInfo

type Attachment = ComposerAttachment

type ChatInputProps = {
  variant?: 'default' | 'hero'
  compact?: boolean
}

const EMPTY_WORKSPACE_REFERENCES: WorkspaceChatReference[] = []

/**
 * Both thresholds are the composer column's own width, never "is the workspace
 * panel open". The panel is resizable and the window is not fixed, so its open
 * state says nothing about the width the composer actually got — a maximised
 * window with the panel open leaves the composer wider than a small window
 * with no panel at all, yet the panel-keyed rule sent the wide one to the
 * narrow layout and kept the narrow one wide.
 *
 * The number comes off the shipped toolbar with the longest mode label
 * ("Ask permissions" / 询问权限): the leading group measures 193px and the
 * trailing cluster 361px, which with the 32px round send button needs a 530px
 * column.
 *
 * There used to be a second, wider threshold here that dropped the send
 * button's label before the location went. The send button has no label to
 * drop any more — it is the same 32px circle at every width — so the location
 * is the only thing left that degrades.
 */
const TOOLBAR_LOCATION_MIN_WIDTH = 530

function workspaceReferenceToAttachment(reference: WorkspaceChatReference): Attachment {
  return {
    id: reference.id,
    name: reference.name,
    type: 'file',
    path: reference.kind === 'chat-selection' ? undefined : reference.path,
    isDirectory: reference.isDirectory,
    lineStart: reference.lineStart,
    lineEnd: reference.lineEnd,
    diffSide: reference.diffSide,
    hunkId: reference.hunkId,
    note: reference.note,
    quote: reference.quote,
  }
}

function insertComposerTokenAtRange(value: string, start: number, end: number, token: string) {
  const boundedStart = Math.max(0, Math.min(start, value.length))
  const boundedEnd = Math.max(boundedStart, Math.min(end, value.length))
  const before = value.slice(0, boundedStart)
  const after = value.slice(boundedEnd)
  const leadingSpace = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const trailingSpace = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const insertion = `${leadingSpace}${token}${trailingSpace}`

  return {
    value: `${before}${insertion}${after}`,
    cursorPos: before.length + insertion.length,
  }
}

export function ChatInput({ variant = 'default', compact = false }: ChatInputProps) {
  const t = useTranslation()
  const isMobileComposer = useMobileViewport() && !isDesktopRuntime()
  // The shell, not the panel inside it: the panel's own `max-w` changes with
  // the layout this measurement picks, which would make the observer chase
  // itself across the threshold. The shell just fills the chat column.
  const [shellRef, shellWidth] = useElementWidth<HTMLDivElement>()
  const [input, setInput] = useState('')
  const [mentions, setMentions] = useState<ComposerMention[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [localSlashPanel, setLocalSlashPanel] = useState<LocalSlashCommandName | null>(null)
  const [atFilter, setAtFilter] = useState('')
  const [atCursorPos, setAtCursorPos] = useState(-1)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [agentSlashCommands, setAgentSlashCommands] = useState<ReturnType<typeof buildAgentSlashCommands>>([])
  const [launchReady, setLaunchReady] = useState(true)
  const [launchTransitioning, setLaunchTransitioning] = useState(false)
  const [editingQueuedMessageId, setEditingQueuedMessageId] = useState<string | null>(null)
  const [editingQueuedMessageText, setEditingQueuedMessageText] = useState('')
  const composingRef = useRef(false)
  const composerRef = useRef<MentionComposerHandle>(null)
  const composerContainerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelSelectorRef = useRef<ModelSelectorHandle>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const fileSearchRef = useRef<FileSearchMenuHandle>(null)
  const slashItemRefs = useRef<(HTMLElement | null)[]>([])
  const slashMenuId = useId()
  const previousActiveTabIdRef = useRef<string | null>(null)
  const inputRef = useRef(input)
  const mentionsRef = useRef(mentions)
  const attachmentsRef = useRef(attachments)
  const pasteGenerationRef = useRef(0)
  const setComposerInput = useCallback((value: string, nextMentions?: ComposerMention[]) => {
    inputRef.current = value
    setInput(value)
    if (nextMentions !== undefined) {
      mentionsRef.current = nextMentions
      setMentions(nextMentions)
    }
  }, [])
  const setComposerAttachments = useCallback((value: Attachment[] | ((previous: Attachment[]) => Attachment[])) => {
    setAttachments((previous) => {
      const next = typeof value === 'function' ? value(previous) : value
      attachmentsRef.current = next
      return next
    })
  }, [])
  const {
    sendMessage,
    stopGeneration,
    clearComposerPrefill,
    clearComposerInsertion,
    queueUserMessage,
    updateQueuedUserMessage,
    removeQueuedUserMessage,
    sendQueuedUserMessage,
    setPreparingTurn,
  } = useChatStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeTabType = useTabStore((s) =>
    s.tabs.find((tab) => tab.sessionId === s.activeTabId)?.type,
  )
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  const repositoryLaunchDraft = sessionState?.repositoryLaunchDraft
  const launchWorkDir = repositoryLaunchDraft?.workDir ?? ''
  const launchBranch = repositoryLaunchDraft?.branch ?? null
  const launchUseWorktree = repositoryLaunchDraft?.useWorktree ?? false
  const chatState = sessionState?.chatState ?? 'idle'
  const isPreparingTurn = Boolean(sessionState?.isPreparingTurn)
  const slashCommands = sessionState?.slashCommands ?? []
  const composerPrefill = sessionState?.composerPrefill ?? null
  const composerInsertion = sessionState?.composerInsertion ?? null
  const queuedUserMessages = sessionState?.queuedUserMessages ?? []
  const runtimeSelection = useSessionRuntimeStore((state) =>
    activeTabId ? state.selections[activeTabId] : undefined,
  )
  const currentModel = useSettingsStore((state) => state.currentModel)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const runtimeSelectionKey = runtimeSelection
    ? `${runtimeSelection.providerId ?? 'official'}:${runtimeSelection.modelId}:${runtimeSelection.effortLevel ?? 'auto'}`
    : undefined
  const runtimeModelLabel = runtimeSelection?.modelId ?? currentModel?.name ?? currentModel?.id
  const activeSession = useSessionStore((state) => activeTabId ? state.sessions.find((session) => session.id === activeTabId) ?? null : null)
  const sessionProtocol = sessionState?.sessionApiFormat ?? activeSession?.sessionApiFormat
  const isProtocolBlocked = sessionProtocol === 'mixed' || sessionProtocol === 'unknown'
  const loadedMessageCount = sessionState?.messages?.length ?? 0
  const messageCount = Math.max(loadedMessageCount, activeSession?.messageCount ?? 0)
  const memberInfo = useTeamStore((s) => activeTabId ? s.getMemberBySessionId(activeTabId) : null)
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null)
  const workspaceReferences = useWorkspaceChatContextStore(
    (s) => activeTabId ? s.referencesBySession[activeTabId] ?? EMPTY_WORKSPACE_REFERENCES : EMPTY_WORKSPACE_REFERENCES,
  )
  const addWorkspaceReference = useWorkspaceChatContextStore((s) => s.addReference)
  const removeWorkspaceReference = useWorkspaceChatContextStore((s) => s.removeReference)
  const clearWorkspaceReferences = useWorkspaceChatContextStore((s) => s.clearReferences)
  const updateRepositoryLaunchDraft = useCallback((
    update: (current: RepositoryLaunchDraftState) => RepositoryLaunchDraftState,
  ) => {
    if (!activeTabId) return
    const chatStore = useChatStore.getState()
    const current = chatStore.sessions[activeTabId]?.repositoryLaunchDraft ?? {
      workDir: '',
      branch: null,
      useWorktree: false,
    }
    chatStore.setRepositoryLaunchDraft(activeTabId, update(current))
  }, [activeTabId])
  const setLaunchBranch = useCallback((branch: string | null) => {
    updateRepositoryLaunchDraft((current) => ({ ...current, branch }))
  }, [updateRepositoryLaunchDraft])
  const setLaunchUseWorktree = useCallback((useWorktree: boolean) => {
    updateRepositoryLaunchDraft((current) => ({ ...current, useWorktree }))
  }, [updateRepositoryLaunchDraft])
  const saveComposerDraft = useCallback((sessionId: string) => {
    const draft = {
      input: inputRef.current,
      attachments: attachmentsRef.current,
      mentions: mentionsRef.current,
    }
    const chatStore = useChatStore.getState()
    if (draft.input.length === 0 && draft.attachments.length === 0) {
      chatStore.clearComposerDraft(sessionId)
      return
    }
    chatStore.setComposerDraft(sessionId, draft)
  }, [])
  const invalidatePendingPastes = useCallback(() => {
    pasteGenerationRef.current += 1
  }, [])

  const isMemberSession = !!memberInfo || activeTabType === 'subagent'
  const isActive = chatState !== 'idle'
  const hasRunningSubagents = hasRunningSubagentTasks(sessionState?.backgroundAgentTasks)
  const workspaceState = getSessionWorkspaceState(activeSession)
  const isWorkspaceMissing = workspaceState !== 'available'
  const hasWorkspaceReferences = !isMemberSession && workspaceReferences.length > 0
  const isHeroComposer = variant === 'hero' && !isMemberSession && !compact
  const resolvedWorkDir = activeSession?.workDir || gitInfo?.workDir || undefined
  const showLaunchControls = !isMemberSession && messageCount === 0
  // Two different questions, and they used to share one answer.
  //
  // `useCompactChrome` is about context: the shell's padding, its top divider
  // and the toolbar's edge-to-edge band belong to the panel-beside-the-composer
  // and mobile layouts regardless of how much room those layouts got.
  //
  // `useCompactControls` is about room, so it asks the column how wide it is.
  // Until a measurement lands (jsdom, first paint) it defers to the caller's
  // `compact`, which keeps the pre-measurement frame from flashing the wrong
  // layout.
  const useCompactChrome = compact || isMobileComposer
  const fitsAtLeast = (minWidth: number) => shellWidth === null ? !compact : shellWidth >= minWidth
  const useCompactControls = isMobileComposer || !fitsAtLeast(TOOLBAR_LOCATION_MIN_WIDTH)
  const activeLaunchWorkDir = showLaunchControls ? (launchWorkDir || resolvedWorkDir || '') : (resolvedWorkDir || '')
  // The run location lives in the toolbar on the wide desktop composer, and it
  // stays there for the whole session: editable while the session is still a
  // draft, read-only once the first message lands. It used to jump from inside
  // the panel to a chip below it at that moment.
  //
  // Deliberately not keyed on `isHeroComposer`: ActiveSession only renders the
  // hero variant while the session is empty, so keying on it moved the location
  // out of the toolbar at the exact moment it was supposed to stay put — the
  // first message swaps the variant and the draft state in the same render.
  // The condition is the composer's width, not its variant — and now literally
  // so. It used to read `compact`, which ActiveSession wires to "is the
  // workspace panel open", so opening the panel dropped the location to a
  // second line on columns with hundreds of pixels to spare.
  const showLocationInToolbar = !useCompactControls && !isMemberSession
  const embedLaunchControlsInToolbar = showLocationInToolbar && showLaunchControls
  const pendingSlashUiAction = !isMemberSession && input.trim().startsWith('/')
    ? resolveSlashUiAction(input.trim().slice(1))
    : null
  const canSubmit = !isWorkspaceMissing && !isProtocolBlocked &&
    !launchTransitioning &&
    !isPreparingTurn &&
    (!showLaunchControls || launchReady || !!pendingSlashUiAction) &&
    (input.trim().length > 0 || (!isMemberSession && (attachments.length > 0 || hasWorkspaceReferences)))
  const composerAttachments = useMemo(
    () => [
      ...attachments,
      ...workspaceReferences.map(workspaceReferenceToAttachment),
    ],
    [attachments, workspaceReferences],
  )
  const slashCommandCount = slashCommands.length

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    const previousActiveTabId = previousActiveTabIdRef.current

    if (previousActiveTabId === activeTabId) return

    if (previousActiveTabId) {
      saveComposerDraft(previousActiveTabId)
    }

    const nextDraft = activeTabId ? useChatStore.getState().sessions[activeTabId]?.composerDraft : undefined
    invalidatePendingPastes()
    setComposerInput(nextDraft?.input ?? '', nextDraft?.mentions ?? [])
    setComposerAttachments(nextDraft?.attachments ?? [])
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setLocalSlashPanel(null)
    setSlashFilter('')
    setAtFilter('')
    setAtCursorPos(-1)
    setEditingQueuedMessageId(null)
    setEditingQueuedMessageText('')
    previousActiveTabIdRef.current = activeTabId
  }, [activeTabId, invalidatePendingPastes, saveComposerDraft, setComposerAttachments, setComposerInput])

  useEffect(() => {
    return () => {
      const currentActiveTabId = previousActiveTabIdRef.current
      if (currentActiveTabId) saveComposerDraft(currentActiveTabId)
    }
  }, [saveComposerDraft])

  useEffect(() => {
    mentionsRef.current = mentions
  }, [mentions])

  useEffect(() => {
    composerRef.current?.focus()
  }, [isActive])

  useEffect(() => {
    if (!composerPrefill || !activeTabId) return

    const nextAttachments = (composerPrefill.attachments ?? [])
      .filter((attachment) => attachment.type === 'image' || attachment.data)
      .map((attachment, index) => ({
        id: `composer-prefill-${composerPrefill.nonce}-${index}`,
        name: attachment.name,
        type: attachment.type,
        mimeType: attachment.mimeType,
        previewUrl: attachment.type === 'image' ? attachment.data : undefined,
        data: attachment.data,
      }))

    if (composerPrefill.mode === 'append') {
      setComposerAttachments((previous) => [...previous, ...nextAttachments])
    } else {
      setComposerInput(composerPrefill.text, [])
      setComposerAttachments(nextAttachments)
    }
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setSlashFilter('')
    setAtFilter('')
    setAtCursorPos(-1)

    requestAnimationFrame(() => {
      composerRef.current?.focus()
      if (composerPrefill.mode !== 'append') {
        composerRef.current?.setSelectionOffsets(composerPrefill.text.length)
      }
    })
    clearComposerPrefill(activeTabId, composerPrefill.nonce)
  }, [
    activeTabId,
    clearComposerPrefill,
    composerPrefill,
    setComposerAttachments,
    setComposerInput,
  ])

  useEffect(() => {
    if (!composerInsertion || !activeTabId || isMemberSession) return

    const currentInput = inputRef.current
    const offsets = composerRef.current?.getSelectionOffsets()
    const start = offsets?.start ?? currentInput.length
    const end = offsets?.end ?? start
    const next = insertComposerTokenAtRange(currentInput, start, end, composerInsertion.text)

    if (composerInsertion.reference) {
      addWorkspaceReference(activeTabId, composerInsertion.reference)
    }
    setComposerInput(next.value)
    setFileSearchOpen(false)
    setSlashMenuOpen(false)
    setAtFilter('')
    setAtCursorPos(-1)
    clearComposerInsertion(activeTabId, composerInsertion.nonce)

    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(next.cursorPos)
    })
  }, [
    activeTabId,
    addWorkspaceReference,
    clearComposerInsertion,
    composerInsertion,
    isMemberSession,
    setComposerInput,
  ])

  const refreshGitInfo = useCallback(() => {
    if (!activeTabId) {
      setGitInfo(null)
      return
    }
    if (isMemberSession) {
      setGitInfo(null)
      return
    }
    sessionsApi.getGitInfo(activeTabId).then(setGitInfo).catch(() => setGitInfo(null))
  }, [activeTabId, isMemberSession])

  useEffect(() => {
    refreshGitInfo()
  }, [refreshGitInfo])

  useEffect(() => {
    if (!activeTabId || isMemberSession || messageCount === 0) return
    const timeout = setTimeout(refreshGitInfo, chatState === 'idle' ? 0 : 500)
    return () => clearTimeout(timeout)
  }, [activeTabId, chatState, isMemberSession, messageCount, refreshGitInfo, slashCommandCount])

  useEffect(() => {
    if (!isMemberSession) return
    setComposerAttachments([])
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
  }, [isMemberSession, activeTabId])

  useEffect(() => {
    if (isMemberSession) {
      setAgentSlashCommands([])
      return
    }

    let cancelled = false
    agentsApi.list(resolvedWorkDir)
      .then(({ activeAgents }) => {
        if (cancelled) return
        setAgentSlashCommands(buildAgentSlashCommands(activeAgents))
      })
      .catch(() => {
        if (!cancelled) setAgentSlashCommands([])
      })

    return () => {
      cancelled = true
    }
  }, [isMemberSession, resolvedWorkDir])

  useEffect(() => {
    if (!activeTabId || !showLaunchControls) return
    const nextWorkDir = activeSession?.workDir || gitInfo?.workDir || ''
    const chatStore = useChatStore.getState()
    const current = chatStore.sessions[activeTabId]?.repositoryLaunchDraft
    if (current?.workDir === nextWorkDir) return
    chatStore.setRepositoryLaunchDraft(activeTabId, {
      workDir: nextWorkDir,
      branch: null,
      useWorktree: false,
    })
    setLaunchReady(!nextWorkDir)
  }, [activeSession?.workDir, activeTabId, gitInfo?.workDir, showLaunchControls])

  useDismissable({
    open: plusMenuOpen,
    refs: [plusMenuRef],
    onDismiss: () => setPlusMenuOpen(false),
  })

  useDismissable({
    open: slashMenuOpen,
    refs: [slashMenuRef, composerContainerRef],
    onDismiss: () => setSlashMenuOpen(false),
  })

  useDismissable({
    open: !!localSlashPanel,
    refs: [slashMenuRef, composerContainerRef],
    onDismiss: () => setLocalSlashPanel(null),
  })

  useDismissable({
    open: fileSearchOpen,
    refs: [composerContainerRef],
    onDismiss: () => setFileSearchOpen(false),
    // This menu is looked up by id rather than held in a ref. Returning true
    // when it is absent preserves the original behavior: with no menu in the
    // DOM, an outside press was ignored.
    isExempt: (target) => {
      const menu = document.getElementById('file-search-menu')
      if (!menu) return true
      return target instanceof Node && menu.contains(target)
    },
  })

  const allSlashCommands = useMemo(
    () => appendAgentSlashCommands(
      mergeSlashCommands(slashCommands, getLocalizedFallbackCommands(t)),
      agentSlashCommands,
    ),
    [agentSlashCommands, slashCommands, t],
  )

  const filteredCommandGroups = useMemo(() => {
    return groupSlashCommands(filterSlashCommands(allSlashCommands, slashFilter))
  }, [allSlashCommands, slashFilter])

  const filteredCommands = filteredCommandGroups.ordered
  const isSlashMenuVisible = !isMemberSession && slashMenuOpen && filteredCommands.length > 0

  const exactSlashCommand = useMemo(() => {
    const normalized = slashFilter.trim().toLowerCase()
    if (!normalized) return null
    return filteredCommands.find((command) => command.name.toLowerCase() === normalized) ?? null
  }, [filteredCommands, slashFilter])

  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [slashFilter])

  useEffect(() => {
    const activeItem = slashMenuOpen ? slashItemRefs.current[slashSelectedIndex] : null
    if (activeItem && typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ block: 'nearest' })
    }
  }, [slashMenuOpen, slashSelectedIndex])

  const detectSlashTrigger = useCallback((value: string, cursorPos: number) => {
    const token = findSlashTrigger(value, cursorPos)
    if (!token) {
      setSlashMenuOpen(false)
      return
    }

    setFileSearchOpen(false)
    setSlashFilter(token.filter)
    setSlashMenuOpen(true)
  }, [])

  // Detect @ trigger (file search). The scan runs on the projected text; an
  // `@` that belongs to an existing mention pill never counts as a trigger.
  const detectAtTrigger = useCallback((value: string, cursorPos: number, currentMentions: ComposerMention[]) => {
    const textBeforeCursor = value.slice(0, cursorPos)
    let pos = -1

    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
      const ch = textBeforeCursor[i]!
      if (ch === '@') {
        if (i === 0 || /\s/.test(textBeforeCursor[i - 1]!)) {
          pos = i
          break
        }
        break
      }
      if (/\s/.test(ch)) {
        break
      }
    }

    if (pos >= 0 && findMentionRanges(value, currentMentions).some((range) => pos >= range.start && pos < range.end)) {
      pos = -1
    }

    if (pos < 0) {
      setFileSearchOpen(false)
      setAtFilter('')
      setAtCursorPos(-1)
      return
    }

    // Extract filter text after @
    const filter = textBeforeCursor.slice(pos + 1)
    setAtFilter(filter)
    setAtCursorPos(pos)
    setSlashMenuOpen(false)
    setFileSearchOpen(true)
  }, [])

  const handleComposerChange = (text: string, nextMentions: ComposerMention[]) => {
    setComposerInput(text, nextMentions)
    if (isMemberSession) {
      return
    }
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? text.length
    detectSlashTrigger(text, cursorPos)
    detectAtTrigger(text, cursorPos, nextMentions)
  }

  const selectSlashCommand = useCallback((command: string) => {
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
    const replacement = replaceSlashToken(input, cursorPos, command)
    setComposerInput(replacement.value)
    setSlashMenuOpen(false)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(replacement.cursorPos)
    })
  }, [input])

  const replaceEmptySession = useCallback(async (
    workDir: string,
    repository?: { branch?: string | null; worktree?: boolean },
  ) => {
    if (!activeTabId) return null
    const oldId = activeTabId
    const sessionStore = useSessionStore.getState()
    const { createSession, deleteSession } = sessionStore
    const { replaceTabSession } = useTabStore.getState()
    const chatStore = useChatStore.getState()
    const {
      disconnectSession,
      connectToSession,
      setComposerDraft,
      setRepositoryLaunchDraft,
    } = chatStore
    const repositoryLaunchDraft = chatStore.sessions[oldId]?.repositoryLaunchDraft
    const permissionMode = sessionStore.sessions.find((session) => session.id === oldId)
      ?.permissionMode as PermissionMode | undefined
    const createOptions = repository || permissionMode
      ? {
          ...(repository ? { repository } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        }
      : undefined
    const newId = await createSession(
      workDir || undefined,
      createOptions,
    )
    if (inputRef.current.length > 0 || attachmentsRef.current.length > 0) {
      setComposerDraft(newId, {
        input: inputRef.current,
        attachments: attachmentsRef.current,
      })
    }
    if (repositoryLaunchDraft) {
      setRepositoryLaunchDraft(newId, repositoryLaunchDraft)
    }
    useSessionRuntimeStore.getState().moveSelection(oldId, newId)
    disconnectSession(oldId)
    replaceTabSession(oldId, newId)
    connectToSession(newId)
    deleteSession(oldId).catch(() => {})
    return newId
  }, [activeTabId])

  const handleLaunchWorkDirChange = useCallback(async (newWorkDir: string) => {
    updateRepositoryLaunchDraft(() => ({
      workDir: newWorkDir,
      branch: null,
      useWorktree: false,
    }))
    setLaunchReady(!newWorkDir)
    if (!activeTabId) return

    setLaunchTransitioning(true)
    try {
      await replaceEmptySession(newWorkDir)
    } catch (error) {
      useUIStore.getState().addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('empty.failedToCreate'),
      })
    } finally {
      setLaunchTransitioning(false)
    }
  }, [activeTabId, replaceEmptySession, t, updateRepositoryLaunchDraft])

  const handleSubmit = async () => {
    const text = input.trim()
    if (isProtocolBlocked) return
    if ((!text && ((!attachments.length && !hasWorkspaceReferences) || isMemberSession)) || isWorkspaceMissing) return

    if (pendingSlashUiAction?.type === 'panel') {
      setLocalSlashPanel(pendingSlashUiAction.command as LocalSlashCommandName)
      setComposerInput('', [])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (pendingSlashUiAction?.type === 'settings') {
      useUIStore.getState().setPendingSettingsTab(pendingSlashUiAction.tab)
      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
      setComposerInput('', [])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (pendingSlashUiAction?.type === 'model') {
      modelSelectorRef.current?.open()
      setComposerInput('', [])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (showLaunchControls && (!launchReady || launchTransitioning)) return

    const workspaceReferencePrompt = !isMemberSession
      ? formatWorkspaceReferencePrompt(workspaceReferences)
      : ''
    // Inline @-mentions travel as the `@"absolute path"` text the CLI already
    // parses. Serialized from the live document — only the doc knows which
    // `@label` is a pill and which is literal text the user typed.
    const serializedText = (composerRef.current?.getModelContent() ?? input).trim()
    const contentForModel = [workspaceReferencePrompt, serializedText].filter(Boolean).join('\n\n')
    const displayContent = text || (
      workspaceReferences.length > 0
        ? t('chat.contextReferencesOnly', { count: workspaceReferences.length })
        : ''
    )
    const uploadAttachmentPayload: AttachmentRef[] = attachments.map((attachment) => ({
      type: attachment.type,
      name: attachment.name,
      path: attachment.path,
      data: attachment.data,
      mimeType: attachment.mimeType,
      lineStart: attachment.lineStart,
      lineEnd: attachment.lineEnd,
      note: attachment.note,
      quote: attachment.quote,
    }))
    const workspaceAttachmentPayload: AttachmentRef[] = workspaceReferences
      .filter((reference) => reference.kind !== 'chat-selection')
      .map((reference) => ({
        type: 'file' as const,
        name: reference.name,
        path: reference.absolutePath ?? reference.path,
        isDirectory: reference.isDirectory,
        lineStart: reference.lineStart,
        lineEnd: reference.lineEnd,
        note: reference.note,
        quote: reference.quote,
      }))
    const visibleAttachmentPayload: AttachmentRef[] = [
      ...uploadAttachmentPayload,
      ...workspaceReferences.map((reference) => ({
        type: 'file' as const,
        name: reference.name,
        path: reference.kind === 'chat-selection' ? undefined : reference.path,
        isDirectory: reference.isDirectory,
        lineStart: reference.lineStart,
        lineEnd: reference.lineEnd,
        diffSide: reference.diffSide,
        hunkId: reference.hunkId,
        note: reference.note,
        quote: reference.quote,
      })),
    ]

    let targetSessionId = activeTabId!
    if (showLaunchControls && activeLaunchWorkDir && launchBranch) {
      const shouldReplaceForRepositoryLaunch =
        launchUseWorktree ||
        (gitInfo?.branch ? launchBranch !== gitInfo.branch : true)
      if (shouldReplaceForRepositoryLaunch) {
        setLaunchTransitioning(true)
        const placeholderSessionId = targetSessionId
        setPreparingTurn(placeholderSessionId, true)
        try {
          const newSessionId = await replaceEmptySession(activeLaunchWorkDir, {
            branch: launchBranch,
            worktree: launchUseWorktree,
          })
          if (!newSessionId) {
            setPreparingTurn(placeholderSessionId, false)
            return
          }
          targetSessionId = newSessionId
          // Keep the placeholder continuous across the old-id -> new-id swap.
          // sendMessage clears it in the same turn that appends the user row.
          setPreparingTurn(targetSessionId, true)
        } catch (error) {
          setPreparingTurn(placeholderSessionId, false)
          useUIStore.getState().addToast({
            type: 'error',
            message: error instanceof Error ? error.message : t('empty.failedToCreate'),
          })
          return
        } finally {
          setLaunchTransitioning(false)
        }
      }
    }

    const targetChatState = useChatStore.getState().sessions[targetSessionId]?.chatState ?? 'idle'
    if (!isMemberSession && targetChatState !== 'idle') {
      queueUserMessage(targetSessionId, {
        content: contentForModel,
        attachments: [...uploadAttachmentPayload, ...workspaceAttachmentPayload],
        displayContent,
        displayAttachments: visibleAttachmentPayload,
      })
    } else {
      sendMessage(targetSessionId, contentForModel, [...uploadAttachmentPayload, ...workspaceAttachmentPayload], {
        displayContent,
        displayAttachments: visibleAttachmentPayload,
      })
    }
    invalidatePendingPastes()
    setComposerInput('', [])
    setComposerAttachments([])
    const chatStore = useChatStore.getState()
    chatStore.clearComposerDraft(activeTabId!)
    chatStore.clearRepositoryLaunchDraft(activeTabId!)
    if (targetSessionId !== activeTabId) {
      chatStore.clearComposerDraft(targetSessionId)
      chatStore.clearRepositoryLaunchDraft(targetSessionId)
    }
    if (!isMemberSession) {
      clearWorkspaceReferences(activeTabId!)
      if (targetSessionId !== activeTabId) clearWorkspaceReferences(targetSessionId)
    }
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setLocalSlashPanel(null)
  }

  const handleComposerKeyDown = (event: KeyboardEvent): boolean => {
    // Ignore key events during IME composition (e.g. Chinese input method)
    if (composingRef.current || event.isComposing || event.keyCode === 229) return false

    // Route file search navigation keys to FileSearchMenu
    if (fileSearchOpen) {
      const key = event.key
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowRight' || key === 'Enter' || key === 'Tab' || key === 'Escape') {
        event.preventDefault()
        if (key === 'Escape') {
          setFileSearchOpen(false)
          setAtFilter('')
          setAtCursorPos(-1)
          return true
        }
        fileSearchRef.current?.handleKeyDown(event)
        return true
      }
      // Other keys (typing) should go to the editor - let ProseMirror handle them
      return false
    }

    if (localSlashPanel) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setLocalSlashPanel(null)
        return true
      }
    }

    if (slashMenuOpen && filteredCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
        return true
      }
      if (event.key === 'Enter') {
        const selected = filteredCommands[slashSelectedIndex]
        if (
          exactSlashCommand &&
          selected?.name.toLowerCase() === exactSlashCommand.name.toLowerCase() &&
          slashFilter.trim().toLowerCase() === exactSlashCommand.name.toLowerCase() &&
          shouldSubmitOnEnter(event, chatSendBehavior)
        ) {
          event.preventDefault()
          void handleSubmit()
          return true
        }
        event.preventDefault()
        if (selected) selectSlashCommand(selected.name)
        return true
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const selected = filteredCommands[slashSelectedIndex]
        if (selected) selectSlashCommand(selected.name)
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashMenuOpen(false)
        return true
      }
    }

    if (shouldSubmitOnEnter(event, chatSendBehavior)) {
      event.preventDefault()
      void handleSubmit()
      return true
    }
    return false
  }

  const handleComposerPaste = (event: ClipboardEvent): boolean => {
    if (isMemberSession) return false
    const files = event.clipboardData ? getDataTransferFiles(event.clipboardData) : []
    if (files.length === 0) return false

    event.preventDefault()
    const pasteGeneration = pasteGenerationRef.current
    const pastedSessionId = activeTabId
    void filesToComposerAttachments(files)
      .then((nextAttachments) => {
        if (pasteGeneration !== pasteGenerationRef.current) return
        if (pastedSessionId !== useTabStore.getState().activeTabId) return
        if (nextAttachments.length === 0) return
        setComposerAttachments((prev) => [...prev, ...nextAttachments])
      })
      .catch((error) => {
        console.warn('[attachments] Failed to read pasted files', error)
      })
    return true
  }

  const appendFiles = useCallback((files: FileList | File[]) => {
    void filesToComposerAttachments(files)
      .then((nextAttachments) => {
        if (nextAttachments.length === 0) return
        setComposerAttachments((prev) => [...prev, ...nextAttachments])
      })
      .catch((error) => {
        console.warn('[attachments] Failed to read selected files', error)
      })
  }, [setComposerAttachments])

  const appendAttachments = useCallback((nextAttachments: Attachment[]) => {
    if (nextAttachments.length === 0) return
    setComposerAttachments((prev) => [...prev, ...nextAttachments])
  }, [setComposerAttachments])

  const { isDragActive, dragHandlers } = useComposerFileDrop({
    disabled: isMemberSession || isWorkspaceMissing,
    panelRef,
    onAttachments: appendAttachments,
    onError: (error) => {
      console.warn('[attachments] Failed to read dropped files', error)
    },
  })

  const openAttachmentPicker = useCallback(() => {
    setPlusMenuOpen(false)
    if (!isDesktopRuntime()) {
      fileInputRef.current?.click()
      return
    }

    void selectNativeFileAttachments()
      .then((nativeAttachments) => {
        if (nativeAttachments) {
          if (nativeAttachments.length > 0) {
            setComposerAttachments((prev) => [...prev, ...nativeAttachments])
          }
          return
        }
        fileInputRef.current?.click()
      })
  }, [setComposerAttachments])

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (isMemberSession) return
    const files = event.target.files
    if (!files) return

    appendFiles(files)
    event.target.value = ''
  }

  const removeAttachment = (id: string) => {
    setComposerAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
    if (activeTabId) removeWorkspaceReference(activeTabId, id)
  }

  const startEditingQueuedMessage = (messageId: string, content: string) => {
    setEditingQueuedMessageId(messageId)
    setEditingQueuedMessageText(content)
  }

  const saveQueuedMessageEdit = () => {
    if (!activeTabId || !editingQueuedMessageId) return
    const nextContent = editingQueuedMessageText.trim()
    if (!nextContent) return
    updateQueuedUserMessage(activeTabId, editingQueuedMessageId, nextContent)
    setEditingQueuedMessageId(null)
    setEditingQueuedMessageText('')
  }

  const cancelQueuedMessageEdit = () => {
    setEditingQueuedMessageId(null)
    setEditingQueuedMessageText('')
  }

  const insertSlashCommand = () => {
    if (isMemberSession) return
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
    const replacement = replaceSlashToken(input, cursorPos, '', { trailingSpace: false })
    setComposerInput(replacement.value)
    setPlusMenuOpen(false)
    setSlashFilter('')
    setSlashMenuOpen(true)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(replacement.cursorPos)
    })
  }

  const composerPlaceholder =
    isHeroComposer
      ? t('empty.placeholder')
      : isWorkspaceMissing
        ? workspaceState === 'worktree_removed'
          ? t('chat.placeholderWorktreeRemoved')
          : t('chat.placeholderMissing')
        : isMemberSession
          ? t('teams.memberPlaceholder')
          : t('chat.placeholder')

  const addFilesLabel = isHeroComposer ? t('empty.addFiles') : t('chat.addFiles')
  const slashCommandsLabel = isHeroComposer ? t('empty.slashCommands') : t('chat.slashCommands')

  return (
    <div
      ref={shellRef}
      data-testid="chat-input-shell"
      data-session-id={activeTabId ?? undefined}
      className={
        isHeroComposer
          ? `bg-[var(--color-surface)] ${isMobileComposer ? 'px-4 pb-3' : 'px-8 pb-4'}`
          : compact
            ? `border-t border-[var(--color-border)] bg-[var(--color-surface)] ${isMobileComposer ? 'px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2' : 'px-3 py-3'}`
            : `bg-[var(--color-surface)] ${isMobileComposer ? 'px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2' : 'px-4 py-4'}`
      }
    >
      <div
        className={
          isHeroComposer
            ? 'mx-auto flex w-full max-w-3xl flex-col'
          : compact
              ? 'mx-auto max-w-full'
              // 900px matches the transcript column above it; at 860 the
              // composer sat 20px narrower on each side than the messages.
              : `${isMobileComposer ? 'mx-0 max-w-none' : 'mx-auto max-w-[900px]'}`
        }
      >
        {isProtocolBlocked && (
          <p role="alert" className="mb-2 text-sm text-[var(--color-text-secondary)]">
            {t(sessionProtocol === 'mixed' ? 'model.protocolMixed' : 'model.protocolUnknown')}
          </p>
        )}
        <div
          ref={panelRef}
          data-testid="chat-input-panel"
          // `glass-panel--composer` is the middle step of the shadow scale, the
          // one the handoff gives the composer; `--radius-2xl` (20px) is the
          // composer corner. Both match EmptySession's shell so the same
          // control does not render two different panels.
          className={isHeroComposer
            // Always fully rounded now: the launch controls used to be a bar
            // welded to the panel's bottom edge, which is what squared it off.
            // They are a single pill today — in the toolbar, or on their own
            // line below — so nothing butts against the panel any more.
            ? `glass-panel glass-panel--composer relative flex flex-col gap-3 overflow-visible rounded-[var(--radius-2xl)] p-4 transition-colors ${isDragActive ? 'composer-drop-target-active' : ''}`
            : compact
              ? `glass-panel glass-panel--composer relative overflow-visible rounded-[var(--radius-2xl)] p-3 transition-colors ${isDragActive ? 'composer-drop-target-active' : ''}`
              : `glass-panel glass-panel--composer relative overflow-visible rounded-[var(--radius-2xl)] transition-colors ${isMobileComposer ? 'p-3' : 'p-4'} ${isDragActive ? 'composer-drop-target-active' : ''}`}
          {...dragHandlers}
        >
          {isDragActive && (
            <ComposerDropOverlay
              testId="chat-input-drop-overlay"
              title={t('chat.dropFilesTitle')}
              description={t('chat.dropFilesHint')}
            />
          )}

          {!isMemberSession && fileSearchOpen && (
            <FileSearchMenu
              ref={fileSearchRef}
              cwd={activeLaunchWorkDir || resolvedWorkDir || ''}
              filter={atFilter}
              compact={isMobileComposer}
              onNavigate={(relativePath) => {
                if (atCursorPos < 0) return
                const replacement = `@${relativePath}`
                const tokenEnd = atCursorPos + 1 + atFilter.length
                const newValue = `${input.slice(0, atCursorPos)}${replacement}${input.slice(tokenEnd)}`
                const newCursorPos = atCursorPos + replacement.length
                setComposerInput(newValue)
                setAtFilter(relativePath)
                requestAnimationFrame(() => {
                  composerRef.current?.focus()
                  composerRef.current?.setSelectionOffsets(newCursorPos)
                })
              }}
              onSelect={(path, name, isDirectory) => {
                if (atCursorPos < 0) return
                const referenceName = name.split('/').filter(Boolean).pop() ?? name
                const tokenEnd = atCursorPos + 1 + atFilter.length
                const inserted = insertMentionIntoText(input, mentions, atCursorPos, tokenEnd, {
                  label: isDirectory ? `${referenceName}/` : referenceName,
                  path,
                  isDirectory,
                })
                setComposerInput(inserted.text, inserted.mentions)
                setFileSearchOpen(false)
                setAtFilter('')
                setAtCursorPos(-1)
                void composerRef.current?.focus()
                requestAnimationFrame(() => {
                  composerRef.current?.setSelectionOffsets(inserted.cursorPos)
                })
              }}
            />
          )}

          {!isMemberSession && localSlashPanel && (
            <div ref={slashMenuRef}>
              <LocalSlashCommandPanel
                command={localSlashPanel}
                sessionId={activeTabId ?? undefined}
                cwd={activeLaunchWorkDir || resolvedWorkDir}
                commands={allSlashCommands}
                onClose={() => setLocalSlashPanel(null)}
              />
            </div>
          )}

          {isSlashMenuVisible && (
            <SlashCommandMenu
              ref={slashMenuRef}
              id={slashMenuId}
              groups={filteredCommandGroups}
              selectedIndex={slashSelectedIndex}
              itemRefs={slashItemRefs}
              onSelect={selectSlashCommand}
              onHighlight={setSlashSelectedIndex}
              showKeyboardHints={!isMobileComposer}
            />
          )}

          {!isMemberSession && activeTabId && queuedUserMessages.length > 0 && (
            // Dashed outline cards stacked above the input, per §4 of the
            // handoff. They used to be a full-bleed filled strip pinned to the
            // panel's top edge, which read as part of the composer chrome
            // rather than as messages waiting their turn.
            <div
              data-testid="pending-user-message-list"
              className={`flex flex-col gap-1.5 ${isHeroComposer ? '' : 'mb-2'}`}
            >
              {queuedUserMessages.map((message) => {
                const isEditing = editingQueuedMessageId === message.id
                return (
                  <div
                    key={message.id}
                    data-testid="pending-user-message"
                    className={[
                      'flex min-w-0 items-center gap-2.5 rounded-[var(--radius-lg)] px-3.5 py-2',
                      // `--color-outline` rather than `--color-border`: a dashed
                      // line at the lighter weight all but disappears.
                      'border border-dashed border-[var(--color-outline)]',
                      'text-[13.5px] text-[var(--color-text-secondary)]',
                    ].join(' ')}
                  >
                    {/* The handoff labels the row in words rather than with a
                        glyph; the arrow icon here was a stand-in from before
                        the string existed. */}
                    <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">
                      {t('chat.pendingMessageQueuedLabel')}
                    </span>
                    {isEditing ? (
                      <>
                        <input
                          value={editingQueuedMessageText}
                          onChange={(event) => setEditingQueuedMessageText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              saveQueuedMessageEdit()
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelQueuedMessageEdit()
                            }
                          }}
                          aria-label={t('chat.pendingMessageEditInput')}
                          className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
                          autoFocus
                        />
                        <Button
                          variant="tonal"
                          size="sm"
                          onClick={saveQueuedMessageEdit}
                          disabled={!editingQueuedMessageText.trim()}
                          className="shrink-0 font-semibold"
                        >
                          {t('common.save')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={cancelQueuedMessageEdit}
                          className="shrink-0"
                        >
                          {t('common.cancel')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate font-medium" title={message.displayContent}>
                          {message.displayContent}
                        </span>
                        {/* The accent action of the three, per the handoff. */}
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => sendQueuedUserMessage(activeTabId, message.id)}
                          aria-label={t('chat.pendingMessageGuideNow')}
                          title={t('chat.pendingMessageGuideNow')}
                          className="shrink-0 font-semibold"
                          icon={<span className="material-symbols-outlined text-[15px]" aria-hidden="true">subdirectory_arrow_right</span>}
                        >
                          {t('chat.pendingMessageGuide')}
                        </Button>
                        <IconButton
                          icon="edit"
                          label={t('chat.pendingMessageEdit')}
                          size="sm"
                          tone="muted"
                          onClick={() => startEditingQueuedMessage(message.id, message.displayContent)}
                        />
                        <IconButton
                          icon="delete"
                          label={t('chat.pendingMessageDelete')}
                          size="sm"
                          tone="muted"
                          hoverTone="danger"
                          onClick={() => removeQueuedUserMessage(activeTabId, message.id)}
                        />
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {composerAttachments.length > 0 && (
            isHeroComposer ? (
              <AttachmentGallery attachments={composerAttachments} variant="composer" onRemove={removeAttachment} />
            ) : (
              <div className="px-3 pt-3">
                <AttachmentGallery attachments={composerAttachments} variant="composer" onRemove={removeAttachment} />
              </div>
            )
          )}

          {isHeroComposer ? (
            <div className="flex items-start gap-3">
              <MentionComposer
                ref={composerRef}
                rootRef={composerContainerRef}
                value={input}
                mentions={mentions}
                onChange={handleComposerChange}
                onKeyDown={handleComposerKeyDown}
                onPaste={handleComposerPaste}
                onCompositionStart={() => { composingRef.current = true }}
                onCompositionEnd={() => { composingRef.current = false }}
                placeholder={composerPlaceholder}
                disabled={isWorkspaceMissing || launchTransitioning || isPreparingTurn}
                className="flex-1"
                editorClassName="max-h-[200px] overflow-y-auto py-2 leading-relaxed text-[var(--color-text-primary)]"
                aria={{
                  role: isSlashMenuVisible ? 'combobox' : 'textbox',
                  'aria-autocomplete': isSlashMenuVisible ? 'list' : undefined,
                  'aria-expanded': isSlashMenuVisible ? 'true' : undefined,
                  'aria-controls': isSlashMenuVisible ? slashMenuId : undefined,
                  'aria-activedescendant': isSlashMenuVisible
                    ? getSlashCommandOptionId(slashMenuId, slashSelectedIndex)
                    : undefined,
                }}
              />
            </div>
          ) : (
            <MentionComposer
              ref={composerRef}
              rootRef={composerContainerRef}
              value={input}
              mentions={mentions}
              onChange={handleComposerChange}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              placeholder={composerPlaceholder}
              disabled={isWorkspaceMissing || launchTransitioning || isPreparingTurn}
              editorClassName={`max-h-[200px] overflow-y-auto text-sm leading-relaxed text-[var(--color-text-primary)] ${
                useCompactChrome ? 'py-1.5' : 'py-2'
              }`}
              aria={{
                role: isSlashMenuVisible ? 'combobox' : 'textbox',
                'aria-autocomplete': isSlashMenuVisible ? 'list' : undefined,
                'aria-expanded': isSlashMenuVisible ? 'true' : undefined,
                'aria-controls': isSlashMenuVisible ? slashMenuId : undefined,
                'aria-activedescendant': isSlashMenuVisible
                  ? getSlashCommandOptionId(slashMenuId, slashSelectedIndex)
                  : undefined,
              }}
            />
          )}

          {/*
            The wide composer keeps one geometry for the whole session. The
            draft and the live session used to render two different rows — the
            draft's divider was inset inside the panel's padding, the live one
            ran edge to edge over a `-mx-4 -mb-4` band — so the first message
            shifted every control left by 4px and widened the divider by 34px.
            The hero spacing wins because EmptySession renders the same row.
            Its top gap comes from the panel's own `flex-col gap-3`, which the
            live panel does not have, so that one repeats here as `mt-3`.
            The narrow layouts keep the band: `p-3` leaves too little room to
            spend on inset, and they never swap variants mid-session anyway.
            The band is keyed to the chrome, not to the control layout — its
            `-mx-3` has to cancel the panel's `p-3` exactly, and the panel is
            padded by the same chrome rule.
          */}
          <div data-testid="chat-input-toolbar" className={`flex items-center justify-between ${
            isHeroComposer
              ? 'pt-3'
              : useCompactChrome
                ? `mt-2 -mx-3 -mb-3 px-2.5 py-2 ${isMobileComposer ? 'gap-1' : 'gap-2'}`
                : 'mt-3 pt-3'
          }`}>
            <div
              data-testid="chat-input-toolbar-leading"
              className={`flex min-w-0 items-center ${isMobileComposer ? 'shrink-0 gap-1' : 'gap-2'}`}
            >
              {!isMemberSession && (
                <>
                  <div ref={plusMenuRef} className="relative">
                    {/*
                      Not `IconButton`: the mobile composer pins 44px touch
                      targets (`h-11 w-11`), and the component's largest size is
                      40px. Shrinking it would regress the very thing the
                      "larger icon-only mobile action buttons" test guards.
                    */}
                    <button
                      type="button"
                      onClick={() => setPlusMenuOpen((value) => !value)}
                      aria-label={t('chat.composerTools')}
                      aria-expanded={plusMenuOpen}
                      // Bordered on desktop so the tools affordance reads as a
                      // control at rest, not only on hover — it sits next to
                      // the permission chip, which is bordered too.
                      className={`inline-flex items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${isMobileComposer ? 'h-11 w-11' : 'h-8 w-8 border border-[var(--color-border)]'}`}
                    >
                      <span className="material-symbols-outlined text-[18px]">add</span>
                    </button>

                    {plusMenuOpen && (
                      <div className={`absolute bottom-full left-0 z-[var(--z-dropdown)] mb-2 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1.5 shadow-[var(--shadow-overlay)] ${isMobileComposer ? 'w-[min(240px,calc(100vw-32px))]' : 'w-[240px]'}`}>
                        <button
                          onClick={openAttachmentPicker}
                          className="flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">attach_file</span>
                          <span className="text-sm text-[var(--color-text-primary)]">{addFilesLabel}</span>
                        </button>
                        <button
                          onClick={insertSlashCommand}
                          className="flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="w-[24px] text-center text-[18px] font-bold text-[var(--color-text-secondary)]">/</span>
                          <span className="text-sm text-[var(--color-text-primary)]">{slashCommandsLabel}</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <PermissionModeSelector compact={useCompactControls} />

                  {showLocationInToolbar && (
                    embedLaunchControlsInToolbar ? (
                      <RepositoryLaunchControls
                        workDir={activeLaunchWorkDir}
                        onWorkDirChange={handleLaunchWorkDirChange}
                        branch={launchBranch}
                        onBranchChange={setLaunchBranch}
                        useWorktree={launchUseWorktree}
                        onUseWorktreeChange={setLaunchUseWorktree}
                        onLaunchReadyChange={setLaunchReady}
                        disabled={isActive || launchTransitioning}
                        placement="toolbar"
                      />
                    ) : (
                      <ProjectContextChip
                        workDir={resolvedWorkDir}
                        projectRoot={activeSession?.projectRoot}
                        repoName={gitInfo?.repoName || null}
                        branch={gitInfo?.branch || null}
                        sourceWorkDir={gitInfo?.worktree?.sourceWorkDir || null}
                        isWorktree={!!gitInfo?.worktree?.enabled}
                        worktreeSlug={gitInfo?.worktree?.slug || null}
                        worktreePath={gitInfo?.worktree?.path || gitInfo?.worktree?.plannedPath || null}
                        variant="toolbar"
                      />
                    )
                  )}
                </>
              )}
            </div>

            <div
              data-testid="chat-input-toolbar-trailing"
              className={`flex min-w-0 items-center ${isMobileComposer ? 'flex-1 justify-end gap-1' : 'shrink-0 gap-2'}`}
            >
              {!isMemberSession && activeTabId && (
                <ContextUsageIndicator
                  sessionId={activeTabId}
                  chatState={chatState}
                  messageCount={messageCount}
                  runtimeSelectionKey={runtimeSelectionKey}
                  fallbackModelLabel={runtimeModelLabel}
                  compact={useCompactControls}
                  refreshNonce={
                    (sessionState?.compactCount ?? 0) +
                    (sessionState?.runtimeConfigReadyCount ?? 0)
                  }
                />
              )}
              {!isMemberSession && activeTabId && (
                <ModelSelector
                  ref={modelSelectorRef}
                  runtimeKey={activeTabId}
                  disabled={isActive}
                  compact={useCompactControls}
                  fluid={isMobileComposer}
                />
              )}
              {!isMemberSession && !isActive && hasRunningSubagents ? (
                <Button
                  variant="danger"
                  size="base"
                  shape="circle"
                  onClick={() => stopGeneration(activeTabId!)}
                  aria-label={t('common.stop')}
                  title={t('chat.stopTitle')}
                  className={`shrink-0 ${isMobileComposer ? 'h-11 w-11' : ''}`}
                  icon={(
                    <span className="material-symbols-outlined text-[18px]">
                      stop
                    </span>
                  )}
                />
              ) : null}
              {/* Same component, shape and icon as EmptySession's send button.
                  The two rendered mirror images of each other until it was
                  spotted in a walkthrough — the arrow led here and trailed
                  there, on what is the same button to the user.

                  A round icon-only target rather than a labelled pill: the
                  label said "run" while every other composer control on the row
                  is already icon-only, and the width it cost was the widest
                  fixed block in a toolbar that has to fit a model picker and a
                  location chip. The arrow points *up* — into the transcript the
                  message is being sent to — which is also what makes it read as
                  send without a word next to it. Dropping the label is why the
                  name now lives only in `aria-label`, on both breakpoints. */}
              <Button
                variant={!isMemberSession && isActive ? 'danger' : 'accent'}
                size="base"
                shape="circle"
                onClick={!isMemberSession && isActive ? () => stopGeneration(activeTabId!) : handleSubmit}
                disabled={!isMemberSession && isActive ? false : !canSubmit}
                aria-label={!isMemberSession && isActive ? t('common.stop') : isMemberSession ? t('common.send') : t('common.run')}
                title={
                  !isMemberSession && isActive
                    ? t('chat.stopTitle')
                    : isMemberSession
                      ? t('common.send')
                      : t('common.run')
                }
                // 44px on touch is the platform minimum for a primary target;
                // the desktop circle stays at the size's own 32px.
                className={`shrink-0 ${isMobileComposer ? 'h-11 w-11' : ''}`}
                icon={(
                  <span className="material-symbols-outlined text-[18px]">
                    {!isMemberSession && isActive ? 'stop' : 'arrow_upward'}
                  </span>
                )}
              />
            </div>
          </div>

        </div>

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

        {!isMemberSession && !showLocationInToolbar && (
          <div className={useCompactControls ? 'mt-2 flex min-w-0 px-1' : 'mt-3 px-1'}>
            {messageCount > 0 ? (
              <ProjectContextChip
                workDir={resolvedWorkDir}
                projectRoot={activeSession?.projectRoot}
                repoName={gitInfo?.repoName || null}
                branch={gitInfo?.branch || null}
                sourceWorkDir={gitInfo?.worktree?.sourceWorkDir || null}
                isWorktree={!!gitInfo?.worktree?.enabled}
                worktreeSlug={gitInfo?.worktree?.slug || null}
                worktreePath={gitInfo?.worktree?.path || gitInfo?.worktree?.plannedPath || null}
                compact={useCompactControls}
              />
            ) : (
              <RepositoryLaunchControls
                workDir={activeLaunchWorkDir}
                onWorkDirChange={handleLaunchWorkDirChange}
                branch={launchBranch}
                onBranchChange={setLaunchBranch}
                useWorktree={launchUseWorktree}
                onUseWorktreeChange={setLaunchUseWorktree}
                onLaunchReadyChange={setLaunchReady}
                disabled={isActive || launchTransitioning}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
