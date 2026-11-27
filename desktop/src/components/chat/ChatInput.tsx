import { AgentProfileControl, type AgentProfileControlHandle } from '@/components/chat/AgentProfileControl'
import { isLeanSlashCommand, isUnsupportedLeanSlashInput } from '@/lib/agentProfile'
import { useSideChatStore } from '@/stores/sideChatStore'
import { openSideChat } from '@/lib/workspace/openSideChat'
import { parseSideQuestionCommand } from './composerUtils'
import { getSessionReferences } from '@/lib/composerMentions'
import { normalizeSessionReferences } from '@/lib/sessionReferences'
import { isComposerReferenceVisible, isComposerSlashCommandVisible } from '@/lib/composerCapabilityVisibility'
import { formatBytes } from '@/lib/formatBytes'
import { checkUserMessageBudget } from '@/lib/userMessageBudget'
import { useState, useRef, useEffect, useCallback, useMemo, useId } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowUp, CornerDownRight, Cpu, Feather, Gauge, Pencil, Plus, ShieldCheck, Square, Trash2 } from 'lucide-react'
import { useDismissable } from '@/hooks/useDismissable'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'
import {
  hasPendingAskUserQuestion,
  listPendingPermissions,
  useChatStore,
  type RepositoryLaunchDraftState,
} from '../../stores/chatStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { DRAFT_RUNTIME_SELECTION_KEY, useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useTeamStore } from '../../stores/teamStore'
import { teamRuntimeControlKey, teamRuntimeScope, useTeamRuntimeControlStore } from '@/stores/teamRuntimeControlStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { isTouchH5Document } from '../../lib/touchH5'
import {
  formatWorkspaceReferencePrompt,
  useWorkspaceChatContextStore,
  type WorkspaceChatReference,
} from '../../stores/workspaceChatContextStore'
import { sessionsApi } from '../../api/sessions'
import { agentsApi } from '../../api/agents'
import { PermissionModeSelector, type PermissionModeSelectorHandle } from '../controls/PermissionModeSelector'
import { PERMISSION_MODE_LABEL_KEYS, useResolvedPermissionMode } from '../controls/permissionModeState'
import { ModelSelector, type ModelSelectorHandle } from '../controls/ModelSelector'
import type { AttachmentRef } from '../../types/chat'
import type { RuntimeSelection } from '../../types/runtime'
import type { SlashCommandOption } from '../../types/slashCommand'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '@/constants/openaiOfficialProvider'
import {
  ANTIGRAVITY_ACP_DEFAULT_MODEL_ID,
  ANTIGRAVITY_ACP_PERMISSION_MODES,
  ANTIGRAVITY_ACP_PROVIDER_ID,
  ANTIGRAVITY_DRAFT_SLASH_COMMANDS,
  ANTIGRAVITY_HOST_UI_SLASH_COMMANDS,
} from '@/constants/antigravityAcp'
import { memberHitContextLimit } from '@/components/agentTeams/agentTeamsModel'
import { AttachmentGallery } from './AttachmentGallery'
import { ComposerDropOverlay } from './ComposerDropOverlay'
import { RepositoryLaunchControls, type RepositoryLaunchControlsHandle } from '@/components/chat/RepositoryLaunchControls'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from './ComposerReferenceMenu'
import { ComposerReferenceDetail } from './ComposerReferenceDetail'
import { ComposerCapabilityMenu } from './ComposerCapabilityMenu'
import { MobileComposerSheet, type MobileComposerSetting } from './MobileComposerSheet'
import { MobileApprovalDock } from './MobileApprovalDock'
import { useCapabilityMenu } from './useCapabilityMenu'
import { AgentProfileChip } from './AgentProfileChip'
import { AgentTeamChip } from './AgentTeamChip'
import { ComputerUseEnableDialog } from '@/components/computer-use/ComputerUseEnableDialog'
import { BrowserUseEnableDialog, BrowserUseTargetPill } from '@/components/browser-use/BrowserUseEnableDialog'
import { AgentTeamsCostDialog } from '@/components/agentTeams/AgentTeamsCostDialog'
import { withAgentTeamRequest, withAntigravitySwarmRequest } from '@/lib/agentTeamRequest'
import { withBrowserUseRequest } from '@/lib/browserUseRequest'
import { recordRecentSkills } from '@/lib/recentSkills'
import { composerReferencesApi, mentionProviderId } from '@/api/composerReferences'
import { useCapabilityCatalogStore } from '@/stores/capabilityCatalogStore'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { LocalSlashCommandPanel, type LocalSlashCommandName } from './LocalSlashCommandPanel'
import { getSlashCommandOptionId, SlashCommandMenu } from './SlashCommandMenu'
import { ContextUsageIndicator, type ContextUsageIndicatorHandle } from './ContextUsageIndicator'
import {
  appendAgentSlashCommands,
  buildAgentSlashCommands,
  getLocalizedFallbackCommands,
  filterSlashCommands,
  findSlashTrigger,
  groupSlashCommands,
  isRefusedTeamMemberCommand,
  isTeamMemberSlashCommand,
  mergeSlashCommands,
  replaceSlashToken,
  resolveSlashUiAction,
} from './composerUtils'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { useElementWidth } from '../../hooks/useElementWidth'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { executeFastSlashCommand } from '../../lib/fastModeCommand'
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
  composerReferenceToMention,
  findMentionRanges,
  insertMentionIntoText,
  type ComposerMention,
  type NewComposerMention,
} from '../../lib/composerMentions'
import type { PermissionMode } from '../../types/settings'
import { getSessionWorkspaceState, getSessionSeedWorkDir } from '../../lib/sessionWorkspace'
import { useSessionStopOffer } from '../../hooks/useSessionStopOffer'
import { useSessionGitInfo } from '../../hooks/useSessionGitInfo'
import {
  extractSessionPromptHistory,
  useComposerPromptHistory,
} from '@/hooks/useComposerPromptHistory'
import { useComposerDictation } from '@/features/voiceInput/useComposerDictation'
import { VoiceInputButton } from '@/features/voiceInput/VoiceInputButton'
import { VoiceRecordingBar } from '@/features/voiceInput/VoiceRecordingBar'
import { PromptOptimizeButton } from './PromptOptimizeButton'
import { isOptimizablePrompt, usePromptOptimize } from './usePromptOptimize'

type Attachment = ComposerAttachment

type ChatInputProps = {
  variant?: 'default' | 'hero'
  compact?: boolean
  sessionId?: string
  visible?: boolean
}

const EMPTY_COMPOSER_REFERENCES: ComposerReferenceCandidate[] = []

const EMPTY_WORKSPACE_REFERENCES: WorkspaceChatReference[] = []

const RUNTIME_EFFORT_LEVELS: ReadonlyArray<NonNullable<RuntimeSelection['effortLevel']>> = ['low', 'medium', 'high', 'xhigh', 'max']

function isRuntimeEffortLevel(value: string | undefined): value is NonNullable<RuntimeSelection['effortLevel']> {
  return RUNTIME_EFFORT_LEVELS.some((level) => level === value)
}

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
    referenceKind: reference.kind === 'chat-selection' ? 'chat-selection' : undefined,
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

export function ChatInput({ variant = 'default', compact = false, sessionId, visible = true }: ChatInputProps) {
  const t = useTranslation()
  const isMobileComposer = useMobileViewport() && !isDesktopRuntime()
  // The shell, not the panel inside it: the panel's own `max-w` changes with
  // the layout this measurement picks, which would make the observer chase
  // itself across the threshold. The shell just fills the chat column.
  const [shellRef, shellWidth] = useElementWidth<HTMLDivElement>()
  const [input, setInput] = useState('')
  const [mentions, setMentions] = useState<ComposerMention[]>([])
  // Bumped when the + menu installs a skill, so the mention list reloads.
  const [referencesVersion, setReferencesVersion] = useState(0)
  const [referenceDetail, setReferenceDetail] = useState<ComposerMention | null>(null)
  const [referenceOptionId, setReferenceOptionId] = useState<string | undefined>()
  const [referenceState, setReferenceState] = useState<{ context: string, items: ComposerReferenceCandidate[], loading: boolean, error: boolean } | null>(null)
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
  const [memberSlashCommands, setMemberSlashCommands] = useState<{ sessionId: string, commands: SlashCommandOption[] } | null>(null)
  const [memberRuntimeSaving, setMemberRuntimeSaving] = useState(false)
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
  const launchControlsRef = useRef<RepositoryLaunchControlsHandle>(null)
  const permissionSelectorRef = useRef<PermissionModeSelectorHandle>(null)
  const contextUsageRef = useRef<ContextUsageIndicatorHandle>(null)
  const agentProfileRef = useRef<AgentProfileControlHandle>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const fileSearchRef = useRef<ComposerReferenceMenuHandle>(null)
  const slashItemRefs = useRef<(HTMLElement | null)[]>([])
  const slashMenuId = useId()
  const referenceMenuId = useId()
  const capabilityMenuId = useId()
  const previousActiveTabIdRef = useRef<string | null>(null)
  // The chat on screen right now, for work that outlasts the click that began it.
  const currentChatRef = useRef<string | null>(null)
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
    dismissPromptSuggestion,
  } = useChatStore(useShallow((s) => ({
    sendMessage: s.sendMessage,
    stopGeneration: s.stopGeneration,
    clearComposerPrefill: s.clearComposerPrefill,
    clearComposerInsertion: s.clearComposerInsertion,
    queueUserMessage: s.queueUserMessage,
    updateQueuedUserMessage: s.updateQueuedUserMessage,
    removeQueuedUserMessage: s.removeQueuedUserMessage,
    sendQueuedUserMessage: s.sendQueuedUserMessage,
    setPreparingTurn: s.setPreparingTurn,
    dismissPromptSuggestion: s.dismissPromptSuggestion,
  })))
  const selectedTabId = useTabStore((s) => s.activeTabId)
  const activeTabId = sessionId ?? selectedTabId
  currentChatRef.current = activeTabId
  const activeTabType = useTabStore((s) =>
    s.tabs.find((tab) => tab.sessionId === (sessionId ?? s.activeTabId))?.type,
  )
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  const repositoryLaunchDraft = sessionState?.repositoryLaunchDraft
  const launchWorkDir = repositoryLaunchDraft?.workDir ?? ''
  const launchBranch = repositoryLaunchDraft?.branch ?? null
  const launchBranchAutomatic = repositoryLaunchDraft?.branchAutomatic ?? false
  const launchUseWorktree = repositoryLaunchDraft?.useWorktree ?? false
  const chatState = sessionState?.chatState ?? 'idle'
  // While a question is waiting, the card is the only way to reach the model: it
  // is blocked inside the AskUserQuestion tool call, so a message typed here
  // would sit in the queue until the question resolves — and reading that as
  // "I already replied" is how questions get abandoned.
  const questionPending = useChatStore((s) =>
    activeTabId ? hasPendingAskUserQuestion(s.sessions[activeTabId]) : false)
  const isPreparingTurn = Boolean(sessionState?.isPreparingTurn)
  const slashCommands = sessionState?.slashCommands ?? []
  const composerPrefill = sessionState?.composerPrefill ?? null
  const composerInsertion = sessionState?.composerInsertion ?? null
  const queuedUserMessages = sessionState?.queuedUserMessages ?? []
  const promptSuggestion = sessionState?.promptSuggestion ?? null
  const nextPromptSuggestionsEnabled = useSettingsStore((state) => state.nextPromptSuggestionsEnabled)
  const runtimeSelection = useSessionRuntimeStore((state) =>
    activeTabId ? state.selections[activeTabId] : undefined,
  )
  const currentModel = useSettingsStore((state) => state.currentModel)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const runtimeSelectionKey = runtimeSelection
    ? `${runtimeSelection.providerId ?? 'official'}:${runtimeSelection.modelId}:${runtimeSelection.effortLevel ?? 'auto'}`
    : undefined
  const runtimeModelLabel = runtimeSelection?.modelId ?? currentModel?.name ?? currentModel?.id
  const sideChat = useSideChatStore(state => activeTabId ? state.entries[activeTabId] : undefined)
  const listedSession = useSessionStore((state) => activeTabId ? state.sessions.find((session) => session.id === activeTabId) ?? null : null)
  const activeSession = listedSession ?? (sideChat ? { ...sideChat, id: sideChat.sessionId, workDirExists: true, workspaceState: 'available' as const, messageCount: 1, projectRoot: sideChat.workDir } : null)
  const isLean = listedSession?.agentProfile === 'lean'
  const isAntigravity = runtimeSelection?.providerId === ANTIGRAVITY_ACP_PROVIDER_ID ||
    listedSession?.runtimeProviderId === ANTIGRAVITY_ACP_PROVIDER_ID
  const loadedMessageCount = sessionState?.messages?.length ?? 0
  const messageCount = Math.max(loadedMessageCount, activeSession?.messageCount ?? 0)
  const memberInfo = useTeamStore((s) => activeTabId ? s.getMemberBySessionId(activeTabId) : null)
  const memberTeam = useTeamStore((s) => activeTabId ? s.getTeamByMemberSessionId(activeTabId) : null)
  const memberRuntimeReadOnly = useTeamStore((s) => {
    const leadId = memberTeam?.leadSessionId
    const timeline = leadId ? s.workbenchesBySession[leadId] : undefined
    const historyIndex = leadId ? s.workbenchHistoryIndexBySession[leadId] : null
    return Boolean(
      (activeTabId && s.memberSnapshotBySession[activeTabId]?.deletedAt) ||
      timeline?.source === 'archive' || timeline?.source === 'transcript' ||
      (historyIndex !== null && historyIndex !== undefined),
    )
  })
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
  // The controls are mounted again whenever the user comes back to this chat;
  // keeping whether they chose the branch lets them keep following the checkout.
  const setLaunchBranchAutomatic = useCallback((branchAutomatic: boolean) => {
    if (!activeTabId) return
    const current = useChatStore.getState().sessions[activeTabId]?.repositoryLaunchDraft
    if ((current?.branchAutomatic ?? false) === branchAutomatic) return
    updateRepositoryLaunchDraft((draft) => ({ ...draft, branchAutomatic }))
  }, [activeTabId, updateRepositoryLaunchDraft])
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
  const { gitInfo, refreshGitInfo } = useSessionGitInfo({
    sessionId: activeTabId,
    enabled: Boolean(activeTabId) && !isMemberSession,
    visible,
    workDir: activeSession?.workDir,
    chatState,
    messageCount,
    secondaryRefreshKey: slashCommands.length,
  })
  // A desktop team member runs in its own CLI. That CLI's session, not this
  // page's tab id, answers for the member's commands, context and model. A
  // SubAgent run, or a member without a CLI of its own, has none of them.
  const memberCliSessionId = memberInfo?.sessionId ?? null
  const memberModel = memberInfo?.model
  const memberProviderId = memberInfo?.providerId
  const memberEffortLevel = memberInfo?.effortLevel
  const memberRuntimeSelection = useMemo((): RuntimeSelection | null => {
    if (!memberCliSessionId || !memberModel) return null
    return {
      providerId: !memberProviderId || memberProviderId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : memberProviderId,
      modelId: memberModel,
      ...(isRuntimeEffortLevel(memberEffortLevel) ? { effortLevel: memberEffortLevel } : {}),
    }
  }, [memberCliSessionId, memberEffortLevel, memberModel, memberProviderId])
  const memberRuntimeKey = memberRuntimeSelection
    ? `${memberRuntimeSelection.providerId ?? 'official'}:${memberRuntimeSelection.modelId}:${memberRuntimeSelection.effortLevel ?? 'auto'}`
    : undefined
  const memberTeamName = memberTeam?.name
  const memberLeadId = memberTeam?.leadSessionId
  const memberIncarnationId = memberTeam?.incarnationId
  const memberScope = useMemo(() => memberTeamName
    ? teamRuntimeScope({ name: memberTeamName, leadSessionId: memberLeadId, incarnationId: memberIncarnationId })
    : null, [memberTeamName, memberLeadId, memberIncarnationId])
  const memberControlKey = memberScope ? teamRuntimeControlKey(memberScope) : null
  const memberControlEntry = useTeamRuntimeControlStore(state => memberControlKey ? state.byTeam[memberControlKey] : undefined)
  const memberRuntimeEditable = !memberRuntimeReadOnly && memberControlEntry?.control?.status === 'paused' &&
    !memberControlEntry.busy && !memberControlEntry.pauseRequested && !memberControlEntry.error &&
    memberControlEntry.control.members.some(member => member.agentId === memberInfo?.agentId && member.sessionId === memberCliSessionId)
  useEffect(() => {
    if (!memberScope || !memberCliSessionId || memberRuntimeReadOnly) return
    void useTeamRuntimeControlStore.getState().refresh(memberScope)
    const timer = window.setInterval(() => void useTeamRuntimeControlStore.getState().refresh(memberScope), 1500)
    return () => window.clearInterval(timer)
  }, [memberScope, memberCliSessionId, memberRuntimeReadOnly])
  const memberContextFull = memberInfo?.status === 'error' && memberHitContextLimit(memberInfo)
  const isActive = chatState !== 'idle'
  const resolvedPermissionMode = useResolvedPermissionMode(activeTabId ?? undefined)
  const stopOffer = useSessionStopOffer(activeTabId)
  const workspaceState = getSessionWorkspaceState(activeSession)
  const isWorkspaceMissing = workspaceState !== 'available'
  // Both composer branches (hero and inline) and the drop handler share this:
  // they used to spell the condition out separately, which is how one branch
  // ends up locked while the other keeps accepting text.
  const composerDisabled = isWorkspaceMissing || launchTransitioning || isPreparingTurn || questionPending
  // A hidden composer keeps its state but is not where the user is looking, so
  // dictation started in it must not survive the switch.
  const dictation = useComposerDictation({
    composerRef,
    draft: input,
    blocked: composerDisabled,
    contextKey: visible ? activeTabId : null,
    // Called from an effect, after this render has declared `handleSubmit`;
    // it is the same path Enter takes, queueing behind a running turn.
    onSubmit: () => { void handleSubmit() },
  })
  // While dictating, the toolbar's controls stay mounted but hidden, and the
  // recording bar takes their row.
  const dictationLive = dictation.phase !== 'idle'
  const hasWorkspaceReferences = !isMemberSession && workspaceReferences.length > 0
  const isHeroComposer = variant === 'hero' && !isMemberSession && !compact
  const resolvedWorkDir = activeSession?.workDir || gitInfo?.workDir || undefined
  const showLaunchControls = !isMemberSession && !sideChat && messageCount === 0
  const sideChatAvailable = !isLean && !isAntigravity && (Boolean(sideChat) || messageCount > 0)
  // `useCompactControls` is about room, so it asks the column how wide it is —
  // never "is a side panel open". Until a measurement lands (jsdom, first
  // paint) it defers to the caller's `compact`, which keeps the
  // pre-measurement frame from flashing the wrong layout. (The card itself has
  // one geometry everywhere; only the shell's outer padding follows `compact`.)
  const fitsAtLeast = (minWidth: number) => shellWidth === null ? !compact : shellWidth >= minWidth
  const useCompactControls = isMobileComposer || !fitsAtLeast(TOOLBAR_LOCATION_MIN_WIDTH)
  const activeLaunchWorkDir = showLaunchControls ? (launchWorkDir || resolvedWorkDir || '') : (resolvedWorkDir || '')
  const sessionPromptHistoryEntries = useMemo(
    () => extractSessionPromptHistory(sessionState?.messages),
    [sessionState?.messages],
  )
  const promptHistory = useComposerPromptHistory({
    sessionId: activeTabId,
    projectPath: activeLaunchWorkDir || resolvedWorkDir || null,
    projectRoot: activeSession?.projectRoot ?? null,
    sessionEntries: sessionPromptHistoryEntries,
    includeProjectHistory: !isMemberSession,
    getCurrentDraft: () => ({ text: inputRef.current, mentions: mentionsRef.current }),
    applyEntry: (entry, cursor) => {
      const nextMentions = entry.mentions ?? []
      composerRef.current?.replaceContent(entry.text, nextMentions, cursor)
      setComposerInput(entry.text, nextMentions)
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setAtFilter('')
      setAtCursorPos(-1)
    },
  })
  const applyOptimizedDraft = useCallback((
    text: string,
    nextMentions: ComposerMention[],
    options?: { flash?: boolean },
  ) => {
    promptHistory.resetHistory()
    if (composerRef.current) {
      composerRef.current.replaceContentWithHistory(text, nextMentions, options)
    } else {
      setComposerInput(text, nextMentions)
    }
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setAtFilter('')
    setAtCursorPos(-1)
    requestAnimationFrame(() => {
      if (visible) composerRef.current?.focus()
    })
  }, [promptHistory.resetHistory, setComposerInput, visible])
  const getPromptOptimizeDraft = useCallback(
    () => ({ text: inputRef.current, mentions: mentionsRef.current }),
    [],
  )
  const promptOptimize = usePromptOptimize({
    sessionId: !isMemberSession ? (activeTabId ?? null) : null,
    disabled: composerDisabled || dictationLive || (showLaunchControls && !launchReady),
    getDraft: getPromptOptimizeDraft,
    applyDraft: applyOptimizedDraft,
  })
  const canOptimizePrompt =
    !isMemberSession &&
    Boolean(activeTabId) &&
    !composerDisabled &&
    !dictationLive &&
    (!showLaunchControls || launchReady) &&
    isOptimizablePrompt(input)
  const referenceCwd = activeLaunchWorkDir || resolvedWorkDir || ''
  const referenceProviderId = mentionProviderId(runtimeSelection)
  const referenceContext = `${activeTabId ?? ''}\0${referenceCwd}\0${referenceProviderId ?? ''}\0${isLean ? 'lean' : 'standard'}`
  const referenceCurrent = referenceState?.context === referenceContext ? referenceState : null
  const composerReferences = useMemo(() => (referenceCurrent?.items ?? EMPTY_COMPOSER_REFERENCES).filter(reference => isComposerReferenceVisible(reference) && (!isLean || reference.kind === 'skill')), [referenceCurrent?.items, isLean])
  useEffect(() => {
    let active = true
    if (isMemberSession) return
    setReferenceState({ context: referenceContext, items: [], loading: true, error: false })
    void composerReferencesApi.list(referenceCwd || undefined, referenceProviderId, isLean ? 'lean' : undefined).then(data => {
      useCapabilityCatalogStore.getState().remember([...data.plugins, ...data.skills])
      if (active) setReferenceState({ context: referenceContext, items: [...data.plugins, ...data.skills], loading: false, error: false })
    }).catch(() => {
      if (active) setReferenceState({ context: referenceContext, items: [], loading: false, error: true })
    })
    return () => { active = false }
  }, [referenceContext, referenceCwd, referenceProviderId, isLean, isMemberSession, slashMenuOpen, fileSearchOpen, plusMenuOpen, referencesVersion])
  useEffect(() => {
    setReferenceDetail(null)
    setReferenceOptionId(undefined)
    setFileSearchOpen(false)
    setSlashMenuOpen(false)
  }, [referenceContext])

  // The under-card strip only holds interactive launch controls for an empty
  // session; once messages exist, the sticky SessionChatHeader owns project,
  // branch, and worktree context so the composer footer stays uncluttered.
  const hasUnderCardContext = showLaunchControls
  const rawPendingSlashUiAction = !isMemberSession && input.trim().startsWith('/')
    ? resolveSlashUiAction(input.trim().slice(1))
    : null
  const pendingSlashCommandName = input.trim().startsWith('/')
    ? input.trim().slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    : ''
  const pendingSlashUiAction = isAntigravity && !ANTIGRAVITY_HOST_UI_SLASH_COMMANDS.has(pendingSlashCommandName)
    ? null
    : rawPendingSlashUiAction
  const canSubmit = !isWorkspaceMissing &&
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

  const hadExternalFocusRef = useRef(false)
  const lastComposerFocusRefreshRef = useRef<number | undefined>(undefined)
  const programmaticFocusRef = useRef(false)

  useEffect(() => {
    hadExternalFocusRef.current = false
    lastComposerFocusRefreshRef.current = undefined
    if (!visible) return
    programmaticFocusRef.current = true
    try {
      composerRef.current?.focus()
    } finally {
      programmaticFocusRef.current = false
    }
  }, [activeTabId, visible])

  useEffect(() => {
    if (visible) return
    const focused = document.activeElement
    if (focused instanceof HTMLElement && panelRef.current?.contains(focused)) focused.blur()
  }, [visible])

  useEffect(() => {
    if (!composerPrefill || !activeTabId) return

    const nextAttachments = (composerPrefill.attachments ?? [])
      .filter((attachment) => attachment.path || attachment.data)
      .map((attachment, index) => ({
        id: `composer-prefill-${composerPrefill.nonce}-${index}`,
        name: attachment.name,
        type: attachment.type,
        mimeType: attachment.mimeType,
        path: attachment.path,
        previewUrl: attachment.type === 'image' ? attachment.data : undefined,
        data: attachment.data,
        isDirectory: attachment.isDirectory,
        lineStart: attachment.lineStart,
        lineEnd: attachment.lineEnd,
        diffSide: attachment.diffSide,
        hunkId: attachment.hunkId,
        note: attachment.note,
        quote: attachment.quote,
      }))
    const contextAttachments = nextAttachments.filter((attachment) => attachment.type === 'file' && attachment.path && (
      attachment.lineStart || attachment.note?.trim() || attachment.quote?.trim() || attachment.diffSide || attachment.hunkId
    ))
    const uploads = nextAttachments.filter((attachment) => !contextAttachments.includes(attachment))

    if (composerPrefill.mode === 'append') {
      setComposerAttachments((previous) => [...previous, ...uploads])
      if (composerPrefill.text) {
        // A refused send can recover both text and screenshots. Append at the
        // end so the existing draft and its mention ordinals stay intact.
        setComposerInput([inputRef.current, composerPrefill.text].filter(Boolean).join('\n\n'))
      }
    } else {
      // The draft's structured pills travel with its projected text; restoring
      // both keeps @-file references as pills instead of demoting them to
      // literal `@"path"` text.
      let restored: { text: string, mentions: ComposerMention[] } = {
        text: composerPrefill.text,
        mentions: composerPrefill.mentions ?? [],
      }
      for (const reference of normalizeSessionReferences(composerPrefill.sessionReferences)) {
        const title = useSessionStore.getState().sessions.find((session) => session.id === reference.sessionId)?.title
        restored = insertMentionIntoText(restored.text, restored.mentions, restored.text.length, restored.text.length, {
          kind: 'session', id: reference.sessionId, label: title || reference.sessionId,
          path: '', isDirectory: false,
        })
      }
      setComposerInput(restored.text, restored.mentions)
      setComposerAttachments(uploads)
      clearWorkspaceReferences(activeTabId)
    }
    for (const attachment of contextAttachments) {
      addWorkspaceReference(activeTabId, {
        ...attachment,
        path: attachment.path!,
        kind: attachment.diffSide || attachment.hunkId ? 'code-comment' : attachment.lineStart ? 'code-selection' : 'file',
      })
    }
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setSlashFilter('')
    setAtFilter('')
    setAtCursorPos(-1)
    promptHistory.resetHistory()

    requestAnimationFrame(() => {
      if (visible) composerRef.current?.focus()
      if (composerPrefill.mode !== 'append') {
        composerRef.current?.setSelectionOffsets(composerPrefill.text.length)
      }
    })
    clearComposerPrefill(activeTabId, composerPrefill.nonce)
  }, [
    activeTabId,
    addWorkspaceReference,
    clearComposerPrefill,
    clearWorkspaceReferences,
    composerPrefill,
    promptHistory.resetHistory,
    setComposerAttachments,
    setComposerInput,
    visible,
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
    promptHistory.resetHistory()
    clearComposerInsertion(activeTabId, composerInsertion.nonce)

    requestAnimationFrame(() => {
      if (visible) composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(next.cursorPos)
    })
  }, [
    activeTabId,
    addWorkspaceReference,
    clearComposerInsertion,
    composerInsertion,
    visible,
    isMemberSession,
    promptHistory.resetHistory,
    setComposerInput,
  ])

  useEffect(() => {
    if (!visible || !activeTabId || isMemberSession) return
    const handleDocumentFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof Node && !panelRef.current?.contains(target)) {
        hadExternalFocusRef.current = true
      }
    }
    document.addEventListener('focusin', handleDocumentFocusIn)
    return () => {
      document.removeEventListener('focusin', handleDocumentFocusIn)
    }
  }, [activeTabId, isMemberSession, visible])

  const handlePanelBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (!visible) return
    const nextFocused = event.relatedTarget
    if (!nextFocused || !event.currentTarget.contains(nextFocused)) {
      hadExternalFocusRef.current = true
    }
  }, [visible])

  const handlePanelFocusCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (programmaticFocusRef.current || !visible || !activeTabId || isMemberSession) return
    const previousFocused = event.relatedTarget
    const enteredFromOutside =
      hadExternalFocusRef.current ||
      (previousFocused instanceof Node && !event.currentTarget.contains(previousFocused))
    if (!enteredFromOutside) return
    hadExternalFocusRef.current = false
    const now = Date.now()
    const last = lastComposerFocusRefreshRef.current
    if (last !== undefined && now >= last && now - last < 1_000) return
    lastComposerFocusRefreshRef.current = now
    if (showLaunchControls) {
      launchControlsRef.current?.refreshContext()
    }
    void refreshGitInfo()
  }, [activeTabId, isMemberSession, refreshGitInfo, showLaunchControls, visible])

  useEffect(() => {
    if (!isMemberSession) return
    setComposerAttachments([])
    setPlusMenuOpen(false)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
  }, [isMemberSession, activeTabId])

  useEffect(() => {
    if (!memberCliSessionId) return
    let cancelled = false
    sessionsApi.getSlashCommands(memberCliSessionId)
      .then(({ commands }) => {
        if (!cancelled) setMemberSlashCommands({ sessionId: memberCliSessionId, commands })
      })
      .catch(() => {
        if (!cancelled) setMemberSlashCommands({ sessionId: memberCliSessionId, commands: [] })
      })
    return () => {
      cancelled = true
    }
  }, [memberCliSessionId])

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
    const nextWorkDir = getSessionSeedWorkDir(activeSession) || gitInfo?.workDir || ''
    const chatStore = useChatStore.getState()
    const current = chatStore.sessions[activeTabId]?.repositoryLaunchDraft
    if (current?.workDir === nextWorkDir) return
    chatStore.setRepositoryLaunchDraft(activeTabId, {
      workDir: nextWorkDir,
      branch: null,
      useWorktree: false,
    })
    setLaunchReady(!nextWorkDir)
  }, [activeSession?.workDir, activeSession?.projectRoot, activeSession?.workspaceState, activeTabId, gitInfo?.workDir, showLaunchControls])

  useDismissable({
    // The phone's + opens a sheet in a portal, which closes itself; an outside
    // press listener here would read every tap inside it as "outside".
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
    // This menu is looked up by id rather than held in a ref. Returning true
    // when it is absent preserves the original behavior: with no menu in the
    // DOM, an outside press was ignored.
    isExempt: (target) => {
      const menu = document.getElementById(referenceMenuId)
      if (!menu) return true
      return target instanceof Node && menu.contains(target)
    },
  })

  // A lean session's own list already passed the lean runtime rule.
  const listedSlashCommandNames = useMemo(() => new Set(slashCommands.map(command => command.name)), [slashCommands])
  const allSlashCommands = useMemo(() => {
    if (isMemberSession) {
      if (!memberCliSessionId) return []
      // The member's CLI reports its own commands and skills; the fallback keeps
      // `/compact` on offer before that list arrives.
      const listed = memberSlashCommands?.sessionId === memberCliSessionId ? memberSlashCommands.commands : []
      return mergeSlashCommands(listed, getLocalizedFallbackCommands(t))
        .filter(command => isComposerSlashCommandVisible(command) && isTeamMemberSlashCommand(command.name))
    }
    if (isAntigravity) {
      // Antigravity sessions use the ACP-reported `slashCommands` authoritatively,
      // plus host UI commands (`/model`, `/config`, `/clear`) without Claude fallbacks.
      // Before ACP reports its command list (e.g. cold-start or reopened history
      // sessions where `/slash-commands` returns disk-scanned AGY skills or `[]`),
      // merge Antigravity's built-in draft commands with those AGY skills.
      const localized = getLocalizedFallbackCommands(t)
      const localizedByName = new Map(localized.map((cmd) => [cmd.name, cmd.description]))
      const hostFallbacks = localized.filter((cmd) =>
        ANTIGRAVITY_HOST_UI_SLASH_COMMANDS.has(cmd.name.toLowerCase()),
      )
      const hasAuthoritativeAcpCommands = slashCommands.some((cmd) => cmd.kind !== 'skill')
      if (!hasAuthoritativeAcpCommands) {
        const draftBuiltIns: SlashCommandOption[] = ANTIGRAVITY_DRAFT_SLASH_COMMANDS.map((cmd) => ({
          name: cmd.name,
          description: localizedByName.get(cmd.name) ?? cmd.description,
          kind: 'command',
        }))
        return mergeSlashCommands(draftBuiltIns, slashCommands)
      }
      return mergeSlashCommands(slashCommands, hostFallbacks)
    }
    const commands = appendAgentSlashCommands(mergeSlashCommands(slashCommands, getLocalizedFallbackCommands(t)), agentSlashCommands)
    const names = new Set(commands.map(command => command.name.toLowerCase()))
    for (const reference of composerReferences) {
      const name = reference.kind === 'plugin' ? reference.id : reference.name
      if (names.has(name.toLowerCase())) continue
      names.add(name.toLowerCase())
      commands.push({ name, description: reference.description, kind: reference.kind })
    }
    // `/btw` forks the conversation so far; a blank session has none to fork.
    return commands.filter(command => isComposerSlashCommandVisible(command) && (!isLean || isLeanSlashCommand(command, listedSlashCommandNames)) && (sideChatAvailable || command.name !== 'btw'))
  }, [agentSlashCommands, slashCommands, listedSlashCommandNames, composerReferences, sideChatAvailable, isLean, isAntigravity, isMemberSession, memberCliSessionId, memberSlashCommands, t])

  const filteredCommandGroups = useMemo(() => {
    return groupSlashCommands(filterSlashCommands(allSlashCommands, slashFilter, { showAllWhenEmpty: isAntigravity }))
  }, [allSlashCommands, isAntigravity, slashFilter])

  const filteredCommands = filteredCommandGroups.ordered
  // A member page lists only what its CLI can run, and nothing without one.
  const isSlashMenuVisible = slashMenuOpen && filteredCommands.length > 0
  const isReferenceMenuVisible = !isMemberSession && fileSearchOpen
  // The predicted next prompt only shows on an idle desktop composer with
  // nothing else claiming the empty draft. The touch composer has no Tab key.
  const promptSuggestionGhost =
    nextPromptSuggestionsEnabled && promptSuggestion && chatState === 'idle' && !dictationLive &&
    !isTouchH5Document() && !isMemberSession && !composerDisabled &&
    !isSlashMenuVisible && !isReferenceMenuVisible && !localSlashPanel && !plusMenuOpen &&
    composerAttachments.length === 0 && queuedUserMessages.length === 0
      ? promptSuggestion
      : null

  const exactSlashCommand = useMemo(() => {
    const normalized = slashFilter.trim().toLowerCase()
    if (!normalized) return null
    return filteredCommands.find((command) => command.name.toLowerCase() === normalized) ?? null
  }, [filteredCommands, slashFilter])

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
    promptHistory.resetHistory()
    promptOptimize.notifyDraftChanged()
    setComposerInput(text, nextMentions)
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? text.length
    if (isMemberSession) {
      // A command typed here goes to the member's own CLI as is; files and
      // references stay out of member messages.
      if (memberCliSessionId) detectSlashTrigger(text, cursorPos)
      return
    }
    detectSlashTrigger(text, cursorPos)
    detectAtTrigger(text, cursorPos, nextMentions)
  }

  const selectSlashCommand = useCallback((command: string) => {
    promptHistory.resetHistory()
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? input.length
    const option = allSlashCommands.find(item => item.name === command)
    let nextCursor: number
    const reference = !isAntigravity && (option?.kind === 'skill' || option?.kind === 'plugin')
      ? composerReferences.find(item => item.kind === option.kind && (item.id === command || item.name === command))
      : undefined
    if (reference) {
      const mention = composerReferenceToMention(reference)
      const trigger = findSlashTrigger(input, cursorPos)
      const inserted = insertMentionIntoText(input, mentions, trigger?.slashPos ?? cursorPos, cursorPos, mention)
      setComposerInput(inserted.text, inserted.mentions)
      nextCursor = inserted.cursorPos
    } else {
      const replacement = replaceSlashToken(input, cursorPos, command)
      setComposerInput(replacement.value)
      nextCursor = replacement.cursorPos
    }
    setSlashMenuOpen(false)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(nextCursor)
    })
  }, [input, mentions, allSlashCommands, composerReferences, isAntigravity, promptHistory.resetHistory, setComposerInput])

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
    const oldSelection = useSessionRuntimeStore.getState().selections[oldId]
    const oldSession = sessionStore.sessions.find((session) => session.id === oldId)
    const permissionMode = oldSession?.permissionMode as PermissionMode | undefined
    const antigravityModelId = isAntigravity
      ? (oldSelection?.providerId === ANTIGRAVITY_ACP_PROVIDER_ID ? oldSelection.modelId : undefined)
        ?? oldSession?.runtimeModelId
        ?? ANTIGRAVITY_ACP_DEFAULT_MODEL_ID
      : undefined
    const antigravityEffortLevel = isAntigravity
      ? (oldSelection?.providerId === ANTIGRAVITY_ACP_PROVIDER_ID ? oldSelection.effortLevel : undefined)
        ?? oldSession?.effortLevel
      : undefined
    const createOptions = repository || permissionMode || isAntigravity
      ? {
          ...(repository ? { repository: isAntigravity ? { ...repository, worktree: false } : repository } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(isAntigravity ? {
            launchProviderId: ANTIGRAVITY_ACP_PROVIDER_ID,
            providerId: ANTIGRAVITY_ACP_PROVIDER_ID,
            modelId: antigravityModelId,
            ...(antigravityEffortLevel ? { effortLevel: antigravityEffortLevel } : {}),
          } : {}),
        }
      : undefined
    const newId = await createSession(
      workDir || undefined,
      isLean && !isAntigravity ? { ...createOptions, agentProfile: 'lean' } : createOptions,
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
  }, [activeTabId, isAntigravity, isLean])

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
    // Belt and braces: the composer is disabled too, but every send path (Enter,
    // slash-Enter, programmatic) funnels through here.
    if (questionPending) return
    const text = input.trim()
    if (isLean && resolvedPermissionMode === 'plan') {
      useUIStore.getState().addToast({ type: 'info', message: t('agentProfile.planUnavailable') })
      return
    }
    // `/btw` becomes a side chat here, before any runtime sees it, and lean
    // offers none — so no listed command of that name can make it available.
    if (isLean && (parseSideQuestionCommand(text) !== null || isUnsupportedLeanSlashInput(text, slashCommands.concat(allSlashCommands), listedSlashCommandNames))) {
      useUIStore.getState().addToast({ type: 'info', message: t('agentProfile.commandUnavailable') })
      return
    }
    if ((!text && ((!attachments.length && !hasWorkspaceReferences) || isMemberSession)) || isWorkspaceMissing) return
    // The server would refuse these for a member; a refused send would sit in
    // the conversation as a message that never goes out. Say why and keep the
    // draft instead.
    if (isMemberSession && isRefusedTeamMemberCommand(text)) {
      useUIStore.getState().addToast({ type: 'info', message: t('teams.memberCommandUnsupported') })
      return
    }

    // Immediate local command: never enter the main turn, launch flow or queue.
    const sideQuestion = !isMemberSession && !isAntigravity ? parseSideQuestionCommand(text) : null
    if (sideQuestion !== null && activeTabId) {
      promptHistory.recordSubmission({ text: input, mentions })
      void openSideChat(sideChat?.parentSessionId ?? activeTabId, { question: sideQuestion || undefined, submit: true })
      setComposerInput('', [])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (pendingSlashUiAction?.type === 'panel') {
      promptHistory.recordSubmission({ text: input, mentions })
      setLocalSlashPanel(pendingSlashUiAction.command as LocalSlashCommandName)
      setComposerInput('', [])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (pendingSlashUiAction?.type === 'settings') {
      promptHistory.recordSubmission({ text: input, mentions })
      useUIStore.getState().setPendingSettingsTab(pendingSlashUiAction.tab)
      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
      setComposerInput('', [])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (pendingSlashUiAction?.type === 'model') {
      promptHistory.recordSubmission({ text: input, mentions })
      modelSelectorRef.current?.open()
      setComposerInput('', [])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (pendingSlashUiAction?.type === 'fast') {
      promptHistory.recordSubmission({ text: input, mentions })
      setComposerInput('', [])
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      await executeFastSlashCommand({
        mode: pendingSlashUiAction.mode,
        runtimeKey: activeTabId ?? DRAFT_RUNTIME_SELECTION_KEY,
        t,
      })
      return
    }

    if (showLaunchControls && (!launchReady || launchTransitioning)) return
    promptOptimize.notifyDraftChanged()

    const workspaceReferencePrompt = !isMemberSession
      ? formatWorkspaceReferencePrompt(workspaceReferences)
      : ''
    // Inline @-mentions travel as the `@"absolute path"` text the CLI already
    // parses. Serialized from the live document — only the doc knows which
    // `@label` is a pill and which is literal text the user typed.
    const sessionReferences = getSessionReferences(input, mentions)
    const serializedText = (composerRef.current?.getModelContent() ?? input).trim()
    const joinedContent = [workspaceReferencePrompt, serializedText].filter(Boolean).join('\n\n')
    // Agent Team / Browser Use armed in the + menu: the model gets the
    // instruction block, the bubble keeps what the user typed plus the chip.
    const sendAsBrowserUse = capabilityMenu.browserUse.armed && !isMemberSession
    const sendAsTeam = capabilityMenu.agentTeamArmed && !isMemberSession
    const contentWithBrowser = sendAsBrowserUse
      ? withBrowserUseRequest(joinedContent, capabilityMenu.browserUse.preferredTarget)
      : joinedContent
    const contentForModel = sendAsTeam
      ? (isAntigravity ? withAntigravitySwarmRequest(contentWithBrowser) : withAgentTeamRequest(contentWithBrowser))
      : contentWithBrowser
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
      ...workspaceReferences.map((reference): AttachmentRef => ({
        type: 'file' as const,
        name: reference.name,
        referenceKind: reference.kind === 'chat-selection' ? 'chat-selection' : undefined,
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

    // The local server drops a frame over its input budget by closing the
    // socket, and the composer would only reconnect: the turn, with its pasted
    // screenshots inlined as data URLs, would vanish without a trace. Say why
    // and keep the draft instead.
    if (!isMemberSession) {
      const budget = checkUserMessageBudget({
        type: 'user_message',
        content: contentForModel,
        attachments: [...uploadAttachmentPayload, ...workspaceAttachmentPayload],
        ...(sessionReferences.length ? { sessionReferences } : {}),
      })
      if (!budget.ok) {
        useUIStore.getState().addToast({
          type: 'error',
          message: t('chat.messageTooLarge', { size: formatBytes(budget.bytes), limit: formatBytes(budget.limit) }),
        })
        return
      }
    }

    let targetSessionId = activeTabId!
    // A chat can wait a long time for its first message, and the server switches
    // the checkout to any launch branch that is not the current one. A branch the
    // controls chose on their own is decided again now, against the checkout as it
    // is, so a stale choice cannot put the repository back where it was.
    let resolvedLaunchBranch = launchBranch
    if (showLaunchControls && activeLaunchWorkDir && launchBranch && launchControlsRef.current) {
      setLaunchTransitioning(true)
      try {
        resolvedLaunchBranch = await launchControlsRef.current.resolveLaunchBranch()
      } finally {
        setLaunchTransitioning(false)
      }
    }
    if (showLaunchControls && activeLaunchWorkDir && resolvedLaunchBranch) {
      let currentSessionBranch = gitInfo?.branch ?? null
      const shouldVerifyLiveBranch =
        !launchUseWorktree && (
          (!launchBranchAutomatic && currentSessionBranch === resolvedLaunchBranch) ||
          (launchBranchAutomatic && currentSessionBranch !== resolvedLaunchBranch)
        )
      if (shouldVerifyLiveBranch) {
        setLaunchTransitioning(true)
        try {
          const latestGitInfo = await refreshGitInfo()
          if (latestGitInfo) {
            currentSessionBranch = latestGitInfo.branch
          }
        } finally {
          setLaunchTransitioning(false)
        }
      }
      const shouldReplaceForRepositoryLaunch =
        launchUseWorktree ||
        (currentSessionBranch ? resolvedLaunchBranch !== currentSessionBranch : true)
      if (shouldReplaceForRepositoryLaunch) {
        setLaunchTransitioning(true)
        const placeholderSessionId = targetSessionId
        setPreparingTurn(placeholderSessionId, true)
        try {
          const newSessionId = await replaceEmptySession(activeLaunchWorkDir, {
            branch: resolvedLaunchBranch,
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
        sessionReferences,
        attachments: [...uploadAttachmentPayload, ...workspaceAttachmentPayload],
        displayContent,
        displayAttachments: visibleAttachmentPayload,
      })
    } else {
      sendMessage(targetSessionId, contentForModel, [...uploadAttachmentPayload, ...workspaceAttachmentPayload], {
        sessionReferences,
        displayContent,
        displayAttachments: visibleAttachmentPayload,
      })
    }
    if (text) {
      promptHistory.recordSubmission(
        { text: input, mentions },
        {
          sessionId: targetSessionId,
          projectPath: activeLaunchWorkDir || resolvedWorkDir || null,
          projectRoot: activeSession?.projectRoot ?? null,
        },
      )
    } else {
      promptHistory.resetHistory()
    }
    recordRecentSkills(mentions.flatMap(mention => mention.kind === 'skill' && mention.id ? [mention.id] : []))
    if (sendAsTeam) capabilityMenu.disarmAgentTeam()
    if (sendAsBrowserUse) capabilityMenu.browserUse.disarm()
    // The send can wait for the launch branch to be read again. If the user moved
    // to another chat meanwhile, the editor holds that chat's draft now, not what
    // was just sent: leave it alone. (The sent chat's saved draft is cleared below.)
    if (currentChatRef.current === activeTabId || currentChatRef.current === targetSessionId) {
      invalidatePendingPastes()
      setComposerInput('', [])
      setComposerAttachments([])
    }
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

    // Route reference selection and directory navigation to the unified menu
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

    if (promptOptimize.isOptimizing && event.key === 'Escape' && !slashMenuOpen) {
      event.preventDefault()
      promptOptimize.cancel()
      return true
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
        const selected = filteredCommands[slashSelectedIndex] ?? filteredCommands[0]
        if (
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
      if (event.key === 'Tab') {
        event.preventDefault()
        const selected = filteredCommands[slashSelectedIndex] ?? filteredCommands[0]
        if (selected) selectSlashCommand(selected.name)
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashMenuOpen(false)
        return true
      }
    }

    // Tab or → copies the predicted prompt into the empty draft for editing;
    // it is never sent on the user's behalf. Esc hides it until the next turn.
    if (
      promptSuggestionGhost &&
      inputRef.current.length === 0 &&
      mentionsRef.current.length === 0 &&
      !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    ) {
      if (event.key === 'Tab' || event.key === 'ArrowRight') {
        event.preventDefault()
        composerRef.current?.insertTextAtOffsets(0, 0, promptSuggestionGhost)
        return true
      }
      if (event.key === 'Escape' && activeTabId) {
        event.preventDefault()
        dismissPromptSuggestion(activeTabId)
        return true
      }
    }

    if (
      !composerDisabled &&
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
    if (isMemberSession) return false
    const files = event.clipboardData ? getDataTransferFiles(event.clipboardData) : []
    if (files.length === 0) return false

    event.preventDefault()
    const pasteGeneration = pasteGenerationRef.current
    const pastedSessionId = activeTabId
    void filesToComposerAttachments(files)
      .then((nextAttachments) => {
        if (pasteGeneration !== pasteGenerationRef.current) return
        if (pastedSessionId !== previousActiveTabIdRef.current) return
        if (nextAttachments.length === 0) return
        setComposerAttachments((prev) => [...prev, ...nextAttachments])
      })
      .catch((error) => {
        console.warn('[attachments] Failed to read pasted files', error)
      })
    return true
  }

  const appendFiles = useCallback((files: FileList | File[]) => {
    const generation = pasteGenerationRef.current
    void filesToComposerAttachments(files)
      .then((nextAttachments) => {
        if (generation !== pasteGenerationRef.current) return
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
    disabled: isMemberSession || composerDisabled,
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

    const generation = pasteGenerationRef.current
    void selectNativeFileAttachments()
      .then((nativeAttachments) => {
        if (generation !== pasteGenerationRef.current) return
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
    promptHistory.resetHistory()
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

  // The "+" capability menu. The hook owns data loading and navigation
  // actions; these handlers are only the composer-local edits (mention badge,
  // slash text, prompt seed) plus the surfaces this composer already opens.
  const insertSelectedFileMention = (mention: NewComposerMention) => {
    promptHistory.resetHistory()
    const cursorPos = composerRef.current?.getSelectionOffsets().start ?? inputRef.current.length
    const inserted = insertMentionIntoText(inputRef.current, mentionsRef.current, cursorPos, cursorPos, mention)
    setComposerInput(inserted.text, inserted.mentions)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(inserted.cursorPos)
    })
  }

  // The phone's + sheet carries the controls that left its toolbar. A row
  // closes the sheet first and opens the control's own sheet a frame later,
  // so the two never stack.
  const openFromComposerSheet = (open: () => void) => {
    setPlusMenuOpen(false)
    requestAnimationFrame(open)
  }
  const mobileComposerSettings: MobileComposerSetting[] = isMobileComposer && !isMemberSession
    ? [
      {
        key: 'permission',
        icon: <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />,
        label: t('permMode.executionPermissions'),
        value: t(PERMISSION_MODE_LABEL_KEYS[resolvedPermissionMode]),
        onSelect: () => openFromComposerSheet(() => permissionSelectorRef.current?.open()),
      },
      ...(activeTabId ? [
        {
          key: 'model',
          icon: <Cpu size={16} strokeWidth={1.75} aria-hidden="true" />,
          label: t('chat.mobileSheet.model'),
          value: runtimeModelLabel,
          disabled: isActive,
          onSelect: () => openFromComposerSheet(() => modelSelectorRef.current?.open()),
        },
        {
          key: 'context',
          icon: <Gauge size={16} strokeWidth={1.75} aria-hidden="true" />,
          label: t('contextIndicator.title'),
          onSelect: () => openFromComposerSheet(() => contextUsageRef.current?.open()),
        },
      ] : []),
      // A lean session's badge and info button left the toolbar: beside the
      // model they squeezed its name to one letter. The mode is locked, so
      // this row only opens what it includes.
      ...(isLean ? [{
        key: 'agentProfile',
        icon: <Feather size={16} strokeWidth={1.75} aria-hidden="true" />,
        label: t('agentProfile.label'),
        value: t('agentProfile.lean'),
        onSelect: () => openFromComposerSheet(() => agentProfileRef.current?.open()),
      }] : []),
    ]
    : []

  // Desktop: the quiet glyph (or, once writes run unattended, the named chip)
  // sits first in the trailing group. A phone keeps it after the chips, where
  // it only appears when some writes run unattended.
  const permissionSelector = isMemberSession ? null : (
    <PermissionModeSelector
      lean={isLean}
      antigravity={isAntigravity}
      allowedModes={isAntigravity ? ANTIGRAVITY_ACP_PERMISSION_MODES : undefined}
      ref={permissionSelectorRef}
      sessionId={activeTabId ?? undefined}
      workDir={resolvedWorkDir}
      compact={useCompactControls}
      trigger={isMobileComposer ? 'elevatedOnly' : 'quiet'}
      // On the desktop the trigger sits at the right of the card: a menu that
      // opened rightwards from it ran past the card and the window edge.
      menuAlign={isMobileComposer ? 'left' : 'right'}
    />
  )

  // A member's model belongs to the team runtime, which restarts its CLI as the
  // same member. The session runtime path (`setSessionRuntime`) would restart
  // it as an ordinary chat and lose who it is, so the picker never takes it.
  const handleMemberRuntimeChange = (picked: RuntimeSelection) => {
    if (!activeTabId || !memberRuntimeSelection || !memberRuntimeEditable) return
    const sameModel = picked.providerId === memberRuntimeSelection.providerId &&
      picked.modelId === memberRuntimeSelection.modelId
    if (sameModel && picked.effortLevel === memberRuntimeSelection.effortLevel) return
    // A member without an effort runs on its model's default. Picking another
    // model fills in the composer-wide effort, which it never chose; only an
    // edit of the effort itself sets one.
    const selection = !sameModel && !memberRuntimeSelection.effortLevel
      ? { ...picked, effortLevel: undefined }
      : picked
    setMemberRuntimeSaving(true)
    void useTeamStore.getState().updateMemberRuntime(activeTabId, selection)
      .catch((error) => {
        useUIStore.getState().addToast({
          type: 'error',
          message: t('teams.memberModelUpdateFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        })
      })
      .finally(() => setMemberRuntimeSaving(false))
  }

  const capabilityMenu = useCapabilityMenu({
    open: plusMenuOpen && !isMemberSession,
    cwd: referenceCwd,
    references: composerReferences,
    lean: isLean,
    antigravity: isAntigravity,
    // A lean conversation's mode is fixed; its row only says so. A phone's "+"
    // sheet opens its own sheet from a settings row instead.
    agentProfile: isLean && !isAntigravity && !isMobileComposer ? { value: 'lean' } : undefined,
    handlers: {
      onInsertMention: (reference) => {
        promptHistory.resetHistory()
        const cursorPos = composerRef.current?.getSelectionOffsets().start ?? inputRef.current.length
        const mention = composerReferenceToMention(reference)
        const inserted = insertMentionIntoText(inputRef.current, mentionsRef.current, cursorPos, cursorPos, mention)
        setComposerInput(inserted.text, inserted.mentions)
        requestAnimationFrame(() => {
          composerRef.current?.focus()
          composerRef.current?.setSelectionOffsets(inserted.cursorPos)
        })
      },
      onInsertSlashText: (command) => {
        promptHistory.resetHistory()
        const cursorPos = composerRef.current?.getSelectionOffsets().start ?? inputRef.current.length
        const replacement = replaceSlashToken(inputRef.current, cursorPos, command)
        setComposerInput(replacement.value)
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

  const composerPlaceholder =
    capabilityMenu.agentTeamArmed && !isWorkspaceMissing && !questionPending && !isMemberSession
      ? t('chat.capabilities.teamPlaceholder')
      : isHeroComposer
      ? t('empty.placeholder')
      : isWorkspaceMissing
        ? workspaceState === 'worktree_removed'
          ? t('chat.placeholderWorktreeRemoved')
          : t('chat.placeholderMissing')
        : questionPending
          ? t(isAntigravity ? 'chat.placeholderQuestionPendingAntigravity' : 'chat.placeholderQuestionPending')
          : isMemberSession
            ? memberContextFull
              ? t('teams.memberContextLimitPlaceholder')
              : t('teams.memberPlaceholder')
            : t(isAntigravity ? 'chat.placeholderAntigravity' : 'chat.placeholder')

  // On a phone a waiting request takes the composer's place (MessageList shows
  // a marker where the card was). Not for a member's page or a side chat:
  // neither hosts its list with `decisionsInComposer`, so the card stays there.
  const approvalInComposer = isMobileComposer && !isMemberSession && !sideChat && !!activeTabId &&
    listPendingPermissions(sessionState).length > 0
  if (approvalInComposer) {
    return (
      <div
        ref={shellRef}
        data-testid="chat-input-shell"
        data-session-id={activeTabId}
        className="composer-fade bg-[var(--color-surface)] px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-1"
      >
        <MobileApprovalDock sessionId={activeTabId} />
      </div>
    )
  }

  return (
    <div
      ref={shellRef}
      data-testid="chat-input-shell"
      data-session-id={activeTabId ?? undefined}
      // The docked composer floats over the end of the transcript: no top
      // divider, and `composer-fade` dissolves the last 28px of the thread into
      // the page ground above the card instead of cutting it off. The hero
      // composer sits in open space, so it needs neither.
      className={
        isHeroComposer
          ? `bg-[var(--color-surface)] ${isMobileComposer ? 'px-4 pb-3' : 'px-8 pb-4'}`
          : `composer-fade bg-[var(--color-surface)] ${
            isMobileComposer
              ? 'px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-1'
              : compact ? 'px-4 pb-4 pt-1' : 'px-6 pb-5 pt-1'
          }`
      }
    >
      <div
        className={
          isHeroComposer
            ? 'mx-auto flex w-full max-w-[var(--chat-content-max-width)] flex-col'
            // Match the transcript even while a side panel tightens padding.
            : `flex flex-col ${isMobileComposer ? 'mx-0 max-w-none' : 'mx-auto max-w-[var(--chat-content-max-width)]'}`
        }
      >
        {!isMemberSession && activeTabId && queuedUserMessages.length > 0 && (
          // Docked top seam banner inset past the composer's 16px rounded top corners.
          <div
            data-testid="pending-user-message-list"
            className="surface-glass composer-seam-above relative z-[var(--z-base)] mx-5 -mb-4 flex flex-col gap-1.5 rounded-t-[var(--radius-2xl)] border border-b-0 border-[var(--color-surface-glass-border)] px-3 pb-5 pt-2.5"
          >
            {queuedUserMessages.map((message) => {
              const isEditing = editingQueuedMessageId === message.id
              return (
                <div
                  key={message.id}
                  data-testid="pending-user-message"
                  className={[
                    'flex min-h-9 min-w-0 items-center gap-2.5 rounded-[var(--radius-card-inner)] py-1 pl-3 pr-1',
                    'border border-dashed border-[var(--color-outline)] bg-[var(--color-surface-container-low)]',
                    'text-[13px] text-[var(--color-text-secondary)]',
                  ].join(' ')}
                >
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
                        className="v6c-field min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
                        autoFocus
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={saveQueuedMessageEdit}
                        disabled={!editingQueuedMessageText.trim()}
                        className="shrink-0"
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
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={questionPending}
                        onClick={() => sendQueuedUserMessage(activeTabId, message.id)}
                        aria-label={t('chat.pendingMessageGuideNow')}
                        title={t('chat.pendingMessageGuideNow')}
                        className="shrink-0"
                        icon={<CornerDownRight size={14} strokeWidth={1.75} aria-hidden="true" />}
                      >
                        {t('chat.pendingMessageGuide')}
                      </Button>
                      <IconButton
                        icon={<Pencil size={14} strokeWidth={1.75} aria-hidden="true" />}
                        label={t('chat.pendingMessageEdit')}
                        size="sm"
                        tone="muted"
                        onClick={() => startEditingQueuedMessage(message.id, message.displayContent)}
                      />
                      <IconButton
                        icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
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

        <div
          ref={panelRef}
          data-testid="chat-input-panel"
          // Floating V6C liquid-glass composer shell: hairline glass rim, neutral
          // elevation, `--radius-2xl` (16px) corners, calm focus edge (no glow).
          className={`composer-glass relative z-[var(--z-raised)] flex flex-col overflow-visible rounded-[var(--radius-2xl)] p-2 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-[var(--color-outline)] ${isDragActive ? 'composer-drop-target-active' : ''}`}
          onFocusCapture={handlePanelFocusCapture}
          onBlurCapture={handlePanelBlurCapture}
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
            <ComposerReferenceMenu
              ref={fileSearchRef}
              id={referenceMenuId}
              references={composerReferences}
              referencesLoading={referenceCurrent?.loading ?? true}
              referencesError={referenceCurrent?.error}
              onActiveChange={setReferenceOptionId}
              cwd={activeLaunchWorkDir || resolvedWorkDir || ''}
              filter={atFilter}
              compact={isMobileComposer}
              onNavigate={(relativePath) => {
                if (atCursorPos < 0) return
                promptHistory.resetHistory()
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
              onSelect={(mention) => {
                if (atCursorPos < 0) return
                promptHistory.resetHistory()
                const tokenEnd = atCursorPos + 1 + atFilter.length
                const inserted = insertMentionIntoText(input, mentions, atCursorPos, tokenEnd, mention)
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
              isSearching={Boolean(slashFilter.trim())}
              ref={slashMenuRef}
              id={slashMenuId}
              groups={filteredCommandGroups}
              references={isAntigravity ? EMPTY_COMPOSER_REFERENCES : composerReferences}
              selectedIndex={slashSelectedIndex}
              itemRefs={slashItemRefs}
              onSelect={selectSlashCommand}
              onHighlight={setSlashSelectedIndex}
              showKeyboardHints={!isMobileComposer}
            />
          )}

          {composerAttachments.length > 0 && (
            <div className="px-2 pt-2">
              <AttachmentGallery attachments={composerAttachments} variant="composer" onRemove={removeAttachment} />
            </div>
          )}

          {isHeroComposer ? (
            <div className="flex items-start">
              <MentionComposer
                ref={composerRef}
                rootRef={composerContainerRef}
                value={input}
                mentions={mentions}
                onMentionClick={mention => {
                  if (mention.kind === 'session' && mention.id) useTabStore.getState().openTab(mention.id, mention.label)
                  else setReferenceDetail(mention)
                }}
                onChange={handleComposerChange}
                onKeyDown={handleComposerKeyDown}
                onPaste={handleComposerPaste}
                onCompositionStart={() => { composingRef.current = true; dictation.compositionHandlers.onCompositionStart() }}
                onCompositionEnd={() => { composingRef.current = false; dictation.compositionHandlers.onCompositionEnd() }}
                placeholder={composerPlaceholder}
                ghostText={promptSuggestionGhost}
                disabled={composerDisabled}
                // `min-w-0`: a paragraph holding an unbreakable run (a long URL,
                // a hash) has a huge min-content size, and `overflow-wrap:
                // break-word` does not shrink it. Without this the flex item
                // refuses to shrink and the whole editor paints past the panel.
                className="flex-1 min-w-0"
                // The new-session card gives the prompt room to start: a taller
                // resting editor than the docked composer, same type.
                editorClassName="chat-reading-text scrollbar-autohide min-h-[72px] max-h-[200px] overflow-y-auto px-2.5 pb-1 pt-2 text-[var(--color-text-primary)]"
                aria={{
                  role: isSlashMenuVisible || isReferenceMenuVisible ? 'combobox' : 'textbox',
                  'aria-autocomplete': isSlashMenuVisible || isReferenceMenuVisible ? 'list' : undefined,
                  'aria-expanded': isSlashMenuVisible || isReferenceMenuVisible ? 'true' : undefined,
                  'aria-controls': isReferenceMenuVisible ? referenceMenuId : isSlashMenuVisible ? slashMenuId : undefined,
                  'aria-activedescendant': isReferenceMenuVisible ? referenceOptionId : isSlashMenuVisible
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
              onMentionClick={mention => {
                  if (mention.kind === 'session' && mention.id) useTabStore.getState().openTab(mention.id, mention.label)
                  else setReferenceDetail(mention)
                }}
              onChange={handleComposerChange}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              onCompositionStart={() => { composingRef.current = true; dictation.compositionHandlers.onCompositionStart() }}
              onCompositionEnd={() => { composingRef.current = false; dictation.compositionHandlers.onCompositionEnd() }}
              placeholder={composerPlaceholder}
              ghostText={promptSuggestionGhost}
              disabled={composerDisabled}
              // Type follows the reader's chat size (`chat-reading-text`); the
              // insets put the first line 14px/16px in from the card edge.
              editorClassName="chat-reading-text scrollbar-autohide min-h-[36px] max-h-[200px] overflow-y-auto px-2 pb-1 pt-1.5 text-[var(--color-text-primary)]"
              aria={{
                role: isSlashMenuVisible || isReferenceMenuVisible ? 'combobox' : 'textbox',
                'aria-autocomplete': isSlashMenuVisible || isReferenceMenuVisible ? 'list' : undefined,
                'aria-expanded': isSlashMenuVisible || isReferenceMenuVisible ? 'true' : undefined,
                'aria-controls': isReferenceMenuVisible ? referenceMenuId : isSlashMenuVisible ? slashMenuId : undefined,
                'aria-activedescendant': isReferenceMenuVisible ? referenceOptionId : isSlashMenuVisible
                  ? getSlashCommandOptionId(slashMenuId, slashSelectedIndex)
                  : undefined,
              }}
            />
          )}

          {/*
            One toolbar geometry for every variant. The draft and the live
            session used to render two different rows (an inset divider versus
            an edge-to-edge band), so the first message shifted every control.
            The card has no divider now — the editor's own bottom inset and this
            row's top inset separate the two — so the narrow layouts no longer
            need a band of their own either.
          */}
          {/*
            One row that never wraps. Because run location lives in the bare
            under-card context strip below the panel, the leading group holds
            only "+" and optional armed chips (`shrink-0` so "+" can never be
            crushed under trailing controls in narrow split-pane columns), while
            the trailing group (`min-w-0 flex-1`) gives up model-name width
            cleanly via ellipsis when horizontal space tightens.
          */}
          <div
            data-testid="chat-input-toolbar"
            className={`flex min-w-0 items-center justify-between pt-1.5 ${isMobileComposer ? 'gap-1' : 'gap-2'}`}
          >
            {dictationLive && <VoiceRecordingBar dictation={dictation} mobile={isMobileComposer} />}
            <div
              data-testid="chat-input-toolbar-leading"
              hidden={dictationLive}
              className="flex shrink-0 items-center gap-1"
            >
              {!isMemberSession && (
                <>
                  <div ref={plusMenuRef} className="relative shrink-0">
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
                      aria-haspopup="menu"
                      aria-expanded={plusMenuOpen}
                      // V6C 10px card-inner square for the "+" launcher; the open
                      // state lifts onto the raised glass face.
                      className={`v6c-pressable inline-flex items-center justify-center rounded-[var(--radius-card-inner)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                        plusMenuOpen ? 'v6c-raised text-[var(--color-text-primary)]' : ''
                      } ${isMobileComposer ? 'h-11 w-11' : 'h-7 w-7'}`}
                    >
                      <Plus size={isMobileComposer ? 18 : 16} strokeWidth={1.75} aria-hidden="true" />
                    </button>

                    {plusMenuOpen && !isMobileComposer && (
                      <ComposerCapabilityMenu
                        cwd={referenceCwd}
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
                        cwd={referenceCwd}
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

                  {capabilityMenu.agentTeamArmed && !isMemberSession ? (
                    <AgentTeamChip touch={isMobileComposer} onRemove={capabilityMenu.disarmAgentTeam} />
                  ) : null}

                  {capabilityMenu.browserUse.armed && !isMemberSession ? (
                    <BrowserUseTargetPill
                      target={capabilityMenu.browserUse.preferredTarget}
                      onChange={capabilityMenu.browserUse.setPreferredTarget}
                      onRemove={capabilityMenu.browserUse.disarm}
                      touch={isMobileComposer}
                    />
                  ) : null}

                  {isLean && !isMobileComposer ? <AgentProfileChip /> : null}

                  {isMobileComposer ? <div className="shrink-0">{permissionSelector}</div> : null}
                </>
              )}
            </div>

            <div
              data-testid="chat-input-toolbar-trailing"
              hidden={dictationLive}
              className="flex min-w-0 flex-1 items-center justify-end gap-1"
            >
              {!isMobileComposer ? permissionSelector : null}
              {activeTabId && (!isMemberSession || memberCliSessionId) && (
                <ContextUsageIndicator
                  ref={contextUsageRef}
                  // A member page has no "+" sheet to open the breakdown from.
                  hideTrigger={isMobileComposer && !isMemberSession}
                  sessionId={memberCliSessionId ?? activeTabId}
                  chatState={chatState}
                  messageCount={messageCount}
                  contentRevision={sessionState?.historyMutationEpoch ?? 0}
                  runtimeSelectionKey={isMemberSession ? memberRuntimeKey : runtimeSelectionKey}
                  fallbackModelLabel={isMemberSession ? memberModel : runtimeModelLabel}
                  compact={useCompactControls}
                  refreshNonce={
                    (sessionState?.compactCount ?? 0) +
                    (sessionState?.runtimeConfigReadyCount ?? 0)
                  }
                />
              )}
              {isMobileComposer && (
                <AgentProfileControl
                  ref={agentProfileRef}
                  value={isLean ? 'lean' : 'standard'}
                />
              )}
              {!isMemberSession && activeTabId && (
                <ModelSelector
                  ref={modelSelectorRef}
                  runtimeKey={activeTabId}
                  lockedProviderId={isAntigravity ? ANTIGRAVITY_ACP_PROVIDER_ID : sideChat ? runtimeSelection?.providerId ?? null : undefined}
                  disabled={isActive}
                  compact={useCompactControls}
                  fluid={isMobileComposer}
                />
              )}
              {memberRuntimeSelection && (
                <ModelSelector
                  runtimeSelection={memberRuntimeSelection}
                  onRuntimeSelectionChange={handleMemberRuntimeChange}
                  effortEditable
                  disabled={isActive || memberRuntimeSaving || !memberRuntimeEditable}
                  compact={useCompactControls}
                  fluid={isMobileComposer}
                />
              )}
              <VoiceInputButton dictation={dictation} blocked={composerDisabled} mobile={isMobileComposer} />
              {!isMemberSession && activeTabId && (
                <PromptOptimizeButton
                  controller={promptOptimize}
                  canOptimize={canOptimizePrompt}
                  mobile={isMobileComposer}
                />
              )}
              {stopOffer === 'background' || (stopOffer === 'turn' && canSubmit && !isMemberSession) ? (
                // Stopping background work, or stopping a running turn while a
                // follow-up message is ready to queue: 36px 11px-radius stop key beside the primary CTA.
                <Button
                  variant="primary"
                  size="md"
                  shape="key"
                  onClick={() => stopGeneration(activeTabId!)}
                  aria-label={t('common.stop')}
                  title={t('chat.stopTitle')}
                  className={`shrink-0 hover:bg-[var(--color-error)] hover:text-[var(--color-on-error)] ${isMobileComposer ? 'h-11 w-11' : ''}`}
                  icon={<Square data-icon="stop" size={isMobileComposer ? 12 : 11} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />}
                />
              ) : null}
              {/* Morphing 36px 11px-radius V6C send key (44px on mobile touch): switches cleanly
                  between Send (up-arrow, sculptural `.v6c-send-btn`), Queue/Steer (when a turn is
                  running and draft is ready), and Stop (ink key turning destructive on hover when
                  a turn is running with empty draft). */}
              <Button
                variant={stopOffer === 'turn' && (!canSubmit || isMemberSession) ? 'primary' : 'accent'}
                size="md"
                shape="key"
                onClick={stopOffer === 'turn' && (!canSubmit || isMemberSession) ? () => stopGeneration(activeTabId!) : handleSubmit}
                disabled={stopOffer === 'turn' && (!canSubmit || isMemberSession) ? false : !canSubmit}
                aria-label={stopOffer === 'turn' && (!canSubmit || isMemberSession) ? t('common.stop') : isMemberSession ? t('common.send') : t('common.run')}
                title={
                  stopOffer === 'turn' && (!canSubmit || isMemberSession)
                    ? t('chat.stopTitle')
                    : isMemberSession
                      ? t('common.send')
                      : t('common.run')
                }
                // 44px on touch is the platform minimum for a primary target;
                // the desktop key sits at 36×36 (`size="md" shape="key"`).
                className={`shrink-0 ${
                  stopOffer === 'turn' && (!canSubmit || isMemberSession)
                    ? 'hover:bg-[var(--color-error)] hover:text-[var(--color-on-error)]'
                    : ''
                } ${isMobileComposer ? 'h-11 w-11' : ''}`}
                icon={stopOffer === 'turn' && (!canSubmit || isMemberSession)
                  ? <Square data-icon="stop" size={isMobileComposer ? 12 : 11} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
                  : <ArrowUp data-icon="send" size={isMobileComposer ? 18 : 16} strokeWidth={1.75} aria-hidden="true" />}
              />
            </div>
          </div>

        </div>

        {/* Bare under-card launch strip sitting cleanly below the floating
            composer card on empty sessions; live sessions surface project and
            branch in the sticky session header instead. */}
        {hasUnderCardContext && (
          <div
            data-testid="composer-context-strip"
            className={`surface-glass relative flex min-w-0 items-center justify-between gap-2 overflow-x-clip pb-0.5 pt-2 ${
              useCompactControls ? 'px-2' : 'px-2.5'
            }`}
          >
            <RepositoryLaunchControls
              // One instance per chat: what it holds (which branch it chose
              // itself, the context it read) belongs to this chat, and
              // ChatInput is reused as the user moves between empty chats.
              key={activeTabId}
              ref={launchControlsRef}
              visible={visible}
              workDir={activeLaunchWorkDir}
              onWorkDirChange={handleLaunchWorkDirChange}
              branch={launchBranch}
              onBranchChange={setLaunchBranch}
              branchAutomatic={launchBranchAutomatic}
              onBranchAutomaticChange={setLaunchBranchAutomatic}
              useWorktree={launchUseWorktree}
              onUseWorktreeChange={setLaunchUseWorktree}
              onLaunchReadyChange={setLaunchReady}
              worktreeSupported={!isAntigravity}
              disabled={isActive || launchTransitioning}
              placement={useCompactControls ? 'outside' : 'toolbar'}
            />
          </div>
        )}

        {memberRuntimeSelection && <div className="mt-2 space-y-1 px-1 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
          <p role="status">{t(memberRuntimeReadOnly ? 'agentTeams.runtime.historyReadOnly' : memberRuntimeEditable ? 'agentTeams.runtime.saveHint' : 'agentTeams.runtime.pauseToEdit')}</p>
          <p>{t('agentTeams.runtime.memberMessageHint')}</p>
        </div>}

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
      </div>
      <ComposerReferenceDetail mention={referenceDetail} onClose={() => setReferenceDetail(null)} />
    </div>
  )
}
