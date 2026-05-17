import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
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
import { PermissionModeSelector } from '../controls/PermissionModeSelector'
import { ModelSelector } from '../controls/ModelSelector'
import type { AttachmentRef } from '../../types/chat'
import { AttachmentGallery } from './AttachmentGallery'
import { ComposerDropOverlay } from './ComposerDropOverlay'
import { ProjectContextChip } from '../shared/ProjectContextChip'
import { RepositoryLaunchControls } from '../shared/RepositoryLaunchControls'
import { FileSearchMenu, type FileSearchMenuHandle } from './FileSearchMenu'
import { LocalSlashCommandPanel, type LocalSlashCommandName } from './LocalSlashCommandPanel'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import {
  FALLBACK_SLASH_COMMANDS,
  filterSlashCommands,
  findSlashTrigger,
  mergeSlashCommands,
  replaceSlashToken,
  resolveSlashUiAction,
} from './composerUtils'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { isTauriRuntime } from '../../lib/desktopRuntime'
import {
  filesToComposerAttachments,
  selectNativeFileAttachments,
  type ComposerAttachment,
} from '../../lib/composerAttachments'
import { useComposerFileDrop } from './useComposerFileDrop'

type GitInfo = SessionGitInfo

type Attachment = ComposerAttachment

type ComposerDraft = {
  input: string
  attachments: Attachment[]
}

type ChatInputProps = {
  variant?: 'default' | 'hero'
  compact?: boolean
}

const EMPTY_WORKSPACE_REFERENCES: WorkspaceChatReference[] = []

function workspaceReferenceToAttachment(reference: WorkspaceChatReference): Attachment {
  return {
    id: reference.id,
    name: reference.name,
    type: 'file',
    path: reference.kind === 'chat-selection' ? undefined : reference.path,
    isDirectory: reference.isDirectory,
    lineStart: reference.lineStart,
    lineEnd: reference.lineEnd,
    note: reference.note,
    quote: reference.quote,
  }
}

export function ChatInput({ variant = 'default', compact = false }: ChatInputProps) {
  const t = useTranslation()
  const isMobileComposer = useMobileViewport() && !isTauriRuntime()
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [localSlashPanel, setLocalSlashPanel] = useState<LocalSlashCommandName | null>(null)
  const [atFilter, setAtFilter] = useState('')
  const [atCursorPos, setAtCursorPos] = useState(-1)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [launchWorkDir, setLaunchWorkDir] = useState('')
  const [launchBranch, setLaunchBranch] = useState<string | null>(null)
  const [launchUseWorktree, setLaunchUseWorktree] = useState(false)
  const [launchReady, setLaunchReady] = useState(true)
  const [launchTransitioning, setLaunchTransitioning] = useState(false)
  const composingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const fileSearchRef = useRef<FileSearchMenuHandle>(null)
  const slashItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const composerDraftsRef = useRef<Record<string, ComposerDraft>>({})
  const previousActiveTabIdRef = useRef<string | null>(null)
  const inputRef = useRef(input)
  const attachmentsRef = useRef(attachments)
  const setComposerInput = useCallback((value: string) => {
    inputRef.current = value
    setInput(value)
  }, [])
  const setComposerAttachments = useCallback((value: Attachment[] | ((previous: Attachment[]) => Attachment[])) => {
    setAttachments((previous) => {
      const next = typeof value === 'function' ? value(previous) : value
      attachmentsRef.current = next
      return next
    })
  }, [])
  const { sendMessage, stopGeneration } = useChatStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  const chatState = sessionState?.chatState ?? 'idle'
  const slashCommands = sessionState?.slashCommands ?? []
  const composerPrefill = sessionState?.composerPrefill ?? null
  const runtimeSelection = useSessionRuntimeStore((state) =>
    activeTabId ? state.selections[activeTabId] : undefined,
  )
  const currentModel = useSettingsStore((state) => state.currentModel)
  const runtimeSelectionKey = runtimeSelection
    ? `${runtimeSelection.providerId ?? 'official'}:${runtimeSelection.modelId}`
    : undefined
  const runtimeModelLabel = runtimeSelection?.modelId ?? currentModel?.name ?? currentModel?.id
  const activeSession = useSessionStore((state) => activeTabId ? state.sessions.find((session) => session.id === activeTabId) ?? null : null)
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

  const isMemberSession = !!memberInfo
  const isActive = chatState !== 'idle'
  const isWorkspaceMissing = activeSession?.workDirExists === false
  const hasWorkspaceReferences = !isMemberSession && workspaceReferences.length > 0
  const isHeroComposer = variant === 'hero' && !isMemberSession && !compact
  const resolvedWorkDir = activeSession?.workDir || gitInfo?.workDir || undefined
  const showLaunchControls = !isMemberSession && messageCount === 0
  const useCompactControls = compact || isMobileComposer
  const iconOnlyAction = compact || isMobileComposer
  const activeLaunchWorkDir = showLaunchControls ? (launchWorkDir || resolvedWorkDir || '') : (resolvedWorkDir || '')
  const embedLaunchControlsInHero = isHeroComposer && !useCompactControls && showLaunchControls
  const pendingSlashUiAction = !isMemberSession && input.trim().startsWith('/')
    ? resolveSlashUiAction(input.trim().slice(1))
    : null
  const canSubmit = !isWorkspaceMissing &&
    !launchTransitioning &&
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
      composerDraftsRef.current[previousActiveTabId] = {
        input: inputRef.current,
        attachments: attachmentsRef.current,
      }
    }

    const nextDraft = activeTabId ? composerDraftsRef.current[activeTabId] : undefined
    setComposerInput(nextDraft?.input ?? '')
    setComposerAttachments(nextDraft?.attachments ?? [])
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setLocalSlashPanel(null)
    setSlashFilter('')
    setAtFilter('')
    setAtCursorPos(-1)
    previousActiveTabIdRef.current = activeTabId
  }, [activeTabId, setComposerAttachments, setComposerInput])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [isActive])

  useEffect(() => {
    if (!composerPrefill) return

    setComposerInput(composerPrefill.text)
    setComposerAttachments(
      (composerPrefill.attachments ?? [])
        .filter((attachment) => attachment.type === 'image' || attachment.data)
        .map((attachment, index) => ({
          id: `rewind-prefill-${composerPrefill.nonce}-${index}`,
          name: attachment.name,
          type: attachment.type,
          mimeType: attachment.mimeType,
          previewUrl: attachment.type === 'image' ? attachment.data : undefined,
          data: attachment.data,
        })),
    )
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setSlashFilter('')
    setAtFilter('')
    setAtCursorPos(-1)

    requestAnimationFrame(() => {
      const el = textareaRef.current
      el?.focus()
      const cursor = composerPrefill.text.length
      el?.setSelectionRange(cursor, cursor)
    })
  }, [composerPrefill, setComposerAttachments, setComposerInput])

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
    if (!showLaunchControls) return
    const nextWorkDir = activeSession?.workDir || gitInfo?.workDir || ''
    setLaunchWorkDir((current) => {
      if (current === nextWorkDir) return current
      setLaunchBranch(null)
      setLaunchUseWorktree(false)
      setLaunchReady(!nextWorkDir)
      return nextWorkDir
    })
  }, [activeSession?.workDir, activeTabId, gitInfo?.workDir, showLaunchControls])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [input])

  useEffect(() => {
    if (!plusMenuOpen) return
    const handleClick = (event: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(event.target as Node)) {
        setPlusMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [plusMenuOpen])

  useEffect(() => {
    if (!slashMenuOpen) return
    const handleClick = (event: MouseEvent) => {
      if (
        slashMenuRef.current &&
        !slashMenuRef.current.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setSlashMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [slashMenuOpen])

  useEffect(() => {
    if (!localSlashPanel) return
    const handleClick = (event: MouseEvent) => {
      if (
        slashMenuRef.current &&
        !slashMenuRef.current.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setLocalSlashPanel(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [localSlashPanel])

  useEffect(() => {
    if (!fileSearchOpen) return
    const handleClick = (event: MouseEvent) => {
      const menu = document.getElementById('file-search-menu')
      if (
        menu &&
        !menu.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setFileSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [fileSearchOpen])

  const allSlashCommands = useMemo(
    () => mergeSlashCommands(slashCommands, FALLBACK_SLASH_COMMANDS),
    [slashCommands],
  )

  const filteredCommands = useMemo(() => {
    return filterSlashCommands(allSlashCommands, slashFilter)
  }, [allSlashCommands, slashFilter])

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

  // Detect @ trigger (file search)
  const detectAtTrigger = useCallback((value: string, cursorPos: number) => {
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

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value
    if (isMemberSession) {
      setComposerInput(value)
      return
    }
    const cursorPos = event.target.selectionStart ?? value.length
    setComposerInput(value)
    detectSlashTrigger(value, cursorPos)
    detectAtTrigger(value, cursorPos)
  }

  const selectSlashCommand = useCallback((command: string) => {
    const el = textareaRef.current
    if (!el) return
    const cursorPos = el.selectionStart ?? input.length
    const replacement = replaceSlashToken(input, cursorPos, command)
    setComposerInput(replacement.value)
    setSlashMenuOpen(false)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(replacement.cursorPos, replacement.cursorPos)
    })
  }, [input])

  const replaceEmptySession = useCallback(async (
    workDir: string,
    repository?: { branch?: string | null; worktree?: boolean },
  ) => {
    if (!activeTabId) return null
    const oldId = activeTabId
    const { createSession, deleteSession } = useSessionStore.getState()
    const { replaceTabSession } = useTabStore.getState()
    const { disconnectSession, connectToSession } = useChatStore.getState()
    const newId = await createSession(
      workDir || undefined,
      repository ? { repository } : undefined,
    )
    useSessionRuntimeStore.getState().moveSelection(oldId, newId)
    disconnectSession(oldId)
    replaceTabSession(oldId, newId)
    connectToSession(newId)
    deleteSession(oldId).catch(() => {})
    return newId
  }, [activeTabId])

  const handleLaunchWorkDirChange = useCallback(async (newWorkDir: string) => {
    setLaunchWorkDir(newWorkDir)
    setLaunchBranch(null)
    setLaunchUseWorktree(false)
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
  }, [activeTabId, replaceEmptySession, t])

  const handleSubmit = async () => {
    const text = input.trim()
    if ((!text && ((!attachments.length && !hasWorkspaceReferences) || isMemberSession)) || isWorkspaceMissing) return

    if (pendingSlashUiAction?.type === 'panel') {
      setLocalSlashPanel(pendingSlashUiAction.command as LocalSlashCommandName)
      setComposerInput('')
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (pendingSlashUiAction?.type === 'settings') {
      useUIStore.getState().setPendingSettingsTab(pendingSlashUiAction.tab)
      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
      setComposerInput('')
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (showLaunchControls && (!launchReady || launchTransitioning)) return

    const workspaceReferencePrompt = !isMemberSession
      ? formatWorkspaceReferencePrompt(workspaceReferences)
      : ''
    const contentForModel = [workspaceReferencePrompt, text].filter(Boolean).join('\n\n')
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
        try {
          const newSessionId = await replaceEmptySession(activeLaunchWorkDir, {
            branch: launchBranch,
            worktree: launchUseWorktree,
          })
          if (!newSessionId) return
          targetSessionId = newSessionId
        } catch (error) {
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

    sendMessage(targetSessionId, contentForModel, [...uploadAttachmentPayload, ...workspaceAttachmentPayload], {
      displayContent,
      displayAttachments: visibleAttachmentPayload,
    })
    setComposerInput('')
    setComposerAttachments([])
    if (!isMemberSession) {
      clearWorkspaceReferences(activeTabId!)
      if (targetSessionId !== activeTabId) clearWorkspaceReferences(targetSessionId)
    }
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setLocalSlashPanel(null)
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Ignore key events during IME composition (e.g. Chinese input method)
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return

    // Route file search navigation keys to FileSearchMenu
    if (fileSearchOpen) {
      const key = event.key
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowRight' || key === 'Enter' || key === 'Tab' || key === 'Escape') {
        event.preventDefault()
        if (key === 'Escape') {
          setFileSearchOpen(false)
          setAtFilter('')
          setAtCursorPos(-1)
          return
        }
        fileSearchRef.current?.handleKeyDown(event.nativeEvent)
        return
      }
      // Other keys (typing) should go to the textarea - let it propagate
      return
    }

    if (localSlashPanel) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setLocalSlashPanel(null)
        return
      }
    }

    if (slashMenuOpen && filteredCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (event.key === 'Enter') {
        if (exactSlashCommand && slashFilter.trim().toLowerCase() === exactSlashCommand.name.toLowerCase()) {
          event.preventDefault()
          handleSubmit()
          return
        }
        event.preventDefault()
        const selected = filteredCommands[slashSelectedIndex]
        if (selected) selectSlashCommand(selected.name)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const selected = filteredCommands[slashSelectedIndex]
        if (selected) selectSlashCommand(selected.name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashMenuOpen(false)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit()
    }
  }

  const handlePaste = (event: React.ClipboardEvent) => {
    if (isMemberSession) return
    const items = event.clipboardData?.items
    if (!items) return

    let hasImage = false
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (!item || !item.type.startsWith('image/')) continue

      hasImage = true
      event.preventDefault()
      const file = item.getAsFile()
      if (!file) continue

      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const reader = new FileReader()
      reader.onload = () => {
        setComposerAttachments((prev) => [
          ...prev,
          {
            id,
            name: `pasted-image-${Date.now()}.png`,
            type: 'image',
            mimeType: file.type || 'image/png',
            previewUrl: reader.result as string,
            data: reader.result as string,
          },
        ])
      }
      reader.readAsDataURL(file)
    }

    if (!hasImage) return
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
    if (!isTauriRuntime()) {
      fileInputRef.current?.click()
      setPlusMenuOpen(false)
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
      .finally(() => setPlusMenuOpen(false))
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

  const insertSlashCommand = () => {
    if (isMemberSession) return
    const el = textareaRef.current
    const cursorPos = el?.selectionStart ?? input.length
    const replacement = replaceSlashToken(input, cursorPos, '', { trailingSpace: false })
    setComposerInput(replacement.value)
    setPlusMenuOpen(false)
    setSlashFilter('')
    setSlashMenuOpen(true)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(replacement.cursorPos, replacement.cursorPos)
    })
  }

  const composerPlaceholder =
    isHeroComposer
      ? t('empty.placeholder')
      : isWorkspaceMissing
        ? t('chat.placeholderMissing')
        : isMemberSession
          ? t('teams.memberPlaceholder')
          : t('chat.placeholder')

  const addFilesLabel = isHeroComposer ? t('empty.addFiles') : t('chat.addFiles')
  const slashCommandsLabel = isHeroComposer ? t('empty.slashCommands') : t('chat.slashCommands')

  return (
    <div
      data-testid="chat-input-shell"
      className={
        isHeroComposer
          ? `bg-[var(--color-surface)] ${isMobileComposer ? 'px-4 pb-3' : 'px-8 pb-4'}`
          : compact
            ? `border-t border-[var(--color-border)]/70 bg-[var(--color-surface)] ${isMobileComposer ? 'px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2' : 'px-3 py-3'}`
            : `bg-[var(--color-surface)] ${isMobileComposer ? 'px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2' : 'px-4 py-4'}`
      }
    >
      <div
        className={
          isHeroComposer
            ? 'mx-auto flex w-full max-w-3xl flex-col'
          : compact
              ? 'mx-auto max-w-full'
              : `${isMobileComposer ? 'mx-0 max-w-none' : 'mx-auto max-w-[860px]'}`
        }
      >
        <div
          ref={panelRef}
          data-testid="chat-input-panel"
          className={isHeroComposer
            ? `glass-panel relative flex flex-col gap-3 overflow-visible ${embedLaunchControlsInHero ? 'rounded-xl' : 'rounded-t-xl rounded-b-none'} p-4 transition-colors ${isDragActive ? 'composer-drop-target-active' : ''}`
            : compact
              ? `glass-panel relative overflow-visible p-3 transition-colors ${isMobileComposer ? 'rounded-2xl shadow-[0_-12px_36px_rgba(54,35,28,0.12)]' : 'rounded-xl'} ${isDragActive ? 'composer-drop-target-active' : ''}`
              : `glass-panel relative overflow-visible transition-colors ${isMobileComposer ? 'rounded-2xl p-3 shadow-[0_-12px_36px_rgba(54,35,28,0.12)]' : 'rounded-xl p-4'} ${isDragActive ? 'composer-drop-target-active' : ''}`}
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
                  textareaRef.current?.focus()
                  textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos)
                })
              }}
              onSelect={(path, name, isDirectory) => {
                if (atCursorPos >= 0) {
                  const referenceName = name.split('/').filter(Boolean).pop() ?? name
                  const tokenEnd = atCursorPos + 1 + atFilter.length
                  const beforeToken = input.slice(0, atCursorPos)
                  const afterToken = beforeToken ? input.slice(tokenEnd) : input.slice(tokenEnd).replace(/^\s+/, '')
                  const spacer = beforeToken && afterToken && !/\s$/.test(beforeToken) && !/^\s/.test(afterToken) ? ' ' : ''
                  const newValue = `${beforeToken}${spacer}${afterToken}`
                  const newCursorPos = atCursorPos + spacer.length
                  if (activeTabId) {
                    addWorkspaceReference(activeTabId, {
                      kind: 'file',
                      path,
                      absolutePath: path,
                      name: isDirectory ? `${referenceName}/` : referenceName,
                      isDirectory,
                    })
                  }
                  setComposerInput(newValue)
                  setFileSearchOpen(false)
                  setAtFilter('')
                  setAtCursorPos(-1)
                  void textareaRef.current?.focus()
                  requestAnimationFrame(() => {
                    textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos)
                  })
                }
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

          {!isMemberSession && slashMenuOpen && filteredCommands.length > 0 && (
            <div
              ref={slashMenuRef}
              className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]"
            >
              <div className="max-h-[300px] overflow-y-auto py-1">
                {filteredCommands.map((command, index) => (
                  <button
                    key={command.name}
                    ref={(el) => { slashItemRefs.current[index] = el }}
                    onClick={() => selectSlashCommand(command.name)}
                    onMouseEnter={() => setSlashSelectedIndex(index)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      index === slashSelectedIndex
                        ? 'bg-[var(--color-surface-hover)]'
                        : 'hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <span className="flex min-w-0 max-w-[52%] shrink-0 items-baseline gap-1.5">
                      <span className="shrink-0 text-sm font-semibold text-[var(--color-text-primary)]">
                        /{command.name}
                      </span>
                      {command.argumentHint ? (
                        <span className="min-w-0 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
                          {command.argumentHint}
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">
                      {command.description}
                    </span>
                  </button>
                ))}
              </div>
              {!isMobileComposer ? (
                <div className="flex items-center gap-1.5 border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-tertiary)]">
                  <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1.5 py-0.5 font-mono text-[10px]">Up/Down</kbd>
                  <span>{t('chat.navigate')}</span>
                  <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1.5 py-0.5 font-mono text-[10px]">Enter</kbd>
                  <span>{t('chat.select')}</span>
                  <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>
                  <span>{t('chat.dismiss')}</span>
                </div>
              ) : null}
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
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => { composingRef.current = true }}
                onCompositionEnd={() => { composingRef.current = false }}
                onPaste={handlePaste}
                placeholder={composerPlaceholder}
                disabled={isWorkspaceMissing}
                rows={2}
                className="flex-1 resize-none border-none bg-transparent py-2 leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-50"
              />
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onPaste={handlePaste}
              placeholder={composerPlaceholder}
              disabled={isWorkspaceMissing}
              rows={1}
              className={`w-full resize-none bg-transparent text-sm leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-50 ${
                useCompactControls ? 'py-1.5 pb-14' : 'py-2 pb-12'
              }`}
            />
          )}

          <div className={isHeroComposer
            ? 'flex items-center justify-between border-t border-[var(--color-border-separator)] pt-3'
            : `absolute bottom-0 left-0 right-0 flex items-center justify-between border-t border-[var(--color-border-separator)] ${
              useCompactControls ? 'gap-2 px-2.5 py-2' : 'px-3 py-3'
            }`}>
            <div className="flex min-w-0 items-center gap-2">
              {!isMemberSession && (
                <>
                  <div ref={plusMenuRef} className="relative">
                    <button
                      onClick={() => setPlusMenuOpen((value) => !value)}
                      aria-label="Open composer tools"
                      className={`text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] ${isMobileComposer ? 'inline-flex h-11 w-11 items-center justify-center rounded-xl' : 'rounded-[var(--radius-md)] p-1.5'}`}
                    >
                      <span className="material-symbols-outlined text-[18px]">add</span>
                    </button>

                    {plusMenuOpen && (
                      <div className={`absolute bottom-full left-0 z-50 mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 shadow-[var(--shadow-dropdown)] ${isMobileComposer ? 'w-[min(240px,calc(100vw-32px))]' : 'w-[240px]'}`}>
                        <button
                          onClick={openAttachmentPicker}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">attach_file</span>
                          <span className="text-sm text-[var(--color-text-primary)]">{addFilesLabel}</span>
                        </button>
                        <button
                          onClick={insertSlashCommand}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="w-[24px] text-center text-[18px] font-bold text-[var(--color-text-secondary)]">/</span>
                          <span className="text-sm text-[var(--color-text-primary)]">{slashCommandsLabel}</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <PermissionModeSelector compact={useCompactControls} />
                </>
              )}
            </div>

            <div className="flex min-w-0 items-center gap-2">
              {!isMemberSession && activeTabId && (
                <ContextUsageIndicator
                  sessionId={activeTabId}
                  chatState={chatState}
                  messageCount={messageCount}
                  runtimeSelectionKey={runtimeSelectionKey}
                  fallbackModelLabel={runtimeModelLabel}
                  compact={useCompactControls}
                />
              )}
              {!isMemberSession && activeTabId && (
                <ModelSelector runtimeKey={activeTabId} disabled={isActive} compact={useCompactControls} />
              )}
              <button
                onClick={!isMemberSession && isActive ? () => stopGeneration(activeTabId!) : handleSubmit}
                disabled={!isMemberSession && isActive ? false : !canSubmit}
                aria-label={!isMemberSession && isActive ? t('common.stop') : isMemberSession ? t('common.send') : t('common.run')}
                title={
                  !isMemberSession && isActive
                    ? t('chat.stopTitle')
                    : iconOnlyAction
                      ? isMemberSession
                        ? t('common.send')
                        : t('common.run')
                      : undefined
                }
                className={`flex shrink-0 items-center justify-center gap-1 rounded-lg text-xs font-semibold transition-all hover:brightness-105 disabled:opacity-30 ${
                  iconOnlyAction ? `${isMobileComposer ? 'h-11 w-11 rounded-xl px-0 py-0' : 'h-8 w-8 px-0 py-0'}` : 'w-[112px] px-3 py-1.5'
                } ${
                  !isMemberSession && isActive
                    ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
                    : 'bg-[image:var(--gradient-btn-primary)] text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)]'
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">
                  {!isMemberSession && isActive ? 'stop' : 'arrow_forward'}
                </span>
                {!iconOnlyAction && (!isMemberSession && isActive ? t('common.stop') : isMemberSession ? t('common.send') : t('common.run'))}
              </button>
            </div>
          </div>

          {embedLaunchControlsInHero && (
            <div className="-mx-4 -mb-4 mt-3">
              <RepositoryLaunchControls
                workDir={activeLaunchWorkDir}
                onWorkDirChange={handleLaunchWorkDirChange}
                branch={launchBranch}
                onBranchChange={setLaunchBranch}
                useWorktree={launchUseWorktree}
                onUseWorktreeChange={setLaunchUseWorktree}
                onLaunchReadyChange={setLaunchReady}
                disabled={isActive || launchTransitioning}
                placement="composer"
              />
            </div>
          )}
        </div>

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

        {!isMemberSession && !embedLaunchControlsInHero && (
          <div className={useCompactControls ? 'mt-2 flex min-w-0 px-1' : 'mt-3 px-1'}>
            {messageCount > 0 ? (
              <ProjectContextChip
                workDir={resolvedWorkDir}
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
