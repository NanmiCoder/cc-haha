import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download } from 'lucide-react'

import type { ActivityStatsResponse } from '../../api/activityStats'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Modal } from '@/components/ui/Modal'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation, type Locale, type TranslationKey } from '../../i18n'
import { THEME_MODES, type ThemeMode } from '../../types/settings'
import { buildShareImageData } from './shareImage/data'
import { SHARE_SIZES, type ShareOptions, type ShareSize } from './shareImage/layout'
import { canvasToPngBlob } from './shareImage/paint'
import { loadShareAssets, renderShareImage, type ShareAssets } from './shareImage/render'
import { resolveShareTheme, type ShareThemeChoice } from './shareImage/theme'
import type { DailyModelSeries, RankedModel } from './usageModel'

const THEME_LABEL_KEYS: Record<ThemeMode, TranslationKey> = {
  white: 'settings.general.appearance.white',
  paper: 'settings.general.appearance.paper',
  'warm-classic': 'settings.general.appearance.warmClassic',
  celadon: 'settings.general.appearance.celadon',
  dark: 'settings.general.appearance.dark',
  'ink-blue': 'settings.general.appearance.inkBlue',
}

type Props = {
  open: boolean
  onClose: () => void
  stats: ActivityStatsResponse
  models: RankedModel[]
  daily: DailyModelSeries[]
  totalTokens: number
  locale: Locale
  profile: { displayName: string; subtitle: string }
  /** Where a custom avatar can be fetched from; null when the profile uses the app icon. */
  avatarUrl: string | null
}

const DEFAULT_OPTIONS: ShareOptions = {
  size: 'portrait',
  showIdentity: true,
  showModels: true,
  showLink: true,
  // A dollar figure in a picture that gets posted is something to opt into.
  showCost: false,
}

function downloadName(now: Date) {
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `cc-haha-token-usage-${now.getFullYear()}${month}${day}.png`
}

export function ShareImageDialog({ open, onClose, stats, models, daily, totalTokens, locale, profile, avatarUrl }: Props) {
  const t = useTranslation()
  const [options, setOptions] = useState<ShareOptions>(DEFAULT_OPTIONS)
  const [themeChoice, setThemeChoice] = useState<ShareThemeChoice>('current')
  const [assets, setAssets] = useState<ShareAssets | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [renderError, setRenderError] = useState(false)
  // True from the moment the inputs change until the matching image exists: the old preview may stay on
  // screen meanwhile, but it must not be what Save or Copy hands out.
  const [pending, setPending] = useState(true)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const blobRef = useRef<Blob | null>(null)

  const data = useMemo(
    () => buildShareImageData({ stats, models, daily, totalTokens, locale, t, profile, now: new Date() }),
    [stats, models, daily, totalTokens, locale, t, profile],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let loaded: ShareAssets | null = null
    void loadShareAssets(avatarUrl).then((next) => {
      if (cancelled) {
        next.dispose()
        return
      }
      loaded = next
      setAssets(next)
    })
    return () => {
      cancelled = true
      loaded?.dispose()
      setAssets(null)
    }
  }, [open, avatarUrl])

  useEffect(() => {
    // A closed dialog keeps nothing: its preview URL was revoked on the way out, so reopening on it shows a broken image.
    if (open) return
    blobRef.current = null
    setPreviewUrl(null)
    setRenderError(false)
    setPending(true)
  }, [open])

  useEffect(() => {
    if (!open || !assets) return
    let cancelled = false
    let url: string | null = null
    blobRef.current = null
    setPending(true)
    setRenderError(false)
    void (async () => {
      try {
        const theme = resolveShareTheme(themeChoice)
        const { canvas } = await renderShareImage({ data, theme, options, assets })
        const blob = await canvasToPngBlob(canvas)
        if (cancelled) return
        blobRef.current = blob
        url = URL.createObjectURL(blob)
        setPreviewUrl(url)
        setPending(false)
      } catch {
        if (cancelled) return
        setRenderError(true)
        setPending(false)
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [open, assets, data, options, themeChoice])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 2500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const setOption = <K extends keyof ShareOptions>(key: K, value: ShareOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }))
  }

  const copy = async () => {
    const blob = blobRef.current
    if (!blob) return
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setNotice({ kind: 'ok', text: t('settings.activity.share.copied') })
    } catch {
      setNotice({ kind: 'error', text: t('settings.activity.share.copyFailed') })
    }
  }

  const save = () => {
    const blob = blobRef.current
    if (!blob) return
    try {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = downloadName(new Date())
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setNotice({ kind: 'error', text: t('settings.activity.share.saveFailed') })
    }
  }

  const { width, height } = SHARE_SIZES[options.size]
  const sizeItems: Array<{ value: ShareSize; label: string }> = [
    { value: 'portrait', label: t('settings.activity.share.size.portrait') },
    { value: 'square', label: t('settings.activity.share.size.square') },
    { value: 'wide', label: t('settings.activity.share.size.wide') },
  ]
  const themeOptions = [
    { value: 'current' as ShareThemeChoice, label: t('settings.activity.share.theme.current') },
    ...THEME_MODES.map((mode) => ({ value: mode as ShareThemeChoice, label: t(THEME_LABEL_KEYS[mode]) })),
  ]
  const ready = Boolean(previewUrl) && !pending && !renderError

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('settings.activity.share.title')}
      width={820}
      typography="interface"
      footer={
        <>
          {notice ? (
            <span
              role="status"
              className={notice.kind === 'ok' ? 'mr-auto text-xs text-[var(--color-success)]' : 'mr-auto text-xs text-[var(--color-error)]'}
            >
              {notice.text}
            </span>
          ) : null}
          <Button variant="secondary" size="base" onClick={copy} disabled={!ready} icon={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}>
            {t('settings.activity.share.copy')}
          </Button>
          <Button variant="primary" size="base" onClick={save} disabled={!ready} icon={<Download size={14} strokeWidth={1.75} aria-hidden="true" />}>
            {t('settings.activity.share.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-6">
        <div className="flex min-h-[320px] min-w-0 flex-[1_1_320px] items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] p-5">
          {renderError ? (
            <p role="alert" className="text-xs text-[var(--color-error)]">{t('settings.activity.share.renderFailed')}</p>
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt={t('settings.activity.share.previewAlt')}
              className="max-h-[420px] max-w-full rounded-[var(--radius-xs)] shadow-[var(--shadow-card)]"
              style={{ aspectRatio: `${width} / ${height}` }}
            />
          ) : (
            <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.share.rendering')}</p>
          )}
        </div>

        <div className="flex w-full flex-col gap-5 sm:w-[240px]">
          <div>
            <div className="mb-2 text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.share.size')}</div>
            <SegmentedControl
              size="sm"
              layout="fill"
              label={t('settings.activity.share.size')}
              value={options.size}
              onChange={(size) => setOption('size', size)}
              items={sizeItems}
            />
            <div className="mt-1.5 font-mono text-[11px] text-[var(--color-text-tertiary)]">{width} × {height}</div>
          </div>

          <SelectField
            label={t('settings.activity.share.theme')}
            value={themeChoice}
            options={themeOptions}
            onChange={setThemeChoice}
          />

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 p-0 text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.share.show')}</legend>
            <div className="flex flex-col gap-2.5">
              <Checkbox label={t('settings.activity.share.show.identity')} checked={options.showIdentity} onChange={(event) => setOption('showIdentity', event.target.checked)} />
              <Checkbox label={t('settings.activity.share.show.models')} checked={options.showModels} onChange={(event) => setOption('showModels', event.target.checked)} />
              <Checkbox label={t('settings.activity.share.show.link')} checked={options.showLink} onChange={(event) => setOption('showLink', event.target.checked)} />
              <Checkbox
                label={t('settings.activity.share.show.cost')}
                description={t('settings.activity.share.show.costHint')}
                checked={options.showCost}
                onChange={(event) => setOption('showCost', event.target.checked)}
              />
            </div>
          </fieldset>
        </div>
      </div>
    </Modal>
  )
}
