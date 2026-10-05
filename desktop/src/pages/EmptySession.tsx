import { isComposerReferenceVisible, isComposerSlashCommandVisible } from '@/lib/composerCapabilityVisibility'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useDismissable } from '@/hooks/useDismissable'
import { ArrowUp, Cpu, Plus, ShieldCheck } from 'lucide-react'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { NewSessionStarter } from '@/components/layout/NewSessionStarter'
import { projectTitle } from '@/components/layout/sidebarTaskGroups'
import { resolveProjectDisplayName } from '../stores/projectDisplayNameStore'
import { Button } from '@/components/ui/Button'
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
import { PermissionModeSelector, type PermissionModeSelectorHandle } from '../components/controls/PermissionModeSelector'
import { PERMISSION_MODE_LABEL_KEYS } from '../components/controls/permissionModeState'
import { ModelSelector, type ModelSelectorHandle } from '../components/controls/ModelSelector'
import { AttachmentGallery } from '../components/chat/AttachmentGallery'
import { ComposerDropOverlay } from '../components/chat/ComposerDropOverlay'
import { ContextUsageIndicator } from '../components/chat/ContextUsageIndicator'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from '@/components/chat/ComposerReferenceMenu'
import { ComposerReferenceDetail } from '@/components/chat/ComposerReferenceDetail'
import { composerReferencesApi, mentionProviderId } from '@/api/composerReferences'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { LocalSlashCommandPanel, type LocalSlashCommandName } from '../components/chat/LocalSlashCommandPanel'
import {
  getSlashCommandOptionId,
  SlashCommandMenu,
} from '../components/chat/SlashCommandMenu'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { GROK_OFFICIAL_PROVIDER_ID } from '../constants/grokOfficialProvider'
import { OPENAI_OFFICIAL_PROVIDER_ID } from '../constants/openaiOfficialProvider'
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
  type NewComposerMention,
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
  replaceSlashToken,
  resolveSlashUiAction,
} from '../components/chat/composerUtils'
import { ComposerCapabilityMenu } from '@/components/chat/ComposerCapabilityMenu'
import { MobileComposerSheet, type MobileComposerSetting } from '@/components/chat/MobileComposerSheet'
import { useCapabilityMenu } from '@/components/chat/useCapabilityMenu'
import type { AttachmentRef } from '../types/chat'
import type { PermissionMode } from '../types/settings'
import type { SlashCommandOption } from '../components/chat/composerUtils'
import { useComposerDictation } from '@/features/voiceInput/useComposerDictation'
import { VoiceInputButton } from '@/features/voiceInput/VoiceInputButton'
import { VoiceRecordingBar } from '@/features/voiceInput/VoiceRecordingBar'

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

type EmptySessionProps = {
  /**
   * The phone's home page puts its session list where the hero would be, with
   * this composer docked under it, so a new task starts from the list.
   */
  mobileHome?: ReactNode
}

export function EmptySession({ mobileHome }: EmptySessionProps = {}) {
  const t = useTranslation()
  const [input, setInput] = useState('')
  const [mentions, setMentions] = useState<ComposerMention[]>([])
  const [referenceDetail, setReferenceDetail] = useState<ComposerMention | null>(null)
  const [referenceOptionId, setReferenceOptionId] = useState<string | undefined>()
  const [referenceState, setReferenceState] = useState<{ context: string, items: ComposerReferenceCandidate[], loading: boolean, error: boolean } | null>(null)
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
  const permissionSelectorRef = useRef<PermissionModeSelectorHandle>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const fileSearchRef = useRef<ComposerReferenceMenuHandle>(null)
  const slashItemRefs = useRef<(HTMLElement | null)[]>([])
  const slashMenuId = useId()
  const referenceMenuId = useId()
  const capabilityMenuId = useId()
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
  const draftRuntimeSelection = useSessionRuntimeStore((state) => state.selections[DRAFT_RUNTIME_SELECTION_KEY])
  const referenceProviderId = mentionProviderId(draftRuntimeSelection)
  const referenceContext = `${workDir}\0${referenceProviderId ?? ''}`
  const referenceCurrent = referenceState?.context === referenceContext ? referenceState : null
  const composerReferences = useMemo(() => (referenceCurrent?.items ?? EMPTY_COMPOSER_REFERENCES).filter(isComposerReferenceVisible), [referenceCurrent?.items])
  useEffect(() => {
    let active = true
    setReferenceState({ context: referenceContext, items: [], loading: true, error: false })
    void composerReferencesApi.list(workDir || undefined, referenceProviderId).then(data => {
      if (active) setReferenceState({ context: referenceContext, items: [...data.plugins, ...data.skills], loading: false, error: false })
    }).catch(() => {
      if (active) setReferenceState({ context: referenceContext, items: [], loading: false, error: true })
    })
    return () => { active = false }
  }, [referenceContext, workDir, referenceProviderId, lastPluginReloadSummary, slashMenuOpen, fileSearchOpen, plusMenuOpen])
  useEffect(() => {
    setReferenceDetail(null)
    setReferenceOptionId(undefined)
    setFileSearchOpen(false)
    setSlashMenuOpen(false)
  }, [workDir])

  const draftRuntimeSelectionKey = draftRuntimeSelection
    ? `${draftRuntimeSelection.providerId ?? 'official'}:${draftRuntimeSelection.modelId}:${draftRuntimeSelection.effortLevel ?? 'auto'}`
    : undefined
  const draftModelLabel = draftRuntimeSelection?.modelId ?? currentModel?.name ?? currentModel?.id
  const isMobileComposer = useMobileViewport() && !isDesktopRuntime()
  const dictation = useComposerDictation({
    composerRef,
    draft: input,
    blocked: isSubmitting,
    contextKey: 'empty-session',
    // Called from an effect, after this render has declared `handleSubmit`.
    onSubmit: () => { void handleSubmit() },
  })
  // While dictating, the toolbar's controls stay mounted but hidden, and the
  // recording bar takes their row.
  const dictationLive = dictation.phase !== 'idle'

  const showMobileHome = isMobileComposer && mobileHome !== undefined

  useEffect(() => {
    // The phone's home is a list to read first; focusing the composer would
    // throw the keyboard over it every time someone comes back to it.
    if (showMobileHome) return
    composerRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useDismissable({
    // On a phone the + opens a sheet that closes itself; see ChatInput.
    open: plusMenuOpen && !isMobileComposer,
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
    return commands.filter(isComposerSlashCommandVisible)
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
        : defaultActiveProviderSelection && (
          defaultActiveProviderSelection.providerId === OPENAI_OFFICIAL_PROVIDER_ID ||
          defaultActiveProviderSelection.providerId === GROK_OFFICIAL_PROVIDER_ID
        )
          // Built-in providers are not in the saved list. Without an explicit
          // effort the server runs the model default while the selector shows
          // the global value, so resolve it against the model's catalog here.
          ? normalizeRuntimeSelection({ ...defaultActiveProviderSelection, effortLevel })
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

  const insertSelectedFileMention = (mention: NewComposerMention) => {
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
    const inserted = insertMentionIntoText(input, mentions, cursorPos, cursorPos, mention)
    setInput(inserted.text)
    setMentions(inserted.mentions)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(inserted.cursorPos)
    })
  }

  // See ChatInput: the phone's + sheet holds the controls that left the
  // toolbar, and a row hands over to that control's own sheet.
  const openFromComposerSheet = (open: () => void) => {
    setPlusMenuOpen(false)
    requestAnimationFrame(open)
  }
  const mobileComposerSettings: MobileComposerSetting[] = isMobileComposer
    ? [
      {
        key: 'permission',
        icon: <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />,
        label: t('permMode.executionPermissions'),
        value: t(PERMISSION_MODE_LABEL_KEYS[draftPermissionMode]),
        onSelect: () => openFromComposerSheet(() => permissionSelectorRef.current?.open()),
      },
      {
        key: 'model',
        icon: <Cpu size={16} strokeWidth={1.75} aria-hidden="true" />,
        label: t('chat.mobileSheet.model'),
        value: draftModelLabel,
        disabled: isSubmitting,
        onSelect: () => openFromComposerSheet(() => modelSelectorRef.current?.open()),
      },
    ]
    : []

  // The "+" capability menu: the shared hook owns data and navigation actions,
  // these handlers are only the composer-local edits. Kept identical to
  // ChatInput's block on purpose — the two composers are one control.
  const capabilityMenu = useCapabilityMenu({
    open: plusMenuOpen,
    cwd: workDir,
    references: composerReferences,
    handlers: {
      onInsertMention: (reference) => {
        const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
        const mention = composerReferenceToMention(reference)
        const inserted = insertMentionIntoText(input, mentions, cursorPos, cursorPos, mention)
        setInput(inserted.text)
        setMentions(inserted.mentions)
        requestAnimationFrame(() => {
          composerRef.current?.focus()
          composerRef.current?.setSelectionOffsets(inserted.cursorPos)
        })
      },
      onInsertSlashText: (command) => {
        const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
        const replacement = replaceSlashToken(input, cursorPos, command)
        setInput(replacement.value)
        requestAnimationFrame(() => {
          composerRef.current?.focus()
          composerRef.current?.setSelectionOffsets(replacement.cursorPos)
        })
      },
      onInsertPromptSeed: (text) => {
        const next = input.trim() ? `${input}\n${text}` : text
        setInput(next)
        requestAnimationFrame(() => {
          composerRef.current?.focus()
          composerRef.current?.setSelectionOffsets(next.length)
        })
      },
      onAttachment: openAttachmentPicker,
      onSlashTrigger: insertSlashCommand,
      onSaveWorkflow: () => setLocalSlashPanel('save-workflow'),
      onClose: () => setPlusMenuOpen(false),
    },
  })

  const heroProject = workDir ? (resolveProjectDisplayName(workDir) ?? projectTitle(workDir)) : null
  // Same merge as the "+" menu's prompt seeds: a draft already typed is kept.
  const insertSuggestion = (text: string) => {
    const next = input.trim() ? `${input}\n${text}` : text
    setInput(next)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(next.length)
    })
  }

  return (
    // The new-session page (「素」, su-12). On desktop the composer sits in the
    // flow between the hero (bottom-aligned) and the starter row (top-aligned),
    // which puts it just above the middle of the page. On a phone it stays
    // docked to the bottom edge, above the keyboard.
    <div className="relative flex flex-1 flex-col overflow-hidden bg-[var(--color-surface)]">
      {showMobileHome ? (
        <div data-testid="mobile-home" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {mobileHome}
        </div>
      ) : (
      <div className={`flex flex-col items-center text-center ${
        isMobileComposer
          ? 'flex-1 justify-center px-6 pb-[230px] pt-10'
          : 'min-h-0 flex-1 justify-end overflow-hidden px-8 pb-7 pt-8'
      }`}>
        <div className={`flex flex-col items-center gap-2.5 ${isMobileComposer ? 'max-w-[300px]' : 'max-w-[600px]'}`}>
          <BrandSeal size={isMobileComposer ? 'md' : 'lg'} />
          <h1
            className={`mt-2 font-semibold leading-[1.3] tracking-tight text-[var(--color-text-primary)] ${
              isMobileComposer ? 'text-[22px]' : 'text-[26px]'
            }`}
          >
            {heroProject
              ? t('empty.heroTitle', { project: heroProject })
              : t('empty.heroTitleNoProject')}
          </h1>
          <p className="text-[14px] leading-6 text-[var(--color-text-tertiary)]">
            {t('empty.heroSubtitle')}
          </p>
        </div>
      </div>
      )}

      <div
        data-testid="empty-session-composer-shell"
        className={`flex justify-center ${
        showMobileHome
          ? 'relative z-[var(--z-raised)] shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 pb-2 pt-2'
          : isMobileComposer
          ? 'absolute bottom-0 left-0 right-0 z-[var(--z-nav)] px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]'
          : 'relative z-[var(--z-raised)] shrink-0 px-8'
      }`}
      >
        <div className={`flex w-full flex-col ${isMobileComposer ? 'max-w-none' : 'max-w-3xl'}`}>
          <div
            ref={panelRef}
            data-testid="empty-session-composer-panel"
            // Kept identical to ChatInput's floating card: `--radius-xl`, the
            // composer shadow step from `glass-panel--composer`, and an 8px
            // inset that the editor and toolbar pad themselves within.
            className={`glass-panel glass-panel--composer relative flex flex-col overflow-visible rounded-[var(--radius-xl)] p-2 ${isDragActive ? 'composer-drop-target-active' : ''}`}
            {...dragHandlers}
          >
            {isDragActive && (
              <ComposerDropOverlay
                testId="empty-session-drop-overlay"
                title={t('chat.dropFilesTitle')}
                description={t('chat.dropFilesHint')}
              />
            )}

            <div className="contents">
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
                  isSearching={Boolean(slashFilter.trim())}
                  references={composerReferences}
                  selectedIndex={slashSelectedIndex}
                  itemRefs={slashItemRefs}
                  onSelect={selectSlashCommand}
                  onHighlight={setSlashSelectedIndex}
                  showKeyboardHints={!isMobileComposer}
                />
              )}

              {attachments.length > 0 && (
                <div className="px-2 pt-2">
                  <AttachmentGallery attachments={attachments} variant="composer" onRemove={removeAttachment} />
                </div>
              )}

              <div className="flex items-start">
                <MentionComposer
                  ref={composerRef}
                  rootRef={composerContainerRef}
                  value={input}
                  mentions={mentions}
                  onMentionClick={setReferenceDetail}
                  onChange={handleComposerChange}
                  onKeyDown={handleComposerKeyDown}
                  onPaste={handleComposerPaste}
                  onCompositionStart={dictation.compositionHandlers.onCompositionStart}
                  onCompositionEnd={dictation.compositionHandlers.onCompositionEnd}
                  placeholder={t('empty.placeholder')}
                  // `min-w-0`: see ChatInput — an unbreakable long run (URL,
                  // hash) otherwise grows this flex item past the panel.
                  className="flex-1 min-w-0"
                  editorClassName={`chat-reading-text ${showMobileHome ? 'min-h-[44px]' : 'min-h-[72px]'} overflow-y-auto px-2.5 pb-1 pt-2 text-[var(--color-text-primary)] ${
                    isMobileComposer ? 'max-h-[132px]' : 'max-h-[200px]'
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

              {/* No divider: the editor's bottom inset and this row's top inset
                  separate the two, exactly as in ChatInput. */}
              <div className={`flex min-w-0 items-center justify-between pt-1.5 ${
                isMobileComposer ? 'flex-wrap gap-1' : 'gap-2'
              }`}>
                {dictationLive && <VoiceRecordingBar dictation={dictation} mobile={isMobileComposer} />}
                <div hidden={dictationLive} className="flex min-w-0 shrink items-center gap-1">
                  <div ref={plusMenuRef} className="relative shrink-0">
                    {/* Hand-rolled like ChatInput's: a quiet 28px square on
                        desktop, the 44px touch minimum on a phone. */}
                    <button
                      type="button"
                      onClick={() => setPlusMenuOpen((prev) => !prev)}
                      aria-label={t('chat.composerTools')}
                      aria-haspopup="menu"
                      aria-expanded={plusMenuOpen}
                      className={`inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                        plusMenuOpen ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : ''
                      } ${isMobileComposer ? 'h-11 w-11' : 'h-7 w-7'}`}
                    >
                      <Plus size={isMobileComposer ? 18 : 16} strokeWidth={1.75} aria-hidden="true" />
                    </button>

                    {plusMenuOpen && !isMobileComposer && (
                      <ComposerCapabilityMenu
                        cwd={workDir}
                        referencesLoading={referenceCurrent?.loading ?? true}
                        referencesError={referenceCurrent?.error}
                        onSelectFile={insertSelectedFileMention}
                        id={capabilityMenuId}
                        sections={capabilityMenu.sections}
                        onAction={capabilityMenu.onAction}
                        onClose={() => setPlusMenuOpen(false)}
                      />
                    )}
                    {isMobileComposer && (
                      <MobileComposerSheet
                        open={plusMenuOpen}
                        onClose={() => setPlusMenuOpen(false)}
                        menuId={capabilityMenuId}
                        settings={mobileComposerSettings}
                        sections={capabilityMenu.sections}
                        cwd={workDir}
                        referencesLoading={referenceCurrent?.loading ?? true}
                        referencesError={referenceCurrent?.error}
                        onSelectFile={insertSelectedFileMention}
                        onAction={capabilityMenu.onAction}
                      />
                    )}
                  </div>

                  <PermissionModeSelector
                    ref={permissionSelectorRef}
                    workDir={workDir}
                    compact={isMobileComposer}
                    trigger={isMobileComposer ? 'elevatedOnly' : 'chip'}
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

                <div
                  hidden={dictationLive}
                  className={`${isMobileComposer ? 'flex min-w-0 flex-1 items-center justify-end gap-1' : 'flex shrink-0 items-center gap-1'}`}
                >
                  {/* A draft has used none of its context; on a phone that is not
                      worth one of the toolbar's few touch targets. */}
                  {!isMobileComposer && (
                    <ContextUsageIndicator
                      chatState="idle"
                      messageCount={0}
                      runtimeSelectionKey={draftRuntimeSelectionKey}
                      fallbackModelLabel={draftModelLabel}
                      draft
                      compact={isMobileComposer}
                    />
                  )}
                  <ModelSelector ref={modelSelectorRef} runtimeKey={DRAFT_RUNTIME_SELECTION_KEY} disabled={isSubmitting} compact={isMobileComposer} />
                  <VoiceInputButton dictation={dictation} blocked={isSubmitting} mobile={isMobileComposer} />
                  {/* Kept identical to ChatInput's send button — same
                      component, shape, size and icon. See the note there for
                      why the label went away. */}
                  <Button
                    variant="accent"
                    size="base"
                    shape="circle"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    aria-label={t('common.run')}
                    title={t('common.run')}
                    className={`shrink-0 ${isMobileComposer ? 'h-11 w-11' : ''}`}
                    icon={<ArrowUp data-icon="send" size={isMobileComposer ? 18 : 16} strokeWidth={2} aria-hidden="true" />}
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

      {!isMobileComposer && (
        <div className="flex min-h-0 flex-[1.3] flex-col items-center overflow-y-auto px-8 pb-8 pt-4">
          <NewSessionStarter
            projectPath={workDir || null}
            projectLabel={heroProject}
            onSuggestion={insertSuggestion}
          />
        </div>
      )}

      <ComposerReferenceDetail mention={referenceDetail} onClose={() => setReferenceDetail(null)} />
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
    </div>
  )
}
