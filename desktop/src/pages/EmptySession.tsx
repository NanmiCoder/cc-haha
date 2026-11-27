import type { AgentProfile } from '@/types/session'
import { AgentProfileControl, type AgentProfileControlHandle } from '@/components/chat/AgentProfileControl'
import { isLeanSlashCommand, isUnsupportedLeanSlashInput } from '@/lib/agentProfile'
import { isComposerReferenceVisible, isComposerSlashCommandVisible } from '@/lib/composerCapabilityVisibility'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useDismissable } from '@/hooks/useDismissable'
import { ArrowUp, Cpu, Feather, Plus, ShieldCheck } from 'lucide-react'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { ModelBrandIcon } from '@/components/composite/ModelBrandIcon'
import { NewSessionStarter } from '@/components/layout/NewSessionStarter'
import { projectTitle } from '@/components/layout/sidebarTaskGroups'
import { resolveProjectDisplayName } from '../stores/projectDisplayNameStore'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { ApiError, rawRecordDiagnosticEvent } from '../api/client'
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
import { useWorkspaceStore } from '../stores/workspaceStore'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { RepositoryLaunchControls, type RepositoryLaunchControlsHandle } from '@/components/chat/RepositoryLaunchControls'
import { PermissionModeSelector, type PermissionModeSelectorHandle } from '../components/controls/PermissionModeSelector'
import { PERMISSION_MODE_LABEL_KEYS } from '../components/controls/permissionModeState'
import { ModelSelector, type ModelSelectorHandle } from '../components/controls/ModelSelector'
import { AttachmentGallery } from '../components/chat/AttachmentGallery'
import { ComposerDropOverlay } from '../components/chat/ComposerDropOverlay'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from '@/components/chat/ComposerReferenceMenu'
import { ComposerReferenceDetail } from '@/components/chat/ComposerReferenceDetail'
import { composerReferencesApi, mentionProviderId } from '@/api/composerReferences'
import { useCapabilityCatalogStore } from '@/stores/capabilityCatalogStore'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { LocalSlashCommandPanel, type LocalSlashCommandName } from '../components/chat/LocalSlashCommandPanel'
import {
  getSlashCommandOptionId,
  SlashCommandMenu,
} from '../components/chat/SlashCommandMenu'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { GROK_OFFICIAL_PROVIDER_ID } from '../constants/grokOfficialProvider'
import {
  DEEPSEEK_ACCOUNT_PROVIDER_ID,
  buildDeepSeekAccountProvider,
} from '../constants/deepseekAccountProvider'
import { CLAUDE_OFFICIAL_PROVIDER_ID, OPENAI_OFFICIAL_PROVIDER_ID } from '../constants/openaiOfficialProvider'
import {
  ANTIGRAVITY_ACP_DEFAULT_MODEL_ID,
  ANTIGRAVITY_ACP_LOGIN_COMMAND,
  ANTIGRAVITY_ACP_PERMISSION_MODES,
  ANTIGRAVITY_ACP_PROVIDER_ID,
  ANTIGRAVITY_DRAFT_SLASH_COMMANDS,
  ANTIGRAVITY_HOST_UI_SLASH_COMMANDS,
} from '../constants/antigravityAcp'
import {
  readAntigravityLastSelection,
  readLastComposerEngine,
  writeAntigravityLastSelection,
  writeLastComposerEngine,
  type ComposerEngine,
} from '../lib/antigravityPreferences'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { getSessionBrowsablePath } from '../lib/sessionWorkspace'
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
import { AgentProfileChip } from '@/components/chat/AgentProfileChip'
import { AgentTeamChip } from '@/components/chat/AgentTeamChip'
import { ComputerUseEnableDialog } from '@/components/computer-use/ComputerUseEnableDialog'
import { BrowserUseEnableDialog, BrowserUseTargetPill } from '@/components/browser-use/BrowserUseEnableDialog'
import { AgentTeamsCostDialog } from '@/components/agentTeams/AgentTeamsCostDialog'
import { withAgentTeamRequest, withAntigravitySwarmRequest } from '@/lib/agentTeamRequest'
import { executeFastSlashCommand } from '@/lib/fastModeCommand'
import { recordRecentSkills } from '@/lib/recentSkills'
import { formatBytes } from '@/lib/formatBytes'
import { checkUserMessageBudget } from '@/lib/userMessageBudget'
import type { AttachmentRef, UIAttachment } from '../types/chat'
import type { AntigravityStatus, SavedProvider } from '../types/provider'
import type { RuntimeSelection } from '../types/runtime'
import type { PermissionMode } from '../types/settings'
import type { SlashCommandOption } from '../components/chat/composerUtils'
import { useComposerDictation } from '@/features/voiceInput/useComposerDictation'
import { VoiceInputButton } from '@/features/voiceInput/VoiceInputButton'
import { VoiceRecordingBar } from '@/features/voiceInput/VoiceRecordingBar'
import { useComposerPromptHistory } from '@/hooks/useComposerPromptHistory'

type Attachment = ComposerAttachment

type Translate = ReturnType<typeof useTranslation>

function toUIAttachment(attachment: Attachment): UIAttachment {
  return {
    type: attachment.type,
    name: attachment.name,
    path: attachment.path,
    data: attachment.data,
    mimeType: attachment.mimeType,
    isDirectory: attachment.isDirectory,
    lineStart: attachment.lineStart,
    lineEnd: attachment.lineEnd,
    diffSide: attachment.diffSide,
    hunkId: attachment.hunkId,
    note: attachment.note,
    referenceKind: attachment.referenceKind,
    quote: attachment.quote,
  }
}

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

/** The provider name the model picker shows; `null` is Claude Official. */
function resolveProviderName(providerId: string | null, providers: SavedProvider[], t: Translate): string {
  switch (providerId) {
    case null:
    case CLAUDE_OFFICIAL_PROVIDER_ID:
      return t('settings.providers.officialName')
    case OPENAI_OFFICIAL_PROVIDER_ID:
      return t('settings.providers.openaiOfficialName')
    case GROK_OFFICIAL_PROVIDER_ID:
      return t('settings.providers.grokOfficialName')
    case DEEPSEEK_ACCOUNT_PROVIDER_ID:
      return t('settings.providers.deepseekAccountName')
    case ANTIGRAVITY_ACP_PROVIDER_ID:
      return t('settings.providers.antigravity.name')
    default:
      return providers.find((provider) => provider.id === providerId)?.name ?? providerId
  }
}

function resolveAntigravityDraftSelection(antigravity: AntigravityStatus | undefined): RuntimeSelection {
  const saved = readAntigravityLastSelection()
  const models = antigravity?.models ?? []
  const savedModel = saved ? models.find((model) => model.id === saved.modelId) : undefined
  const currentModel = antigravity?.currentModelId
    ? models.find((model) => model.id === antigravity.currentModelId)
    : undefined
  const chosenModel = savedModel ?? currentModel ?? models[0]
  const modelId = savedModel?.id
    ?? (models.length === 0 && saved?.modelId ? saved.modelId : undefined)
    ?? chosenModel?.id
    ?? antigravity?.currentModelId
    ?? ANTIGRAVITY_ACP_DEFAULT_MODEL_ID
  const matchesSavedModel = Boolean(saved?.modelId && saved.modelId === modelId)
  const matchesCurrentModel = Boolean(antigravity?.currentModelId && chosenModel?.id === antigravity.currentModelId)
  const supportedEfforts = chosenModel?.supportedReasoningEfforts
  let effortLevel: RuntimeSelection['effortLevel']
  if (Array.isArray(supportedEfforts)) {
    if (supportedEfforts.length > 0) {
      const candidates: Array<RuntimeSelection['effortLevel']> = [
        matchesSavedModel ? saved?.effortLevel : undefined,
        matchesCurrentModel ? antigravity?.currentEffortLevel : undefined,
        chosenModel?.defaultReasoningEffort,
        supportedEfforts[0],
      ]
      effortLevel = candidates.find((candidate): candidate is NonNullable<RuntimeSelection['effortLevel']> =>
        candidate !== undefined && supportedEfforts.includes(candidate),
      )
    }
  } else {
    effortLevel = (matchesSavedModel ? saved?.effortLevel : undefined)
      ?? (matchesCurrentModel ? antigravity?.currentEffortLevel : undefined)
      ?? chosenModel?.defaultReasoningEffort
      ?? antigravity?.currentEffortLevel
      ?? 'medium'
  }
  return {
    providerId: ANTIGRAVITY_ACP_PROVIDER_ID,
    modelId,
    ...(effortLevel ? { effortLevel } : {}),
  }
}

const EMPTY_COMPOSER_REFERENCES: ComposerReferenceCandidate[] = []

function reportDraftWorkspaceStaleRequest() {
  void rawRecordDiagnosticEvent({
    type: 'draft_workspace_request_stale',
    severity: 'warn',
    summary: 'A draft workspace request became stale before it could be consumed.',
  })
}

type EmptySessionProps = {
  /** The folder the task starts in; the phone's new-task sheet suggests one. */
  initialWorkDir?: string
  visible?: boolean
  /**
   * Set when this composer is the desktop's retained new-session draft. It
   * then reports whether it holds unsent content, keeps the draft's project
   * current, and follows `initialWorkDir` when an empty draft is moved.
   */
  draftRevision?: number
}

export function EmptySession({ initialWorkDir = '', visible = true, draftRevision }: EmptySessionProps = {}) {
  const t = useTranslation()
  const leanModeEnabled = useSettingsStore((state) => state.leanModeEnabled)
  const [selectedAgentProfile, setAgentProfile] = useState<AgentProfile>('standard')
  const agentProfile = leanModeEnabled ? selectedAgentProfile : 'standard'
  useEffect(() => {
    if (!leanModeEnabled) setAgentProfile('standard')
  }, [leanModeEnabled])
  const isLean = agentProfile === 'lean'
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [input, setInput] = useState('')
  const [mentions, setMentions] = useState<ComposerMention[]>([])
  const [referenceDetail, setReferenceDetail] = useState<ComposerMention | null>(null)
  const [referenceOptionId, setReferenceOptionId] = useState<string | undefined>()
  const [referenceState, setReferenceState] = useState<{ context: string, items: ComposerReferenceCandidate[], loading: boolean, error: boolean } | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [workDir, setWorkDir] = useState(initialWorkDir)
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  // Same rule as picking a folder: hold Send until its repository is read.
  const [repositoryLaunchReady, setRepositoryLaunchReady] = useState(!initialWorkDir)
  const applyWorkDir = (nextWorkDir: string) => {
    setWorkDir(nextWorkDir)
    setSelectedBranch(null)
    setUseWorktree(false)
    setRepositoryLaunchReady(!nextWorkDir)
  }
  // "New session" moves an empty retained draft to another project by changing
  // its seed. Follow it in place: a remount would drop the mode and permission
  // picked here. Our own folder picks write the same value back, a no-op.
  const [followedWorkDir, setFollowedWorkDir] = useState(initialWorkDir)
  if (draftRevision !== undefined && followedWorkDir !== initialWorkDir) {
    setFollowedWorkDir(initialWorkDir)
    if (initialWorkDir !== workDir) applyWorkDir(initialWorkDir)
  }
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  // Bumped when the + menu installs a skill, so the mention list reloads.
  const [referencesVersion, setReferencesVersion] = useState(0)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [localSlashPanel, setLocalSlashPanel] = useState<LocalSlashCommandName | null>(null)
  const [atFilter, setAtFilter] = useState('')
  const [atCursorPos, setAtCursorPos] = useState(-1)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [slashCommandState, setSlashCommandState] = useState<{
    cwd: string | null
    providerId: string | null
    commands: SlashCommandOption[]
  }>({ cwd: null, providerId: null, commands: [] })
  const slashCommands = slashCommandState.commands
  const slashCommandsCwd = slashCommandState.cwd
  const slashCommandsProviderId = slashCommandState.providerId
  const [agentSlashCommands, setAgentSlashCommands] = useState<SlashCommandOption[]>([])
  const composerRef = useRef<MentionComposerHandle>(null)
  const materializingRef = useRef<{
    revision: number | undefined
    promise: Promise<{ sessionId: string, ownedDraft: boolean } | null>
  } | null>(null)
  const workspaceRequestInFlightRef = useRef(new Set<number>())
  const runSubmittingRef = useRef(false)
  const draftComposerRef = useRef({ input, attachments, mentions })
  draftComposerRef.current = { input, attachments, mentions }
  const workspaceRequestAttemptRef = useRef(new Map<number, number>())
  const [materializationAttempt, setMaterializationAttempt] = useState(0)
  const composerContainerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelSelectorRef = useRef<ModelSelectorHandle>(null)
  const permissionSelectorRef = useRef<PermissionModeSelectorHandle>(null)
  const agentProfileRef = useRef<AgentProfileControlHandle>(null)
  const repositoryLaunchRef = useRef<RepositoryLaunchControlsHandle>(null)
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
  const draftWorkspaceRequest = useUIStore((state) => state.draftWorkspaceRequest)
  const currentModel = useSettingsStore((state) => state.currentModel)
  const activeProviderName = useSettingsStore((state) => state.activeProviderName)
  const effortLevel = useSettingsStore((state) => state.effortLevel)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const defaultPermissionMode = useSettingsStore((state) => state.permissionMode)
  const providers = useProviderStore((state) => state.providers)
  const activeProviderId = useProviderStore((state) => state.activeId)
  const antigravity = useProviderStore((state) => state.antigravity)
  const antigravityEnabled = useProviderStore((state) => state.antigravityEnabled)
  const discoverAntigravity = useProviderStore((state) => state.discoverAntigravity)
  // The draft follows the default from Settings until a mode is picked in this
  // draft. It stays mounted while Settings is open, so a copy taken at mount
  // would launch the next session in a mode the user had already turned off.
  const [pickedPermissionMode, setDraftPermissionMode] = useState<PermissionMode | null>(null)
  const lastPluginReloadSummary = usePluginStore((state) => state.lastReloadSummary)
  const draftRuntimeSelection = useSessionRuntimeStore((state) => state.selections[DRAFT_RUNTIME_SELECTION_KEY])
  const antigravityAvailable = Boolean(antigravity && antigravity.status !== 'not_installed' && antigravityEnabled)
  const [selectedEngine, setSelectedEngine] = useState<ComposerEngine>(() =>
    draftRuntimeSelection?.providerId === ANTIGRAVITY_ACP_PROVIDER_ID
      ? 'antigravity'
      : readLastComposerEngine(),
  )
  const engine: ComposerEngine = antigravityAvailable ? selectedEngine : 'cc-haha'
  const isAntigravity = engine === 'antigravity'
  const draftPermissionMode = pickedPermissionMode ?? defaultPermissionMode
  const lastStandardSelectionRef = useRef<RuntimeSelection | null>(
    draftRuntimeSelection && draftRuntimeSelection.providerId !== ANTIGRAVITY_ACP_PROVIDER_ID
      ? draftRuntimeSelection
      : null,
  )
  useEffect(() => {
    if (draftRuntimeSelection && draftRuntimeSelection.providerId !== ANTIGRAVITY_ACP_PROVIDER_ID) {
      lastStandardSelectionRef.current = draftRuntimeSelection
    }
  }, [draftRuntimeSelection])
  useEffect(() => {
    const runtimeStore = useSessionRuntimeStore.getState()
    const current = runtimeStore.selections[DRAFT_RUNTIME_SELECTION_KEY]
    if (isAntigravity) {
      const hasDiscoveredAntigravityModel = Boolean(
        antigravity && (
          antigravity.models.length > 0 ||
          (antigravity.currentModelId && antigravity.currentModelId !== ANTIGRAVITY_ACP_DEFAULT_MODEL_ID)
        ),
      )
      const shouldUpgradePlaceholder =
        current?.providerId === ANTIGRAVITY_ACP_PROVIDER_ID &&
        current.modelId === ANTIGRAVITY_ACP_DEFAULT_MODEL_ID &&
        hasDiscoveredAntigravityModel
      if (current?.providerId !== ANTIGRAVITY_ACP_PROVIDER_ID || shouldUpgradePlaceholder) {
        const nextSelection = resolveAntigravityDraftSelection(antigravity)
        if (
          current?.providerId !== nextSelection.providerId ||
          current?.modelId !== nextSelection.modelId ||
          current?.effortLevel !== nextSelection.effortLevel
        ) {
          runtimeStore.setSelection(DRAFT_RUNTIME_SELECTION_KEY, nextSelection)
        }
      }
      if (useWorktree) setUseWorktree(false)
      if (selectedAgentProfile === 'lean') setAgentProfile('standard')
      if (antigravity?.status === 'unchecked' && typeof providersApi.discoverAntigravity === 'function') {
        void discoverAntigravity().catch(() => {})
      }
    } else if (current?.providerId === ANTIGRAVITY_ACP_PROVIDER_ID) {
      if (lastStandardSelectionRef.current) {
        runtimeStore.setSelection(DRAFT_RUNTIME_SELECTION_KEY, lastStandardSelectionRef.current)
      } else {
        runtimeStore.clearSelection(DRAFT_RUNTIME_SELECTION_KEY)
      }
    }
  }, [antigravity, discoverAntigravity, isAntigravity, selectedAgentProfile, useWorktree])
  const referenceProviderId = mentionProviderId(draftRuntimeSelection)
  const referenceContext = `${workDir}\0${referenceProviderId ?? ''}\0${agentProfile}`
  const referenceCurrent = referenceState?.context === referenceContext ? referenceState : null
  const composerReferences = useMemo(() => (referenceCurrent?.items ?? EMPTY_COMPOSER_REFERENCES).filter(reference => isComposerReferenceVisible(reference) && (!isLean || reference.kind === 'skill')), [referenceCurrent?.items, isLean])
  useEffect(() => {
    let active = true
    setReferenceState({ context: referenceContext, items: [], loading: true, error: false })
    void composerReferencesApi.list(workDir || undefined, referenceProviderId, isLean ? 'lean' : undefined).then(data => {
      useCapabilityCatalogStore.getState().remember([...data.plugins, ...data.skills])
      if (active) setReferenceState({ context: referenceContext, items: [...data.plugins, ...data.skills], loading: false, error: false })
    }).catch(() => {
      if (active) setReferenceState({ context: referenceContext, items: [], loading: false, error: true })
    })
    return () => { active = false }
  }, [referenceContext, workDir, referenceProviderId, isLean, lastPluginReloadSummary, slashMenuOpen, fileSearchOpen, plusMenuOpen, referencesVersion])
  useEffect(() => {
    setReferenceDetail(null)
    setReferenceOptionId(undefined)
    setFileSearchOpen(false)
    setSlashMenuOpen(false)
  }, [workDir])

  const draftModelLabel = draftRuntimeSelection?.modelId ?? currentModel?.name ?? currentModel?.id
  const isMobileComposer = useMobileViewport() && !isDesktopRuntime()
  // Picking the Agent mode is a row of the "+" menu (the phone's "+" sheet opens
  // its own sheet from a row); the toolbar only marks a lean draft.
  const changeAgentProfile = (profile: AgentProfile) => {
    if (profile === agentProfile) return
    setAgentProfile(profile)
    if (profile === 'lean' && draftPermissionMode === 'plan') {
      setDraftPermissionMode('default')
      addToast({ type: 'info', message: t('agentProfile.planReset') })
    }
  }
  const dictation = useComposerDictation({
    composerRef,
    draft: input,
    blocked: isSubmitting || !visible,
    contextKey: visible ? 'empty-session' : null,
    // Called from an effect, after this render has declared `handleSubmit`.
    onSubmit: () => { void handleSubmit() },
  })
  // While dictating, the toolbar's controls stay mounted but hidden, and the
  // recording bar takes their row.
  const dictationLive = dictation.phase !== 'idle'

  const promptHistory = useComposerPromptHistory({
    sessionId: null,
    projectPath: workDir || null,
    includeProjectHistory: true,
    getCurrentDraft: () => ({
      text: draftComposerRef.current.input,
      mentions: draftComposerRef.current.mentions,
    }),
    applyEntry: (entry, cursor) => {
      const nextMentions = entry.mentions ?? []
      composerRef.current?.replaceContent(entry.text, nextMentions, cursor)
      draftComposerRef.current = {
        ...draftComposerRef.current,
        input: entry.text,
        mentions: nextMentions,
      }
      setInput(entry.text)
      setMentions(nextMentions)
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setAtFilter('')
      setAtCursorPos(-1)
    },
  })

  useEffect(() => {
    if (visible) composerRef.current?.focus()
    else {
      promptHistory.resetHistory()
      setPlusMenuOpen(false)
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setReferenceDetail(null)
      setLocalSlashPanel(null)
    }
  }, [promptHistory.resetHistory, visible])

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

  const antigravityDiscoveryStatus = isAntigravity ? (antigravity?.status ?? null) : null

  useEffect(() => {
    let cancelled = false

    const cwd = workDir || undefined
    const mapSkillsToSlashCommands = (
      skills: Array<{
        name: string
        description: string
        source?: string
        userInvocable?: boolean
        leanCompatible?: boolean
      }>,
    ): SlashCommandOption[] =>
      skills
        .filter((skill) => skill.userInvocable !== false)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          kind: 'skill' as const,
          ...(skill.source === 'user' || skill.source === 'project' || skill.source === 'plugin'
            ? { source: skill.source }
            : {}),
          // Kept on the row so the lean/standard choice, made later, can filter without a refetch.
          ...(skill.leanCompatible === false ? { leanCompatible: false } : {}),
        }))

    const sanitizeSlashCommands = (commands: SlashCommandOption[]): SlashCommandOption[] =>
      commands.map(({ argumentHint, description, ...rest }) => {
        const normalizedHint =
          typeof argumentHint === 'string' && argumentHint.trim()
            ? argumentHint.trim()
            : undefined
        return {
          ...rest,
          description: typeof description === 'string' ? description : '',
          ...(normalizedHint ? { argumentHint: normalizedHint } : {}),
        }
      })

    const providerId = isAntigravity ? ANTIGRAVITY_ACP_PROVIDER_ID : null
    const loadFromSkillsFallback = () =>
      skillsApi.list(cwd).then(({ skills }) => mapSkillsToSlashCommands(skills))

    const loadPromise =
      typeof skillsApi.commands === 'function'
        ? (isAntigravity
            ? skillsApi.commands(cwd, undefined, ANTIGRAVITY_ACP_PROVIDER_ID)
            : skillsApi.commands(cwd)
          ).then(
            ({ commands }) => sanitizeSlashCommands(commands),
            (error) => {
              if (!isAntigravity && error instanceof ApiError && error.status === 400) {
                return loadFromSkillsFallback()
              }
              throw error
            },
          )
        : isAntigravity
          ? Promise.resolve([])
          : loadFromSkillsFallback()

    loadPromise
      .then((commands) => {
        if (cancelled) return
        setSlashCommandState({ cwd: workDir, providerId, commands })
      })
      .catch(() => {
        if (!cancelled) {
          setSlashCommandState((prev) =>
            prev.cwd === workDir && prev.providerId === providerId
              ? prev
              : { cwd: workDir, providerId, commands: [] },
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [workDir, isAntigravity, antigravityDiscoveryStatus, lastPluginReloadSummary, referencesVersion])

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

  // A lean draft's skills and mention list come from the server already filtered
  // for lean, `.claude/commands/*.md` among them (as skills). A name on them is
  // available even when a desktop built-in row shares it, which is what ChatInput
  // trusts in a lean session: `/review` runs the project's own command there.
  // The mention list is fetched again whenever a menu opens or closes and is empty
  // while that runs; a send or a menu filter landing in it must not forget what
  // the server just listed. A new project, provider or mode drops the names.
  const referenceNamesRef = useRef<string[]>([])
  const referenceNames = useMemo(() => {
    const names = composerReferences.map(reference => (reference.kind === 'plugin' ? reference.id : reference.name))
    if (names.length === 0 && referenceCurrent?.loading) return referenceNamesRef.current
    referenceNamesRef.current = names
    return names
  }, [composerReferences, referenceCurrent?.loading])
  const listedLeanNames = useMemo(() => new Set([
    ...(slashCommandsCwd === workDir && slashCommandsProviderId === null ? slashCommands : []).filter(command => command.leanCompatible !== false).map(command => command.name),
    ...referenceNames,
  ]), [slashCommands, slashCommandsCwd, slashCommandsProviderId, workDir, referenceNames])

  const allSlashCommands = useMemo(() => {
    if (isAntigravity) {
      const localized = new Map(getLocalizedFallbackCommands(t).map((cmd) => [cmd.name, cmd.description]))
      const draftBuiltIns: SlashCommandOption[] = ANTIGRAVITY_DRAFT_SLASH_COMMANDS.map((cmd) => ({
        name: cmd.name,
        description: localized.get(cmd.name) ?? cmd.description,
        kind: 'command',
      }))
      const agySkills =
        slashCommandsCwd === workDir && slashCommandsProviderId === ANTIGRAVITY_ACP_PROVIDER_ID
          ? slashCommands
          : []
      const seen = new Set(draftBuiltIns.map((cmd) => cmd.name.toLowerCase()))
      const merged = [...draftBuiltIns]
      for (const skill of agySkills) {
        const key = skill.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        merged.push({ ...skill, kind: skill.kind ?? 'skill' })
      }
      return merged
    }
    const commands = appendAgentSlashCommands(
      mergeSlashCommands(
        slashCommandsCwd === workDir && slashCommandsProviderId === null ? slashCommands : [],
        getLocalizedFallbackCommands(t),
      ),
      agentSlashCommands,
    )
    const names = new Set(commands.map(command => command.name.toLowerCase()))
    for (const reference of composerReferences) {
      const name = reference.kind === 'plugin' ? reference.id : reference.name
      if (names.has(name.toLowerCase())) continue
      names.add(name.toLowerCase())
      commands.push({ name, description: reference.description, kind: reference.kind })
    }
    return commands.filter(command => isComposerSlashCommandVisible(command) && (!isLean || isLeanSlashCommand(command, listedLeanNames)))
  }, [agentSlashCommands, slashCommands, slashCommandsCwd, slashCommandsProviderId, workDir, composerReferences, listedLeanNames, isLean, isAntigravity, t])

  const handleWorkDirChange = (newWorkDir: string) => {
    applyWorkDir(newWorkDir)
    // Keep the seed current for another Cmd+N while no server tab is active.
    // Only the draft's own composer may move it.
    if (draftRevision !== undefined) {
      useUIStore.setState(state => state.newSessionDraft?.revision === draftRevision
        ? { newSessionDraft: { ...state.newSessionDraft, workDir: newWorkDir } }
        : state)
    }
  }

  // Whitespace alone is not worth keeping a project for; mentions live in the
  // text. A project, model or mode choice is not content either. A draft that is
  // being sent is not empty: Run is enabled with only a project chosen, and moving
  // that project mid-send would point the launch at another repository.
  const hasUnsentContent = input.trim().length > 0 || attachments.length > 0 || isSubmitting
  useEffect(() => {
    if (draftRevision === undefined) return
    useUIStore.getState().setNewSessionDraftContent(draftRevision, hasUnsentContent)
  }, [draftRevision, hasUnsentContent])

  const filteredCommandGroups = useMemo(() => {
    return groupSlashCommands(filterSlashCommands(allSlashCommands, slashFilter, { showAllWhenEmpty: isAntigravity }))
  }, [allSlashCommands, isAntigravity, slashFilter])
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
    setSlashSelectedIndex((prev) =>
      filteredCommands.length === 0 ? 0 : Math.min(prev, filteredCommands.length - 1),
    )
  }, [filteredCommands.length])

  useEffect(() => {
    const activeItem = slashMenuOpen ? slashItemRefs.current[slashSelectedIndex] : null
    if (activeItem && typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ block: 'nearest' })
    }
  }, [slashMenuOpen, slashSelectedIndex])

  /**
   * Assigns the retained draft a real session without sending anything.
   *
   * Both Enter and a workspace control need this: the draft holds no server
   * session until then (the immutable agent profile has to be chosen first),
   * while every workspace panel is keyed by a session id. The draft is cleared
   * only when this call still owns it, so a late response cannot discard a
   * newer draft.
   */
  const createDraftSession = useCallback(async (): Promise<{ sessionId: string, ownedDraft: boolean } | null> => {
    const runtimeStore = useSessionRuntimeStore.getState()
    const explicitDraftSelection = runtimeStore.selections[DRAFT_RUNTIME_SELECTION_KEY]
    const submittedDraft = useUIStore.getState().newSessionDraft
    const ownsDraft = () => mounted.current && useUIStore.getState().newSessionDraft?.revision === submittedDraft?.revision

    try {
      // A model picked in this draft runs on its own provider, whatever the
      // global default is, so that provider's credentials are the ones to check.
      // Without a pick the server keeps judging the global default.
      let authStatus = isAntigravity
        ? await providersApi.authStatus(ANTIGRAVITY_ACP_PROVIDER_ID)
        : explicitDraftSelection
          ? await providersApi.authStatus(explicitDraftSelection.providerId ?? CLAUDE_OFFICIAL_PROVIDER_ID)
          : await providersApi.authStatus()
      if (isAntigravity && !authStatus.hasAuth) {
        let antigravityAuthState = authStatus.antigravityStatus ?? authStatus.localAgentStatus
        let antigravityError: string | undefined
        if (antigravityAuthState === 'unchecked' && typeof discoverAntigravity === 'function') {
          try {
            const discovered = await discoverAntigravity()
            if (discovered) {
              antigravityAuthState = discovered.status
              if (discovered.status === 'ready') {
                authStatus = { ...authStatus, hasAuth: true, antigravityStatus: 'ready', localAgentStatus: 'ready' }
              }
            }
          } catch (error) {
            antigravityAuthState = 'error'
            antigravityError = error instanceof Error ? error.message : String(error)
          }
        }
        if (!authStatus.hasAuth) {
          if (antigravityAuthState === 'login_required') {
            addToast({
              type: 'warning',
              message: t('settings.providers.antigravity.status.login_required', { command: ANTIGRAVITY_ACP_LOGIN_COMMAND }),
            })
          } else if (antigravityAuthState === 'not_installed') {
            addToast({
              type: 'warning',
              message: t('settings.providers.antigravity.status.not_installed'),
            })
          } else {
            addToast({
              type: 'warning',
              message: antigravityError || t('settings.providers.antigravity.status.error'),
            })
          }
          useUIStore.getState().setPendingSettingsTab('providers')
          useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
          return null
        }
      }
      if (!authStatus.hasAuth) {
        const providerName = resolveProviderName(
          explicitDraftSelection ? explicitDraftSelection.providerId : activeProviderId,
          providers,
          t,
        )
        const modelName = explicitDraftSelection?.modelId ?? currentModel?.name ?? currentModel?.id
        addToast({
          type: 'warning',
          message: modelName
            ? t('empty.noCredentials', { model: modelName, provider: providerName })
            : t('empty.noCredentialsProvider', { provider: providerName }),
        })
        useUIStore.getState().setPendingSettingsTab('providers')
        useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
        return null
      }

      const defaultActiveProviderSelection = explicitDraftSelection
        ? null
        : resolveActiveProviderRuntimeSelection(
          activeProviderId,
          activeProviderName,
          providers,
          currentModel?.id,
        )
      // The DeepSeek account provider is built in, so it is not in the saved
      // list, but it resolves effort exactly like a saved DeepSeek provider.
      const activeCustomProvider = defaultActiveProviderSelection
        ? providers.find((provider) => provider.id === defaultActiveProviderSelection.providerId) ??
          (defaultActiveProviderSelection.providerId === DEEPSEEK_ACCOUNT_PROVIDER_ID
            ? buildDeepSeekAccountProvider()
            : undefined)
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
      const runtimeSelection = isAntigravity
        ? (explicitDraftSelection?.providerId === ANTIGRAVITY_ACP_PROVIDER_ID &&
            (explicitDraftSelection.modelId !== ANTIGRAVITY_ACP_DEFAULT_MODEL_ID || !antigravity?.models.length)
            ? explicitDraftSelection
            : resolveAntigravityDraftSelection(antigravity))
        : (explicitDraftSelection
            ?? defaultRuntimeSelection
            ?? claudeOAuthRuntimeSelection)
      // The draft may have waited for hours. A branch chosen for the user is
      // decided again now, against the checkout as it is: the server switches
      // to any launch branch that is not the current one.
      const launchBranch = selectedBranch && repositoryLaunchRef.current
        ? await repositoryLaunchRef.current.resolveLaunchBranch()
        : selectedBranch
      const sessionId = await createSession(
        workDir || undefined,
        {
          ...(launchBranch
            ? { repository: { branch: launchBranch, worktree: isAntigravity ? false : useWorktree } }
            : {}),
          permissionMode: draftPermissionMode,
          ...(isLean && !isAntigravity ? { agentProfile } : {}),
          ...(isAntigravity ? {
            launchProviderId: ANTIGRAVITY_ACP_PROVIDER_ID,
            providerId: ANTIGRAVITY_ACP_PROVIDER_ID,
            modelId: runtimeSelection?.modelId ?? ANTIGRAVITY_ACP_DEFAULT_MODEL_ID,
            ...(runtimeSelection?.effortLevel ? { effortLevel: runtimeSelection.effortLevel } : {}),
          } : {}),
        },
      )
      if (runtimeSelection) {
        runtimeStore.setSelection(sessionId, runtimeSelection)
      }
      const ownedDraft = ownsDraft()
      if (ownedDraft) {
        if (explicitDraftSelection && useSessionRuntimeStore.getState().selections[DRAFT_RUNTIME_SELECTION_KEY] === explicitDraftSelection) {
          runtimeStore.clearSelection(DRAFT_RUNTIME_SELECTION_KEY)
        }
        if (!useUIStore.getState().draftWorkspaceRequest) {
          useUIStore.setState({ newSessionDraft: null })
        }
      }
      return { sessionId, ownedDraft }
    } catch (error) {
      addToast({
        type: 'error',
        message: resolveCreateSessionErrorMessage(error, t),
      })
      return null
    }
  }, [
    activeProviderId,
    activeProviderName,
    addToast,
    agentProfile,
    antigravity,
    createSession,
    currentModel?.id,
    currentModel?.name,
    draftPermissionMode,
    effortLevel,
    isAntigravity,
    isLean,
    providers,
    selectedBranch,
    t,
    useWorktree,
    workDir,
  ])

  const materializeDraftSession = useCallback(() => {
    const revision = draftRevision ?? useUIStore.getState().newSessionDraft?.revision
    const cached = materializingRef.current
    if (cached && cached.revision === revision) return cached.promise

    const promise = createDraftSession()
    const materialization = { revision, promise }
    materializingRef.current = materialization
    void promise.then((result) => {
      if (materializingRef.current !== materialization) return
      const pendingRequest = useUIStore.getState().draftWorkspaceRequest
      const draftStillOwnsRequest =
        result !== null &&
        pendingRequest?.revision === revision &&
        useUIStore.getState().newSessionDraft?.revision === revision
      if (!draftStillOwnsRequest) materializingRef.current = null
    })
    return promise
  }, [createDraftSession, draftRevision])

  const handleSubmit = async () => {
    const text = input.trim()
    if (!canSubmit || !visible) return
    if (isLean && isUnsupportedLeanSlashInput(text, [...allSlashCommands, ...slashCommands, ...getLocalizedFallbackCommands(t)], listedLeanNames)) {
      addToast({ type: 'info', message: t('agentProfile.draftCommandUnavailable') })
      return
    }

    if (isLean && draftPermissionMode === 'plan') {
      addToast({ type: 'info', message: t('agentProfile.planUnavailable') })
      return
    }

    const rawSlashUiAction = text.startsWith('/') ? resolveSlashUiAction(text.slice(1)) : null
    const slashCommandName = text.startsWith('/') ? text.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? '' : ''
    const slashUiAction = isAntigravity && !ANTIGRAVITY_HOST_UI_SLASH_COMMANDS.has(slashCommandName)
      ? null
      : rawSlashUiAction
    if (slashUiAction?.type === 'panel') {
      promptHistory.recordSubmission({ text: input, mentions })
      setLocalSlashPanel(slashUiAction.command as LocalSlashCommandName)
      setInput('')
      setMentions([])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (slashUiAction?.type === 'settings') {
      promptHistory.recordSubmission({ text: input, mentions })
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
      promptHistory.recordSubmission({ text: input, mentions })
      modelSelectorRef.current?.open()
      setInput('')
      setMentions([])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (slashUiAction?.type === 'fast') {
      promptHistory.recordSubmission({ text: input, mentions })
      setInput('')
      setMentions([])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      await executeFastSlashCommand({
        mode: slashUiAction.mode,
        runtimeKey: DRAFT_RUNTIME_SELECTION_KEY,
        t,
      })
      return
    }

    const submittedTabId = useTabStore.getState().activeTabId
    const serializedText = (composerRef.current?.getModelContent() ?? input).trim()
    const attachmentPayload: AttachmentRef[] = attachments.map((attachment) => ({
      type: attachment.type,
      name: attachment.name,
      path: attachment.path,
      data: attachment.data,
      mimeType: attachment.mimeType,
    }))
    // Inline @-mentions go out as the `@"absolute path"` text the CLI parses,
    // serialized from the live document; the bubble keeps the pill text.
    // Agent Team armed in the + menu: the model gets the team instruction,
    // the bubble keeps what the user typed.
    const sendAsTeam = capabilityMenu.agentTeamArmed
    const contentForModel = sendAsTeam
      ? (isAntigravity ? withAntigravitySwarmRequest(serializedText) : withAgentTeamRequest(serializedText))
      : serializedText
    // The local server drops a frame over its input budget by closing the
    // socket, and the client would only reconnect: the first turn, with its
    // pasted screenshots inlined as data URLs, would vanish without a trace.
    // Checked before the draft becomes a session, so the draft stays as it is.
    const budget = checkUserMessageBudget({ type: 'user_message', content: contentForModel, attachments: attachmentPayload })
    if (!budget.ok) {
      addToast({
        type: 'error',
        message: t('chat.messageTooLarge', { size: formatBytes(budget.bytes), limit: formatBytes(budget.limit) }),
      })
      return
    }
    setIsSubmitting(true)
    runSubmittingRef.current = true
    setMaterializationAttempt((attempt) => attempt + 1)
    try {
      const materialized = await materializeDraftSession()
      if (!materialized) return
      const { sessionId, ownedDraft } = materialized
      if (ownedDraft) {
        if (useTabStore.getState().activeTabId === submittedTabId) {
          setActiveView('code')
          useTabStore.getState().openTab(sessionId, 'New Session')
        }
      } else {
        const activeTab = useTabStore.getState().tabs.find(tab => tab.sessionId === useTabStore.getState().activeTabId)
        useSessionStore.getState().setActiveSession(activeTab?.type === 'session' ? activeTab.sessionId : null)
      }
      connectToSession(sessionId)
      if (serializedText || attachmentPayload.length > 0) {
        sendMessage(sessionId, contentForModel, attachmentPayload, { displayContent: text })
      }
      if (text) {
        const createdSession = useSessionStore.getState().sessions.find((session) => session.id === sessionId)
        promptHistory.recordSubmission(
          { text: input, mentions },
          {
            sessionId,
            projectPath: workDir || createdSession?.workDir || null,
            projectRoot: createdSession?.projectRoot ?? null,
          },
        )
      } else {
        promptHistory.resetHistory()
      }
      recordRecentSkills(mentions.flatMap(mention => mention.kind === 'skill' && mention.id ? [mention.id] : []))
      if (sendAsTeam) capabilityMenu.disarmAgentTeam()
      setInput('')
      setMentions([])
      setAttachments([])
    } catch (error) {
      addToast({
        type: 'error',
        message: resolveCreateSessionErrorMessage(error, t),
      })
    } finally {
      runSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  // A workspace action belongs to its draft even if session creation is also
  // being driven by Run. Keep it queued until one shared creation has completed.
  useEffect(() => {
    const request = draftWorkspaceRequest
    if (!request || !visible || draftRevision === undefined || request.revision !== draftRevision) return
    if (workspaceRequestInFlightRef.current.has(request.nonce)) return
    if (workspaceRequestAttemptRef.current.get(request.nonce) === materializationAttempt) return
    workspaceRequestAttemptRef.current.set(request.nonce, materializationAttempt)
    workspaceRequestInFlightRef.current.add(request.nonce)

    const draftWorkDir = workDir
    const runAlreadySubmitting = runSubmittingRef.current
    setIsSubmitting(true)
    void (async () => {
      let consumed = false
      try {
        const materialized = await materializeDraftSession()
        const currentRequest = useUIStore.getState().draftWorkspaceRequest
        if (
          !materialized ||
          !materialized.ownedDraft ||
          currentRequest?.nonce !== request.nonce ||
          currentRequest.revision !== request.revision
        ) {
          if (materialized && !materialized.ownedDraft) reportDraftWorkspaceStaleRequest()
          return
        }

        const { sessionId } = materialized
        const activeTabId = useTabStore.getState().activeTabId
        if (activeTabId === request.originatingTabId && useUIStore.getState().activeView === request.originatingView) {
          setActiveView('code')
        }
        useTabStore.getState().openTab(sessionId, t('sidebar.newSession'))
        if (activeTabId !== request.originatingTabId && activeTabId !== sessionId) useTabStore.getState().setActiveTab(activeTabId)
        connectToSession(sessionId)
        // The editor stays usable during creation; carry its latest content.
        const { input: draftText, attachments: draftAttachments, mentions: draftMentions } = draftComposerRef.current
        if (!runAlreadySubmitting && (draftText || draftAttachments.length > 0 || draftMentions.length > 0)) {
          useChatStore.getState().queueComposerPrefill(sessionId, {
            text: draftText,
            attachments: draftAttachments.map(toUIAttachment),
            mentions: draftMentions,
            mode: 'replace',
          })
        }

        const createdSession = useSessionStore.getState().sessions.find((session) => session.id === sessionId)
        const bottomCwd = getSessionBrowsablePath(createdSession) ?? draftWorkDir
        const workspace = useWorkspaceStore.getState()
        if (request.action === 'toggle-side') {
          workspace.toggleWorkspace(sessionId)
        } else if (request.action === 'toggle-bottom') {
          workspace.toggleBottomPanel(sessionId, bottomCwd)
        } else {
          workspace.toggleWorkspace(sessionId)
          workspace.toggleFullscreen(sessionId)
        }
        consumed = true
      } finally {
        if (mounted.current) setIsSubmitting(false)
        if (consumed) {
          useUIStore.getState().clearDraftWorkspaceRequest(request.nonce)
          if (useUIStore.getState().newSessionDraft?.revision === request.revision) {
            useUIStore.setState({ newSessionDraft: null })
          }
          if (materializingRef.current?.revision === request.revision) {
            materializingRef.current = null
          }
        }
        workspaceRequestInFlightRef.current.delete(request.nonce)
      }
    })()
  }, [
    attachments,
    connectToSession,
    draftRevision,
    draftWorkspaceRequest,
    setActiveView,
    input,
    materializationAttempt,
    materializeDraftSession,
    mentions,
    t,
    visible,
    workDir,
  ])

  const handleComposerChange = (value: string, nextMentions: ComposerMention[]) => {
    promptHistory.resetHistory()
    draftComposerRef.current = {
      ...draftComposerRef.current,
      input: value,
      mentions: nextMentions,
    }
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
        const selected = filteredCommands[slashSelectedIndex] ?? filteredCommands[0]
        if (
          event.key === 'Enter' &&
          exactSlashCommand &&
          (isAntigravity || !composerReferences.some(item => item.kind === selected?.kind && (item.id === selected?.name || item.name === selected?.name))) &&
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

    if (
      !isSubmitting &&
      !dictationLive &&
      !localSlashPanel &&
      !plusMenuOpen &&
      !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    ) {
      if (event.key === 'ArrowUp' && composerRef.current?.isSelectionAtBoundary('up')) {
        if (promptHistory.onHistoryUp()) {
          event.preventDefault()
          return true
        }
      }
      if (
        event.key === 'ArrowDown' &&
        promptHistory.isNavigating() &&
        composerRef.current?.isSelectionAtBoundary('down')
      ) {
        if (promptHistory.onHistoryDown()) {
          event.preventDefault()
          return true
        }
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
    disabled: !visible,
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
    promptHistory.resetHistory()
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
    const option = allSlashCommands.find(item => item.name === command)
    let nextCursor: number
    const reference = !isAntigravity && (option?.kind === 'skill' || option?.kind === 'plugin')
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
    promptHistory.resetHistory()
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
    promptHistory.resetHistory()
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
      // The mode has no chip on a phone's toolbar: it covered the "+".
      ...(leanModeEnabled && !isAntigravity ? [{
        key: 'agentProfile',
        icon: <Feather size={16} strokeWidth={1.75} aria-hidden="true" />,
        label: t('agentProfile.label'),
        value: t(isLean ? 'agentProfile.lean' : 'agentProfile.standard'),
        disabled: isSubmitting,
        onSelect: () => openFromComposerSheet(() => agentProfileRef.current?.open()),
      }] : []),
    ]
    : []

  // The "+" capability menu: the shared hook owns data and navigation actions,
  // these handlers are only the composer-local edits. Kept identical to
  // ChatInput's block on purpose — the two composers are one control.
  // Desktop: first in the trailing group, as a quiet glyph until writes run
  // unattended. A phone keeps it after the chips, where it only shows then.
  const permissionSelector = (
    <PermissionModeSelector
      ref={permissionSelectorRef}
      workDir={workDir}
      compact={isMobileComposer}
      trigger={isMobileComposer ? 'elevatedOnly' : 'quiet'}
      // On the desktop the trigger sits at the right of the card: a menu that
      // opened rightwards from it ran past the card and the window edge.
      menuAlign={isMobileComposer ? 'left' : 'right'}
      lean={isLean}
      antigravity={isAntigravity}
      allowedModes={isAntigravity ? ANTIGRAVITY_ACP_PERMISSION_MODES : undefined}
      value={draftPermissionMode}
      onChange={setDraftPermissionMode}
    />
  )

  const capabilityMenu = useCapabilityMenu({
    open: plusMenuOpen,
    cwd: workDir,
    references: composerReferences,
    lean: isLean,
    antigravity: isAntigravity,
    // While the conversation is being created the mode is fixed, as it will be after.
    agentProfile: leanModeEnabled && !isMobileComposer && !isAntigravity
      ? { value: agentProfile, onChange: isSubmitting ? undefined : changeAgentProfile }
      : undefined,
    handlers: {
      onInsertMention: (reference) => {
        promptHistory.resetHistory()
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
        promptHistory.resetHistory()
        const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
        const replacement = replaceSlashToken(input, cursorPos, command)
        setInput(replacement.value)
        requestAnimationFrame(() => {
          composerRef.current?.focus()
          composerRef.current?.setSelectionOffsets(replacement.cursorPos)
        })
      },
      onAttachment: openAttachmentPicker,
      onSlashTrigger: insertSlashCommand,
      onSaveWorkflow: () => setLocalSlashPanel('save-workflow'),
      onReferencesChanged: () => setReferencesVersion(version => version + 1),
      onClose: () => setPlusMenuOpen(false),
    },
  })

  const handleEngineChange = (nextEngine: ComposerEngine) => {
    if (nextEngine === engine || isSubmitting) return
    setSelectedEngine(nextEngine)
    writeLastComposerEngine(nextEngine)
    const runtimeStore = useSessionRuntimeStore.getState()
    if (nextEngine === 'antigravity') {
      setUseWorktree(false)
      if (selectedAgentProfile === 'lean') setAgentProfile('standard')
      runtimeStore.setSelection(DRAFT_RUNTIME_SELECTION_KEY, resolveAntigravityDraftSelection(antigravity))
      if (antigravity?.status === 'unchecked' && typeof providersApi.discoverAntigravity === 'function') {
        void discoverAntigravity().catch(() => {})
      }
      return
    }
    const current = runtimeStore.selections[DRAFT_RUNTIME_SELECTION_KEY]
    if (current?.providerId === ANTIGRAVITY_ACP_PROVIDER_ID) {
      writeAntigravityLastSelection({
        modelId: current.modelId,
        ...(current.effortLevel ? { effortLevel: current.effortLevel } : {}),
      })
    }
    if (lastStandardSelectionRef.current) {
      runtimeStore.setSelection(DRAFT_RUNTIME_SELECTION_KEY, lastStandardSelectionRef.current)
    } else {
      runtimeStore.clearSelection(DRAFT_RUNTIME_SELECTION_KEY)
    }
  }

  const engineSwitcher = antigravityAvailable ? (
    <div data-testid="composer-engine-switcher" className="shrink-0">
      <SegmentedControl
        size="sm"
        label={t('empty.engineSwitcher.label')}
        value={engine}
        onChange={handleEngineChange}
        items={[
          { value: 'cc-haha', label: 'cc-haha', disabled: isSubmitting },
          {
            value: 'antigravity',
            label: t('settings.providers.antigravity.name'),
            icon: <ModelBrandIcon providerId={ANTIGRAVITY_ACP_PROVIDER_ID} size={12} />,
            disabled: isSubmitting,
          },
        ]}
      />
    </div>
  ) : null

  const heroProject = workDir ? (resolveProjectDisplayName(workDir) ?? projectTitle(workDir)) : null
  // A draft already typed is kept: the suggestion goes on a new line.
  const insertSuggestion = (text: string) => {
    promptHistory.resetHistory()
    const next = input.trim() ? `${input}\n${text}` : text
    setInput(next)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(next.length)
    })
  }

  const heroBlock = (
    <div
      data-testid="empty-session-hero"
      className={`flex flex-col items-center gap-2.5 text-center ${isMobileComposer ? 'max-w-[300px]' : 'mb-7 max-w-[600px]'}`}
    >
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
        {t(isAntigravity ? 'empty.heroSubtitleAntigravity' : 'empty.heroSubtitle')}
      </p>
    </div>
  )

  const composerShell = (
    <div
      data-testid="empty-session-composer-shell"
      className={`flex justify-center ${
        isMobileComposer
          ? 'absolute bottom-0 left-0 right-0 z-[var(--z-nav)] px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]'
          : 'relative z-[var(--z-raised)] w-full shrink-0'
      }`}
    >
      <div className={`flex w-full flex-col ${isMobileComposer ? 'max-w-none' : 'max-w-[var(--chat-content-max-width)]'}`}>
        <div
          ref={panelRef}
          data-testid="empty-session-composer-panel"
          // Kept identical to ChatInput's floating V6C studio card:
          // `.composer-glass` + `--radius-2xl` (16px) + calm `--color-outline` focus edge.
          className={`composer-glass relative z-[var(--z-raised)] flex flex-col overflow-visible rounded-[var(--radius-2xl)] p-2 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-[var(--color-outline)] ${isDragActive ? 'composer-drop-target-active' : ''}`}
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
                  promptHistory.resetHistory()
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
                  promptHistory.resetHistory()
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
                references={isAntigravity ? EMPTY_COMPOSER_REFERENCES : composerReferences}
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
                placeholder={capabilityMenu.agentTeamArmed ? t('chat.capabilities.teamPlaceholder') : t('empty.placeholder')}
                // `min-w-0`: see ChatInput — an unbreakable long run (URL,
                // hash) otherwise grows this flex item past the panel.
                className="flex-1 min-w-0"
                editorClassName={`chat-reading-text scrollbar-autohide min-h-[72px] overflow-y-auto px-2.5 pb-1 pt-2 text-[var(--color-text-primary)] ${
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

            <div
              data-testid="empty-session-toolbar"
              className={`flex min-w-0 items-center justify-between pt-1.5 ${
                isMobileComposer ? 'flex-wrap gap-1' : 'gap-2'
              }`}
            >
              {dictationLive && <VoiceRecordingBar dictation={dictation} mobile={isMobileComposer} />}
              <div data-testid="empty-session-toolbar-leading" hidden={dictationLive} className="flex shrink-0 items-center gap-1">
                <div ref={plusMenuRef} className="relative shrink-0">
                  {/* Hand-rolled like ChatInput's: a quiet 28px square on
                      desktop, the 44px touch minimum on a phone. */}
                  <button
                    type="button"
                    onClick={() => setPlusMenuOpen((prev) => !prev)}
                    aria-label={t('chat.composerTools')}
                    aria-haspopup="menu"
                    aria-expanded={plusMenuOpen}
                    className={`v6c-pressable inline-flex items-center justify-center rounded-[var(--radius-card-inner)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                      plusMenuOpen ? 'v6c-raised text-[var(--color-text-primary)]' : ''
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
                  <ComputerUseEnableDialog {...capabilityMenu.computerUseConsent} />
                  <BrowserUseEnableDialog {...capabilityMenu.browserUseConsent} />
                  <AgentTeamsCostDialog allowDismiss {...capabilityMenu.agentTeamsNotice} />
                </div>

                {capabilityMenu.agentTeamArmed ? (
                  <AgentTeamChip touch={isMobileComposer} onRemove={capabilityMenu.disarmAgentTeam} />
                ) : null}

                {capabilityMenu.browserUse.enabled ? (
                  <BrowserUseTargetPill
                    target={capabilityMenu.browserUse.preferredTarget}
                    onChange={capabilityMenu.browserUse.setPreferredTarget}
                    onDisable={capabilityMenu.browserUse.disable}
                    touch={isMobileComposer}
                  />
                ) : null}

                {isLean && !isMobileComposer ? (
                  <AgentProfileChip onRemove={isSubmitting ? undefined : () => changeAgentProfile('standard')} />
                ) : null}

                {isMobileComposer ? permissionSelector : null}
              </div>

              {/* A draft has used none of its context, so the usage ring is not
                  on this row: it appears with the session's first reading. */}
              <div
                data-testid="empty-session-toolbar-trailing"
                hidden={dictationLive}
                className="flex min-w-0 flex-1 items-center justify-end gap-1"
              >
                {leanModeEnabled && isMobileComposer && !isAntigravity && <AgentProfileControl
                  ref={agentProfileRef}
                  value={agentProfile}
                  onChange={changeAgentProfile}
                  disabled={isSubmitting}
                />}
                {!isMobileComposer ? permissionSelector : null}
                <ModelSelector
                  ref={modelSelectorRef}
                  runtimeKey={DRAFT_RUNTIME_SELECTION_KEY}
                  lockedProviderId={isAntigravity ? ANTIGRAVITY_ACP_PROVIDER_ID : undefined}
                  disabled={isSubmitting}
                  compact={isMobileComposer}
                />
                <VoiceInputButton dictation={dictation} blocked={isSubmitting} mobile={isMobileComposer} />
                <Button
                  variant="accent"
                  size="md"
                  shape="key"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  aria-label={t('common.run')}
                  title={t('common.run')}
                  className={`shrink-0 ${isMobileComposer ? 'h-11 w-11' : ''}`}
                  icon={<ArrowUp data-icon="send" size={isMobileComposer ? 18 : 16} strokeWidth={1.75} aria-hidden="true" />}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Bare under-card context strip sitting cleanly below the floating
            composer card on desktop without overlapping its rounded corners. */}
        {!isMobileComposer && (
          <div
            data-testid="composer-context-strip"
            className="relative flex min-w-0 items-center justify-between gap-2 overflow-x-clip px-2.5 pb-0.5 pt-2"
          >
            <RepositoryLaunchControls
              ref={repositoryLaunchRef}
              workDir={workDir}
              onWorkDirChange={handleWorkDirChange}
              branch={selectedBranch}
              onBranchChange={setSelectedBranch}
              useWorktree={useWorktree}
              onUseWorktreeChange={setUseWorktree}
              onLaunchReadyChange={setRepositoryLaunchReady}
              worktreeSupported={!isAntigravity}
              disabled={isSubmitting}
              visible={visible}
              placement="toolbar"
            />
            {engineSwitcher}
          </div>
        )}
      </div>
    </div>
  )

  return (
    // Zero-shift centered Draft Hero on desktop: headline is anchored via a
    // viewport-clamped top inset so typing multiline drafts or toggling
    // attachments never jumps the hero upward. On a phone the composer stays
    // docked to the bottom above the keyboard and the project stays at the top.
    <div className="v6c-main-canvas relative flex flex-1 flex-col overflow-hidden">
      {isMobileComposer ? (
        <>
          <div data-testid="empty-session-mobile-launch" className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-4 pt-1">
            <RepositoryLaunchControls
              ref={repositoryLaunchRef}
              workDir={workDir}
              onWorkDirChange={handleWorkDirChange}
              branch={selectedBranch}
              onBranchChange={setSelectedBranch}
              useWorktree={useWorktree}
              onUseWorktreeChange={setUseWorktree}
              onLaunchReadyChange={setRepositoryLaunchReady}
              worktreeSupported={!isAntigravity}
              disabled={isSubmitting}
              visible={visible}
            />
            {engineSwitcher}
          </div>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6 pb-[230px] pt-6 text-center">
            {heroBlock}
          </div>
          {composerShell}
        </>
      ) : (
        <div className="scrollbar-autohide flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 pb-10 pt-[clamp(3rem,14vh,8.5rem)]">
          {heroBlock}
          {composerShell}
          <div className="mt-6 flex w-full max-w-[var(--chat-content-max-width)] flex-col items-center">
            <NewSessionStarter
              projectPath={workDir || null}
              projectLabel={heroProject}
              onSuggestion={insertSuggestion}
            />
          </div>
        </div>
      )}

      <ComposerReferenceDetail mention={referenceDetail} onClose={() => setReferenceDetail(null)} />
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
    </div>
  )
}
