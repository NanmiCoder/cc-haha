import { useState, useEffect } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type { UpdateProxyMode } from '../../types/settings'
import { MarkdownRenderer } from '../../components/markdown/MarkdownRenderer'
import { useUpdateStore } from '../../stores/updateStore'
import { formatBytes } from '../../lib/formatBytes'
import { getDesktopHost } from '../../lib/desktopHost'
import { publicAssetPath } from '../../lib/publicAsset'
import { BrandSeal } from '../../components/composite/BrandSeal'
import { isValidHttpProxyUrl } from '../settings/shared'

/**
 * The About panel: version, update channel and the project's links.
 *
 * Moved verbatim out of `Settings.tsx`. Its repo/social constants come along because
 * nothing else in that file referenced them; `isValidHttpProxyUrl` stayed in
 * `./shared`, since the General panel needs it too.
 */

const GITHUB_REPO = 'https://github.com/NanmiCoder/cc-haha'
const GITHUB_ISSUES = `${GITHUB_REPO}/issues`
const GITHUB_RELEASES = `${GITHUB_REPO}/releases`
const AUTHOR_GITHUB = 'https://github.com/NanmiCoder'
const SOCIAL_LINKS = [
  { name: 'Bilibili', icon: '/icons/bilibili.svg', url: 'https://space.bilibili.com/434377496', label: '程序员阿江-Relakkes' },
  { name: 'Douyin', icon: '/icons/douyin.svg', url: 'https://www.douyin.com/user/MS4wLjABAAAATJPY7LAlaa5X-c8uNdWkvz0jUGgpw4eeXIwu_8BhvqE', label: '程序员阿江-Relakkes' },
  { name: 'Xiaohongshu', icon: '/icons/xiaohongshu.svg', url: 'https://www.xiaohongshu.com/user/profile/5f58bd990000000001003753', label: '程序员阿江-Relakkes' },
] as const

export function AboutSettings() {
  const t = useTranslation()
  const [version, setVersion] = useState('')
  const updateProxy = useSettingsStore((s) => s.updateProxy)
  const setUpdateProxy = useSettingsStore((s) => s.setUpdateProxy)
  const updateStatus = useUpdateStore((s) => s.status)
  const availableVersion = useUpdateStore((s) => s.availableVersion)
  const releaseNotes = useUpdateStore((s) => s.releaseNotes)
  const progressPercent = useUpdateStore((s) => s.progressPercent)
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes)
  const totalBytes = useUpdateStore((s) => s.totalBytes)
  const error = useUpdateStore((s) => s.error)
  const checkedAt = useUpdateStore((s) => s.checkedAt)
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates)
  const installUpdate = useUpdateStore((s) => s.installUpdate)
  const initialize = useUpdateStore((s) => s.initialize)
  const [showUpdateProxyAdvanced, setShowUpdateProxyAdvanced] = useState(false)
  const [updateProxyDraft, setUpdateProxyDraft] = useState(updateProxy)
  const [updateProxySaveError, setUpdateProxySaveError] = useState<string | null>(null)
  const [isSavingUpdateProxy, setIsSavingUpdateProxy] = useState(false)

  useEffect(() => {
    let cancelled = false

    getDesktopHost().app.getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value)
      })
      .catch(() => {
        if (!cancelled) setVersion('')
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    setUpdateProxyDraft(updateProxy)
    setUpdateProxySaveError(null)
  }, [updateProxy])

  const openUrl = (url: string) => {
    void getDesktopHost().shell.open(url).catch(() => window.open(url, '_blank'))
  }

  const checkedAtText =
    checkedAt
      ? new Date(checkedAt).toLocaleString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          month: 'short',
          day: 'numeric',
        })
      : null
  const updateProxyModes: Array<{ value: UpdateProxyMode; label: string; description: string }> = [
    {
      value: 'system',
      label: t('update.proxyModeSystem'),
      description: t('update.proxyModeSystemDescription'),
    },
    {
      value: 'manual',
      label: t('update.proxyModeManual'),
      description: t('update.proxyModeManualDescription'),
    },
  ]
  const manualProxyUrl = updateProxyDraft.url.trim()
  const manualProxyError =
    updateProxyDraft.mode === 'manual' && !manualProxyUrl
      ? t('update.proxyUrlRequired')
      : updateProxyDraft.mode === 'manual' && !isValidHttpProxyUrl(manualProxyUrl)
        ? t('update.proxyUrlInvalid')
        : null
  const updateProxyDirty =
    updateProxyDraft.mode !== updateProxy.mode ||
    updateProxyDraft.url.trim() !== updateProxy.url.trim()

  const saveUpdateProxy = async () => {
    if (manualProxyError) {
      setUpdateProxySaveError(manualProxyError)
      return
    }

    setIsSavingUpdateProxy(true)
    setUpdateProxySaveError(null)
    try {
      await setUpdateProxy({
        mode: updateProxyDraft.mode,
        url: manualProxyUrl,
      })
    } catch (error) {
      setUpdateProxySaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingUpdateProxy(false)
    }
  }

  const hasKnownProgress = typeof totalBytes === 'number' && totalBytes > 0
  const downloadedText = formatBytes(downloadedBytes)
  const updateDescription = (() => {
    if (updateStatus === 'checking') return t('update.checking')
    if (error) return t('update.failed', { error })
    if (updateStatus === 'downloading') {
      return hasKnownProgress
        ? t('update.progress', { progress: String(progressPercent) })
        : t('update.progressBytes', { downloaded: downloadedText })
    }
    if (updateStatus === 'downloaded') return t('update.downloaded')
    if (updateStatus === 'installing') return t('update.installing')
    if (updateStatus === 'restarting') return t('update.restarting')
    if (updateStatus === 'available' && availableVersion) return t('update.newVersion', { version: availableVersion })
    if (updateStatus === 'up-to-date') return t('update.upToDate', { version: version || t('update.currentVersionUnknown') })
    return t('update.idle')
  })()

  return (
    <div className="w-full min-w-0 max-w-2xl mx-auto flex flex-col items-center py-6">
      {/* Logo + App Name + Version */}
      <BrandSeal size="xl" className="mb-4" />
      <h1 className="text-xl font-bold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>Claude Code Haha</h1>
      {version && (
        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          <span>{t('settings.about.version')} {version}</span>
          <span className="text-[var(--color-border)]">·</span>
          <Button variant="link" size="xs" onClick={() => openUrl(GITHUB_RELEASES)}>
            {t('settings.about.changelog')}
          </Button>
        </div>
      )}

      {/* GitHub Repo */}
      <div className="mt-6 w-full">
        <button
          onClick={() => openUrl(GITHUB_REPO)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
        >
          <img src={publicAssetPath('icons/github.svg')} alt="GitHub" className="w-5 h-5 opacity-70" />
          <div className="flex-1 text-left">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">NanmiCoder/cc-haha</div>
            <div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.about.starHint')}</div>
          </div>
        </button>
      </div>

      <Card radius="xl" surface="low" padding="none" className="mt-4 w-full p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.about.updates')}</div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1">
              {t('settings.about.updatesDesc')}
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void checkForUpdates()}
            loading={updateStatus === 'checking'}
          >
            {t('update.checkNow')}
          </Button>
        </div>

        <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                {t('settings.about.version')}
              </div>
              <div className="text-sm font-medium text-[var(--color-text-primary)] mt-1">
                {version || t('update.currentVersionUnknown')}
              </div>
            </div>

            {availableVersion && (
              <div className="text-right">
                <div className="text-xs uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                  {t('update.availableLabel')}
                </div>
                <div className="text-sm font-medium text-[var(--color-text-primary)] mt-1">
                  {availableVersion}
                </div>
              </div>
            )}
          </div>

          <p className={`mt-3 text-sm ${error ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]'}`}>
            {updateDescription}
          </p>

          {checkedAtText && (
            <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
              {t('update.checkedAt', { time: checkedAtText })}
            </p>
          )}

          <div className="mt-3 border-t border-[var(--color-border-separator)] pt-3">
            <button
              type="button"
              onClick={() => setShowUpdateProxyAdvanced((value) => !value)}
              className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] text-left text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              aria-expanded={showUpdateProxyAdvanced}
            >
              <span>{t('update.proxyAdvanced')}</span>
              <span className="material-symbols-outlined text-[18px]">
                {showUpdateProxyAdvanced ? 'expand_less' : 'expand_more'}
              </span>
            </button>

            {showUpdateProxyAdvanced && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {updateProxyModes.map((mode) => (
                    <button
                      key={mode.value}
                      type="button"
                      onClick={() => {
                        setUpdateProxyDraft((current) => ({ ...current, mode: mode.value }))
                        setUpdateProxySaveError(null)
                      }}
                      aria-pressed={updateProxyDraft.mode === mode.value}
                      className={`rounded-[var(--radius-lg)] border px-3 py-2 text-left transition-colors ${
                        updateProxyDraft.mode === mode.value
                          ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                          : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      <div className="text-xs font-semibold">{mode.label}</div>
                      <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                        {mode.description}
                      </div>
                    </button>
                  ))}
                </div>

                {updateProxyDraft.mode === 'manual' && (
                  <div>
                    <Input
                      id="update-proxy-url"
                      label={t('update.proxyUrl')}
                      value={updateProxyDraft.url}
                      placeholder="http://127.0.0.1:7890"
                      autoComplete="off"
                      onChange={(event) => {
                        setUpdateProxyDraft((current) => ({ ...current, url: event.target.value }))
                        setUpdateProxySaveError(null)
                      }}
                    />
                    <p className={`mt-1 text-[11px] leading-4 ${manualProxyError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}>
                      {manualProxyError ?? t('update.proxyUrlHint')}
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                    {t('update.proxyScopeHint')}
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-w-[72px] px-4 whitespace-nowrap"
                    disabled={!updateProxyDirty || !!manualProxyError || isSavingUpdateProxy}
                    loading={isSavingUpdateProxy}
                    onClick={() => void saveUpdateProxy()}
                  >
                    {t('update.proxySave')}
                  </Button>
                </div>

                {updateProxySaveError && (
                  <p className="text-[11px] leading-4 text-[var(--color-error)]">
                    {updateProxySaveError}
                  </p>
                )}
              </div>
            )}
          </div>

          {(updateStatus === 'downloading' || updateStatus === 'restarting') && (
            <div className="mt-3">
              <div className="h-1.5 bg-[var(--color-surface-container-low)] rounded-full overflow-hidden">
                {hasKnownProgress || updateStatus === 'restarting' ? (
                  <div
                    className="h-full bg-[var(--color-text-accent)] transition-all duration-300"
                    style={{ width: `${Math.min(progressPercent, 100)}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 rounded-full bg-[var(--color-text-accent)] animate-pulse" />
                )}
              </div>
              {!hasKnownProgress && updateStatus === 'downloading' && downloadedBytes > 0 && (
                <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                  {downloadedText}
                </p>
              )}
            </div>
          )}

          {releaseNotes && availableVersion && (
            <div className="mt-3 rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] px-3 py-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                {t('update.releaseNotes')}
              </div>
              <MarkdownRenderer
                content={releaseNotes}
                variant="document"
                className="mt-2 text-[13px] leading-6 text-[var(--color-text-secondary)] [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_p]:text-[13px] [&_p]:leading-6"
              />
            </div>
          )}

          {availableVersion && (
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                onClick={() => void installUpdate()}
                loading={updateStatus === 'downloading' || updateStatus === 'installing' || updateStatus === 'restarting'}
                disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
              >
                {updateStatus === 'downloaded'
                  ? t('update.installAndRestart')
                  : updateStatus === 'installing'
                    ? t('update.installing')
                    : updateStatus === 'restarting'
                      ? t('update.restarting')
                      : t('update.now')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Divider */}
      <div className="w-full border-t border-[var(--color-border-separator)] my-6" />

      {/* Author */}
      <div className="w-full">
        <h3 className="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">{t('settings.about.author')}</h3>
        <button
          onClick={() => openUrl(AUTHOR_GITHUB)}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-[var(--radius-lg)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
        >
          <img src={publicAssetPath('icons/github.svg')} alt="GitHub" className="w-4 h-4 opacity-60" />
          <span className="text-sm text-[var(--color-text-primary)]">程序员阿江-Relakkes</span>
          <span className="text-xs text-[var(--color-text-tertiary)] ml-auto">GitHub</span>
        </button>
      </div>

      {/* Social Media */}
      <div className="w-full mt-4">
        <h3 className="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">{t('settings.about.socialMedia')}</h3>
        <div className="flex flex-col gap-0.5">
          {SOCIAL_LINKS.map((link) => (
            <button
              key={link.name}
              onClick={() => openUrl(link.url)}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-[var(--radius-lg)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
            >
              <img src={publicAssetPath(link.icon)} alt={link.name} className="w-4 h-4 opacity-60" />
              <span className="text-sm text-[var(--color-text-primary)]">{link.label}</span>
              <span className="text-xs text-[var(--color-text-tertiary)] ml-auto">{link.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 w-full">
        <button
          onClick={() => openUrl(GITHUB_ISSUES)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[20px] text-[var(--color-text-tertiary)]">feedback</span>
          <div className="flex-1 text-left">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.about.feedback')}</div>
            <div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.about.feedbackDesc')}</div>
          </div>
        </button>
      </div>
    </div>
  )
}
