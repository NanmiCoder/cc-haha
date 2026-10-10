import { forwardRef, useState, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { AppWindow, Brain, ChevronDown, FolderInput, RotateCw } from 'lucide-react'
import {
  useSettingsStore,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_STEP,
  DEFAULT_CLEANUP_PERIOD_DAYS,
  MAX_CLEANUP_PERIOD_DAYS,
  NETWORK_TIMEOUT_MAX_SECONDS,
} from '../../stores/settingsStore'
import { settingsApi } from '../../api/settings'
import { useTranslation, type TranslationKey } from '../../i18n'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { Button, type ButtonProps } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cx } from '@/lib/cx'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { Dropdown } from '@/components/ui/Dropdown'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SelectField } from '@/components/ui/SelectField'
import { PermissionModeSelector } from '../../components/controls/PermissionModeSelector'
import { ReasoningEffortPopover } from '../../components/controls/ReasoningEffortPopover'
import { isDarkThemeMode, isLightThemeMode, isMaxConcurrentSubagents } from '../../types/settings'
import type { ThemeMode, NetworkProxyMode, WebSearchMode, AppMode, ChatSendBehavior, OutputStyleSource, ReasoningEffortLevel } from '../../types/settings'
import type { Locale } from '../../i18n'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { getDesktopHost } from '../../lib/desktopHost'
import { getDesktopNotificationPermission, notifyDesktop, getDesktopNotificationPlatform, openDesktopNotificationSettings, requestDesktopNotificationPermission, type DesktopNotificationPermission } from '../../lib/desktopNotifications'
import { isValidHttpProxyUrl } from '../settings/shared'
import { isTouchH5Document } from '../../lib/touchH5'
import { MODEL_REASONING_EFFORTS } from '../../../../src/shared/modelReasoning'
import { AUTO_QUESTION_TIMEOUT_OPTIONS } from '../../../../src/shared/autoQuestionSettings'
import { ChatAppearanceSettings } from './ChatAppearanceSettings'
import { DataMigrationSettings } from './DataMigrationSettings'

/**
 * The General settings panel — the largest of the seven, and the one most often
 * edited.
 *
 * Moved verbatim out of `Settings.tsx`. It carries the four output-style label
 * helpers and the network-timeout bounds because nothing else in that file used
 * them; the proxy-URL validator stayed behind in `./shared`, which is what more
 * than one panel reaches for.
 *
 * Laid out on the settings skeleton (`SettingsSection` → `SettingsGroup` →
 * rows): the toggles that used to stand alone are grouped by topic — theme,
 * language, chat appearance, zoom, Agent preferences, notifications, network,
 * WebSearch, trace, retention, storage — in that order.
 */

const NETWORK_TIMEOUT_MIN_SECONDS = 30
const NETWORK_TIMEOUT_STEP_SECONDS = 30
const BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS = {
  default: {
    label: 'settings.general.outputStyleBuiltin.default.label',
    description: 'settings.general.outputStyleBuiltin.default.description',
  },
  Explanatory: {
    label: 'settings.general.outputStyleBuiltin.explanatory.label',
    description: 'settings.general.outputStyleBuiltin.explanatory.description',
  },
  Learning: {
    label: 'settings.general.outputStyleBuiltin.learning.label',
    description: 'settings.general.outputStyleBuiltin.learning.description',
  },
} satisfies Record<string, { label: TranslationKey; description: TranslationKey }>

export function GeneralSettings() {
  const {
    currentModel,
    effortLevel,
    setEffort,
    thinkingEnabled,
    setThinkingEnabled,
    workflowKeywordTriggerEnabled,
    setWorkflowKeywordTriggerEnabled,
    agentTeamsEnabled,
    setAgentTeamsEnabled,
    maxConcurrentSubagents,
    setMaxConcurrentSubagents,
    permissionMode,
    setPermissionMode,
    autoDreamEnabled,
    setAutoDreamEnabled,
    autoQuestion,
    setAutoQuestion,
    locale,
    setLocale,
    setTheme,
    chatSendBehavior,
    setChatSendBehavior,
    outputStyle,
    outputStyles,
    outputStyleScope,
    outputStylesLoading,
    outputStyleError,
    fetchOutputStyles,
    setOutputStyle,
    skipWebFetchPreflight,
    setSkipWebFetchPreflight,
    desktopNotificationsEnabled,
    setDesktopNotificationsEnabled,
    webSearch,
    setWebSearch,
    network,
    setNetwork,
    cleanupPeriodDays,
    setCleanupPeriodDays,
    traceCapture,
    setTraceCaptureEnabled,
    responseLanguage,
    setResponseLanguage,
    appMode,
    appModeRequiresRestart,
    fetchAppMode,
    setAppMode: setAppModeAction,
    uiZoom,
    setUiZoom,
    proxyManagedSettingsWarning,
  } = useSettingsStore()
  // Read the theme from the store that owns it. settingsStore keeps a copy for
  // its own consumers, but that copy is only refreshed on an explicit setTheme
  // — an OS flip updates uiStore alone and would leave this picker highlighting
  // a theme that is no longer on screen.
  const theme = useUIStore((s) => s.theme)
  const followSystemTheme = useUIStore((s) => s.followSystemTheme)
  const lightTheme = useUIStore((s) => s.lightTheme)
  const darkTheme = useUIStore((s) => s.darkTheme)
  const setFollowSystemTheme = useUIStore((s) => s.setFollowSystemTheme)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const t = useTranslation()
  const [webSearchDraft, setWebSearchDraft] = useState(webSearch)
  const [networkDraft, setNetworkDraft] = useState(network)
  const [networkTimeoutInput, setNetworkTimeoutInput] = useState(String(Math.round(network.aiRequestTimeoutMs / 1000)))
  const [networkSaveError, setNetworkSaveError] = useState<string | null>(null)
  const [isSavingNetwork, setIsSavingNetwork] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState<DesktopNotificationPermission>('default')
  const [notificationActionRunning, setNotificationActionRunning] = useState(false)
  const [autoDreamConfirmOpen, setAutoDreamConfirmOpen] = useState(false)
  const [autoDreamActionRunning, setAutoDreamActionRunning] = useState(false)
  const [agentTeamsSaving, setAgentTeamsSaving] = useState(false)
  const [subagentLimitInput, setSubagentLimitInput] = useState(String(maxConcurrentSubagents ?? ''))
  const [subagentLimitBadInput, setSubagentLimitBadInput] = useState(false)
  const [subagentLimitSaving, setSubagentLimitSaving] = useState(false)
  const [subagentLimitError, setSubagentLimitError] = useState<string | null>(null)
  const [modeSwitchConfirmOpen, setModeSwitchConfirmOpen] = useState(false)
  const [pendingMode, setPendingMode] = useState<AppMode | null>(null)
  const [pendingPortableDir, setPendingPortableDir] = useState<string | null>(null)
  const [portableDirDraft, setPortableDirDraft] = useState('')
  const [migrationRunning, setMigrationRunning] = useState(false)
  const [modeActionRunning, setModeActionRunning] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const [uiZoomDraft, setUiZoomDraft] = useState(uiZoom)
  const [retentionInput, setRetentionInput] = useState(String(cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS))
  const [retentionConfirmOpen, setRetentionConfirmOpen] = useState(false)
  const [retentionActionRunning, setRetentionActionRunning] = useState(false)
  const [retentionSaveError, setRetentionSaveError] = useState<string | null>(null)
  const [retentionPreviewFiles, setRetentionPreviewFiles] = useState<number | null>(null)
  const [retentionPreviewLoading, setRetentionPreviewLoading] = useState(false)
  /**
   * The value the open dialog is asking about. Pinned when the dialog opens so
   * a failed save (which rolls the store back and resets the input) cannot
   * silently change what the user is about to confirm.
   */
  const [retentionPendingDays, setRetentionPendingDays] = useState<number | null>(null)
  const [isUiZoomDragging, setIsUiZoomDragging] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const isUiZoomDraggingRef = useRef(false)
  /** Guards against a slow dry-run response overwriting a newer one. */
  const retentionPreviewRequestId = useRef(0)
  const effortButtonRef = useRef<HTMLButtonElement>(null)
  const addToast = useUIStore((s) => s.addToast)
  const openTargets = useOpenTargetStore((s) => s.targets)
  const ensureOpenTargets = useOpenTargetStore((s) => s.ensureTargets)
  const editorTargetId = useOpenTargetStore((s) => s.editorTargetId)
  const setEditorTargetId = useOpenTargetStore((s) => s.setEditorTargetId)
  const detectedEditors = useMemo(
    () => openTargets.filter((target) => target.kind === 'ide'),
    [openTargets],
  )
  const webSearchDirty = JSON.stringify(webSearchDraft) !== JSON.stringify(webSearch)
  const uiZoomPercent = Math.round(uiZoomDraft * 100)
  const uiZoomRangeProgress = `${Math.round(((uiZoomDraft - UI_ZOOM_MIN) / (UI_ZOOM_MAX - UI_ZOOM_MIN)) * 1000) / 10}%`
  const activeConfigDir = appMode.activeConfigDir ?? (appMode.mode === 'portable' ? appMode.portableDir : null)
  const configDirSource = appMode.configDirSource ?? (appMode.mode === 'portable' ? 'portable' : 'system')
  const isEnvironmentConfigDir = configDirSource === 'environment'
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  )
  const outputStyleWorkDir =
    activeSession?.workDirExists === false
      ? null
      : activeSession?.workDir ?? activeSession?.projectRoot ?? null

  useEffect(() => {
    setWebSearchDraft(webSearch)
  }, [webSearch])

  useEffect(() => {
    void ensureOpenTargets()
  }, [ensureOpenTargets])

  useEffect(() => {
    void fetchOutputStyles(outputStyleWorkDir)
  }, [fetchOutputStyles, outputStyleWorkDir])

  useEffect(() => {
    setNetworkDraft(network)
    setNetworkTimeoutInput(String(Math.round(network.aiRequestTimeoutMs / 1000)))
    setNetworkSaveError(null)
  }, [network])

  useEffect(() => {
    setRetentionInput(String(cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS))
  }, [cleanupPeriodDays])

  useEffect(() => {
    setSubagentLimitInput(String(maxConcurrentSubagents ?? ''))
    setSubagentLimitBadInput(false)
  }, [maxConcurrentSubagents])

  async function handleSubagentLimitSave() {
    const input = subagentLimitInput.trim()
    const value = input === '' ? null : Number(input)
    if (subagentLimitBadInput || (input !== '' && !/^\d+$/.test(input)) || !isMaxConcurrentSubagents(value)) {
      setSubagentLimitError(t('settings.general.subagentConcurrencyInvalid'))
      return
    }
    setSubagentLimitSaving(true)
    setSubagentLimitError(null)
    try {
      await setMaxConcurrentSubagents(value)
    } catch {
      setSubagentLimitError(t('settings.general.subagentConcurrencySaveFailed'))
    } finally {
      setSubagentLimitSaving(false)
    }
  }

  useEffect(() => {
    if (!isUiZoomDragging) {
      setUiZoomDraft(uiZoom)
    }
  }, [isUiZoomDragging, uiZoom])

  useEffect(() => {
    let cancelled = false
    getDesktopNotificationPermission().then((permission) => {
      if (!cancelled) setNotificationPermission(permission)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isDesktopRuntime()) return
    void fetchAppMode()
  }, [fetchAppMode])

  useEffect(() => {
    setPortableDirDraft(appMode.portableDir ?? '')
  }, [appMode.portableDir])

  const LANGUAGES: Array<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'jp', label: '日本語' },
    { value: 'kr', label: '한국어' },
  ]

  const RESPONSE_LANGUAGES: Array<{ value: string; label: string }> = [
    { value: '', label: t('settings.general.responseLangDefault') },
    { value: 'english', label: 'English' },
    { value: 'chinese', label: '中文 (Chinese)' },
    { value: 'japanese', label: '日本語 (Japanese)' },
    { value: 'korean', label: '한국어 (Korean)' },
    { value: 'spanish', label: 'Español (Spanish)' },
    { value: 'french', label: 'Français (French)' },
    { value: 'german', label: 'Deutsch (German)' },
    { value: 'portuguese', label: 'Português (Portuguese)' },
    { value: 'italian', label: 'Italiano (Italian)' },
    { value: 'russian', label: 'Русский (Russian)' },
    { value: 'dutch', label: 'Nederlands (Dutch)' },
    { value: 'polish', label: 'Polski (Polish)' },
    { value: 'turkish', label: 'Türkçe (Turkish)' },
    { value: 'hindi', label: 'हिन्दी (Hindi)' },
    { value: 'indonesian', label: 'Bahasa Indonesia' },
    { value: 'ukrainian', label: 'Українська (Ukrainian)' },
    { value: 'greek', label: 'Ελληνικά (Greek)' },
    { value: 'czech', label: 'Čeština (Czech)' },
    { value: 'danish', label: 'Dansk (Danish)' },
    { value: 'swedish', label: 'Svenska (Swedish)' },
    { value: 'norwegian', label: 'Norsk (Norwegian)' },
  ]
  const selectedResponseLanguageLabel =
    RESPONSE_LANGUAGES.find(({ value }) => value === responseLanguage)?.label ?? RESPONSE_LANGUAGES[0]!.label
  const outputStyleItems = outputStyles.map((style) => ({
    value: style.value,
    label: getOutputStyleLabel(style, t),
    description: `${getOutputStyleDescription(style, t)} · ${getOutputStyleSourceLabel(style.source, t)}`,
  }))
  const selectedOutputStyle =
    outputStyles.find((style) => style.value === outputStyle) ?? outputStyles[0]
  const selectedOutputStyleLabel = selectedOutputStyle
    ? getOutputStyleLabel(selectedOutputStyle, t)
    : outputStyle
  const selectedOutputStyleDescription = selectedOutputStyle
    ? getOutputStyleDescription(selectedOutputStyle, t)
    : ''
  const outputStyleScopeLabel = outputStyleScope === 'localSettings'
    ? t('settings.general.outputStyleScopeLocal')
    : t('settings.general.outputStyleScopeUser')
  const outputStyleScopeHint = outputStyleScope === 'localSettings'
    ? t('settings.general.outputStyleScopeLocalHint')
    : t('settings.general.outputStyleScopeUserHint')

  const THEMES: Array<{ value: ThemeMode; label: string }> = [
    { value: 'white', label: t('settings.general.appearance.white') },
    { value: 'paper', label: t('settings.general.appearance.paper') },
    { value: 'warm-classic', label: t('settings.general.appearance.warmClassic') },
    { value: 'celadon', label: t('settings.general.appearance.celadon') },
    { value: 'dark', label: t('settings.general.appearance.dark') },
    { value: 'ink-blue', label: t('settings.general.appearance.inkBlue') },
  ]
  // Split by ground, in the order THEMES already lists them, so the two rows
  // shown while following the system stay consistent with the flat picker.
  const LIGHT_THEMES = THEMES.filter(({ value }) => isLightThemeMode(value))
  const DARK_THEMES = THEMES.filter(({ value }) => isDarkThemeMode(value))

  const WEB_SEARCH_MODES: Array<{ value: WebSearchMode; label: string }> = [
    { value: 'auto', label: t('settings.general.webSearch.mode.auto') },
    { value: 'tavily', label: t('settings.general.webSearch.mode.tavily') },
    { value: 'brave', label: t('settings.general.webSearch.mode.brave') },
    { value: 'anthropic', label: t('settings.general.webSearch.mode.anthropic') },
    { value: 'disabled', label: t('settings.general.webSearch.mode.disabled') },
  ]

  const NETWORK_PROXY_MODES: Array<{ value: NetworkProxyMode; label: string; description: string }> = [
    {
      value: 'direct',
      label: t('settings.general.networkProxyModeDirect'),
      description: t('settings.general.networkProxyModeDirectDescription'),
    },
    {
      value: 'system',
      label: t('settings.general.networkProxyModeSystem'),
      description: t('settings.general.networkProxyModeSystemDescription'),
    },
    {
      value: 'manual',
      label: t('settings.general.networkProxyModeManual'),
      description: t('settings.general.networkProxyModeManualDescription'),
    },
  ]

  const CHAT_SEND_BEHAVIORS: Array<{ value: ChatSendBehavior; label: string; description: string }> = [
    {
      value: 'enter',
      label: t('settings.general.chatSendBehaviorEnter'),
      description: t('settings.general.chatSendBehaviorEnterDescription'),
    },
    {
      value: 'modifierEnter',
      label: t('settings.general.chatSendBehaviorModifier'),
      description: t('settings.general.chatSendBehaviorModifierDescription'),
    },
  ]

  const effortLabels: Record<ReasoningEffortLevel, string> = {
    low: t('settings.general.effort.low'),
    medium: t('settings.general.effort.medium'),
    high: t('settings.general.effort.high'),
    xhigh: t('settings.general.effort.xhigh'),
    max: t('settings.general.effort.max'),
  }
  const supportedReasoningEfforts = currentModel?.supportedReasoningEfforts
  const effortOptions = !currentModel
    ? []
    : supportedReasoningEfforts === undefined
      // Match the new-session selector's compatibility fallback for models
      // that predate explicit capability metadata. xhigh is opt-in; the other
      // Claude Code levels remain available until the provider declares it.
      ? MODEL_REASONING_EFFORTS.filter((level) => level !== 'xhigh')
      : MODEL_REASONING_EFFORTS.filter((level) => supportedReasoningEfforts.includes(level))
  const modelDefaultEffort = currentModel?.defaultReasoningEffort
  const selectedEffort = effortOptions.includes(effortLevel)
    ? effortLevel
    : modelDefaultEffort && effortOptions.includes(modelDefaultEffort)
      ? modelDefaultEffort
      : effortOptions[0]

  const notificationStatusLabel: Record<DesktopNotificationPermission, string> = {
    granted: t('settings.general.notificationsStatusGranted'),
    denied: t('settings.general.notificationsStatusDenied'),
    default: t('settings.general.notificationsStatusDefault'),
    unsupported: t('settings.general.notificationsStatusUnsupported'),
  }

  const handleDesktopNotificationsToggle = async (enabled: boolean) => {
    await setDesktopNotificationsEnabled(enabled)
    if (!enabled) return

    setNotificationActionRunning(true)
    try {
      const permission = await requestDesktopNotificationPermission()
      setNotificationPermission(permission)
      if (permission === 'granted' && getDesktopNotificationPlatform() !== 'win32') {
        void notifyDesktop({
          title: t('settings.general.notificationsTestTitle'),
          body: t('settings.general.notificationsTestBody'),
        })
      }
    } finally {
      setNotificationActionRunning(false)
    }
  }

  const handleAutoDreamToggle = (enabled: boolean) => {
    if (enabled) {
      setAutoDreamConfirmOpen(true)
      return
    }
    void setAutoDreamEnabled(false)
  }

  const confirmAutoDreamEnable = async () => {
    setAutoDreamActionRunning(true)
    try {
      await setAutoDreamEnabled(true)
      setAutoDreamConfirmOpen(false)
    } finally {
      setAutoDreamActionRunning(false)
    }
  }

  const handleNotificationPermissionAction = async () => {
    setNotificationActionRunning(true)
    try {
      if (notificationPermission === 'denied') {
        await openDesktopNotificationSettings()
      } else {
        const permission = await requestDesktopNotificationPermission()
        setNotificationPermission(permission)
        if (permission === 'granted') {
          void notifyDesktop({
            title: t('settings.general.notificationsTestTitle'),
            body: t('settings.general.notificationsTestBody'),
          })
        }
        if (permission === 'denied') {
          await openDesktopNotificationSettings()
        }
      }
    } finally {
      setNotificationActionRunning(false)
    }
  }

  const networkProxyUrl = networkDraft.proxy.url.trim()
  const networkProxyError =
    networkDraft.proxy.mode === 'manual' && !networkProxyUrl
      ? t('settings.general.networkProxyUrlRequired')
      : networkDraft.proxy.mode === 'manual' && !isValidHttpProxyUrl(networkProxyUrl)
        ? t('settings.general.networkProxyUrlInvalid')
        : null
  const timeoutSeconds = Math.round(networkDraft.aiRequestTimeoutMs / 1000)
  const parsedNetworkTimeoutSeconds = (() => {
    const trimmed = networkTimeoutInput.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds) || seconds < NETWORK_TIMEOUT_MIN_SECONDS || seconds > NETWORK_TIMEOUT_MAX_SECONDS) return null
    return seconds
  })()
  const networkTimeoutError =
    networkTimeoutInput.trim().length === 0
      ? t('settings.general.networkTimeoutRequired')
      : parsedNetworkTimeoutSeconds === null
        ? t('settings.general.networkTimeoutRange', {
            min: String(NETWORK_TIMEOUT_MIN_SECONDS),
            max: String(NETWORK_TIMEOUT_MAX_SECONDS),
          })
        : null
  const networkDirty =
    networkDraft.aiRequestTimeoutMs !== network.aiRequestTimeoutMs ||
    networkDraft.proxy.mode !== network.proxy.mode ||
    networkDraft.proxy.url.trim() !== network.proxy.url.trim()

  const effectiveRetentionDays = cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS
  const parsedRetentionDays = (() => {
    const trimmed = retentionInput.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const days = Number(trimmed)
    if (!Number.isInteger(days) || days < 0 || days > MAX_CLEANUP_PERIOD_DAYS) return null
    return days
  })()
  const retentionInputError =
    retentionInput.trim().length === 0
      ? t('settings.general.sessionRetentionRequired')
      : parsedRetentionDays === null
        ? t('settings.general.sessionRetentionRange', { max: String(MAX_CLEANUP_PERIOD_DAYS) })
        : null
  const retentionDirty =
    parsedRetentionDays !== null && parsedRetentionDays !== effectiveRetentionDays

  const setNetworkTimeoutSeconds = (seconds: number) => {
    const nextSeconds = Math.min(Math.max(Math.round(seconds), NETWORK_TIMEOUT_MIN_SECONDS), NETWORK_TIMEOUT_MAX_SECONDS)
    setNetworkTimeoutInput(String(nextSeconds))
    setNetworkDraft((current) => ({
      ...current,
      aiRequestTimeoutMs: nextSeconds * 1000,
    }))
    setNetworkSaveError(null)
  }

  const saveNetworkSettings = async () => {
    if (networkProxyError) {
      setNetworkSaveError(networkProxyError)
      return
    }
    if (networkTimeoutError || parsedNetworkTimeoutSeconds === null) {
      setNetworkSaveError(networkTimeoutError ?? t('settings.general.networkTimeoutRange', {
        min: String(NETWORK_TIMEOUT_MIN_SECONDS),
        max: String(NETWORK_TIMEOUT_MAX_SECONDS),
      }))
      return
    }

    setIsSavingNetwork(true)
    setNetworkSaveError(null)
    try {
      await setNetwork({
        aiRequestTimeoutMs: parsedNetworkTimeoutSeconds * 1000,
        proxy: {
          mode: networkDraft.proxy.mode,
          url: networkDraft.proxy.mode === 'manual' ? networkProxyUrl : '',
        },
      })
      addToast({
        type: 'success',
        message: t('settings.general.networkSaved'),
      })
    } catch (error) {
      setNetworkSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingNetwork(false)
    }
  }

  /**
   * Changing the retention period deletes transcripts immediately, so the save
   * button never saves directly. It first asks the server for a dry-run count
   * and only then opens the dialog with the blast radius already on screen —
   * the dialog can therefore never be confirmed before the count is known.
   */
  const openRetentionConfirm = async () => {
    if (parsedRetentionDays === null) {
      setRetentionSaveError(
        retentionInputError ??
          t('settings.general.sessionRetentionRange', {
            max: String(MAX_CLEANUP_PERIOD_DAYS),
          }),
      )
      return
    }
    const days = parsedRetentionDays
    const requestId = ++retentionPreviewRequestId.current
    setRetentionSaveError(null)
    setRetentionPreviewFiles(null)
    setRetentionPreviewLoading(true)
    try {
      const preview = await settingsApi.cleanupSessions(days, true)
      if (requestId !== retentionPreviewRequestId.current) return
      setRetentionPreviewFiles(preview.files)
      setRetentionPendingDays(days)
      setRetentionConfirmOpen(true)
    } catch (error) {
      if (requestId !== retentionPreviewRequestId.current) return
      setRetentionSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === retentionPreviewRequestId.current) {
        setRetentionPreviewLoading(false)
      }
    }
  }

  const closeRetentionConfirm = () => {
    if (retentionActionRunning) return
    setRetentionConfirmOpen(false)
    setRetentionPendingDays(null)
    setRetentionSaveError(null)
  }

  const confirmRetentionChange = async () => {
    if (retentionPendingDays === null) return
    setRetentionActionRunning(true)
    setRetentionSaveError(null)
    try {
      await setCleanupPeriodDays(retentionPendingDays)
      const result = await settingsApi.cleanupSessions(retentionPendingDays)
      setRetentionConfirmOpen(false)
      setRetentionPendingDays(null)
      addToast({
        type: 'success',
        message:
          result.errors > 0
            ? t('settings.general.sessionRetentionSavedPartial', {
                count: String(result.files),
                errors: String(result.errors),
              })
            : t('settings.general.sessionRetentionSaved', {
                count: String(result.files),
              }),
      })
      void useSessionStore.getState().fetchSessions()
    } catch (error) {
      // Keep the dialog open: the error is rendered inside it and the target
      // value stays pinned, so confirming again retries the same change even if
      // the failed save already rolled the store back.
      setRetentionSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setRetentionActionRunning(false)
    }
  }

  const handleAgentTeamsChange = async (enabled: boolean) => {
    if (agentTeamsSaving) return
    setAgentTeamsSaving(true)
    try {
      await setAgentTeamsEnabled(enabled)
    } catch {
      addToast({ type: 'error', message: t('settings.general.agentTeamsSaveFailed') })
    } finally {
      setAgentTeamsSaving(false)
    }
  }

  const handleOutputStyleChange = async (value: string) => {
    try {
      await setOutputStyle(value, outputStyleWorkDir)
      addToast({
        type: 'success',
        message: t('settings.general.outputStyleSaved'),
      })
    } catch {
      // The store exposes outputStyleError below; keep the interaction local.
    }
  }

  const openPortableDirPicker = async () => {
    setModeError(null)
    const host = getDesktopHost()
    if (!host.capabilities.dialogs) {
      setModeError(t('settings.general.storagePickerError'))
      return
    }
    try {
      const selected = await host.dialogs.open({
        directory: true,
        multiple: false,
        title: t('settings.general.storageChooseDirTitle'),
      })
      if (typeof selected === 'string') {
        setPortableDirDraft(selected)
      }
    } catch {
      setModeError(t('settings.general.storagePickerError'))
    }
  }

  const openModeSwitchConfirm = (mode: AppMode) => {
    if (isEnvironmentConfigDir) {
      setModeError(t('settings.general.storageEnvironmentSwitchBlocked'))
      return
    }

    const portableDir = portableDirDraft.trim()
    if (mode === 'portable' && !portableDir) {
      setModeError(t('settings.general.storageNoDirError'))
      return
    }

    setModeError(null)
    setPendingMode(mode)
    setPendingPortableDir(mode === 'portable' ? portableDir : null)
    setModeSwitchConfirmOpen(true)
  }

  const closeModeSwitchConfirm = () => {
    if (modeActionRunning) return
    setModeSwitchConfirmOpen(false)
    setPendingMode(null)
    setPendingPortableDir(null)
  }

  const confirmModeSwitch = async () => {
    if (!pendingMode) return

    setModeActionRunning(true)
    setModeError(null)
    try {
      await setAppModeAction(pendingMode, pendingPortableDir)
      const host = getDesktopHost()
      await host.appMode.prepareRestart()
      await host.appMode.restart()
    } catch (error) {
      setModeError(
        error instanceof Error
          ? error.message
          : t('settings.general.storageRestartError'),
      )
      setModeSwitchConfirmOpen(false)
      setPendingMode(null)
      setPendingPortableDir(null)
      setModeActionRunning(false)
    }
  }

  const setUiZoomDraggingState = (dragging: boolean) => {
    isUiZoomDraggingRef.current = dragging
    setIsUiZoomDragging(dragging)
  }

  const commitUiZoom = (value: number) => {
    const nextZoom = Number.isFinite(value) ? value : UI_ZOOM_DEFAULT
    setUiZoomDraggingState(false)
    setUiZoomDraft(nextZoom)
    setUiZoom(nextZoom)
  }

  const uiZoomShortcuts = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
      <span>{t('settings.general.uiZoomShortcutHint')}</span>
      <span className="inline-flex items-center gap-1">
        <span className="text-[var(--color-text-secondary)]">{t('settings.general.uiZoomShortcutMac')}</span>
        <kbd className="settings-zoom-kbd">⌘</kbd>
        <kbd className="settings-zoom-kbd">+</kbd>
        <span>/</span>
        <kbd className="settings-zoom-kbd">⌘</kbd>
        <kbd className="settings-zoom-kbd">-</kbd>
        <span>/</span>
        <kbd className="settings-zoom-kbd">⌘</kbd>
        <kbd className="settings-zoom-kbd">0</kbd>
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-[var(--color-text-secondary)]">{t('settings.general.uiZoomShortcutWindows')}</span>
        <kbd className="settings-zoom-kbd">Ctrl</kbd>
        <kbd className="settings-zoom-kbd">+</kbd>
        <span>/</span>
        <kbd className="settings-zoom-kbd">Ctrl</kbd>
        <kbd className="settings-zoom-kbd">-</kbd>
        <span>/</span>
        <kbd className="settings-zoom-kbd">Ctrl</kbd>
        <kbd className="settings-zoom-kbd">0</kbd>
      </span>
      <span>{t('settings.general.uiZoomShortcutResetHint')}</span>
    </div>
  )

  const uiZoomSection = (
    <SettingsSection title={t('settings.general.uiZoom')} description={t('settings.general.uiZoomDescription')}>
      <SettingsGroup>
        <SettingsBlock className="space-y-3">
          <div
            className={`settings-zoom-control flex items-center gap-3 ${isUiZoomDragging ? 'is-dragging' : ''}`}
            style={{ '--settings-zoom-range-progress': uiZoomRangeProgress } as CSSProperties}
          >
            <div className="settings-zoom-range-wrap min-w-0 flex-1">
              <div className="settings-zoom-preview" aria-hidden="true">
                {uiZoomPercent}%
              </div>
              <input
                type="range"
                aria-label={t('settings.general.uiZoom')}
                min={UI_ZOOM_MIN}
                max={UI_ZOOM_MAX}
                step={UI_ZOOM_STEP}
                value={uiZoomDraft}
                onPointerDown={() => {
                  setUiZoomDraggingState(true)
                }}
                onPointerUp={(e) => commitUiZoom(e.currentTarget.valueAsNumber)}
                onPointerCancel={() => {
                  setUiZoomDraggingState(false)
                  setUiZoomDraft(uiZoom)
                }}
                onChange={(e) => {
                  const nextZoom = Number.isFinite(e.currentTarget.valueAsNumber)
                    ? e.currentTarget.valueAsNumber
                    : UI_ZOOM_DEFAULT
                  setUiZoomDraft(nextZoom)
                  if (!isUiZoomDraggingRef.current) {
                    setUiZoom(nextZoom)
                  }
                }}
                onBlur={(e) => {
                  if (uiZoomDraft !== uiZoom) {
                    commitUiZoom(e.currentTarget.valueAsNumber)
                  } else {
                    setUiZoomDraggingState(false)
                  }
                }}
                className="settings-zoom-range w-full"
              />
            </div>
            <span className="w-11 shrink-0 text-right font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">
              {uiZoomPercent}%
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              aria-label={t('settings.general.uiZoomReset')}
              title={t('settings.general.uiZoomReset')}
              onClick={() => {
                setIsUiZoomDragging(false)
                setUiZoomDraft(UI_ZOOM_DEFAULT)
                setUiZoom(UI_ZOOM_DEFAULT)
              }}
              icon={<RotateCw size={12} strokeWidth={2} aria-hidden="true" />}
            >
              100%
            </Button>
          </div>
          {uiZoomShortcuts}
        </SettingsBlock>
      </SettingsGroup>
    </SettingsSection>
  )

  const selectedProxyMode = NETWORK_PROXY_MODES.find((mode) => mode.value === networkDraft.proxy.mode)
  const selectedSendBehavior = CHAT_SEND_BEHAVIORS.find((option) => option.value === chatSendBehavior)
  const fieldInvalidClass = 'aria-[invalid=true]:border-[var(--color-error)]'

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader title={t('settings.tab.general')} description={t('settings.general.pageDescription')} />

      {proxyManagedSettingsWarning && (
        <div
          role="alert"
          className="mt-5 rounded-[var(--radius-lg)] bg-[var(--color-warning-container)] px-4 py-3 text-xs leading-[1.5] text-[var(--color-on-warning-container)]"
        >
          {t('settings.general.proxyManagedSettingsWarning')}
        </div>
      )}

      {/* Theme. The six palettes stay, drawn as cards; following the system
          splits them into the ground each OS mode returns to. */}
      <SettingsSection title={t('settings.general.appearanceTitle')} description={t('settings.general.appearanceDescription')}>
        <SettingsGroup>
          <SettingsBlock className="px-4 py-4">
            {followSystemTheme ? (
              <div className="flex flex-col gap-4">
                <div>
                  <p className="mb-2 text-xs text-[var(--color-text-tertiary)]">
                    {t('settings.general.appearance.lightThemeLabel')}
                  </p>
                  <div className={`grid grid-cols-4 gap-3 ${THEME_GRID_WIDTH}`}>
                    {LIGHT_THEMES.map(({ value, label }) => (
                      <ThemeCard
                        key={value}
                        theme={value}
                        label={label}
                        selected={lightTheme === value}
                        onSelect={() => void setTheme(value)}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs text-[var(--color-text-tertiary)]">
                    {t('settings.general.appearance.darkThemeLabel')}
                  </p>
                  <div className={`grid grid-cols-4 gap-3 ${THEME_GRID_WIDTH}`}>
                    {DARK_THEMES.map(({ value, label }) => (
                      <ThemeCard
                        key={value}
                        theme={value}
                        label={label}
                        selected={darkTheme === value}
                        onSelect={() => void setTheme(value)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className={`grid grid-cols-3 gap-3.5 ${THEME_GRID_WIDTH}`}>
                {THEMES.map(({ value, label }) => (
                  <ThemeCard
                    key={value}
                    theme={value}
                    label={label}
                    selected={theme === value}
                    onSelect={() => void setTheme(value)}
                  />
                ))}
              </div>
            )}
          </SettingsBlock>
          <SettingsSwitchRow
            title={t('settings.general.appearance.followSystem')}
            description={t('settings.general.appearance.followSystemHint')}
            checked={followSystemTheme}
            onChange={setFollowSystemTheme}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('settings.general.languageTitle')}>
        <SettingsGroup>
          <SettingsRow title={t('settings.general.languageTitle')} description={t('settings.general.languageDescription')}>
            <SegmentedControl<Locale>
              label={t('settings.general.languageTitle')}
              size="sm"
              value={locale}
              onChange={setLocale}
              items={LANGUAGES}
            />
          </SettingsRow>
          <SettingsRow title={t('settings.general.responseLangTitle')} description={t('settings.general.responseLangDescription')}>
            <Dropdown<string>
              items={RESPONSE_LANGUAGES}
              value={responseLanguage}
              onChange={(value) => void setResponseLanguage(value)}
              width={280}
              maxHeight={320}
              align="right"
              trigger={
                <PickerButton aria-label={t('settings.general.responseLangTitle')}>
                  {selectedResponseLanguageLabel}
                </PickerButton>
              }
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <ChatAppearanceSettings />

      {uiZoomSection}

      {/* Everything a new session starts from, in one card. */}
      <SettingsSection title={t('h5Settings.agentPreferences')}>
        <SettingsGroup>
          <SettingsRow
            title={t('settings.general.chatSendBehaviorTitle')}
            description={selectedSendBehavior?.description ?? t('settings.general.chatSendBehaviorDescription')}
          >
            <SegmentedControl<ChatSendBehavior>
              label={t('settings.general.chatSendBehaviorTitle')}
              size="sm"
              value={chatSendBehavior}
              onChange={(value) => void setChatSendBehavior(value)}
              items={CHAT_SEND_BEHAVIORS.map(({ value, label }) => ({ value, label }))}
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.general.defaultPermissionTitle')}
            description={t('settings.general.defaultPermissionHint')}
          >
            <PermissionModeSelector
              value={permissionMode}
              onChange={(mode) => void setPermissionMode(mode)}
              workDir={t('settings.general.defaultPermissionScope')}
              menuPlacement="bottom"
              menuAlign="right"
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.general.effortDefaultLabel')}
            description={currentModel
              ? t('settings.general.effortModelHint', { model: currentModel.name || currentModel.id })
              : t('settings.general.effortNoModelHint')}
          >
            <Button
              ref={effortButtonRef}
              variant="secondary"
              size="base"
              disabled={!selectedEffort}
              aria-label={selectedEffort
                ? t('settings.general.effortSelectLabel', { level: effortLabels[selectedEffort] })
                : t('settings.general.effortUnavailable')}
              aria-expanded={selectedEffort ? effortOpen : undefined}
              onClick={() => setEffortOpen((open) => !open)}
              icon={<Brain size={14} strokeWidth={1.75} aria-hidden="true" />}
              iconPosition="start"
            >
              {selectedEffort ? effortLabels[selectedEffort] : t('settings.general.effortUnavailable')}
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
            </Button>
            {selectedEffort && (
              <ReasoningEffortPopover
                open={effortOpen}
                anchorRef={effortButtonRef}
                options={effortOptions}
                value={selectedEffort}
                labels={effortLabels}
                ariaLabel={t('settings.general.effortDefaultLabel')}
                onChange={(level) => void setEffort(level)}
                onClose={() => setEffortOpen(false)}
              />
            )}
          </SettingsRow>
          <SettingsSwitchRow
            title={t('settings.general.thinkingEnabled')}
            description={t('settings.general.thinkingDescription')}
            checked={thinkingEnabled}
            onChange={(enabled) => void setThinkingEnabled(enabled)}
          />
          <SettingsRow
            title={t('settings.general.outputStyleTitle')}
            description={selectedOutputStyleDescription || t('settings.general.outputStyleDescription')}
            footer={(
              <div className="space-y-1.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge size="sm">{outputStyleScopeLabel}</Badge>
                  {selectedOutputStyle && (
                    <Badge size="sm">{getOutputStyleSourceLabel(selectedOutputStyle.source, t)}</Badge>
                  )}
                  <span className="min-w-0">{outputStyleScopeHint}</span>
                </div>
                <p>{t('settings.general.outputStyleRestartHint')}</p>
                {outputStyleError && <p className="text-[var(--color-error)]">{outputStyleError}</p>}
              </div>
            )}
          >
            <Dropdown<string>
              items={outputStyleItems}
              value={outputStyle}
              onChange={(value) => void handleOutputStyleChange(value)}
              width={360}
              maxHeight={360}
              align="right"
              trigger={
                <PickerButton
                  aria-label={t('settings.general.outputStyleSelectLabel')}
                  disabled={outputStylesLoading}
                >
                  {outputStylesLoading
                    ? t('settings.general.outputStyleLoading')
                    : selectedOutputStyleLabel}
                </PickerButton>
              }
            />
          </SettingsRow>
          {/*
            Only the editors we detect, never every installed application: the menu
            offers one editor slot, and this chooses which. Hidden entirely when none
            are installed — there is nothing to pick between.
          */}
          {detectedEditors.length > 0 && (
            <SettingsRow
              title={t('settings.general.defaultEditorTitle')}
              description={t('settings.general.defaultEditorDescription')}
            >
              <Dropdown<string>
                items={[
                  { value: '', label: t('settings.general.defaultEditorAuto') },
                  ...detectedEditors.map((target) => ({ value: target.id, label: target.label })),
                ]}
                value={editorTargetId ?? ''}
                onChange={(value) => setEditorTargetId(value || null)}
                width={240}
                maxHeight={320}
                align="right"
                label={t('settings.general.defaultEditorTitle')}
                trigger={
                  <PickerButton aria-label={t('settings.general.defaultEditorTitle')}>
                    {detectedEditors.find((target) => target.id === editorTargetId)?.label
                      ?? t('settings.general.defaultEditorAuto')}
                  </PickerButton>
                }
              />
            </SettingsRow>
          )}
          <SettingsSwitchRow
            title={t('settings.general.workflowKeywordEnabled')}
            description={t('settings.general.workflowKeywordDescription')}
            checked={workflowKeywordTriggerEnabled}
            onChange={(enabled) => void setWorkflowKeywordTriggerEnabled(enabled)}
          />
          <SettingsSwitchRow
            title={t('settings.general.agentTeamsEnabled')}
            description={(
              <>
                <span>{t('settings.general.agentTeamsDescription')}</span>{' '}
                <span>{t('settings.general.agentTeamsHint')}</span>
              </>
            )}
            checked={agentTeamsEnabled}
            onChange={(enabled) => void handleAgentTeamsChange(enabled)}
            disabled={agentTeamsSaving}
          />
          <SettingsRow
            title={t('settings.general.subagentConcurrencyTitle')}
            description={t('settings.general.subagentConcurrencyDescription')}
            data-testid="subagent-concurrency-setting"
            footer={(
              <p className="text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                {t('settings.general.subagentConcurrencyHint')}
              </p>
            )}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              size="md"
              containerClassName="w-[180px]"
              aria-label={t('settings.general.subagentConcurrencyTitle')}
              placeholder={t('settings.general.subagentConcurrencyUnlimited')}
              value={subagentLimitInput}
              disabled={subagentLimitSaving}
              error={subagentLimitError ?? undefined}
              onInput={(event) => {
                // 清空未完成的数字输入时 value="" 可能不变，单靠 React
                // onChange 不会再次触发，会留下过期的 badInput 标记。
                setSubagentLimitBadInput(event.currentTarget.validity.badInput)
                setSubagentLimitError(null)
              }}
              onChange={(event) => {
                setSubagentLimitInput(event.target.value)
                // 浏览器会将未完成或非法的数字文本暴露为空值。
                // 只有真正清空输入框才表示不限。
                setSubagentLimitBadInput(event.target.validity.badInput)
                setSubagentLimitError(null)
              }}
            />
            <Button
              variant="secondary"
              size="base"
              disabled={subagentLimitSaving}
              onClick={() => void handleSubagentLimitSave()}
            >
              {t('common.save')}
            </Button>
          </SettingsRow>
          <SettingsSwitchRow
            title={t('settings.general.autoQuestionEnabled')}
            description={t('settings.general.autoQuestionHint')}
            checked={autoQuestion.enabled}
            onChange={(enabled) => void setAutoQuestion({ ...autoQuestion, enabled }).catch(() => {
              addToast({ type: 'error', message: t('settings.general.autoQuestionSaveFailed') })
            })}
          />
          {autoQuestion.enabled && (
            <SettingsRow title={t('settings.general.autoQuestionTimeout')} layout="inline">
              <SelectField
                label={t('settings.general.autoQuestionTimeout')}
                labelHidden
                size="md"
                className="w-auto min-w-[120px]"
                value={String(autoQuestion.timeoutMinutes)}
                options={AUTO_QUESTION_TIMEOUT_OPTIONS.map((minutes) => ({
                  value: String(minutes),
                  label: t('settings.general.autoQuestionMinutes', { count: minutes }),
                }))}
                onChange={(value) => void setAutoQuestion({
                  ...autoQuestion,
                  timeoutMinutes: Number(value),
                }).catch(() => {
                  addToast({ type: 'error', message: t('settings.general.autoQuestionSaveFailed') })
                })}
              />
            </SettingsRow>
          )}
          <SettingsSwitchRow
            title={t('settings.general.autoDreamEnabled')}
            description={autoDreamEnabled
              ? t('settings.general.autoDreamHintOn')
              : t('settings.general.autoDreamHintOff')}
            checked={autoDreamEnabled}
            onChange={handleAutoDreamToggle}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('settings.general.notificationsTitle')} description={t('settings.general.notificationsDescription')}>
        <SettingsGroup>
          <SettingsSwitchRow
            title={t('settings.general.notificationsEnabled')}
            description={desktopNotificationsEnabled
              ? t('settings.general.notificationsHintOn')
              : t('settings.general.notificationsHintOff')}
            checked={desktopNotificationsEnabled}
            onChange={(enabled) => void handleDesktopNotificationsToggle(enabled)}
          />
          {desktopNotificationsEnabled && (
            <SettingsRow
              layout="inline"
              title={<>{t('settings.general.notificationsStatus')}: {notificationStatusLabel[notificationPermission]}</>}
            >
              {notificationPermission !== 'granted' && notificationPermission !== 'unsupported' && (
                <Button
                  size="base"
                  variant="secondary"
                  className="whitespace-nowrap"
                  disabled={notificationActionRunning}
                  onClick={() => void handleNotificationPermissionAction()}
                >
                  {notificationPermission === 'denied'
                    ? t('settings.general.notificationsOpenSettings')
                    : t('settings.general.notificationsAuthorize')}
                </Button>
              )}
            </SettingsRow>
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('settings.general.networkTitle')} description={t('settings.general.networkDescription')}>
        <SettingsGroup>
          <SettingsBlock>
            <SegmentedControl<NetworkProxyMode>
              label={t('settings.general.networkTitle')}
              layout="fill"
              size="sm"
              value={networkDraft.proxy.mode}
              onChange={(mode) => {
                setNetworkDraft((current) => ({
                  ...current,
                  proxy: { ...current.proxy, mode },
                }))
                setNetworkSaveError(null)
              }}
              items={NETWORK_PROXY_MODES.map(({ value, label }) => ({ value, label }))}
            />
            {selectedProxyMode && (
              <p className="mt-2 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{selectedProxyMode.description}</p>
            )}
          </SettingsBlock>

          {networkDraft.proxy.mode === 'manual' && (
            <SettingsRow
              title={t('settings.general.networkProxyUrl')}
              htmlFor="network-proxy-url"
              description={networkProxyError
                ? <span className="text-[var(--color-error)]">{networkProxyError}</span>
                : t('settings.general.networkProxyUrlHint')}
            >
              <Input
                id="network-proxy-url"
                size="md"
                containerClassName="w-full sm:w-[260px]"
                className={`font-mono text-xs ${fieldInvalidClass}`}
                value={networkDraft.proxy.url}
                placeholder="http://127.0.0.1:7890"
                autoComplete="off"
                aria-invalid={networkProxyError ? true : undefined}
                onChange={(event) => {
                  setNetworkDraft((current) => ({
                    ...current,
                    proxy: { ...current.proxy, url: event.target.value },
                  }))
                  setNetworkSaveError(null)
                }}
              />
            </SettingsRow>
          )}

          <SettingsRow
            title={t('settings.general.networkTimeout')}
            htmlFor="network-timeout-seconds"
            descriptionId="network-timeout-help"
            description={networkTimeoutError
              ? <span className="text-[var(--color-error)]">{networkTimeoutError}</span>
              : t('settings.general.networkTimeoutHint')}
          >
            <Button
              type="button"
              size="base"
              variant="secondary"
              className="px-2.5 font-mono tabular-nums"
              aria-label={t('settings.general.networkTimeoutDecrease')}
              onClick={() => setNetworkTimeoutSeconds((parsedNetworkTimeoutSeconds ?? timeoutSeconds) - NETWORK_TIMEOUT_STEP_SECONDS)}
            >
              -30
            </Button>
            <NumberField
              id="network-timeout-seconds"
              unit={t('settings.general.networkTimeoutUnit')}
              min={NETWORK_TIMEOUT_MIN_SECONDS}
              max={NETWORK_TIMEOUT_MAX_SECONDS}
              value={networkTimeoutInput}
              invalid={!!networkTimeoutError}
              describedBy="network-timeout-help"
              onChange={(nextValue) => {
                if (!/^\d*$/.test(nextValue)) return
                setNetworkTimeoutInput(nextValue)
                const seconds = Number(nextValue)
                if (nextValue.length > 0 && seconds >= NETWORK_TIMEOUT_MIN_SECONDS && seconds <= NETWORK_TIMEOUT_MAX_SECONDS) {
                  setNetworkDraft((current) => ({
                    ...current,
                    aiRequestTimeoutMs: seconds * 1000,
                  }))
                }
                setNetworkSaveError(null)
              }}
            />
            <Button
              type="button"
              size="base"
              variant="secondary"
              className="px-2.5 font-mono tabular-nums"
              aria-label={t('settings.general.networkTimeoutIncrease')}
              onClick={() => setNetworkTimeoutSeconds((parsedNetworkTimeoutSeconds ?? timeoutSeconds) + NETWORK_TIMEOUT_STEP_SECONDS)}
            >
              +30
            </Button>
          </SettingsRow>

          <SettingsBlock className="flex items-center justify-between gap-4">
            <div className="min-w-0 text-xs leading-[1.5]">
              <p className="text-[var(--color-text-tertiary)]">{t('settings.general.networkScopeHint')}</p>
              {networkSaveError && (
                <p className="mt-1 text-[var(--color-error)]">{networkSaveError}</p>
              )}
            </div>
            <Button
              size="base"
              variant="secondary"
              className="shrink-0 whitespace-nowrap"
              disabled={!networkDirty || !!networkProxyError || !!networkTimeoutError || isSavingNetwork}
              loading={isSavingNetwork}
              onClick={() => void saveNetworkSettings()}
            >
              {t('settings.general.networkSave')}
            </Button>
          </SettingsBlock>

          <SettingsSwitchRow
            title={t('settings.general.webFetchPreflightEnabled')}
            description={(
              <>
                <span>{t('settings.general.webFetchPreflightDescription')}</span>{' '}
                <span>{t('settings.general.webFetchPreflightHint')}</span>
              </>
            )}
            checked={skipWebFetchPreflight}
            onChange={(enabled) => void setSkipWebFetchPreflight(enabled)}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('settings.general.webSearchTitle')} description={t('settings.general.webSearchDescription')}>
        <SettingsGroup>
          <SettingsBlock>
            <SegmentedControl<WebSearchMode>
              label={t('settings.general.webSearchTitle')}
              layout="fill"
              size="sm"
              value={webSearchDraft.mode ?? 'auto'}
              onChange={(mode) => setWebSearchDraft({ ...webSearchDraft, mode })}
              items={WEB_SEARCH_MODES.map(({ value, label }) => ({ value, label, title: label }))}
            />
            <p className="mt-2 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{t('settings.general.webSearchHint')}</p>
          </SettingsBlock>
          <SettingsRow
            title={t('settings.general.webSearchTavilyKey')}
            htmlFor="web-search-tavily-key"
            description={(
              <>
                {t('settings.general.webSearchTavilyFreeHint')}{' '}
                <a
                  href="https://app.tavily.com/home"
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('settings.general.webSearchTavilyApiKeyLink')}
                  className="whitespace-nowrap text-[var(--color-text-accent)] hover:underline"
                >
                  {t('settings.general.webSearchGetApiKey')}
                </a>
              </>
            )}
          >
            <Input
              id="web-search-tavily-key"
              type="password"
              size="md"
              containerClassName="w-full sm:w-[260px]"
              value={webSearchDraft.tavilyApiKey ?? ''}
              placeholder="tvly-..."
              autoComplete="off"
              onChange={(event) =>
                setWebSearchDraft({
                  ...webSearchDraft,
                  tavilyApiKey: event.target.value,
                })
              }
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.general.webSearchBraveKey')}
            htmlFor="web-search-brave-key"
            description={(
              <>
                {t('settings.general.webSearchBraveFreeHint')}{' '}
                <a
                  href="https://api-dashboard.search.brave.com/app/keys"
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('settings.general.webSearchBraveApiKeyLink')}
                  className="whitespace-nowrap text-[var(--color-text-accent)] hover:underline"
                >
                  {t('settings.general.webSearchGetApiKey')}
                </a>
              </>
            )}
          >
            <Input
              id="web-search-brave-key"
              type="password"
              size="md"
              containerClassName="w-full sm:w-[260px]"
              value={webSearchDraft.braveApiKey ?? ''}
              placeholder={t('settings.general.webSearchBravePlaceholder')}
              autoComplete="off"
              onChange={(event) =>
                setWebSearchDraft({
                  ...webSearchDraft,
                  braveApiKey: event.target.value,
                })
              }
            />
          </SettingsRow>
          <SettingsBlock className="flex justify-end">
            <Button
              size="base"
              variant="secondary"
              className="whitespace-nowrap"
              disabled={!webSearchDirty}
              onClick={() => void setWebSearch(webSearchDraft)}
            >
              {t('settings.general.webSearchSave')}
            </Button>
          </SettingsBlock>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('settings.general.traceTitle')} description={t('settings.general.traceDescription')}>
        <SettingsGroup>
          <SettingsSwitchRow
            title={t('settings.general.traceEnabled')}
            description={traceCapture.enabled ? t('settings.general.traceHintOn') : t('settings.general.traceHintOff')}
            checked={traceCapture.enabled}
            onChange={(enabled) => void setTraceCaptureEnabled(enabled)}
            footer={traceCapture.storageDir ? (
              <div className="truncate rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
                {traceCapture.storageDir}
              </div>
            ) : undefined}
          />
        </SettingsGroup>
      </SettingsSection>

      {/*
        Retention changes delete transcripts irreversibly and the server only
        accepts them with the desktop process token, so a paired phone browser
        would only ever see a 403 here.
      */}
      {!isTouchH5Document() && (
        <SettingsSection title={t('settings.general.sessionRetentionTitle')} description={t('settings.general.sessionRetentionDescription')}>
          <SettingsGroup>
            <SettingsRow
              title={t('settings.general.sessionRetentionLabel')}
              htmlFor="session-retention-days"
              descriptionId="session-retention-help"
              description={(
                <>
                  <span className="text-[var(--color-text-secondary)]">
                    {effectiveRetentionDays === 0
                      ? t('settings.general.sessionRetentionCurrentOff')
                      : t('settings.general.sessionRetentionCurrent', { days: String(effectiveRetentionDays) })}
                  </span>
                  {' · '}
                  {retentionInputError
                    ? <span className="text-[var(--color-error)]">{retentionInputError}</span>
                    : <span>{t('settings.general.sessionRetentionHint')}</span>}
                </>
              )}
              footer={retentionSaveError ? (
                <p className="text-xs text-[var(--color-error)]">{retentionSaveError}</p>
              ) : undefined}
            >
              <NumberField
                id="session-retention-days"
                unit={t('settings.general.sessionRetentionUnit')}
                min={0}
                max={MAX_CLEANUP_PERIOD_DAYS}
                value={retentionInput}
                invalid={!!retentionInputError}
                describedBy="session-retention-help"
                onChange={(nextValue) => {
                  if (!/^\d*$/.test(nextValue)) return
                  setRetentionInput(nextValue)
                  setRetentionSaveError(null)
                }}
              />
              <Button
                size="base"
                variant="secondary"
                className="whitespace-nowrap"
                disabled={
                  !retentionDirty ||
                  !!retentionInputError ||
                  retentionActionRunning ||
                  retentionPreviewLoading
                }
                loading={retentionPreviewLoading || retentionActionRunning}
                onClick={() => void openRetentionConfirm()}
              >
                {t('settings.general.sessionRetentionSave')}
              </Button>
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
      )}

      {isDesktopRuntime() && (
        <SettingsSection title={t('settings.general.storageTitle')} description={t('settings.general.storageDescription')}>
          <SettingsGroup>
            <button
              type="button"
              disabled={migrationRunning}
              onClick={() => {
                if (isEnvironmentConfigDir) {
                  setModeError(t('settings.general.storageEnvironmentSwitchBlocked'))
                  return
                }
                if (appMode.mode !== 'default') {
                  openModeSwitchConfirm('default')
                }
              }}
              aria-pressed={appMode.mode === 'default' && !isEnvironmentConfigDir}
              className="group flex w-full items-start gap-3 px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
            >
              <StorageOptionText
                selected={appMode.mode === 'default' && !isEnvironmentConfigDir}
                icon={<AppWindow size={16} strokeWidth={1.75} aria-hidden="true" />}
                title={t('settings.general.storageSystemTitle')}
                description={t('settings.general.storageSystemDescription')}
              />
            </button>

            <div className="px-4 py-3">
              <div className="flex items-start gap-3">
                <StorageOptionText
                  selected={appMode.mode === 'portable' && !isEnvironmentConfigDir}
                  icon={<FolderInput size={16} strokeWidth={1.75} aria-hidden="true" />}
                  title={t('settings.general.storagePortableTitle')}
                  description={t('settings.general.storagePortableDescription')}
                />
              </div>
              <div className="mt-3 flex items-end gap-2 pl-7">
                <Input
                  id="portable-data-dir"
                  label={t('settings.general.storagePortableDirLabel')}
                  size="md"
                  containerClassName="min-w-0 flex-1"
                  value={portableDirDraft}
                  placeholder={t('settings.general.storagePortableDirPlaceholder')}
                  onChange={(event) => {
                    setPortableDirDraft(event.target.value)
                    setModeError(null)
                  }}
                  className="font-mono text-xs"
                  disabled={migrationRunning}
                />
                <Button
                  type="button"
                  size="base"
                  variant="secondary"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void openPortableDirPicker()}
                  disabled={migrationRunning}
                >
                  {t('settings.general.storageChooseDir')}
                </Button>
              </div>
              <div className="mt-3 flex justify-end">
                <Button
                  type="button"
                  size="base"
                  variant="secondary"
                  disabled={modeActionRunning || migrationRunning || (appMode.mode === 'portable' && portableDirDraft.trim() === (appMode.portableDir ?? ''))}
                  onClick={() => openModeSwitchConfirm('portable')}
                >
                  {t('settings.general.storageApplyPortable')}
                </Button>
              </div>
            </div>

            <SettingsBlock className="space-y-3">
              {activeConfigDir && (
                <div>
                  <div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.general.storageActiveDir')}</div>
                  <div className="mt-1 break-all rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-2 py-1 font-mono text-xs text-[var(--color-text-secondary)]">
                    {activeConfigDir}
                  </div>
                </div>
              )}
              {isEnvironmentConfigDir && (
                <StorageNotice>{t('settings.general.storageEnvironmentHint')}</StorageNotice>
              )}
              {appModeRequiresRestart && (
                <StorageNotice>{t('settings.general.storageRestartHint')}</StorageNotice>
              )}
              <p className="text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                {t('settings.general.storageMoveHint')}
              </p>
              {modeError && (
                <p className="text-xs text-[var(--color-error)]">{modeError}</p>
              )}
            </SettingsBlock>

            <DataMigrationSettings
              environmentControlled={isEnvironmentConfigDir}
              disabled={modeActionRunning || appModeRequiresRestart}
              onBusyChange={setMigrationRunning}
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      {/* Confirm dialog for mode switch */}
      <ConfirmDialog
        open={modeSwitchConfirmOpen}
        onClose={closeModeSwitchConfirm}
        onConfirm={() => void confirmModeSwitch()}
        title={t('settings.general.modeSwitchTitle')}
        body={(
          <div className="space-y-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
            <p>
              {pendingMode === 'portable'
                ? t('settings.general.storageSwitchPortableBody')
                : t('settings.general.storageSwitchDefaultBody')}
            </p>
            {pendingMode === 'portable' && pendingPortableDir && (
              <div className="break-all rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
                {pendingPortableDir}
              </div>
            )}
            <p>{t('settings.general.storageSwitchRestartBody')}</p>
          </div>
        )}
        confirmLabel={t('settings.general.modeSwitchConfirm')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={modeActionRunning}
      />
      <ConfirmDialog
        open={autoDreamConfirmOpen}
        onClose={() => {
          if (!autoDreamActionRunning) setAutoDreamConfirmOpen(false)
        }}
        onConfirm={() => void confirmAutoDreamEnable()}
        title={t('settings.general.autoDreamConfirmTitle')}
        body={(
          <div className="space-y-2">
            <p>{t('settings.general.autoDreamConfirmKeepRunning')}</p>
            <p>{t('settings.general.autoDreamConfirmTokenCost')}</p>
          </div>
        )}
        confirmLabel={t('settings.general.autoDreamConfirmEnable')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={autoDreamActionRunning}
      />
      <ConfirmDialog
        open={retentionConfirmOpen}
        onClose={closeRetentionConfirm}
        onConfirm={() => void confirmRetentionChange()}
        title={t('settings.general.sessionRetentionConfirmTitle')}
        body={(
          <div className="space-y-2 text-[13px] leading-6">
            <p>
              {retentionPendingDays === 0
                ? t('settings.general.sessionRetentionConfirmDisable')
                : t('settings.general.sessionRetentionConfirmDelete', {
                    days: String(retentionPendingDays ?? effectiveRetentionDays),
                  })}
            </p>
            <p className="text-[var(--color-text-tertiary)]">
              {retentionPreviewFiles === null
                ? t('settings.general.sessionRetentionPreviewUnavailable')
                : t('settings.general.sessionRetentionPreview', {
                    count: String(retentionPreviewFiles),
                  })}
            </p>
            {retentionSaveError && (
              <p className="text-[var(--color-error)]">{retentionSaveError}</p>
            )}
          </div>
        )}
        confirmLabel={t('settings.general.sessionRetentionConfirmAction')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={retentionActionRunning}
      />
    </div>
  )
}

/**
 * The secondary button a `Dropdown` opens from: current value, then a chevron.
 * Forwards its ref and props because `Dropdown` clones its trigger to attach both.
 */
const PickerButton = forwardRef<HTMLButtonElement, ButtonProps & { children: ReactNode }>(
  function PickerButton({ children, className, ...props }, ref) {
    return (
      <Button
        ref={ref}
        variant="secondary"
        size="base"
        className={cx('max-w-[240px] gap-2', className)}
        {...props}
      >
        <span className="min-w-0 truncate">{children}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      </Button>
    )
  },
)

/**
 * The swatches are previews, not content, so they keep the size they were drawn
 * at (about 190px across three columns) however wide the settings frame grows,
 * rather than swelling into 330px posters on a large display. The grid sits at
 * the start of its block, the way the rows' labels do.
 */
const THEME_GRID_WIDTH = 'max-w-[600px]'

/**
 * A palette card. The miniature is painted from the palette's own source
 * variables: `data-theme` re-declares the `--cc-*` ramp on the swatch, so it
 * shows the real colours of that theme without copying a single value here.
 * The selection ring and frame use the app's current tokens, which the swatch
 * inherits because the semantic layer resolves them on the root.
 */
function ThemeCard({ theme, label, selected, onSelect }: {
  theme: ThemeMode
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className="group grid min-w-0 justify-items-center gap-2 rounded-[var(--radius-md)] text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-container-lowest)]"
    >
      <span
        aria-hidden="true"
        data-theme={theme}
        className={cx(
          'grid aspect-[16/10] w-full grid-cols-[28%_1fr] overflow-hidden rounded-[var(--radius-md)] transition-shadow duration-150',
          selected
            ? 'shadow-[0_0_0_2px_var(--color-brand)]'
            : 'shadow-[inset_0_0_0_1px_var(--color-outline)] group-hover:shadow-[inset_0_0_0_1px_var(--color-border-strong)]',
        )}
      >
        <span className="flex flex-col gap-1 bg-[var(--cc-s0)] px-[16%] pt-[26%]">
          <span className="h-[3px] rounded-full bg-[var(--cc-bd2)]" />
          <span className="h-[3px] w-2/3 rounded-full bg-[var(--cc-bd)]" />
          <span className="h-[3px] w-3/4 rounded-full bg-[var(--cc-bd)]" />
        </span>
        <span className="flex flex-col gap-1.5 bg-[var(--cc-bg)] px-[14%] pb-[12%] pt-[20%]">
          <span className="h-[3px] w-3/5 rounded-full bg-[var(--cc-t3)]" />
          <span className="h-[3px] rounded-full bg-[var(--cc-bd2)]" />
          <span className="h-[3px] w-4/5 rounded-full bg-[var(--cc-bd2)]" />
          <span className="mt-auto h-2 w-2 self-end rounded-full bg-[var(--cc-ac)]" />
        </span>
      </span>
      <span
        className={cx(
          'max-w-full truncate',
          selected
            ? 'font-medium text-[var(--color-text-primary)]'
            : 'text-[var(--color-text-secondary)] group-hover:text-[var(--color-text-primary)]',
        )}
      >
        {label}
      </span>
    </button>
  )
}

/** Radio mark + icon + title/description for one data-storage choice. */
function StorageOptionText({ selected, icon, title, description }: {
  selected: boolean
  icon: ReactNode
  title: string
  description: string
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cx(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          selected
            ? 'border-[1.5px] border-[var(--color-brand)]'
            : 'border-[var(--color-border-strong)] group-hover:border-[var(--color-text-secondary)]',
        )}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-[var(--color-brand)]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] font-medium leading-5 text-[var(--color-text-primary)]">
          <span className="text-[var(--color-text-tertiary)]">{icon}</span>
          {title}
        </span>
        <span className="mt-0.5 block text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{description}</span>
      </span>
    </>
  )
}

function StorageNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-[1.5] text-[var(--color-on-warning-container)]">
      {children}
    </div>
  )
}

/**
 * A short whole-number field with its unit inside the box. Built on `Input`;
 * the invalid border comes from `aria-invalid` because the error text lives in
 * the row's description line, not under the field.
 */
function NumberField({ id, unit, min, max, value, invalid, describedBy, onChange }: {
  id: string
  unit: string
  min: number
  max: number
  value: string
  invalid: boolean
  describedBy: string
  onChange: (value: string) => void
}) {
  return (
    <div className="relative w-[120px]">
      <Input
        id={id}
        type="number"
        size="md"
        min={min}
        max={max}
        step={1}
        inputMode="numeric"
        value={value}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="pr-9 tabular-nums aria-[invalid=true]:border-[var(--color-error)]"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-tertiary)]">
        {unit}
      </span>
    </div>
  )
}

function getBuiltInOutputStyleTranslationKeys(style: {
  value: string
  source: OutputStyleSource
}) {
  if (style.source !== 'built-in') return null
  return BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS[
    style.value as keyof typeof BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS
  ] ?? null
}

function getOutputStyleLabel(
  style: {
    value: string
    label: string
    source: OutputStyleSource
  },
  t: (key: TranslationKey) => string,
) {
  const keys = getBuiltInOutputStyleTranslationKeys(style)
  return keys ? t(keys.label) : style.label
}

function getOutputStyleDescription(
  style: {
    value: string
    description: string
    source: OutputStyleSource
  },
  t: (key: TranslationKey) => string,
) {
  const keys = getBuiltInOutputStyleTranslationKeys(style)
  return keys ? t(keys.description) : style.description
}

function getOutputStyleSourceLabel(
  source: OutputStyleSource,
  t: (key: TranslationKey) => string,
) {
  switch (source) {
    case 'built-in':
      return t('settings.general.outputStyleSourceBuiltIn')
    case 'userSettings':
      return t('settings.general.outputStyleSourceUser')
    case 'projectSettings':
      return t('settings.general.outputStyleSourceProject')
    case 'localSettings':
      return t('settings.general.outputStyleSourceLocal')
    case 'policySettings':
      return t('settings.general.outputStyleSourcePolicy')
    case 'plugin':
      return t('settings.general.outputStyleSourcePlugin')
  }
}
