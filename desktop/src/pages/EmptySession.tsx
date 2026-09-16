import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useDismissable } from '@/hooks/useDismissable'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ApiError } from '../api/client'
import { agentsApi } from '../api/agents'
import { providersApi } from '../api/providers'
import { getBundledPresetReasoningProviderKind } from '../config/providerPresets'
import { skillsApi } from '../api/skills'
import { useTranslation } from '../i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { usePluginStore } from '../stores/pluginStore'
import { useProviderStore } from '../stores/providerStore'
import { useSessionRuntimeStore, DRAFT_RUNTIME_SELECTION_KEY } from '../stores/sessionRuntimeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { RepositoryLaunchControls } from '@/components/chat/RepositoryLaunchControls'
import { PermissionModeSelector } from '../components/controls/PermissionModeSelector'
import { ModelSelector, type ModelSelectorHandle } from '../components/controls/ModelSelector'
import { AttachmentGallery } from '../components/chat/AttachmentGallery'
import { ComposerDropOverlay } from '../components/chat/ComposerDropOverlay'
import { ContextUsageIndicator } from '../components/chat/ContextUsageIndicator'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from '@/components/chat/ComposerReferenceMenu'
import { ComposerReferenceDetail } from '@/components/chat/ComposerReferenceDetail'
import { composerReferencesApi } from '@/api/composerReferences'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { LocalSlashCommandPanel, type LocalSlashCommandName } from '../components/chat/LocalSlashCommandPanel'
import {
  getSlashCommandOptionId,
  SlashCommandMenu,
} from '../components/chat/SlashCommandMenu'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import {
  normalizeRuntimeSelection,
  resolveActiveProviderRuntimeSelection,
} from '../lib/runtimeSelection'
import {
  filesToComposerAttachments,
  getDataTransferFiles,
  selectNativeFileAttachments,
  type ComposerAttachment,
} from '../lib/composerAttachments'
import { useComposerFileDrop } from '../components/chat/useComposerFileDrop'
import { shouldSubmitOnEnter } from '../components/chat/sendShortcut'
import { MentionComposer, type MentionComposerHandle } from '../components/chat/MentionComposer'
import {
  composerReferenceToMention,
  findMentionRanges,
  insertMentionIntoText,
  type ComposerMention,
} from '../lib/composerMentions'
import {
  appendAgentSlashCommands,
  buildAgentSlashCommands,
  getLocalizedFallbackCommands,
  filterSlashCommands,
  findSlashToken,
  groupSlashCommands,
  insertSlashTrigger,
  mergeSlashCommands,
  replaceSlashCommand,
  resolveSlashUiAction,
} from '../components/chat/composerUtils'
import type { AttachmentRef } from '../types/chat'
import type { PermissionMode } from '../types/settings'
import type { SlashCommandOption } from '../components/chat/composerUtils'

type Attachment = ComposerAttachment

type Translate = ReturnType<typeof useTranslation>

function getApiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body
  if (!body || typeof body !== 'object' || !('error' in body)) return null
  return typeof body.error === 'string' ? body.error : null
}

function resolveCreateSessionErrorMessage(error: unknown, t: Translate): string {
  const code = getApiErrorCode(error)
  switch (code) {
    case 'WORKDIR_MISSING':
    case 'WORKDIR_NOT_DIRECTORY':
      return t('empty.createError.workdirMissing')
    case 'REPOSITORY_NOT_GIT':
      return t('empty.createError.notGit')
    case 'REPOSITORY_BRANCH_NOT_FOUND':
      return t('empty.createError.branchNotFound')
    case 'REPOSITORY_DIRTY_WORKTREE':
      return t('empty.createError.dirtyWorktree')
    case 'REPOSITORY_BRANCH_CHECKED_OUT':
      return t('empty.createError.branchCheckedOut')
    case 'REPOSITORY_WORKTREE_CREATE_FAILED':
      return t('empty.createError.worktreeCreateFailed', {
        detail: error instanceof Error ? error.message : t('empty.failedToCreate'),
      })
    case 'REPOSITORY_SWITCH_FAILED':
      return t('empty.createError.switchFailed', {
        detail: error instanceof Error ? error.message : t('empty.failedToCreate'),
      })
    case 'REPOSITORY_CONTEXT_ERROR':
      return t('empty.createError.contextFailed')
    default:
      return error instanceof Error ? error.message : t('empty.failedToCreate')
  }
}

const EMPTY_COMPOSER_REFERENCES: ComposerReferenceCandidate[] = []

export function EmptySession() {
  const t = useTranslation()
  const [input, setInput] = useState('')
  const [mentions, setMentions] = useState<ComposerMention[]>([])
  const [referenceDetail, setReferenceDetail] = useState<ComposerMention | null>(null)
  const [referenceOptionId, setReferenceOptionId] = useState<string | undefined>()
  const [referenceState, setReferenceState] = useState<{ cwd: string, items: ComposerReferenceCandidate[], loading: boolean, error: boolean } | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [workDir, setWorkDir] = useState('')
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [repositoryLaunchReady, setRepositoryLaunchReady] = useState(true)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [localSlashPanel, setLocalSlashPanel] = useState<LocalSlashCommandName | null>(null)
  const [atFilter, setAtFilter] = useState('')
  const [atCursorPos, setAtCursorPos] = useState(-1)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>([])
  const [slashCommandsCwd, setSlashCommandsCwd] = useState<string | null>(null)
  const [agentSlashCommands, setAgentSlashCommands] = useState<SlashCommandOption[]>([])
  const composerRef = useRef<MentionComposerHandle>(null)
  const composerContainerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelSelectorRef = useRef<ModelSelectorHandle>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const fileSearchRef = useRef<ComposerReferenceMenuHandle>(null)
  const slashItemRefs = useRef<(HTMLElement | null)[]>([])
  const slashMenuId = useId()
  const referenceMenuId = useId()
  const createSession = useSessionStore((state) => state.createSession)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const connectToSession = useChatStore((state) => state.connectToSession)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const addToast = useUIStore((state) => state.addToast)
  const currentModel = useSettingsStore((state) => state.currentModel)
  const activeProviderName = useSettingsStore((state) => state.activeProviderName)
  const effortLevel = useSettingsStore((state) => state.effortLevel)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const defaultPermissionMode = useSettingsStore((state) => state.permissionMode)
  const providers = useProviderStore((state) => state.providers)
  const activeProviderId = useProviderStore((state) => state.activeId)
  const [draftPermissionMode, setDraftPermissionMode] = useState<PermissionMode>(defaultPermissionMode)
  const lastPluginReloadSummary = usePluginStore((state) => state.lastReloadSummary)
  const referenceCurrent = referenceState?.cwd === workDir ? referenceState : null
  const composerReferences = referenceCurrent?.items ?? EMPTY_COMPOSER_REFERENCES
  useEffect(() => {
    let active = true
    setReferenceState(previous => ({ cwd: workDir, items: previous?.cwd === workDir ? previous.items : [], loading: true, error: false }))
    void composerReferencesApi.list(workDir || undefined).then(data => {
      if (active) setReferenceState({ cwd: workDir, items: [...data.plugins, ...data.skills], loading: false, error: false })
    }).catch(() => {
      if (active) setReferenceState({ cwd: workDir, items: [], loading: false, error: true })
    })
    return () => { active = false }
  }, [workDir, lastPluginReloadSummary, slashMenuOpen, fileSearchOpen])
  useEffect(() => {
    setReferenceDetail(null)
    setReferenceOptionId(undefined)
    setFileSearchOpen(false)
    setSlashMenuOpen(false)
  }, [workDir])

  const draftRuntimeSelection = useSessionRuntimeStore((state) => state.selections[DRAFT_RUNTIME_SELECTION_KEY])
  const draftRuntimeSelectionKey = draftRuntimeSelection
    ? `${draftRuntimeSelection.providerId ?? 'official'}:${draftRuntimeSelection.modelId}:${draftRuntimeSelection.effortLevel ?? 'auto'}`
    : undefined
  const draftModelLabel = draftRuntimeSelection?.modelId ?? currentModel?.name ?? currentModel?.id
  const isMobileComposer = useMobileViewport() && !isDesktopRuntime()

  useEffect(() => {
    composerRef.current?.focus()
  }, [])

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
    // See ChatInput: this menu is found by id, and its absence used to mean
    // "ignore the press".
    isExempt: (target) => {
      const menu = document.getElementById(referenceMenuId)
      if (!menu) return true
      return target instanceof Node && menu.contains(target)
    },
  })

  useEffect(() => {
    let cancelled = false

    const cwd = workDir || undefined

    skillsApi.list(cwd)
      .then(({ skills }) => {
        if (cancelled) return
        setSlashCommandsCwd(workDir)
        setSlashCommands(
          skills
            .filter((skill) => skill.userInvocable)
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
              kind: 'skill' as const,
              ...(skill.source === 'user' || skill.source === 'project' || skill.source === 'plugin'
                ? { source: skill.source }
                : {}),
            })),
        )
      })
      .catch(() => {
        if (!cancelled) {
          setSlashCommands([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [workDir, lastPluginReloadSummary])

  useEffect(() => {
    let cancelled = false
    const cwd = workDir || undefined

    agentsApi.list(cwd)
      .then(({ activeAgents }) => {
        if (cancelled) return
        setAgentSlashCommands(buildAgentSlashCommands(activeAgents))
      })
      .catch(() => {
        if (!cancelled) {
          setAgentSlashCommands([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [workDir, lastPluginReloadSummary])

  const allSlashCommands = useMemo(() => {
    const commands = appendAgentSlashCommands(mergeSlashCommands(slashCommandsCwd === workDir ? slashCommands : [], getLocalizedFallbackCommands(t)), agentSlashCommands)
    const names = new Set(commands.map(command => command.name.toLowerCase()))
    for (const reference of composerReferences) {
      const name = reference.kind === 'plugin' ? reference.id : reference.name
      if (names.has(name.toLowerCase())) continue
      names.add(name.toLowerCase())
      commands.push({ name, description: reference.description, kind: reference.kind })
    }
    return commands
  }, [agentSlashCommands, slashCommands, slashCommandsCwd, workDir, composerReferences, t])

  const handleWorkDirChange = (newWorkDir: string) => {
    setWorkDir(newWorkDir)
    setSelectedBranch(null)
    setUseWorktree(false)
    setRepositoryLaunchReady(!newWorkDir)
  }

  const filteredCommandGroups = useMemo(() => {
    return groupSlashCommands(filterSlashCommands(allSlashCommands, slashFilter))
  }, [allSlashCommands, slashFilter])
  const filteredCommands = filteredCommandGroups.ordered
  const isSlashMenuVisible = slashMenuOpen && filteredCommands.length > 0

  const exactSlashCommand = useMemo(() => {
    const normalized = slashFilter.trim().toLowerCase()
    if (!normalized) return null
    return filteredCommands.find((command) => command.name.toLowerCase() === normalized) ?? null
  }, [filteredCommands, slashFilter])
  const canSubmit = (
    input.trim().length > 0 ||
    attachments.length > 0 ||
    !!workDir
  ) && !isSubmitting && repositoryLaunchReady

  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [slashFilter])

  useEffect(() => {
    const activeItem = slashMenuOpen ? slashItemRefs.current[slashSelectedIndex] : null
    if (activeItem && typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ block: 'nearest' })
    }
  }, [slashMenuOpen, slashSelectedIndex])

  const handleSubmit = async () => {
    const text = input.trim()
    if (!canSubmit) return

    const slashUiAction = text.startsWith('/') ? resolveSlashUiAction(text.slice(1)) : null
    if (slashUiAction?.type === 'panel') {
      setLocalSlashPanel(slashUiAction.command as LocalSlashCommandName)
      setInput('')
      setMentions([])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (slashUiAction?.type === 'settings') {
      useUIStore.getState().setPendingSettingsTab(slashUiAction.tab)
      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
      setInput('')
      setMentions([])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (slashUiAction?.type === 'model') {
      modelSelectorRef.current?.open()
      setInput('')
      setMentions([])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    setIsSubmitting(true)
    try {
      const authStatus = await providersApi.authStatus()
      if (!authStatus.hasAuth) {
        useUIStore.getState().setPendingSettingsTab('providers')
        useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
        return
      }

      const runtimeStore = useSessionRuntimeStore.getState()
      const explicitDraftSelection = runtimeStore.selections[DRAFT_RUNTIME_SELECTION_KEY]
      const defaultActiveProviderSelection = explicitDraftSelection
        ? null
        : resolveActiveProviderRuntimeSelection(
          activeProviderId,
          activeProviderName,
          providers,
          currentModel?.id,
        )
      const activeCustomProvider = defaultActiveProviderSelection
        ? providers.find((provider) => provider.id === defaultActiveProviderSelection.providerId)
        : undefined
      const defaultRuntimeSelection = defaultActiveProviderSelection && activeCustomProvider
        ? normalizeRuntimeSelection(
          { ...defaultActiveProviderSelection, effortLevel },
          activeCustomProvider.apiFormat,
          getBundledPresetReasoningProviderKind(activeCustomProvider.presetId),
        )
        : defaultActiveProviderSelection
      const claudeOAuthRuntimeSelection = !explicitDraftSelection &&
        authStatus.source === 'claude-oauth' &&
        activeProviderId === null &&
        currentModel?.id
        ? {
            providerId: null,
            modelId: currentModel.id,
            effortLevel,
          }
        : undefined
      const runtimeSelection = explicitDraftSelection
        ?? defaultRuntimeSelection
        ?? claudeOAuthRuntimeSelection
      const sessionId = await createSession(
        workDir || undefined,
        {
          ...(selectedBranch
            ? { repository: { branch: selectedBranch, worktree: useWorktree } }
            : {}),
          permissionMode: draftPermissionMode,
        },
      )
      if (runtimeSelection) {
        runtimeStore.setSelection(sessionId, runtimeSelection)
        if (explicitDraftSelection) {
          runtimeStore.clearSelection(DRAFT_RUNTIME_SELECTION_KEY)
        }
      }
      setActiveView('code')
      useTabStore.getState().openTab(sessionId, 'New Session')
      connectToSession(sessionId)
      const attachmentPayload: AttachmentRef[] = attachments.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        path: attachment.path,
        data: attachment.data,
        mimeType: attachment.mimeType,
      }))
      // Inline @-mentions go out as the `@"absolute path"` text the CLI parses,
      // serialized from the live document; the bubble keeps the pill text.
      const serializedText = (composerRef.current?.getModelContent() ?? input).trim()
      if (serializedText || attachmentPayload.length > 0) {
        sendMessage(sessionId, serializedText, attachmentPayload, { displayContent: text })
      }
      setInput('')
      setMentions([])
      setAttachments([])
    } catch (error) {
      addToast({
        type: 'error',
        message: resolveCreateSessionErrorMessage(error, t),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleComposerChange = (value: string, nextMentions: ComposerMention[]) => {
    setInput(value)
    setMentions(nextMentions)
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? value.length
    const token = findSlashToken(value, cursorPos)
    if (!token) {
      setSlashMenuOpen(false)
    } else {
      setSlashFilter(token.filter)
      setSlashMenuOpen(true)
    }

    // Detect @ trigger for file search, skipping an `@` that belongs to an
    // existing mention pill.
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
    if (pos >= 0 && findMentionRanges(value, nextMentions).some((range) => pos >= range.start && pos < range.end)) {
      pos = -1
    }
    if (pos < 0) {
      setFileSearchOpen(false)
      setAtFilter('')
      setAtCursorPos(-1)
    } else {
      setAtFilter(textBeforeCursor.slice(pos + 1))
      setAtCursorPos(pos)
      setSlashMenuOpen(false)
      setFileSearchOpen(true)
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent): boolean => {
    // Ignore key events during IME composition (e.g. Chinese input method)
    if (event.isComposing || event.keyCode === 229) return false

    // Route reference selection and directory navigation to the unified menu
    if (fileSearchOpen) {
      const key = event.key
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === 'Tab' || key === 'Escape') {
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
      return false
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
      if (event.key === 'Enter' || event.key === 'Tab') {
        const selected = filteredCommands[slashSelectedIndex]
        if (
          event.key === 'Enter' &&
          exactSlashCommand &&
          !composerReferences.some(item => item.kind === selected?.kind && (item.id === selected?.name || item.name === selected?.name)) &&
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
    const files = event.clipboardData ? getDataTransferFiles(event.clipboardData) : []
    if (files.length === 0) return false

    event.preventDefault()
    void filesToComposerAttachments(files)
      .then((nextAttachments) => {
        if (nextAttachments.length === 0) return
        setAttachments((prev) => [...prev, ...nextAttachments])
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
        setAttachments((prev) => [...prev, ...nextAttachments])
      })
      .catch((error) => {
        console.warn('[attachments] Failed to read selected files', error)
      })
  }, [])

  const appendAttachments = useCallback((nextAttachments: Attachment[]) => {
    if (nextAttachments.length === 0) return
    setAttachments((prev) => [...prev, ...nextAttachments])
  }, [])

  const { isDragActive, dragHandlers } = useComposerFileDrop({
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
            setAttachments((prev) => [...prev, ...nativeAttachments])
          }
          return
        }
        fileInputRef.current?.click()
      })
  }, [])

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files) return

    appendFiles(files)
    event.target.value = ''
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }

  const selectSlashCommand = (command: string) => {
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
    const option = allSlashCommands.find(item => item.name === command)
    let nextCursor: number
    const reference = (option?.kind === 'skill' || option?.kind === 'plugin')
      ? composerReferences.find(item => item.kind === option.kind && (item.id === command || item.name === command))
      : undefined
    if (reference) {
      const mention = composerReferenceToMention(reference)
      const trigger = findSlashToken(input, cursorPos)
      if (!trigger) return
      const inserted = insertMentionIntoText(input, mentions, trigger.start, cursorPos, mention)
      setInput(inserted.text)
      setMentions(inserted.mentions)
      nextCursor = inserted.cursorPos
    } else {
      const replacement = replaceSlashCommand(input, cursorPos, command)
      if (!replacement) return
      setInput(replacement.value)
      nextCursor = replacement.cursorPos
    }
    setSlashMenuOpen(false)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(nextCursor)
    })
  }

  const insertSlashCommand = () => {
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
    const replacement = insertSlashTrigger(input, cursorPos)
    setInput(replacement.value)
    setPlusMenuOpen(false)
    setSlashFilter('')
    setSlashMenuOpen(true)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(replacement.cursorPos)
    })
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className={`brand-seal-glow flex flex-1 flex-col items-center justify-center ${
        isMobileComposer ? 'px-6 pb-[230px] pt-10' : 'p-8 pb-32'
      }`}>
        <div className={`flex flex-col items-center text-center ${
          isMobileComposer ? 'max-w-[300px] gap-3' : 'max-w-[420px] gap-[13px]'
        }`}>
          <BrandSeal size={isMobileComposer ? 'lg' : 'xl'} />
          <h1
            className={`font-bold tracking-tight text-[var(--color-text-primary)] ${
              isMobileComposer ? 'text-2xl' : 'text-[27px]'
            }`}
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {t('empty.title')}
          </h1>
          <p
            className={`mx-auto -mt-1 text-[var(--color-text-secondary)] ${
              isMobileComposer ? 'max-w-[280px] text-sm leading-6' : 'text-[15px] leading-[1.7]'
            }`}
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {t('empty.subtitle')}
          </p>
        </div>
      </div>

      <div
        data-testid="empty-session-composer-shell"
        className={`absolute left-0 right-0 z-[var(--z-nav)] flex justify-center ${
        isMobileComposer
          ? 'bottom-0 px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]'
          : 'bottom-4 px-8'
      }`}
      >
        <div className={`flex w-full flex-col ${isMobileComposer ? 'max-w-none' : 'max-w-3xl'}`}>
          <div
            ref={panelRef}
            data-testid="empty-session-composer-panel"
            className={`glass-panel glass-panel--composer relative flex flex-col gap-3 overflow-visible rounded-[var(--radius-2xl)] ${
              isMobileComposer ? 'p-3' : 'p-0'
            } ${isDragActive ? 'composer-drop-target-active' : ''}`}
            {...dragHandlers}
          >
            {isDragActive && (
              <ComposerDropOverlay
                testId="empty-session-drop-overlay"
                title={t('chat.dropFilesTitle')}
                description={t('chat.dropFilesHint')}
              />
            )}

            <div className={isMobileComposer ? 'contents' : 'flex flex-col gap-3 p-4'}>
              {fileSearchOpen && (
                <ComposerReferenceMenu
                  ref={fileSearchRef}
                  id={referenceMenuId}
                  compact={isMobileComposer}
                  references={composerReferences}
                  referencesLoading={referenceCurrent?.loading ?? true}
                  referencesError={referenceCurrent?.error}
                  onActiveChange={setReferenceOptionId}
                  cwd={workDir || ''}
                  filter={atFilter}
                  onNavigate={(relativePath) => {
                    if (atCursorPos < 0) return
                    const replacement = `@${relativePath}`
                    const tokenEnd = atCursorPos + 1 + atFilter.length
                    const newValue = `${input.slice(0, atCursorPos)}${replacement}${input.slice(tokenEnd)}`
                    const newCursorPos = atCursorPos + replacement.length
                    setInput(newValue)
                    setAtFilter(relativePath)
                    requestAnimationFrame(() => {
                      composerRef.current?.focus()
                      composerRef.current?.setSelectionOffsets(newCursorPos)
                    })
                  }}
                  onSelect={(mention) => {
                    if (atCursorPos < 0) return
                    const tokenEnd = atCursorPos + 1 + atFilter.length
                    const inserted = insertMentionIntoText(input, mentions, atCursorPos, tokenEnd, mention)
                    setInput(inserted.text)
                    setMentions(inserted.mentions)
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

              {localSlashPanel && (
                <div ref={slashMenuRef}>
                  <LocalSlashCommandPanel
                    command={localSlashPanel}
                    cwd={workDir || undefined}
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
                  references={composerReferences}
                  selectedIndex={slashSelectedIndex}
                  itemRefs={slashItemRefs}
                  onSelect={selectSlashCommand}
                  onHighlight={setSlashSelectedIndex}
                  showKeyboardHints={!isMobileComposer}
                />
              )}

              {attachments.length > 0 && (
                <AttachmentGallery attachments={attachments} variant="composer" onRemove={removeAttachment} />
              )}

              <div className="flex items-start gap-3">
                <MentionComposer
                  ref={composerRef}
                  rootRef={composerContainerRef}
                  value={input}
                  mentions={mentions}
                  onMentionClick={setReferenceDetail}
                  onChange={handleComposerChange}
                  onKeyDown={handleComposerKeyDown}
                  onPaste={handleComposerPaste}
                  placeholder={t('empty.placeholder')}
                  className="flex-1"
                  editorClassName={`overflow-y-auto leading-relaxed text-[var(--color-text-primary)] ${
                    isMobileComposer ? 'max-h-[132px] min-h-[72px] py-1.5 text-base' : 'max-h-[200px] py-2'
                  }`}
                  aria={{
                    role: isSlashMenuVisible || fileSearchOpen ? 'combobox' : 'textbox',
                    'aria-autocomplete': isSlashMenuVisible || fileSearchOpen ? 'list' : undefined,
                    'aria-expanded': isSlashMenuVisible || fileSearchOpen ? 'true' : undefined,
                    'aria-controls': fileSearchOpen ? referenceMenuId : isSlashMenuVisible ? slashMenuId : undefined,
                    'aria-activedescendant': fileSearchOpen ? referenceOptionId : isSlashMenuVisible
                      ? getSlashCommandOptionId(slashMenuId, slashSelectedIndex)
                      : undefined,
                  }}
                />
              </div>

              <div className={`border-t border-[var(--color-border-separator)] pt-3 ${
                isMobileComposer ? 'flex flex-wrap items-center gap-2' : 'flex items-center justify-between'
              }`}>
                <div className="flex min-w-0 shrink items-center gap-2">
                  <div ref={plusMenuRef} className="relative shrink-0">
                    <IconButton
                      icon="add"
                      label={t('chat.composerTools')}
                      showTooltip={false}
                      tone="secondary"
                      size={isMobileComposer ? 'xl' : 'md'}
                      className={isMobileComposer ? 'h-11 w-11' : undefined}
                      aria-expanded={plusMenuOpen}
                      onClick={() => setPlusMenuOpen((prev) => !prev)}
                    />

                    {plusMenuOpen && (
                      <div className={`absolute bottom-full left-0 mb-2 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 shadow-[var(--shadow-dropdown)] ${
                        isMobileComposer ? 'w-[min(240px,calc(100vw-32px))]' : 'w-[240px]'
                      }`}>
                        <button
                          onClick={openAttachmentPicker}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">attach_file</span>
                          {t('empty.addFiles')}
                        </button>
                        <button
                          onClick={insertSlashCommand}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="w-5 text-center text-[18px] font-bold text-[var(--color-text-secondary)]">/</span>
                          {t('empty.slashCommands')}
                        </button>
                      </div>
                    )}
                  </div>

                  <PermissionModeSelector
                    workDir={workDir}
                    compact={isMobileComposer}
                    value={draftPermissionMode}
                    onChange={setDraftPermissionMode}
                  />

                  {!isMobileComposer && (
                    <RepositoryLaunchControls
                      workDir={workDir}
                      onWorkDirChange={handleWorkDirChange}
                      branch={selectedBranch}
                      onBranchChange={setSelectedBranch}
                      useWorktree={useWorktree}
                      onUseWorktreeChange={setUseWorktree}
                      onLaunchReadyChange={setRepositoryLaunchReady}
                      disabled={isSubmitting}
                      placement="toolbar"
                    />
                  )}
                </div>

                <div className={`${isMobileComposer ? 'flex min-w-0 flex-1 items-center justify-end gap-2' : 'flex shrink-0 items-center gap-3'}`}>
                  <ContextUsageIndicator
                    chatState="idle"
                    messageCount={0}
                    runtimeSelectionKey={draftRuntimeSelectionKey}
                    fallbackModelLabel={draftModelLabel}
                    draft
                    compact={isMobileComposer}
                  />
                  <ModelSelector ref={modelSelectorRef} runtimeKey={DRAFT_RUNTIME_SELECTION_KEY} disabled={isSubmitting} compact={isMobileComposer} />
                  {/* Kept identical to ChatInput's send button — same
                      component, shape, size and icon. See the note there for
                      why the label went away. */}
                  <Button
                    variant="primary"
                    size="base"
                    shape="circle"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    aria-label={t('common.run')}
                    title={t('common.run')}
                    className={`shrink-0 ${isMobileComposer ? 'h-11 w-11' : ''}`}
                    icon={<span className="material-symbols-outlined text-[18px]">arrow_upward</span>}
                  />
                </div>
              </div>
            </div>

          </div>

          {isMobileComposer && (
            <RepositoryLaunchControls
              workDir={workDir}
              onWorkDirChange={handleWorkDirChange}
              branch={selectedBranch}
              onBranchChange={setSelectedBranch}
              useWorktree={useWorktree}
              onUseWorktreeChange={setUseWorktree}
              onLaunchReadyChange={setRepositoryLaunchReady}
              disabled={isSubmitting}
            />
          )}
        </div>
      </div>

      <ComposerReferenceDetail mention={referenceDetail} onClose={() => setReferenceDetail(null)} />
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
    </div>
  )
}
