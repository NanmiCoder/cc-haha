import { PublicAccessSettings } from './PublicAccessSettings'
import { useState, useEffect, useMemo } from 'react'
import QRCode from 'qrcode'
import { Copy, Eye, EyeOff, PowerOff, QrCode, RotateCw } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Switch } from '@/components/ui/Switch'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { useUIStore } from '../../stores/uiStore'
import { isBrowserSafePort } from '../../lib/browserSafePort'
import { copyTextToClipboard } from '@/lib/clipboard'

/**
 * The H5 access panel: the settings tab that exposes the desktop app's built-in
 * server to a phone on the same network.
 *
 * Moved verbatim out of `Settings.tsx`, which had grown to 4639 lines holding seven
 * unrelated panels. This one comes out first because it is provably self-contained:
 * the eight URL/port helpers below have no other caller in that file, and the panel
 * shares no helper with any other panel — so relocating it cannot change behavior.
 */

function buildH5LaunchUrl(baseUrl: string | null, token: string | null): string | null {
  if (!baseUrl) return null

  try {
    const url = new URL(baseUrl)
    if (token) {
      url.searchParams.set('serverUrl', baseUrl)
      url.searchParams.set('h5Token', token)
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return token
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}serverUrl=${encodeURIComponent(baseUrl)}&h5Token=${encodeURIComponent(token)}`
      : baseUrl
  }
}

function isLanH5BaseUrl(url: URL): boolean {
  return url.protocol === 'http:' &&
    !!url.port &&
    (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.startsWith('10.') ||
      url.hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname) ||
      url.hostname.startsWith('169.254.')
    )
}

function extractH5AccessAddressDraft(baseUrl: string | null): string {
  if (!baseUrl) return ''

  try {
    const url = new URL(baseUrl)
    return isLanH5BaseUrl(url) ? url.hostname : baseUrl
  } catch {
    return baseUrl
  }
}

function extractHostnameFromUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname || null
  } catch {
    return null
  }
}

function extractH5AccessPort(baseUrl: string | null): string | null {
  if (!baseUrl) return null

  try {
    const url = new URL(baseUrl)
    return url.port || null
  } catch {
    return null
  }
}

// Mirrors the server-side fixedPort range (h5AccessService MIN/MAX_FIXED_PORT).
function parseH5FixedPortDraft(draft: string): number | null | 'invalid' {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (!/^\d{1,5}$/.test(trimmed)) return 'invalid'
  const port = Number(trimmed)
  return port >= 1024 && port <= 65535 && isBrowserSafePort(port) ? port : 'invalid'
}

// Mirrors the server-side disconnect grace range (h5AccessService
// MIN/MAX_DISCONNECT_GRACE_SECONDS). Empty = use the built-in 30s default.
function parseH5GraceDraft(draft: string): number | null | 'invalid' {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (!/^\d{1,5}$/.test(trimmed)) return 'invalid'
  const seconds = Number(trimmed)
  return seconds >= 5 && seconds <= 86400 ? seconds : 'invalid'
}

function buildH5PublicBaseUrlFromHostDraft(draft: string, currentBaseUrl: string | null): string | null {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed

  try {
    const current = currentBaseUrl ? new URL(currentBaseUrl) : null
    if (!current) return trimmed

    const port = current.port ? `:${current.port}` : ''
    const path = current.pathname === '/' ? '' : current.pathname.replace(/\/+$/, '')
    return `${current.protocol}//${trimmed}${port}${path}`
  } catch {
    return trimmed
  }
}

export function H5AccessSettings() {
  const {
    h5Access,
    h5AccessDiagnostics,
    h5AccessError,
    enableH5Access,
    disableH5Access,
    regenerateH5AccessToken,
    updateH5AccessSettings,
  } = useSettingsStore()
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const [h5PublicBaseUrlDraft, setH5PublicBaseUrlDraft] = useState(extractH5AccessAddressDraft(h5Access.publicBaseUrl))
  const [h5FixedPortDraft, setH5FixedPortDraft] = useState(h5Access.fixedPort != null ? String(h5Access.fixedPort) : '')
  const [h5GraceDraft, setH5GraceDraft] = useState(h5Access.disconnectGraceSeconds != null ? String(h5Access.disconnectGraceSeconds) : '')
  const [h5TokenVisible, setH5TokenVisible] = useState(false)
  const [h5EnableConfirmOpen, setH5EnableConfirmOpen] = useState(false)
  const [h5QrDataUrl, setH5QrDataUrl] = useState<string | null>(null)
  const [h5ActionRunning, setH5ActionRunning] = useState(false)
  const h5AccessUrl = h5Access.publicBaseUrl
  // The token is persisted server-side, so the QR code and copy actions stay
  // available across desktop restarts (issue #767).
  const h5Token = h5Access.token
  const h5LaunchUrl = useMemo(
    () => buildH5LaunchUrl(h5AccessUrl, h5Token),
    [h5AccessUrl, h5Token],
  )
  const h5ActivePort = h5AccessDiagnostics?.activePort != null
    ? String(h5AccessDiagnostics.activePort)
    : extractH5AccessPort(h5AccessUrl)
  const h5NextPublicBaseUrl = buildH5PublicBaseUrlFromHostDraft(h5PublicBaseUrlDraft, h5Access.publicBaseUrl)
  const h5NextFixedPort = parseH5FixedPortDraft(h5FixedPortDraft)
  const h5FixedPortInvalid = h5NextFixedPort === 'invalid'
  const h5NextGrace = parseH5GraceDraft(h5GraceDraft)
  const h5GraceInvalid = h5NextGrace === 'invalid'
  const h5AccessDirty = h5NextPublicBaseUrl !== (h5Access.publicBaseUrl ?? null) ||
    (!h5FixedPortInvalid && h5NextFixedPort !== h5Access.fixedPort) ||
    (!h5GraceInvalid && h5NextGrace !== h5Access.disconnectGraceSeconds)
  const h5FixedPortPendingRestart = h5Access.fixedPort != null &&
    h5ActivePort != null &&
    String(h5Access.fixedPort) !== h5ActivePort

  useEffect(() => {
    setH5PublicBaseUrlDraft(extractH5AccessAddressDraft(h5Access.publicBaseUrl))
    setH5FixedPortDraft(h5Access.fixedPort != null ? String(h5Access.fixedPort) : '')
    setH5GraceDraft(h5Access.disconnectGraceSeconds != null ? String(h5Access.disconnectGraceSeconds) : '')
  }, [h5Access])

  useEffect(() => {
    let cancelled = false
    if (!h5Access.enabled || !h5LaunchUrl || !h5Token) {
      setH5QrDataUrl(null)
      return () => {
        cancelled = true
      }
    }

    QRCode.toDataURL(h5LaunchUrl, { margin: 1, width: 192 })
      .then((dataUrl) => {
        if (!cancelled) setH5QrDataUrl(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setH5QrDataUrl(null)
      })

    return () => {
      cancelled = true
    }
  }, [h5Access.enabled, h5LaunchUrl, h5Token])

  const runH5Action = async (action: () => Promise<void>) => {
    setH5ActionRunning(true)
    try {
      await action()
    } catch {
      // The store owns H5-specific error state.
    } finally {
      setH5ActionRunning(false)
    }
  }

  const handleH5SettingsSave = async () => {
    if (h5FixedPortInvalid || h5GraceInvalid) return
    await runH5Action(async () => {
      await updateH5AccessSettings({
        publicBaseUrl: h5NextPublicBaseUrl,
        fixedPort: h5NextFixedPort,
        disconnectGraceSeconds: h5NextGrace,
      })
    })
  }

  const handleH5SwitchToSuggestedHost = async () => {
    const suggested = h5AccessDiagnostics?.suggestedHost
    if (!suggested) return
    await runH5Action(async () => {
      // Build URL using current port if available, otherwise let backend pick.
      const port = extractH5AccessPort(h5Access.publicBaseUrl)
      const nextUrl = port ? `http://${suggested}:${port}` : `http://${suggested}`
      await updateH5AccessSettings({ publicBaseUrl: nextUrl })
    })
  }

  const handleH5UrlCopy = async () => {
    if (!h5AccessUrl) return
    const copied = await copyTextToClipboard(h5AccessUrl)
    addToast({
      type: copied ? 'success' : 'error',
      message: copied ? t('settings.general.h5AccessUrlCopied') : t('common.copyFailed'),
    })
  }

  const handleH5LaunchUrlCopy = async () => {
    if (!h5LaunchUrl) return
    const copied = await copyTextToClipboard(h5LaunchUrl)
    addToast({
      type: copied ? 'success' : 'error',
      message: copied ? t('settings.general.h5AccessLaunchUrlCopied') : t('common.copyFailed'),
    })
  }

  const handleH5EnableConfirm = async () => {
    await runH5Action(async () => {
      await enableH5Access()
      setH5TokenVisible(false)
      setH5EnableConfirmOpen(false)
    })
  }

  const handleH5Disable = async () => {
    await runH5Action(async () => {
      await disableH5Access()
      setH5TokenVisible(false)
    })
  }

  const handleH5Regenerate = async () => {
    await runH5Action(async () => {
      await regenerateH5AccessToken()
      setH5TokenVisible(false)
    })
  }

  return (
    <div className="w-full min-w-0">
      <section aria-labelledby="h5-access-title" role="region">
        <SettingsPageHeader
          titleId="h5-access-title"
          title={t('settings.tab.h5Access')}
          description={t('settings.general.h5AccessDescription')}
        />

        <SettingsGroup className="mt-7">
          <SettingsRow
            layout="inline"
            title={t('settings.general.h5AccessEnabled')}
            description={t('settings.general.h5AccessEnabledHint')}
          >
            <Badge tone={h5Access.enabled ? 'success' : 'neutral'} size="sm">
              {h5Access.enabled ? t('settings.general.h5AccessStatusEnabled') : t('settings.general.h5AccessDisabledValue')}
            </Badge>
            <Switch
              label={t('settings.general.h5AccessEnabled')}
              labelHidden
              checked={h5Access.enabled}
              disabled={h5ActionRunning}
              onChange={(checked) => {
                if (checked) {
                  setH5EnableConfirmOpen(true)
                } else {
                  void handleH5Disable()
                }
              }}
            />
          </SettingsRow>

          {h5AccessDiagnostics?.storedHostStaleness === 'unreachable' && h5AccessDiagnostics.storedPublicBaseUrl ? (
            <SettingsBlock>
              <div
                data-testid="h5-access-stale-host-banner"
                className="rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-3 text-xs leading-[1.5] text-[var(--color-on-warning-container)]"
              >
                <div className="font-semibold">
                  {t('settings.general.h5AccessStaleHostTitle')}
                </div>
                <div className="mt-1">
                  {h5AccessDiagnostics.suggestedHost
                    ? t('settings.general.h5AccessStaleHostBody', {
                        storedHost: extractHostnameFromUrl(h5AccessDiagnostics.storedPublicBaseUrl) ?? h5AccessDiagnostics.storedPublicBaseUrl,
                      })
                    : t('settings.general.h5AccessStaleHostNoSuggestion', {
                        storedHost: extractHostnameFromUrl(h5AccessDiagnostics.storedPublicBaseUrl) ?? h5AccessDiagnostics.storedPublicBaseUrl,
                      })}
                </div>
                {h5AccessDiagnostics.suggestedHost && (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="primary"
                      loading={h5ActionRunning}
                      onClick={() => void handleH5SwitchToSuggestedHost()}
                      data-testid="h5-access-stale-host-apply"
                    >
                      {t('settings.general.h5AccessStaleHostApply', {
                        suggestedHost: h5AccessDiagnostics.suggestedHost,
                      })}
                    </Button>
                  </div>
                )}
              </div>
            </SettingsBlock>
          ) : null}

          {h5AccessDiagnostics?.storedHostStaleness === 'proxy' ? (
            <SettingsBlock>
              <p
                data-testid="h5-access-proxy-note"
                className="text-xs leading-[1.5] text-[var(--color-text-tertiary)]"
              >
                {t('settings.general.h5AccessProxyNote')}
              </p>
            </SettingsBlock>
          ) : null}
        </SettingsGroup>

        <SettingsSection title={t('settings.general.h5AccessUrl')} description={t('settings.general.h5AccessOpenHint')}>
          <SettingsGroup>
            <SettingsRow title={t('settings.general.h5AccessPublicHost')} htmlFor="h5-access-public-url">
              <Input
                id="h5-access-public-url"
                size="md"
                containerClassName="w-full sm:w-[260px]"
                className="font-mono text-xs"
                value={h5PublicBaseUrlDraft}
                placeholder={t('settings.general.h5AccessPublicHostPlaceholder')}
                onChange={(event) => setH5PublicBaseUrlDraft(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow
              title={t('settings.general.h5AccessFixedPort')}
              htmlFor="h5-access-fixed-port"
              description={t('settings.general.h5AccessFixedPortHint')}
            >
              <Input
                id="h5-access-fixed-port"
                size="md"
                containerClassName="w-full sm:w-[140px]"
                className="font-mono text-xs tabular-nums"
                value={h5FixedPortDraft}
                placeholder={t('settings.general.h5AccessFixedPortPlaceholder')}
                inputMode="numeric"
                error={h5FixedPortInvalid ? t('settings.general.h5AccessFixedPortInvalid') : undefined}
                onChange={(event) => setH5FixedPortDraft(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow title={t('settings.general.h5AccessCurrentPort')} htmlFor="h5-access-current-port">
              <Input
                id="h5-access-current-port"
                size="md"
                containerClassName="w-full sm:w-[140px]"
                value={h5ActivePort ?? t('settings.general.h5AccessCurrentPortUnknown')}
                readOnly
                className="font-mono text-xs tabular-nums text-[var(--color-text-tertiary)]"
              />
            </SettingsRow>
            <SettingsRow
              title={t('settings.general.h5AccessDisconnectGrace')}
              htmlFor="h5-access-disconnect-grace"
              description={t('settings.general.h5AccessDisconnectGraceHint')}
            >
              <Input
                id="h5-access-disconnect-grace"
                size="md"
                containerClassName="w-full sm:w-[140px]"
                className="font-mono text-xs tabular-nums"
                value={h5GraceDraft}
                placeholder={t('settings.general.h5AccessDisconnectGracePlaceholder')}
                inputMode="numeric"
                error={h5GraceInvalid ? t('settings.general.h5AccessDisconnectGraceInvalid') : undefined}
                onChange={(event) => setH5GraceDraft(event.target.value)}
              />
            </SettingsRow>
            {h5FixedPortPendingRestart && (
              <SettingsBlock>
                <div
                  data-testid="h5-access-fixed-port-restart-note"
                  className="rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-[1.5] text-[var(--color-on-warning-container)]"
                >
                  {t('settings.general.h5AccessFixedPortRestartNote', {
                    fixedPort: String(h5Access.fixedPort),
                    activePort: h5ActivePort ?? '',
                  })}
                </div>
              </SettingsBlock>
            )}
            {h5AccessUrl && (
              <SettingsBlock>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1 break-all rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs leading-5 text-[var(--color-text-primary)]">
                    {h5AccessUrl}
                  </div>
                  <Button
                    size="base"
                    variant="secondary"
                    className="shrink-0"
                    icon={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
                    aria-label={t('settings.general.h5AccessCopyUrl')}
                    onClick={() => void handleH5UrlCopy()}
                  >
                    {t('settings.general.h5AccessCopy')}
                  </Button>
                </div>
              </SettingsBlock>
            )}
            <SettingsBlock className="flex justify-end">
              <Button
                size="base"
                variant="secondary"
                className="whitespace-nowrap"
                onClick={() => void handleH5SettingsSave()}
                disabled={!h5AccessDirty || h5FixedPortInvalid || h5GraceInvalid || h5ActionRunning}
                aria-label={t('settings.general.h5AccessSave')}
              >
                {t('settings.general.h5AccessSave')}
              </Button>
            </SettingsBlock>
          </SettingsGroup>
        </SettingsSection>

        {h5Access.enabled && (
          <SettingsSection title={t('settings.general.h5AccessQrTitle')}>
            <SettingsGroup>
              {h5AccessUrl && (
                <SettingsBlock className="flex flex-col gap-4 py-4 sm:flex-row">
                  {/* A white box on purpose, in every theme: scanners need the
                      contrast, so its placeholder text uses stock neutrals that
                      stay dark under `data-theme="dark"` too. */}
                  <div className="flex h-44 w-44 shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-3">
                    {h5QrDataUrl ? (
                      <img
                        src={h5QrDataUrl}
                        alt={t('settings.general.h5AccessQrAlt')}
                        className="h-full w-full"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-3 px-4 text-center">
                        <QrCode size={40} strokeWidth={1.5} className="text-neutral-400" aria-hidden="true" />
                        <p className="text-xs leading-5 text-neutral-500">
                          {t('settings.general.h5AccessQrEmptyHint')}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                      {h5Token
                        ? t('settings.general.h5AccessQrHint')
                        : t('settings.general.h5AccessQrRefreshHint')}
                    </p>
                    {h5LaunchUrl && (
                      <div className="mt-3 break-all rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs leading-5 text-[var(--color-text-primary)]">
                        {h5LaunchUrl}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="base"
                        variant="secondary"
                        icon={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
                        disabled={!h5LaunchUrl || !h5Token}
                        onClick={() => void handleH5LaunchUrlCopy()}
                      >
                        {t('settings.general.h5AccessCopyLaunchUrl')}
                      </Button>
                      <Button
                        size="base"
                        variant={h5Token ? 'secondary' : 'primary'}
                        icon={<RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />}
                        loading={h5ActionRunning}
                        onClick={() => void handleH5Regenerate()}
                      >
                        {h5Token ? t('settings.general.h5AccessRegenerate') : t('settings.general.h5AccessGenerateToken')}
                      </Button>
                    </div>
                  </div>
                </SettingsBlock>
              )}

              <SettingsRow
                title={t('settings.general.h5AccessTokenPreview')}
                description={(
                  <span className="break-all font-mono text-xs text-[var(--color-text-primary)]">
                    {h5TokenVisible && h5Token
                      ? h5Token
                      : h5Access.tokenPreview || t('settings.general.h5AccessTokenNotAvailable')}
                  </span>
                )}
              >
                <Button
                  size="base"
                  variant="secondary"
                  icon={h5TokenVisible
                    ? <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" />
                    : <Eye size={14} strokeWidth={1.75} aria-hidden="true" />}
                  disabled={!h5Token}
                  onClick={() => setH5TokenVisible((visible) => !visible)}
                >
                  {h5TokenVisible ? t('settings.general.h5AccessHideToken') : t('settings.general.h5AccessShowToken')}
                </Button>
                <Button
                  size="base"
                  variant="danger-ghost"
                  icon={<PowerOff size={14} strokeWidth={1.75} aria-hidden="true" />}
                  loading={h5ActionRunning}
                  onClick={() => void handleH5Disable()}
                >
                  {t('settings.general.h5AccessDisable')}
                </Button>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
        )}

        <p className="mt-3 px-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
          {t('settings.general.h5AccessSafetyNote')}
        </p>
        {h5AccessError && (
          <p className="mt-2 px-0.5 text-xs text-[var(--color-error)]">
            {h5AccessError}
          </p>
        )}
      </section>

      <PublicAccessSettings />

      <ConfirmDialog
        open={h5EnableConfirmOpen}
        onClose={() => {
          if (!h5ActionRunning) setH5EnableConfirmOpen(false)
        }}
        onConfirm={handleH5EnableConfirm}
        title={t('settings.general.h5AccessConfirmTitle')}
        body={t('settings.general.h5AccessConfirmBody')}
        confirmLabel={t('settings.general.h5AccessConfirmEnable')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={h5ActionRunning}
      />
    </div>
  )
}
