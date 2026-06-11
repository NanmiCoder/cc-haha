import { useState, useEffect, useCallback } from 'react'
import { useAdapterStore } from '../stores/adapterStore'
import { useTranslation } from '../i18n'
import { Input } from '../components/shared/Input'
import { Button } from '../components/shared/Button'
import { DirectoryPicker } from '../components/shared/DirectoryPicker'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import QRCode from 'qrcode'

type ImTab = 'telegram' | 'feishu' | 'wechat' | 'dingtalk' | 'whatsapp'
type ImPlatform = 'telegram' | 'feishu' | 'wechat' | 'dingtalk' | 'whatsapp'
type AdapterUnbindTarget = 'wechatAccount' | 'dingtalkBot' | 'whatsappAccount'

const FEISHU_CREATE_BOT_URL = 'https://open.feishu.cn/page/openclaw?form=multiAgent'
const IM_CONFIG_DOCS_URL = 'https://claudecode-haha.relakkesyang.org/im/'

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
  } = useAdapterStore()

  // Active IM tab
  const [activeIm, setActiveIm] = useState<ImTab>('telegram')

  // Server —— serverUrl 不再暴露在 UI 里（见下方 Server URL 注释），
  // 桌面端用 sidecar env var 注入动态端口。
  const [defaultProjectDir, setDefaultProjectDir] = useState('')

  // Telegram
  const [tgBotToken, setTgBotToken] = useState('')
  const [tgAllowedUsers, setTgAllowedUsers] = useState('')

  // Feishu
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

  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')

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

  async function handleSave() {
    setIsSaving(true)
    setSaveStatus('idle')
    setSaveError('')
    try {
      const patch: Record<string, unknown> = {}

      if (defaultProjectDir) patch.defaultProjectDir = defaultProjectDir

      const tgUsers = tgAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n))

      patch.telegram = {
        botToken: tgBotToken || undefined,
        allowedUsers: tgUsers.length ? tgUsers : [],
      }

      const fsUsers = fsAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      patch.feishu = {
        appId: fsAppId || undefined,
        appSecret: fsAppSecret || undefined,
        encryptKey: fsEncryptKey || undefined,
        verificationToken: fsVerificationToken || undefined,
        allowedUsers: fsUsers.length ? fsUsers : [],
        streamingCard: fsStreamingCard,
      }

      const wcUsers = wcAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      patch.wechat = {
        ...config.wechat,
        allowedUsers: wcUsers.length ? wcUsers : [],
      }

      const waUsers = waAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      patch.whatsapp = {
        ...config.whatsapp,
        allowedUsers: waUsers.length ? waUsers : [],
      }

      const dtUsers = dtAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      patch.dingtalk = {
        clientId: dtClientId || undefined,
        clientSecret: dtClientSecret || undefined,
        allowedUsers: dtUsers.length ? dtUsers : [],
        endpoint: dtEndpoint || undefined,
        permissionCardTemplateId: dtPermissionCardTemplateId || undefined,
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

  // Collect all paired users across platforms
  const allPairedUsers = [
    ...(config.telegram?.pairedUsers ?? []).map((u) => ({ ...u, platform: 'telegram' as const })),
    ...(config.feishu?.pairedUsers ?? []).map((u) => ({ ...u, platform: 'feishu' as const })),
    ...(config.wechat?.pairedUsers ?? []).map((u) => ({ ...u, platform: 'wechat' as const })),
    ...(config.dingtalk?.pairedUsers ?? []).map((u) => ({ ...u, platform: 'dingtalk' as const })),
    ...(config.whatsapp?.pairedUsers ?? []).map((u) => ({ ...u, platform: 'whatsapp' as const })),
  ]

  // Check pairing expiry
  const pairingExpiry = config.pairing?.expiresAt
  const isPairingActive = pairingExpiry ? Date.now() < pairingExpiry : false
  const minutesLeft = pairingExpiry ? Math.max(0, Math.ceil((pairingExpiry - Date.now()) / 60000)) : 0
  const hasSavedFeishuCredentials = Boolean(config.feishu?.appId && config.feishu?.appSecret)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-[var(--color-text-tertiary)]">
        <span className="material-symbols-outlined animate-spin text-[20px] mr-2">progress_activity</span>
        Loading...
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-8">
      {/* Description */}
      <div>
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
          {t('settings.adapters.description')}{' '}
          <a
            href={IM_CONFIG_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-[var(--color-brand)] transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
          >
            {t('settings.adapters.configurationDocs')}
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">open_in_new</span>
          </a>
          {t('settings.adapters.descriptionAfterDocs')}
        </p>
      </div>

      {/* Pairing */}
      <section className="rounded-xl border border-[var(--color-border)] overflow-hidden">
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
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--color-surface-hover)]"
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
                    <button
                      onClick={() => handleUnbind(user.platform, user.userId)}
                      className="text-xs text-[var(--color-error)] hover:underline cursor-pointer"
                    >
                      {t('settings.adapters.unbind')}
                    </button>
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
        <DirectoryPicker value={defaultProjectDir} onChange={setDefaultProjectDir} />
        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('settings.adapters.defaultProjectHint')}
        </p>
      </div>

      {/* IM Adapter Tabs */}
      <section className="rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div role="tablist" aria-label="IM adapter" className="flex items-stretch border-b border-[var(--color-border)] bg-[var(--color-surface-hover)]">
          <ImTabButton
            label={t('settings.adapters.telegram')}
            active={activeIm === 'telegram'}
            onClick={() => setActiveIm('telegram')}
          />
          <ImTabButton
            label={t('settings.adapters.feishu')}
            active={activeIm === 'feishu'}
            onClick={() => setActiveIm('feishu')}
          />
          <ImTabButton
            label={t('settings.adapters.wechat')}
            active={activeIm === 'wechat'}
            onClick={() => setActiveIm('wechat')}
          />
          <ImTabButton
            label={t('settings.adapters.dingtalk')}
            active={activeIm === 'dingtalk'}
            onClick={() => setActiveIm('dingtalk')}
          />
          <ImTabButton
            label={t('settings.adapters.whatsapp')}
            active={activeIm === 'whatsapp'}
            onClick={() => setActiveIm('whatsapp')}
          />
        </div>

        {activeIm === 'feishu' && (
          <div className="p-4 space-y-4">
            {!hasSavedFeishuCredentials && (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
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
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
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
                    className="h-40 w-40 rounded-lg border border-[var(--color-border)] bg-white object-contain p-2"
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
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
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
                      className="h-40 w-40 rounded-lg border border-[var(--color-border)] bg-white object-contain p-2"
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
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
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
                    className="h-40 w-40 rounded-lg border border-[var(--color-border)] bg-white object-contain p-2"
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
          if (isUnbindingWechatAccount || isUnbindingDtBot || isUnbindingWhatsAppAccount) return
          setPendingAdapterUnbind(null)
        }}
        onConfirm={pendingAdapterUnbind === 'wechatAccount'
          ? handleUnbindWechatAccount
          : pendingAdapterUnbind === 'whatsappAccount'
            ? handleUnbindWhatsAppAccount
            : handleUnbindDingtalkBot}
        title={pendingAdapterUnbind === 'wechatAccount'
          ? t('settings.adapters.wechatUnbindAccount')
          : pendingAdapterUnbind === 'whatsappAccount'
            ? t('settings.adapters.whatsappUnbindAccount')
            : t('settings.adapters.dingtalkUnbindBot')}
        body={pendingAdapterUnbind === 'wechatAccount'
          ? t('settings.adapters.wechatUnbindAccountConfirm')
          : pendingAdapterUnbind === 'whatsappAccount'
            ? t('settings.adapters.whatsappUnbindAccountConfirm')
            : t('settings.adapters.dingtalkUnbindBotConfirm')}
        confirmLabel={pendingAdapterUnbind === 'wechatAccount'
          ? t('settings.adapters.wechatUnbindAccount')
          : pendingAdapterUnbind === 'whatsappAccount'
            ? t('settings.adapters.whatsappUnbindAccount')
            : t('settings.adapters.dingtalkUnbindBot')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isUnbindingWechatAccount || isUnbindingDtBot || isUnbindingWhatsAppAccount}
      />
    </div>
  )
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
