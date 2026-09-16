import { useState, useEffect, useCallback, useRef } from 'react'
import { useAdapterStore } from '../stores/adapterStore'
import { useTranslation } from '../i18n'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import QRCode from 'qrcode'

type ImTab = 'telegram' | 'feishu' | 'wechat' | 'dingtalk' | 'whatsapp' | 'wecom' | 'qq' | 'slack'
type ImPlatform = ImTab
type AdapterUnbindTarget =
  | 'wechatAccount'
  | 'dingtalkBot'
  | 'whatsappAccount'
  | 'feishuApp'
  | 'wecomBot'
  | 'qqBot'
  | 'slackApp'

const FEISHU_CREATE_BOT_URL = 'https://open.feishu.cn/page/openclaw?form=multiAgent'
const IM_CONFIG_DOCS_URL = 'https://cchaha.ai/im/'

const IM_TABS: readonly ImTab[] = [
  'telegram',
  'feishu',
  'wechat',
  'dingtalk',
  'whatsapp',
  'wecom',
  'qq',
  'slack',
]

type QrBindingState = {
  qrDataUrl: string | null
  /** The URL the QR encodes, kept so the panel still works when the image
   *  could not be generated server-side. */
  verificationUrl: string | null
  sessionKey: string | null
  status: string
  isBinding: boolean
}

const IDLE_QR_BINDING: QrBindingState = {
  qrDataUrl: null,
  verificationUrl: null,
  sessionKey: null,
  status: '',
  isBinding: false,
}

type QrPollResult = {
  connected: boolean
  status?: string
  message?: string
  qrDataUrl?: string
  verificationUrl?: string
  /** Server-supplied cadence, e.g. after Feishu answers RFC 8628 `slow_down`. */
  pollIntervalMs?: number
}

/** Poll outcomes that end the attempt; anything else keeps the QR on screen. */
const TERMINAL_QR_STATUSES = new Set(['expired', 'failed', 'denied', 'error', 'not_started'])

/** Consecutive transport failures tolerated before a scan is abandoned. */
const MAX_CONSECUTIVE_POLL_ERRORS = 3

/**
 * Drives one scan-to-bind flow: request a code, show it, poll until the server
 * reports the credentials are stored.
 *
 * Feishu, WeCom and QQ all bind this way, and the failure modes that matter —
 * a poll that outlives the component, a rotated QR image, a terminal status
 * that must stop the loop — are identical. Keeping them in one hook is what
 * stops the third copy from quietly skipping one of them.
 */
function useQrBinding(options: {
  start: () => Promise<{
    sessionKey: string
    qrDataUrl?: string
    verificationUrl?: string
    message?: string
    pollIntervalMs?: number
  }>
  poll: (sessionKey: string) => Promise<QrPollResult>
  pollIntervalMs?: number
  successMessage: string
  failureMessage: string
}) {
  const { start, poll, successMessage, failureMessage } = options
  const defaultIntervalMs = options.pollIntervalMs ?? 1500
  const [state, setState] = useState<QrBindingState>(IDLE_QR_BINDING)
  // The platform, not this component, knows how fast it will answer: Feishu
  // widens the interval on `slow_down`, and ignoring that just earns more of
  // them.
  const intervalRef = useRef(defaultIntervalMs)

  const begin = useCallback(async () => {
    setState({ ...IDLE_QR_BINDING, isBinding: true })
    intervalRef.current = defaultIntervalMs
    try {
      const result = await start()
      if (result.pollIntervalMs && result.pollIntervalMs > 0) {
        intervalRef.current = result.pollIntervalMs
      }
      setState({
        qrDataUrl: result.qrDataUrl ?? null,
        verificationUrl: result.verificationUrl ?? null,
        sessionKey: result.sessionKey,
        status: result.message ?? '',
        isBinding: true,
      })
    } catch (err) {
      setState({
        ...IDLE_QR_BINDING,
        status: err instanceof Error ? err.message : failureMessage,
      })
    }
  }, [start, failureMessage])

  const reset = useCallback((status = '') => {
    setState({ ...IDLE_QR_BINDING, status })
  }, [])

  const sessionKey = state.sessionKey
  useEffect(() => {
    if (!sessionKey) return

    let cancelled = false
    let timer: number | null = null
    let consecutiveErrors = 0

    const tick = async () => {
      try {
        const result = await poll(sessionKey)
        if (cancelled) return
        if (result.connected) {
          setState({ ...IDLE_QR_BINDING, status: successMessage })
          return
        }
        if (result.pollIntervalMs && result.pollIntervalMs > 0) {
          intervalRef.current = result.pollIntervalMs
        }
        setState((prev) => ({
          ...prev,
          qrDataUrl: result.qrDataUrl ?? prev.qrDataUrl,
          verificationUrl: result.verificationUrl ?? prev.verificationUrl,
          status: result.message ?? prev.status,
        }))
        if (result.status && TERMINAL_QR_STATUSES.has(result.status)) {
          setState((prev) => ({ ...IDLE_QR_BINDING, status: result.message ?? prev.status }))
          return
        }
        consecutiveErrors = 0
      } catch (err) {
        if (cancelled) return
        // A poll travels through the local server out to the vendor, so a 5xx
        // or a timeout is ordinary. Tearing the QR down on the first one — as
        // this did — makes the user rescan for a blip the next tick would have
        // ridden out. Keep the code on screen and retry, and only give up once
        // the failures look persistent rather than transient.
        consecutiveErrors += 1
        const message = err instanceof Error ? err.message : failureMessage
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          setState({ ...IDLE_QR_BINDING, status: message })
          return
        }
        setState((prev) => ({ ...prev, status: message }))
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), intervalRef.current)
    }

    timer = window.setTimeout(() => void tick(), intervalRef.current)
    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [sessionKey, poll, successMessage, failureMessage])

  return { ...state, begin, reset }
}

export function AdapterSettings() {
  const t = useTranslation()
  const {
    config,
    isLoading,
    fetchConfig,
    updateConfig,
    generatePairingCode,
    startWechatLogin,
    pollWechatLogin,
    startWhatsAppLogin,
    pollWhatsAppLogin,
    removePairedUser,
    beginDingtalkRegistration,
    pollDingtalkRegistration,
    unbindWechatAccount,
    unbindDingtalkBot,
    unbindWhatsAppAccount,
    beginFeishuRegistration,
    pollFeishuRegistration,
    cancelFeishuRegistration,
    unbindFeishuApp,
    startWecomLogin,
    pollWecomLogin,
    unbindWecomBot,
    startQqLogin,
    pollQqLogin,
    unbindQqBot,
    getSlackManifest,
    unbindSlackApp,
  } = useAdapterStore()

  // Active IM tab
  const [activeIm, setActiveIm] = useState<ImTab>('telegram')

  // Server —— serverUrl 不再暴露在 UI 里（见下方 Server URL 注释），
  // 桌面端用 sidecar env var 注入动态端口。
  const [defaultProjectDir, setDefaultProjectDir] = useState('')
  // Which directories the IM bots may reach at all. Empty = the built-in default
  // (home directory + default project), which is what restores /projects (#1191).
  const [allowedProjectRoots, setAllowedProjectRoots] = useState<string[]>([])

  // Telegram
  const [tgBotToken, setTgBotToken] = useState('')
  const [tgAllowedUsers, setTgAllowedUsers] = useState('')

  // Feishu
  const [isUnbindingFeishuApp, setIsUnbindingFeishuApp] = useState(false)
  const [fsAppId, setFsAppId] = useState('')
  const [fsAppSecret, setFsAppSecret] = useState('')
  const [fsEncryptKey, setFsEncryptKey] = useState('')
  const [fsVerificationToken, setFsVerificationToken] = useState('')
  const [fsAllowedUsers, setFsAllowedUsers] = useState('')
  const [fsStreamingCard, setFsStreamingCard] = useState(false)

  // WeChat
  const [wcAllowedUsers, setWcAllowedUsers] = useState('')
  const [wechatQrUrl, setWechatQrUrl] = useState<string | null>(null)
  const [wechatSessionKey, setWechatSessionKey] = useState<string | null>(null)
  const [wechatStatus, setWechatStatus] = useState('')
  const [isWechatBinding, setIsWechatBinding] = useState(false)
  const [isUnbindingWechatAccount, setIsUnbindingWechatAccount] = useState(false)

  // WhatsApp
  const [waAllowedUsers, setWaAllowedUsers] = useState('')
  const [whatsappQrUrl, setWhatsappQrUrl] = useState<string | null>(null)
  const [whatsappSessionKey, setWhatsappSessionKey] = useState<string | null>(null)
  const [whatsappStatus, setWhatsappStatus] = useState('')
  const [isWhatsAppBinding, setIsWhatsAppBinding] = useState(false)
  const [isUnbindingWhatsAppAccount, setIsUnbindingWhatsAppAccount] = useState(false)

  // DingTalk
  const [dtClientId, setDtClientId] = useState('')
  const [dtClientSecret, setDtClientSecret] = useState('')
  const [dtAllowedUsers, setDtAllowedUsers] = useState('')
  const [dtEndpoint, setDtEndpoint] = useState('')
  const [dtPermissionCardTemplateId, setDtPermissionCardTemplateId] = useState('')
  const [dtRegistration, setDtRegistration] = useState<{
    deviceCode: string
    verificationUriComplete: string
    qrDataUrl?: string
    intervalSeconds: number
    expiresAt: number
  } | null>(null)
  const [dtAuthStatus, setDtAuthStatus] = useState<'idle' | 'waiting' | 'bound' | 'error'>('idle')
  const [dtAuthError, setDtAuthError] = useState('')
  const [isStartingDtAuth, setIsStartingDtAuth] = useState(false)
  const [isUnbindingDtBot, setIsUnbindingDtBot] = useState(false)

  // WeCom (企业微信)
  const [wecomAllowedUsers, setWecomAllowedUsers] = useState('')
  const [isUnbindingWecomBot, setIsUnbindingWecomBot] = useState(false)

  // QQ
  const [qqAllowedUsers, setQqAllowedUsers] = useState('')
  const [isUnbindingQqBot, setIsUnbindingQqBot] = useState(false)

  // Slack
  const [slackBotToken, setSlackBotToken] = useState('')
  const [slackAppToken, setSlackAppToken] = useState('')
  const [slackAllowedUsers, setSlackAllowedUsers] = useState('')
  const [slackManifest, setSlackManifest] = useState<{ manifest: string; createAppUrl: string } | null>(null)
  const [slackManifestError, setSlackManifestError] = useState('')
  const [slackStatus, setSlackStatus] = useState('')
  const [isUnbindingSlackApp, setIsUnbindingSlackApp] = useState(false)

  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')

  // Platforms whose own allowedProjectRoots replace the global list below.
  const platformsWithOwnRoots = IM_TABS
    .filter((platform) => (config[platform]?.allowedProjectRoots?.length ?? 0) > 0)
    .map((platform) => t(`settings.adapters.${platform}` as const))

  // Pairing
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [pendingUnbind, setPendingUnbind] = useState<{ platform: ImPlatform; userId: string | number } | null>(null)
  const [pendingAdapterUnbind, setPendingAdapterUnbind] = useState<AdapterUnbindTarget | null>(null)
  const [isUnbinding, setIsUnbinding] = useState(false)

  useEffect(() => {
    fetchConfig()
  }, [])

  // Sync form state when config is loaded
  useEffect(() => {
    setDefaultProjectDir(config.defaultProjectDir ?? '')
    setAllowedProjectRoots(config.allowedProjectRoots ?? [])
    setTgBotToken(config.telegram?.botToken ?? '')
    setTgAllowedUsers(config.telegram?.allowedUsers?.join(', ') ?? '')
    setFsAppId(config.feishu?.appId ?? '')
    setFsAppSecret(config.feishu?.appSecret ?? '')
    setFsEncryptKey(config.feishu?.encryptKey ?? '')
    setFsVerificationToken(config.feishu?.verificationToken ?? '')
    setFsAllowedUsers(config.feishu?.allowedUsers?.join(', ') ?? '')
    setFsStreamingCard(config.feishu?.streamingCard ?? false)
    setWcAllowedUsers(config.wechat?.allowedUsers?.join(', ') ?? '')
    setWaAllowedUsers(config.whatsapp?.allowedUsers?.join(', ') ?? '')
    setDtClientId(config.dingtalk?.clientId ?? '')
    setDtClientSecret(config.dingtalk?.clientSecret ?? '')
    setDtAllowedUsers(config.dingtalk?.allowedUsers?.join(', ') ?? '')
    setDtEndpoint(config.dingtalk?.endpoint ?? '')
    setDtPermissionCardTemplateId(config.dingtalk?.permissionCardTemplateId ?? '')
    setWecomAllowedUsers(config.wecom?.allowedUsers?.join(', ') ?? '')
    setQqAllowedUsers(config.qq?.allowedUsers?.join(', ') ?? '')
    setSlackBotToken(config.slack?.botToken ?? '')
    setSlackAppToken(config.slack?.appToken ?? '')
    setSlackAllowedUsers(config.slack?.allowedUsers?.join(', ') ?? '')
  }, [config])

  useEffect(() => {
    if (!wechatSessionKey) return

    let cancelled = false
    let timer: number | null = null

    const poll = async () => {
      try {
        const result = await pollWechatLogin(wechatSessionKey)
        if (cancelled) return
        if (result.connected) {
          setWechatStatus(t('settings.adapters.wechatBindSuccess'))
          setWechatQrUrl(null)
          setWechatSessionKey(null)
          setIsWechatBinding(false)
          return
        }
        if (result.message) {
          setWechatStatus(result.message)
        }
        if (result.status === 'expired' || result.status === 'not_started') {
          setWechatQrUrl(null)
          setWechatSessionKey(null)
          setIsWechatBinding(false)
          return
        }
      } catch (err) {
        if (!cancelled) setWechatStatus(err instanceof Error ? err.message : 'WeChat bind failed')
      }

      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), 1200)
      }
    }

    timer = window.setTimeout(() => void poll(), 1200)

    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [wechatSessionKey, pollWechatLogin, t])

  useEffect(() => {
    if (!whatsappSessionKey) return

    let cancelled = false
    let timer: number | null = null

    const poll = async () => {
      try {
        const result = await pollWhatsAppLogin(whatsappSessionKey)
        if (cancelled) return
        if (result.connected) {
          setWhatsappStatus(t('settings.adapters.whatsappBindSuccess'))
          setWhatsappQrUrl(null)
          setWhatsappSessionKey(null)
          setIsWhatsAppBinding(false)
          return
        }
        if (result.qrDataUrl) {
          setWhatsappQrUrl(result.qrDataUrl)
        }
        if (result.message) {
          setWhatsappStatus(result.message)
        }
        if (result.status === 'expired' || result.status === 'error') {
          setWhatsappSessionKey(null)
          setIsWhatsAppBinding(false)
          return
        }
      } catch (err) {
        if (!cancelled) setWhatsappStatus(err instanceof Error ? err.message : t('settings.adapters.whatsappBindFailed'))
      }

      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), 1200)
      }
    }

    timer = window.setTimeout(() => void poll(), 1200)

    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [whatsappSessionKey, pollWhatsAppLogin, t])

  useEffect(() => {
    if (!dtRegistration || dtAuthStatus !== 'waiting') return

    let cancelled = false
    const poll = async () => {
      if (Date.now() > dtRegistration.expiresAt) {
        setDtAuthStatus('error')
        setDtAuthError(t('settings.adapters.dingtalkAuthExpired'))
        setDtRegistration(null)
        return
      }

      try {
        const result = await pollDingtalkRegistration(dtRegistration.deviceCode)
        if (cancelled) return
        if (result.status === 'SUCCESS') {
          setDtAuthStatus('bound')
          setDtRegistration(null)
          setDtAuthError('')
          await fetchConfig()
        } else if (result.status === 'FAIL' || result.status === 'EXPIRED') {
          setDtAuthStatus('error')
          setDtAuthError(result.failReason || t('settings.adapters.dingtalkAuthFailed'))
          setDtRegistration(null)
        }
      } catch (err) {
        if (!cancelled) {
          setDtAuthStatus('error')
          setDtAuthError(err instanceof Error ? err.message : t('settings.adapters.dingtalkAuthFailed'))
        }
      }
    }

    const timer = window.setInterval(poll, Math.max(1, dtRegistration.intervalSeconds) * 1000)
    void poll()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [dtRegistration, dtAuthStatus, pollDingtalkRegistration, fetchConfig, t])

  // Feishu / WeCom / QQ all bind by scanning; only the endpoints differ.
  const feishuBinding = useQrBinding({
    start: useCallback(async () => {
      const begun = await beginFeishuRegistration()
      return {
        ...begun,
        verificationUrl: begun.verificationUri,
        pollIntervalMs: begun.intervalSeconds > 0 ? begun.intervalSeconds * 1000 : undefined,
      }
    }, [beginFeishuRegistration]),
    poll: useCallback(async (sessionKey: string) => {
      const result = await pollFeishuRegistration(sessionKey)
      return {
        connected: result.status === 'success',
        status: result.status,
        message: result.message,
        pollIntervalMs: result.intervalSeconds ? result.intervalSeconds * 1000 : undefined,
      }
    }, [pollFeishuRegistration]),
    successMessage: t('settings.adapters.feishuBindSuccess'),
    failureMessage: t('settings.adapters.feishuAuthFailed'),
  })

  const wecomBinding = useQrBinding({
    start: useCallback(() => startWecomLogin(), [startWecomLogin]),
    poll: useCallback((sessionKey: string) => pollWecomLogin(sessionKey), [pollWecomLogin]),
    successMessage: t('settings.adapters.wecomBindSuccess'),
    failureMessage: t('settings.adapters.wecomBindFailed'),
  })

  const qqBinding = useQrBinding({
    start: useCallback(() => startQqLogin(), [startQqLogin]),
    poll: useCallback((sessionKey: string) => pollQqLogin(sessionKey), [pollQqLogin]),
    successMessage: t('settings.adapters.qqBindSuccess'),
    failureMessage: t('settings.adapters.qqBindFailed'),
  })

  // The Slack manifest is static per build; fetch it once the tab is opened so
  // a user who never touches Slack pays nothing for it.
  useEffect(() => {
    if (activeIm !== 'slack' || slackManifest) return
    let cancelled = false
    void getSlackManifest()
      .then((info) => {
        if (!cancelled) setSlackManifest(info)
      })
      .catch((err) => {
        if (!cancelled) {
          setSlackManifestError(err instanceof Error ? err.message : t('settings.adapters.slackManifestFailed'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeIm, slackManifest, getSlackManifest, t])

  async function handleSave() {
    setIsSaving(true)
    setSaveStatus('idle')
    setSaveError('')
    try {
      const patch: Record<string, unknown> = {
        defaultProjectDir,
        allowedProjectRoots,
      }

      const tgUsers = tgAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n))

      patch.telegram = {
        botToken: tgBotToken,
        allowedUsers: tgUsers.length ? tgUsers : [],
      }

      const fsUsers = fsAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      patch.feishu = {
        appId: fsAppId,
        appSecret: fsAppSecret,
        encryptKey: fsEncryptKey,
        verificationToken: fsVerificationToken,
        allowedUsers: fsUsers.length ? fsUsers : [],
        streamingCard: fsStreamingCard,
      }

      const wcUsers = wcAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      patch.wechat = {
        allowedUsers: wcUsers.length ? wcUsers : [],
      }

      const waUsers = waAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      patch.whatsapp = {
        allowedUsers: waUsers.length ? waUsers : [],
      }

      const dtUsers = dtAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      patch.dingtalk = {
        clientId: dtClientId,
        clientSecret: dtClientSecret,
        allowedUsers: dtUsers.length ? dtUsers : [],
        endpoint: dtEndpoint,
        permissionCardTemplateId: dtPermissionCardTemplateId,
      }

      // WeCom and QQ credentials are owned by the QR binding, so only the
      // editable allowlist round-trips through Save — the same rule the
      // WeChat and WhatsApp panels follow.
      patch.wecom = {
        allowedUsers: splitAllowedUsers(wecomAllowedUsers),
      }

      patch.qq = {
        allowedUsers: splitAllowedUsers(qqAllowedUsers),
      }

      patch.slack = {
        botToken: slackBotToken,
        appToken: slackAppToken,
        allowedUsers: splitAllowedUsers(slackAllowedUsers),
      }

      await updateConfig(patch)
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  const handleGenerateCode = useCallback(async () => {
    setIsGenerating(true)
    try {
      const code = await generatePairingCode()
      setPairingCode(code)
    } catch (err) {
      console.error('Failed to generate pairing code:', err)
    } finally {
      setIsGenerating(false)
    }
  }, [generatePairingCode])

  const handleWechatBind = useCallback(async () => {
    setIsWechatBinding(true)
    setWechatStatus('')
    try {
      const result = await startWechatLogin()
      if (!result.qrcodeUrl) {
        throw new Error(result.message || 'WeChat QR URL missing')
      }
      const qrDataUrl = await QRCode.toDataURL(result.qrcodeUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 8,
      })
      setWechatQrUrl(qrDataUrl)
      setWechatSessionKey(result.sessionKey)
      setWechatStatus(result.message)
    } catch (err) {
      setWechatStatus(err instanceof Error ? err.message : 'WeChat bind failed')
      setIsWechatBinding(false)
    }
  }, [startWechatLogin])

  const handleWhatsAppBind = useCallback(async () => {
    setIsWhatsAppBinding(true)
    setWhatsappStatus('')
    try {
      const result = await startWhatsAppLogin()
      if (result.qrDataUrl) {
        setWhatsappQrUrl(result.qrDataUrl)
      }
      setWhatsappSessionKey(result.sessionKey)
      setWhatsappStatus(result.message)
    } catch (err) {
      setWhatsappStatus(err instanceof Error ? err.message : t('settings.adapters.whatsappBindFailed'))
      setIsWhatsAppBinding(false)
    }
  }, [startWhatsAppLogin, t])

  const handleStartDingtalkAuth = useCallback(async () => {
    setIsStartingDtAuth(true)
    setDtAuthStatus('idle')
    setDtAuthError('')
    try {
      const begin = await beginDingtalkRegistration()
      setDtRegistration({
        deviceCode: begin.deviceCode,
        verificationUriComplete: begin.verificationUriComplete,
        qrDataUrl: begin.qrDataUrl,
        intervalSeconds: begin.intervalSeconds,
        expiresAt: Date.now() + begin.expiresInSeconds * 1000,
      })
      setDtAuthStatus('waiting')
    } catch (err) {
      setDtAuthStatus('error')
      setDtAuthError(err instanceof Error ? err.message : t('settings.adapters.dingtalkAuthFailed'))
    } finally {
      setIsStartingDtAuth(false)
    }
  }, [beginDingtalkRegistration, t])

  const handleUnbindWechatAccount = useCallback(async () => {
    setIsUnbindingWechatAccount(true)
    setWechatStatus('')
    try {
      await unbindWechatAccount()
      await fetchConfig()
      setWechatQrUrl(null)
      setWechatSessionKey(null)
      setWechatStatus(t('settings.adapters.wechatUnbound'))
    } catch (err) {
      setWechatStatus(err instanceof Error ? err.message : t('settings.adapters.wechatUnbindFailed'))
    } finally {
      setIsUnbindingWechatAccount(false)
      setIsWechatBinding(false)
      setPendingAdapterUnbind(null)
    }
  }, [unbindWechatAccount, fetchConfig, t])

  const handleUnbindDingtalkBot = useCallback(async () => {
    setIsUnbindingDtBot(true)
    setDtAuthError('')
    try {
      await unbindDingtalkBot()
      setDtAuthStatus('idle')
      setDtRegistration(null)
      await fetchConfig()
    } catch (err) {
      setDtAuthStatus('error')
      setDtAuthError(err instanceof Error ? err.message : t('settings.adapters.dingtalkUnbindFailed'))
    } finally {
      setIsUnbindingDtBot(false)
      setPendingAdapterUnbind(null)
    }
  }, [unbindDingtalkBot, fetchConfig, t])

  const handleUnbindWhatsAppAccount = useCallback(async () => {
    setIsUnbindingWhatsAppAccount(true)
    setWhatsappStatus('')
    try {
      await unbindWhatsAppAccount()
      await fetchConfig()
      setWhatsappQrUrl(null)
      setWhatsappSessionKey(null)
      setWhatsappStatus(t('settings.adapters.whatsappUnbound'))
    } catch (err) {
      setWhatsappStatus(err instanceof Error ? err.message : t('settings.adapters.whatsappUnbindFailed'))
    } finally {
      setIsUnbindingWhatsAppAccount(false)
      setIsWhatsAppBinding(false)
      setPendingAdapterUnbind(null)
    }
  }, [unbindWhatsAppAccount, fetchConfig, t])

  const handleUnbindFeishuApp = useCallback(async () => {
    setIsUnbindingFeishuApp(true)
    try {
      if (feishuBinding.sessionKey) await cancelFeishuRegistration(feishuBinding.sessionKey)
      await unbindFeishuApp()
      feishuBinding.reset(t('settings.adapters.feishuUnbound'))
    } catch (err) {
      feishuBinding.reset(err instanceof Error ? err.message : t('settings.adapters.feishuUnbindFailed'))
    } finally {
      setIsUnbindingFeishuApp(false)
      setPendingAdapterUnbind(null)
    }
  }, [unbindFeishuApp, cancelFeishuRegistration, feishuBinding, t])

  const handleUnbindWecomBot = useCallback(async () => {
    setIsUnbindingWecomBot(true)
    try {
      await unbindWecomBot()
      wecomBinding.reset(t('settings.adapters.wecomUnbound'))
    } catch (err) {
      wecomBinding.reset(err instanceof Error ? err.message : t('settings.adapters.wecomUnbindFailed'))
    } finally {
      setIsUnbindingWecomBot(false)
      setPendingAdapterUnbind(null)
    }
  }, [unbindWecomBot, wecomBinding, t])

  const handleUnbindQqBot = useCallback(async () => {
    setIsUnbindingQqBot(true)
    try {
      await unbindQqBot()
      qqBinding.reset(t('settings.adapters.qqUnbound'))
    } catch (err) {
      qqBinding.reset(err instanceof Error ? err.message : t('settings.adapters.qqUnbindFailed'))
    } finally {
      setIsUnbindingQqBot(false)
      setPendingAdapterUnbind(null)
    }
  }, [unbindQqBot, qqBinding, t])

  const handleUnbindSlackApp = useCallback(async () => {
    setIsUnbindingSlackApp(true)
    setSlackStatus('')
    try {
      await unbindSlackApp()
      setSlackStatus(t('settings.adapters.slackUnbound'))
    } catch (err) {
      // The dialog closes either way, so without this the tokens stay bound
      // and nothing on screen says so.
      setSlackStatus(err instanceof Error ? err.message : t('settings.adapters.slackUnbindFailed'))
    } finally {
      setIsUnbindingSlackApp(false)
      setPendingAdapterUnbind(null)
    }
  }, [unbindSlackApp, t])

  const handleUnbind = useCallback(async (platform: ImPlatform, userId: string | number) => {
    setPendingUnbind({ platform, userId })
  }, [])

  const confirmUnbind = useCallback(async () => {
    if (!pendingUnbind) return
    setIsUnbinding(true)
    try {
      await removePairedUser(pendingUnbind.platform, pendingUnbind.userId)
      await fetchConfig()
      setPendingUnbind(null)
    } finally {
      setIsUnbinding(false)
    }
  }, [pendingUnbind, removePairedUser, fetchConfig])

  /**
   * Everything the account-unbind dialog needs, per target.
   *
   * Seven targets share one dialog; a chain of ternaries over label, body,
   * handler and loading flag was already hard to read at three and is where a
   * mismatched pair (this title, that handler) would hide.
   */
  const adapterUnbindTargets: Record<
    AdapterUnbindTarget,
    { label: string; body: string; onConfirm: () => Promise<void>; loading: boolean }
  > = {
    wechatAccount: {
      label: t('settings.adapters.wechatUnbindAccount'),
      body: t('settings.adapters.wechatUnbindAccountConfirm'),
      onConfirm: handleUnbindWechatAccount,
      loading: isUnbindingWechatAccount,
    },
    whatsappAccount: {
      label: t('settings.adapters.whatsappUnbindAccount'),
      body: t('settings.adapters.whatsappUnbindAccountConfirm'),
      onConfirm: handleUnbindWhatsAppAccount,
      loading: isUnbindingWhatsAppAccount,
    },
    dingtalkBot: {
      label: t('settings.adapters.dingtalkUnbindBot'),
      body: t('settings.adapters.dingtalkUnbindBotConfirm'),
      onConfirm: handleUnbindDingtalkBot,
      loading: isUnbindingDtBot,
    },
    feishuApp: {
      label: t('settings.adapters.feishuUnbindApp'),
      body: t('settings.adapters.feishuUnbindAppConfirm'),
      onConfirm: handleUnbindFeishuApp,
      loading: isUnbindingFeishuApp,
    },
    wecomBot: {
      label: t('settings.adapters.wecomUnbindBot'),
      body: t('settings.adapters.wecomUnbindBotConfirm'),
      onConfirm: handleUnbindWecomBot,
      loading: isUnbindingWecomBot,
    },
    qqBot: {
      label: t('settings.adapters.qqUnbindBot'),
      body: t('settings.adapters.qqUnbindBotConfirm'),
      onConfirm: handleUnbindQqBot,
      loading: isUnbindingQqBot,
    },
    slackApp: {
      label: t('settings.adapters.slackUnbindApp'),
      body: t('settings.adapters.slackUnbindAppConfirm'),
      onConfirm: handleUnbindSlackApp,
      loading: isUnbindingSlackApp,
    },
  }
  const adapterUnbind = pendingAdapterUnbind ? adapterUnbindTargets[pendingAdapterUnbind] : null

  // Collect all paired users across platforms
  const allPairedUsers = IM_TABS.flatMap((platform) =>
    (config[platform]?.pairedUsers ?? []).map((user) => ({ ...user, platform })),
  )

  // Check pairing expiry
  const pairingExpiry = config.pairing?.expiresAt
  const isPairingActive = pairingExpiry ? Date.now() < pairingExpiry : false
  const minutesLeft = pairingExpiry ? Math.max(0, Math.ceil((pairingExpiry - Date.now()) / 60000)) : 0
  const hasSavedFeishuCredentials = Boolean(config.feishu?.appId && config.feishu?.appSecret)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingState label={t('common.loading')} variant="inline" size="md" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-8">
      {/* Page header. The pane opened straight onto its description, the only
          one of the sixteen sections without a title. */}
      <div>
        <h2
          className="mb-1.5 text-[24px] font-semibold leading-tight text-[var(--color-text-primary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          {t('settings.tab.adapters')}
        </h2>
        <p className="text-[13.5px] leading-6 text-[var(--color-text-secondary)]">
          {t('settings.adapters.description')}{' '}
          <a
            href={IM_CONFIG_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-[var(--color-brand)] transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)]"
          >
            {t('settings.adapters.configurationDocs')}
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">open_in_new</span>
          </a>
          {t('settings.adapters.descriptionAfterDocs')}
        </p>
      </div>

      {/* Pairing */}
      <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 bg-[var(--color-surface-hover)] border-b border-[var(--color-border)]">
          <span className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">link</span>
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.adapters.pairing')}</span>
        </div>
        <div className="p-4 space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">{t('settings.adapters.pairingDesc')}</p>

          {/* Generate code */}
          <div className="flex items-center gap-3">
            <Button onClick={handleGenerateCode} loading={isGenerating}>
              {pairingCode || isPairingActive ? t('settings.adapters.regenerateCode') : t('settings.adapters.generateCode')}
            </Button>
            {pairingCode && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-2xl font-bold tracking-[0.3em] text-[var(--color-brand)]">
                  {pairingCode}
                </span>
                <span className="text-xs text-[var(--color-text-tertiary)]">
                  {t('settings.adapters.codeExpiresIn')} 60 {t('settings.adapters.minutes')}
                </span>
              </div>
            )}
            {!pairingCode && isPairingActive && (
              <span className="text-xs text-[var(--color-text-tertiary)]">
                {t('settings.adapters.codeExpiresIn')} {minutesLeft} {t('settings.adapters.minutes')}
              </span>
            )}
          </div>
          {pairingCode && (
            <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.pairingCodeHint')}</p>
          )}

          {/* Paired users list */}
          <div>
            <h4 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">{t('settings.adapters.pairedUsers')}</h4>
            {allPairedUsers.length === 0 ? (
              <p className="text-sm text-[var(--color-text-tertiary)]">{t('settings.adapters.noPairedUsers')}</p>
            ) : (
              <div className="space-y-2">
                {allPairedUsers.map((user) => (
                  <div
                    key={`${user.platform}-${user.userId}`}
                    className="flex items-center justify-between px-3 py-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
                        {t(`settings.adapters.platform.${user.platform}`)}
                      </span>
                      <span className="text-sm text-[var(--color-text-primary)]">{user.displayName}</span>
                      <span className="text-xs text-[var(--color-text-tertiary)]">
                        {new Date(user.pairedAt).toLocaleDateString()}
                      </span>
                    </div>
                    <Button
                      variant="danger-outline"
                      size="sm"
                      onClick={() => handleUnbind(user.platform, user.userId)}
                    >
                      {t('settings.adapters.unbind')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Server URL —— 之前是个手填字段，但桌面端启动 adapter sidecar
          时已经把 server 的动态端口通过 ADAPTER_SERVER_URL env var 注进去了，
          loadConfig() 里 env 优先级高于这里的 file value，所以这个字段在桌面
          运行时完全不会被读到。用户也根本不知道该填什么端口（每次启动随机）。
          Standalone 模式（直接 bun run adapters/...）保留 file 字段兜底就够了。 */}

      {/* Default Project */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-[var(--color-text-primary)]">
          {t('settings.adapters.defaultProject')}
        </label>
        <div className="flex items-center gap-2">
          <DirectoryPicker value={defaultProjectDir} onChange={setDefaultProjectDir} />
          {defaultProjectDir && (
            <Button variant="ghost" size="sm" onClick={() => setDefaultProjectDir('')}>
              {t('settings.adapters.clearDefaultProject')}
            </Button>
          )}
        </div>
        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('settings.adapters.defaultProjectHint')}
        </p>
      </div>

      {/* Allowed project roots —— 这是 IM 通道真正的边界。刻意和「默认项目」分开：
          「默认项目」只决定新会话开在哪，一度被当成唯一允许的根目录，导致 /projects
          只剩下那一个项目（#1191）。留空 = 主目录，足以覆盖绝大多数用法。 */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-[var(--color-text-primary)]">
          {t('settings.adapters.allowedRoots')}
        </label>
        {allowedProjectRoots.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {allowedProjectRoots.map((root) => (
              <li
                key={root}
                className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-1.5"
              >
                <span className="truncate text-xs text-[var(--color-text-secondary)]" title={root}>{root}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('settings.adapters.removeAllowedRoot')}
                  onClick={() => setAllowedProjectRoots((prev) => prev.filter((item) => item !== root))}
                >
                  {t('settings.adapters.removeAllowedRoot')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {t('settings.adapters.allowedRootsDefault')}
          </p>
        )}
        <div className="flex items-center gap-2">
          <DirectoryPicker
            value=""
            onChange={(dir) => {
              if (!dir) return
              setAllowedProjectRoots((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
            }}
          />
        </div>
        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('settings.adapters.allowedRootsHint')}
        </p>
        {/* A platform-level list replaces the global one, and the docs teach
            hand-editing adapters.json — so say it, rather than letting a save
            here look like it applied everywhere. */}
        {platformsWithOwnRoots.length > 0 && (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {t('settings.adapters.allowedRootsOverridden', {
              platforms: platformsWithOwnRoots.join(', '),
            })}
          </p>
        )}
      </div>

      {/* IM Adapter Tabs */}
      <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] overflow-hidden">
        <div role="tablist" aria-label={t('settings.adapters.imTabs')} className="flex flex-wrap items-stretch border-b border-[var(--color-border)] bg-[var(--color-surface-hover)]">
          {IM_TABS.map((tab) => (
            <ImTabButton
              key={tab}
              label={t(`settings.adapters.${tab}` as const)}
              active={activeIm === tab}
              onClick={() => setActiveIm(tab)}
            />
          ))}
        </div>

        {activeIm === 'feishu' && (
          <div className="p-4 space-y-4">
            {/* Scan-to-create is the primary path: the confirmation page
                pre-fills the exact scopes and events this adapter calls, and
                the credentials never pass through the user's clipboard. */}
            <QrBindPanel
              title={t('settings.adapters.feishuQrTitle')}
              description={t('settings.adapters.feishuQrDesc')}
              bindLabel={hasSavedFeishuCredentials
                ? t('settings.adapters.feishuRebind')
                : t('settings.adapters.feishuStartAuth')}
              unbindLabel={t('settings.adapters.feishuUnbindApp')}
              qrAlt={t('settings.adapters.feishuQrAlt')}
              waitingLabel={t('settings.adapters.feishuWaiting')}
              binding={feishuBinding}
              isBound={hasSavedFeishuCredentials}
              isUnbinding={isUnbindingFeishuApp}
              onUnbind={() => setPendingAdapterUnbind('feishuApp')}
            />
            {!hasSavedFeishuCredentials && (
              <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <span className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-brand)]">smart_toy</span>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.adapters.feishuCreateBotTitle')}</h4>
                      <p className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">{t('settings.adapters.feishuCreateBotDesc')}</p>
                      <ol className="mt-2 space-y-1 text-xs leading-5 text-[var(--color-text-secondary)]">
                        <li>1. {t('settings.adapters.feishuCreateBotStepCreate')}</li>
                        <li>2. {t('settings.adapters.feishuCreateBotStepFill')}</li>
                      </ol>
                    </div>
                  </div>
                  <a
                    href={FEISHU_CREATE_BOT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[image:var(--gradient-btn-primary)] px-3 text-xs font-medium text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] transition-colors hover:bg-[image:var(--gradient-btn-primary-hover)] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
                  >
                    {t('settings.adapters.feishuCreateBotAction')}
                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                  </a>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('settings.adapters.appId')}
                value={fsAppId}
                onChange={(e) => setFsAppId(e.target.value)}
                placeholder={t('settings.adapters.appIdPlaceholder')}
              />
              <Input
                label={t('settings.adapters.appSecret')}
                type="password"
                value={fsAppSecret}
                onChange={(e) => setFsAppSecret(e.target.value)}
                placeholder={t('settings.adapters.appSecretPlaceholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('settings.adapters.encryptKey')}
                type="password"
                value={fsEncryptKey}
                onChange={(e) => setFsEncryptKey(e.target.value)}
                placeholder={t('settings.adapters.encryptKeyPlaceholder')}
              />
              <Input
                label={t('settings.adapters.verificationToken')}
                type="password"
                value={fsVerificationToken}
                onChange={(e) => setFsVerificationToken(e.target.value)}
                placeholder={t('settings.adapters.verificationTokenPlaceholder')}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.allowedUsers')}
                value={fsAllowedUsers}
                onChange={(e) => setFsAllowedUsers(e.target.value)}
                placeholder={t('settings.adapters.fsAllowedUsersPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.allowedUsersHint')}</p>
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={fsStreamingCard}
                onChange={(e) => setFsStreamingCard(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--color-border)] accent-[var(--color-brand)]"
              />
              <div>
                <span className="text-sm text-[var(--color-text-primary)]">{t('settings.adapters.streamingCard')}</span>
                <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.streamingCardDesc')}</p>
              </div>
            </label>
          </div>
        )}

        {activeIm === 'wechat' && (
          <div className="p-4 space-y-4">
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">
                    {config.wechat?.accountId ? t('settings.adapters.wechatConnected') : t('settings.adapters.wechatNotConnected')}
                  </div>
                  <p className="text-xs text-[var(--color-text-tertiary)]">
                    {t('settings.adapters.wechatQrHint')}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button onClick={handleWechatBind} loading={isWechatBinding && !wechatQrUrl} size="sm">
                    {config.wechat?.accountId ? t('settings.adapters.wechatRebind') : t('settings.adapters.wechatBind')}
                  </Button>
                  {config.wechat?.accountId && (
                    <Button onClick={() => setPendingAdapterUnbind('wechatAccount')} loading={isUnbindingWechatAccount} size="sm" variant="danger">
                      {t('settings.adapters.wechatUnbindAccount')}
                    </Button>
                  )}
                </div>
              </div>

              {wechatQrUrl && (
                <div className="flex items-start gap-4">
                  <img
                    src={wechatQrUrl}
                    alt={t('settings.adapters.wechatQrAlt')}
                    className="h-40 w-40 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white object-contain p-2"
                  />
                  <div className="pt-2 text-sm text-[var(--color-text-secondary)]">
                    {wechatStatus || t('settings.adapters.wechatWaiting')}
                  </div>
                </div>
              )}

              {!wechatQrUrl && wechatStatus && (
                <p className="text-sm text-[var(--color-text-secondary)]">{wechatStatus}</p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.allowedUsers')}
                value={wcAllowedUsers}
                onChange={(e) => setWcAllowedUsers(e.target.value)}
                placeholder={t('settings.adapters.wcAllowedUsersPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.wechatAllowedUsersHint')}</p>
            </div>
          </div>
        )}

        {activeIm === 'dingtalk' && (
          <div className="p-4 space-y-4">
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.adapters.dingtalkQrTitle')}</h4>
                  <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.dingtalkQrDesc')}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button onClick={handleStartDingtalkAuth} loading={isStartingDtAuth} size="sm">
                    {t('settings.adapters.dingtalkStartAuth')}
                  </Button>
                  {(config.dingtalk?.clientId || dtClientId) && (
                    <Button onClick={() => setPendingAdapterUnbind('dingtalkBot')} loading={isUnbindingDtBot} size="sm" variant="danger">
                      {t('settings.adapters.dingtalkUnbindBot')}
                    </Button>
                  )}
                </div>
              </div>

              {dtRegistration && (
                <div className="flex flex-wrap items-center gap-4">
                  {dtRegistration.qrDataUrl ? (
                    <img
                      src={dtRegistration.qrDataUrl}
                      alt={t('settings.adapters.dingtalkQrAlt')}
                      className="h-40 w-40 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white object-contain p-2"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="text-sm text-[var(--color-text-primary)]">{t('settings.adapters.dingtalkWaiting')}</p>
                    <a
                      href={dtRegistration.verificationUriComplete}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-xs text-[var(--color-brand)] hover:underline"
                    >
                      {dtRegistration.verificationUriComplete}
                    </a>
                  </div>
                </div>
              )}

              {dtAuthStatus === 'bound' && (
                <p className="text-sm text-[var(--color-success)]">{t('settings.adapters.dingtalkBound')}</p>
              )}
              {dtAuthStatus === 'error' && (
                <p className="text-sm text-[var(--color-error)]">{dtAuthError}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('settings.adapters.dingtalkClientId')}
                value={dtClientId}
                onChange={(e) => setDtClientId(e.target.value)}
                placeholder={t('settings.adapters.dingtalkClientIdPlaceholder')}
              />
              <Input
                label={t('settings.adapters.dingtalkClientSecret')}
                type="password"
                value={dtClientSecret}
                onChange={(e) => setDtClientSecret(e.target.value)}
                placeholder={t('settings.adapters.dingtalkClientSecretPlaceholder')}
              />
            </div>
            <Input
              label={t('settings.adapters.dingtalkEndpoint')}
              value={dtEndpoint}
              onChange={(e) => setDtEndpoint(e.target.value)}
              placeholder={t('settings.adapters.dingtalkEndpointPlaceholder')}
            />
            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.dingtalkPermissionCardTemplateId')}
                value={dtPermissionCardTemplateId}
                onChange={(e) => setDtPermissionCardTemplateId(e.target.value)}
                placeholder={t('settings.adapters.dingtalkPermissionCardTemplateIdPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.dingtalkPermissionCardTemplateIdHint')}</p>
            </div>
            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.allowedUsers')}
                value={dtAllowedUsers}
                onChange={(e) => setDtAllowedUsers(e.target.value)}
                placeholder={t('settings.adapters.dtAllowedUsersPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.allowedUsersHint')}</p>
            </div>
          </div>
        )}

        {activeIm === 'telegram' && (
          <div className="p-4 space-y-4">
            <Input
              label={t('settings.adapters.botToken')}
              type="password"
              value={tgBotToken}
              onChange={(e) => setTgBotToken(e.target.value)}
              placeholder={t('settings.adapters.botTokenPlaceholder')}
            />
            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.allowedUsers')}
                value={tgAllowedUsers}
                onChange={(e) => setTgAllowedUsers(e.target.value)}
                placeholder={t('settings.adapters.tgAllowedUsersPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.allowedUsersHint')}</p>
            </div>
          </div>
        )}

        {activeIm === 'whatsapp' && (
          <div className="p-4 space-y-4">
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">
                    {config.whatsapp?.accountJid ? t('settings.adapters.whatsappConnected') : t('settings.adapters.whatsappNotConnected')}
                  </div>
                  <p className="text-xs text-[var(--color-text-tertiary)]">
                    {t('settings.adapters.whatsappQrHint')}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button onClick={handleWhatsAppBind} loading={isWhatsAppBinding && !whatsappQrUrl} size="sm">
                    {config.whatsapp?.accountJid ? t('settings.adapters.whatsappRebind') : t('settings.adapters.whatsappBind')}
                  </Button>
                  {config.whatsapp?.accountJid && (
                    <Button onClick={() => setPendingAdapterUnbind('whatsappAccount')} loading={isUnbindingWhatsAppAccount} size="sm" variant="danger">
                      {t('settings.adapters.whatsappUnbindAccount')}
                    </Button>
                  )}
                </div>
              </div>

              {config.whatsapp?.accountJid && (
                <p className="text-xs text-[var(--color-text-tertiary)]">{config.whatsapp.accountJid}</p>
              )}

              {whatsappQrUrl && (
                <div className="flex items-start gap-4">
                  <img
                    src={whatsappQrUrl}
                    alt={t('settings.adapters.whatsappQrAlt')}
                    className="h-40 w-40 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white object-contain p-2"
                  />
                  <div className="pt-2 text-sm text-[var(--color-text-secondary)]">
                    {whatsappStatus || t('settings.adapters.whatsappWaiting')}
                  </div>
                </div>
              )}

              {!whatsappQrUrl && whatsappStatus && (
                <p className="text-sm text-[var(--color-text-secondary)]">{whatsappStatus}</p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.allowedUsers')}
                value={waAllowedUsers}
                onChange={(e) => setWaAllowedUsers(e.target.value)}
                placeholder={t('settings.adapters.waAllowedUsersPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.whatsappAllowedUsersHint')}</p>
            </div>
          </div>
        )}

        {activeIm === 'wecom' && (
          <div className="p-4 space-y-4">
            <QrBindPanel
              title={t('settings.adapters.wecomQrTitle')}
              description={t('settings.adapters.wecomQrDesc')}
              bindLabel={config.wecom?.botId
                ? t('settings.adapters.wecomRebind')
                : t('settings.adapters.wecomBind')}
              unbindLabel={t('settings.adapters.wecomUnbindBot')}
              qrAlt={t('settings.adapters.wecomQrAlt')}
              waitingLabel={t('settings.adapters.wecomWaiting')}
              binding={wecomBinding}
              isBound={Boolean(config.wecom?.botId)}
              boundDetail={config.wecom?.botId}
              isUnbinding={isUnbindingWecomBot}
              onUnbind={() => setPendingAdapterUnbind('wecomBot')}
            />

            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.allowedUsers')}
                value={wecomAllowedUsers}
                onChange={(e) => setWecomAllowedUsers(e.target.value)}
                placeholder={t('settings.adapters.wecomAllowedUsersPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.wecomAllowedUsersHint')}</p>
            </div>
          </div>
        )}

        {activeIm === 'qq' && (
          <div className="p-4 space-y-4">
            <QrBindPanel
              title={t('settings.adapters.qqQrTitle')}
              description={t('settings.adapters.qqQrDesc')}
              bindLabel={config.qq?.appId
                ? t('settings.adapters.qqRebind')
                : t('settings.adapters.qqBind')}
              unbindLabel={t('settings.adapters.qqUnbindBot')}
              qrAlt={t('settings.adapters.qqQrAlt')}
              waitingLabel={t('settings.adapters.qqWaiting')}
              binding={qqBinding}
              isBound={Boolean(config.qq?.appId)}
              boundDetail={config.qq?.appId}
              isUnbinding={isUnbindingQqBot}
              onUnbind={() => setPendingAdapterUnbind('qqBot')}
            />

            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.allowedUsers')}
                value={qqAllowedUsers}
                onChange={(e) => setQqAllowedUsers(e.target.value)}
                placeholder={t('settings.adapters.qqAllowedUsersPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.qqAllowedUsersHint')}</p>
            </div>
          </div>
        )}

        {activeIm === 'slack' && (
          <div className="p-4 space-y-4">
            {/* Slack has no scan flow. The manifest is the closest equivalent:
                one link that opens the create-app dialog fully configured. */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.adapters.slackCreateAppTitle')}</h4>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">{t('settings.adapters.slackCreateAppDesc')}</p>
                  <ol className="mt-2 space-y-1 text-xs leading-5 text-[var(--color-text-secondary)]">
                    <li>1. {t('settings.adapters.slackStepCreate')}</li>
                    <li>2. {t('settings.adapters.slackStepInstall')}</li>
                    <li>3. {t('settings.adapters.slackStepTokens')}</li>
                  </ol>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {slackManifest && (
                    <a
                      href={slackManifest.createAppUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[image:var(--gradient-btn-primary)] px-3 text-xs font-medium text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] transition-colors hover:bg-[image:var(--gradient-btn-primary-hover)] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
                    >
                      {t('settings.adapters.slackCreateAppAction')}
                      <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                    </a>
                  )}
                  {(config.slack?.botToken || slackBotToken) && (
                    <Button onClick={() => setPendingAdapterUnbind('slackApp')} loading={isUnbindingSlackApp} size="sm" variant="danger">
                      {t('settings.adapters.slackUnbindApp')}
                    </Button>
                  )}
                </div>
              </div>

              {slackManifest && (
                <details className="text-xs text-[var(--color-text-secondary)]">
                  <summary className="cursor-pointer select-none">{t('settings.adapters.slackManifestToggle')}</summary>
                  <pre className="mt-2 max-h-56 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] p-3 text-[11px] leading-5">
                    {slackManifest.manifest}
                  </pre>
                </details>
              )}
              {slackManifestError && (
                <p className="text-xs text-[var(--color-error)]">{slackManifestError}</p>
              )}
              {slackStatus && (
                <p className="text-sm text-[var(--color-text-secondary)]">{slackStatus}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('settings.adapters.slackBotToken')}
                type="password"
                value={slackBotToken}
                onChange={(e) => setSlackBotToken(e.target.value)}
                placeholder={t('settings.adapters.slackBotTokenPlaceholder')}
              />
              <Input
                label={t('settings.adapters.slackAppToken')}
                type="password"
                value={slackAppToken}
                onChange={(e) => setSlackAppToken(e.target.value)}
                placeholder={t('settings.adapters.slackAppTokenPlaceholder')}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Input
                label={t('settings.adapters.allowedUsers')}
                value={slackAllowedUsers}
                onChange={(e) => setSlackAllowedUsers(e.target.value)}
                placeholder={t('settings.adapters.slackAllowedUsersPlaceholder')}
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.adapters.allowedUsersHint')}</p>
            </div>
          </div>
        )}
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} loading={isSaving}>
          {saveStatus === 'saved' ? t('settings.adapters.saved') : t('settings.adapters.save')}
        </Button>
        {saveStatus === 'saved' && (
          <span className="text-sm text-[var(--color-success)]">
            <span className="material-symbols-outlined text-[16px] align-middle mr-1">check_circle</span>
            {t('settings.adapters.saved')}
          </span>
        )}
        {saveStatus === 'error' && (
          <span className="text-sm text-[var(--color-error)]">
            <span className="material-symbols-outlined text-[16px] align-middle mr-1">error</span>
            {saveError}
          </span>
        )}
      </div>

      <ConfirmDialog
        open={pendingUnbind !== null}
        onClose={() => {
          if (isUnbinding) return
          setPendingUnbind(null)
        }}
        onConfirm={confirmUnbind}
        title={t('settings.adapters.unbind')}
        body={t('settings.adapters.unbindConfirm')}
        confirmLabel={t('settings.adapters.unbind')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isUnbinding}
      />
      <ConfirmDialog
        open={pendingAdapterUnbind !== null}
        onClose={() => {
          if (adapterUnbind?.loading) return
          setPendingAdapterUnbind(null)
        }}
        onConfirm={adapterUnbind?.onConfirm ?? (async () => {})}
        title={adapterUnbind?.label ?? ''}
        body={adapterUnbind?.body ?? ''}
        confirmLabel={adapterUnbind?.label ?? ''}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={adapterUnbind?.loading ?? false}
      />
    </div>
  )
}

/**
 * The scan-to-bind card shared by Feishu, WeCom and QQ.
 *
 * All three show the same four things — a title, a bind button, the QR image
 * while an attempt is live, and the current status line — so the panel is one
 * component rather than three copies that drift.
 */
function QrBindPanel({
  title,
  description,
  bindLabel,
  unbindLabel,
  qrAlt,
  waitingLabel,
  binding,
  isBound,
  boundDetail,
  isUnbinding,
  onUnbind,
}: {
  title: string
  description: string
  bindLabel: string
  unbindLabel: string
  qrAlt: string
  waitingLabel: string
  binding: QrBindingState & { begin: () => Promise<void> }
  isBound: boolean
  boundDetail?: string
  isUnbinding: boolean
  onUnbind: () => void
}) {
  // The image is generated server-side and that can fail silently, so the
  // panel keys off the live attempt rather than the picture: the button stops
  // spinning once the code exists, and the raw URL is offered as a fallback.
  const attemptActive = Boolean(binding.sessionKey)
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h4>
          <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{description}</p>
          {isBound && boundDetail && (
            <p className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]">{boundDetail}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={() => void binding.begin()}
            loading={binding.isBinding && !attemptActive}
            size="sm"
          >
            {bindLabel}
          </Button>
          {isBound && (
            <Button onClick={onUnbind} loading={isUnbinding} size="sm" variant="danger">
              {unbindLabel}
            </Button>
          )}
        </div>
      </div>

      {attemptActive && (
        <div className="flex flex-wrap items-start gap-4">
          {binding.qrDataUrl && (
            <img
              src={binding.qrDataUrl}
              alt={qrAlt}
              className="h-40 w-40 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white object-contain p-2"
            />
          )}
          <div className="min-w-0 flex-1 space-y-2 pt-2">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {binding.status || waitingLabel}
            </p>
            {binding.verificationUrl && (
              <a
                href={binding.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-xs text-[var(--color-brand)] hover:underline"
              >
                {binding.verificationUrl}
              </a>
            )}
          </div>
        </div>
      )}

      {!attemptActive && binding.status && (
        <p className="text-sm text-[var(--color-text-secondary)]">{binding.status}</p>
      )}
    </div>
  )
}

/** Comma-separated allowlist input → the string[] the config stores. */
function splitAllowedUsers(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function ImTabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative px-4 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-inset ${
        active
          ? 'text-[var(--color-text-primary)] font-semibold after:absolute after:left-3 after:right-3 after:bottom-0 after:h-[2px] after:bg-[var(--color-brand)]'
          : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      {label}
    </button>
  )
}
