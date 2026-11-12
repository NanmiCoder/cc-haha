import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { FolderOpen, ImagePlus, RefreshCw, Trash2, Video } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { videoWallpaperUrl, webWallpaperUrl } from '../../lib/dynamicWallpaper'
import { WALLPAPER_ACCEPT } from '../../lib/wallpaper'
import { useDynamicWallpaperStore } from '../../stores/dynamicWallpaperStore'
import { useWallpaperStore } from '../../stores/wallpaperStore'

const DEBOUNCE_MS = 250
/** The preview keeps the window's shape; cap how tall that can get. */
const PREVIEW_MAX_HEIGHT = 400

type WallpaperNumbers = { blur: number; panelOpacity: number; zoom: number }
type Focus = { focusX: number; focusY: number }
type DragState = Focus & { pointerId: number; startX: number; startY: number }
type WallpaperType = 'image' | 'video' | 'web'

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function windowAspectRatio(): number {
  if (typeof window === 'undefined') return 16 / 10
  return window.innerWidth / Math.max(1, window.innerHeight)
}

export function WallpaperSettings() {
  const t = useTranslation()
  const preferences = useWallpaperStore((state) => state.preferences)
  const objectUrl = useWallpaperStore((state) => state.objectUrl)
  const loading = useWallpaperStore((state) => state.loading)
  const error = useWallpaperStore((state) => state.error)
  const setOption = useWallpaperStore((state) => state.setOption)
  const upload = useWallpaperStore((state) => state.upload)
  const remove = useWallpaperStore((state) => state.remove)

  const dynamicSupported = getDesktopHost().capabilities.dynamicWallpaper === true
  const dynamicStatus = useDynamicWallpaperStore((state) => state.status)
  const dynamicLoading = useDynamicWallpaperStore((state) => state.loading)
  const dynamicError = useDynamicWallpaperStore((state) => state.error)
  const updateDynamic = useDynamicWallpaperStore((state) => state.update)
  const pickVideo = useDynamicWallpaperStore((state) => state.pickVideo)
  const pickWeb = useDynamicWallpaperStore((state) => state.pickWeb)
  const clearDynamicSource = useDynamicWallpaperStore((state) => state.clearSource)
  const reloadDynamic = useDynamicWallpaperStore((state) => state.reload)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [aspectRatio, setAspectRatio] = useState(windowAspectRatio)
  const [dragFocus, setDragFocus] = useState<Focus | null>(null)

  const kind: WallpaperType = dynamicSupported ? dynamicStatus.preferences.kind : 'image'
  const isImage = kind === 'image'
  const isVideo = kind === 'video'
  const isWeb = kind === 'web'
  const activePreferences = isImage ? preferences : dynamicStatus.preferences
  const activeLoading = isImage ? loading : dynamicLoading
  const [draft, setDraft] = useState<WallpaperNumbers>({
    blur: activePreferences.blur,
    panelOpacity: activePreferences.panelOpacity,
    zoom: activePreferences.zoom,
  })

  useEffect(() => {
    setDraft({
      blur: activePreferences.blur,
      panelOpacity: activePreferences.panelOpacity,
      zoom: activePreferences.zoom,
    })
  }, [activePreferences.blur, activePreferences.panelOpacity, activePreferences.zoom, kind])

  useEffect(() => {
    const update = () => setAspectRatio(windowAspectRatio())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  const hasImage = preferences.file !== null
  const hasDynamicSource = isVideo
    ? dynamicStatus.preferences.videoPath !== null && dynamicStatus.unavailable !== 'video-missing'
    : isWeb
      ? dynamicStatus.preferences.webDir !== null && dynamicStatus.unavailable !== 'web-missing'
      : false
  const hasSource = isImage ? hasImage : hasDynamicSource
  const controlsDisabled = !hasSource || activeLoading

  function saveNumbers(next: WallpaperNumbers) {
    if (isImage) void setOption(next)
    else void updateDynamic(next)
  }

  function saveFocus(next: Focus) {
    if (isImage) void setOption(next)
    else void updateDynamic(next)
  }

  function updateNumber(field: keyof WallpaperNumbers, value: number) {
    const next = { ...draft, [field]: value }
    setDraft(next)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      saveNumbers(next)
    }, DEBOUNCE_MS)
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    await upload(file)
  }

  function dragFocusAt(
    drag: DragState,
    rect: DOMRect,
    clientX: number,
    clientY: number,
  ): Focus {
    // The image follows the pointer: dragging right shows the part on the left.
    // Dividing by the magnification keeps the movement under the cursor at any zoom.
    const zoom = Math.max(1, activePreferences.zoom / 100)
    return {
      focusX: clampPercent(
        Math.round(drag.focusX - ((clientX - drag.startX) / rect.width) * (100 / zoom)),
      ),
      focusY: clampPercent(
        Math.round(drag.focusY - ((clientY - drag.startY) / rect.height) * (100 / zoom)),
      ),
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (controlsDisabled) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      focusX: activePreferences.focusX,
      focusY: activePreferences.focusY,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragFocus({ focusX: activePreferences.focusX, focusY: activePreferences.focusY })
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    setDragFocus(dragFocusAt(drag, rect, event.clientX, event.clientY))
  }

  function handlePointerEnd(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const rect = event.currentTarget.getBoundingClientRect()
    const next = rect.width > 0 && rect.height > 0
      ? dragFocusAt(drag, rect, event.clientX, event.clientY)
      : null
    setDragFocus(null)
    if (next && (next.focusX !== activePreferences.focusX || next.focusY !== activePreferences.focusY)) {
      saveFocus(next)
    }
  }

  function handleFocusKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 10 : 5
    let deltaX = 0
    let deltaY = 0
    if (event.key === 'ArrowLeft') deltaX = -step
    else if (event.key === 'ArrowRight') deltaX = step
    else if (event.key === 'ArrowUp') deltaY = -step
    else if (event.key === 'ArrowDown') deltaY = step
    else return
    event.preventDefault()
    saveFocus({
      focusX: clampPercent(activePreferences.focusX + deltaX),
      focusY: clampPercent(activePreferences.focusY + deltaY),
    })
  }

  const focus = dragFocus ?? {
    focusX: activePreferences.focusX,
    focusY: activePreferences.focusY,
  }

  const message = isImage
    ? error
    : dynamicError === 'web-index-missing'
      ? t('settings.wallpaper.webIndexMissing')
      : dynamicError

  return (
    <SettingsSection
      title={t('settings.wallpaper.title')}
      description={t('settings.wallpaper.description')}
    >
      <SettingsGroup>
        {dynamicSupported ? (
          <SettingsRow
            title={t('settings.wallpaper.typeTitle')}
            description={t('settings.wallpaper.typeDescription')}
          >
            <SegmentedControl<WallpaperType>
              label={t('settings.wallpaper.typeTitle')}
              value={kind}
              items={[
                { value: 'image', label: t('settings.wallpaper.typeImage') },
                { value: 'video', label: t('settings.wallpaper.typeVideo') },
                { value: 'web', label: t('settings.wallpaper.typeWeb') },
              ]}
              onChange={(next) => void updateDynamic({ kind: next })}
            />
          </SettingsRow>
        ) : null}

        {isImage ? (
          <>
            {objectUrl ? (
              <SettingsBlock>
                <div className="flex justify-center">
                  <button
                    type="button"
                    data-testid="wallpaper-preview"
                    aria-label={t('settings.wallpaper.focusLabel')}
                    disabled={controlsDisabled}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerEnd}
                    onKeyDown={handleFocusKey}
                    style={{
                      aspectRatio,
                      maxWidth: `${PREVIEW_MAX_HEIGHT * aspectRatio}px`,
                    }}
                    className="relative block w-full touch-none select-none cursor-grab overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] active:cursor-grabbing disabled:cursor-not-allowed"
                  >
                    <span
                      aria-hidden="true"
                      data-testid="wallpaper-preview-image"
                      className="absolute inset-0"
                      style={{
                        backgroundImage: `url("${objectUrl}")`,
                        backgroundPosition: `${focus.focusX}% ${focus.focusY}%`,
                        backgroundSize: 'cover',
                        backgroundRepeat: 'no-repeat',
                        transform: `scale(${preferences.zoom / 100})`,
                        transformOrigin: `${focus.focusX}% ${focus.focusY}%`,
                      }}
                    />
                    <span
                      aria-hidden="true"
                      data-testid="wallpaper-focus-marker"
                      className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
                      style={{ left: `${focus.focusX}%`, top: `${focus.focusY}%` }}
                    />
                  </button>
                </div>
                <p className="mt-1.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                  {t('settings.wallpaper.focusHint')}
                </p>
              </SettingsBlock>
            ) : (
              <SettingsRow title={t('settings.wallpaper.noImage')} description={t('settings.wallpaper.noImageHint')} />
            )}

            <SettingsSwitchRow
              title={t('settings.wallpaper.enableTitle')}
              description={t('settings.wallpaper.enableDescription')}
              checked={preferences.enabled}
              disabled={!hasImage || loading}
              onChange={(enabled) => void setOption({ enabled })}
              data-testid="wallpaper-enable"
            />

            <SettingsRow
              title={t('settings.wallpaper.chooseImage')}
              description={t('settings.wallpaper.chooseImageHint')}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={WALLPAPER_ACCEPT}
                className="hidden"
                data-testid="wallpaper-file-input"
                onChange={handleFile}
              />
              <Button
                variant="secondary"
                size="base"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                icon={<ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />}
              >
                {hasImage ? t('settings.wallpaper.changeImage') : t('settings.wallpaper.pickImage')}
              </Button>
              {hasImage ? (
                <Button
                  variant="ghost"
                  size="base"
                  disabled={loading}
                  onClick={() => void remove()}
                  icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
                >
                  {t('settings.wallpaper.removeImage')}
                </Button>
              ) : null}
            </SettingsRow>
          </>
        ) : null}

        {isVideo ? (
          <>
            <SettingsRow
              title={t('settings.wallpaper.videoSource')}
              description={
                hasDynamicSource
                  ? dynamicStatus.preferences.videoName ?? ''
                  : t('settings.wallpaper.noVideoHint')
              }
            >
              <Button
                variant="secondary"
                size="base"
                disabled={dynamicLoading}
                onClick={() => void pickVideo({
                  dialogTitle: t('settings.wallpaper.pickVideo'),
                  dialogFilterName: t('settings.wallpaper.videoFilter'),
                })}
                icon={<Video size={14} strokeWidth={1.75} aria-hidden="true" />}
              >
                {hasDynamicSource ? t('settings.wallpaper.changeVideo') : t('settings.wallpaper.pickVideo')}
              </Button>
              {hasDynamicSource ? (
                <Button
                  variant="ghost"
                  size="base"
                  disabled={dynamicLoading}
                  onClick={() => void clearDynamicSource()}
                  icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
                >
                  {t('settings.wallpaper.removeImage')}
                </Button>
              ) : null}
            </SettingsRow>
            <p className="px-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
              {t('settings.wallpaper.dynamicHint')}
            </p>
          </>
        ) : null}

        {isWeb ? (
          <>
            <SettingsRow
              title={t('settings.wallpaper.webSource')}
              description={
                hasDynamicSource
                  ? dynamicStatus.preferences.webName ?? ''
                  : t('settings.wallpaper.noWebHint')
              }
            >
              <Button
                variant="secondary"
                size="base"
                disabled={dynamicLoading}
                onClick={() => void pickWeb({ dialogTitle: t('settings.wallpaper.pickWeb') })}
                icon={<FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />}
              >
                {hasDynamicSource ? t('settings.wallpaper.changeWeb') : t('settings.wallpaper.pickWeb')}
              </Button>
              {hasDynamicSource ? (
                <>
                  <Button
                    variant="ghost"
                    size="base"
                    disabled={dynamicLoading}
                    onClick={() => void reloadDynamic()}
                    icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
                  >
                    {t('settings.wallpaper.reloadWeb')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="base"
                    disabled={dynamicLoading}
                    onClick={() => void clearDynamicSource()}
                    icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
                  >
                    {t('settings.wallpaper.removeImage')}
                  </Button>
                </>
              ) : null}
            </SettingsRow>
            <p className="px-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
              {t('settings.wallpaper.webHint')}
            </p>
          </>
        ) : null}

        {!isImage && hasDynamicSource ? (
          <SettingsBlock>
            <div className="flex justify-center">
              <button
                type="button"
                data-testid="wallpaper-dynamic-preview"
                aria-label={t('settings.wallpaper.focusLabel')}
                disabled={controlsDisabled}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
                onKeyDown={handleFocusKey}
                style={{
                  aspectRatio,
                  maxWidth: `${PREVIEW_MAX_HEIGHT * aspectRatio}px`,
                }}
                className="relative block w-full touch-none select-none cursor-grab overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] active:cursor-grabbing disabled:cursor-not-allowed"
              >
                {isVideo ? (
                  <video
                    data-testid="wallpaper-dynamic-preview-media"
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                    src={videoWallpaperUrl(dynamicStatus.preferences.revision)}
                    style={{
                      objectPosition: `${focus.focusX}% ${focus.focusY}%`,
                      transform: `scale(${dynamicStatus.preferences.zoom / 100})`,
                      transformOrigin: `${focus.focusX}% ${focus.focusY}%`,
                    }}
                    muted
                    loop
                    autoPlay
                    playsInline
                  />
                ) : (
                  <iframe
                    data-testid="wallpaper-dynamic-preview-media"
                    aria-hidden="true"
                    tabIndex={-1}
                    title={t('settings.wallpaper.title')}
                    className="pointer-events-none absolute inset-0 h-full w-full border-0"
                    src={webWallpaperUrl(dynamicStatus.preferences.revision)}
                    sandbox="allow-scripts"
                    style={{
                      transform: `scale(${dynamicStatus.preferences.zoom / 100})`,
                      transformOrigin: `${focus.focusX}% ${focus.focusY}%`,
                    }}
                  />
                )}
                <span
                  aria-hidden="true"
                  data-testid="wallpaper-focus-marker"
                  className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
                  style={{ left: `${focus.focusX}%`, top: `${focus.focusY}%` }}
                />
              </button>
            </div>
            <p className="mt-1.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
              {t('settings.wallpaper.focusHint')}
            </p>
          </SettingsBlock>
        ) : null}

        {!isImage && dynamicStatus.unavailable ? (
          <p role="status" className="px-0.5 text-xs text-[var(--color-warning)]">
            {dynamicStatus.unavailable === 'video-missing'
              ? t('settings.wallpaper.videoMissing')
              : t('settings.wallpaper.webMissing')}
          </p>
        ) : null}

        {!isImage ? (
          <SettingsSwitchRow
            title={t('settings.wallpaper.enableTitle')}
            description={t('settings.wallpaper.enableDescription')}
            checked={dynamicStatus.preferences.enabled}
            disabled={!hasDynamicSource || dynamicLoading}
            onChange={(enabled) => void updateDynamic({ enabled })}
            data-testid="wallpaper-enable"
          />
        ) : null}

        <SettingsRow title={t('settings.wallpaper.zoomLabel')} layout="inline">
          <input
            type="range"
            min={100}
            max={300}
            step={1}
            value={draft.zoom}
            disabled={!hasSource}
            aria-label={t('settings.wallpaper.zoomLabel')}
            className="w-40 accent-[var(--color-btn-primary-bg)]"
            onChange={(event) => updateNumber('zoom', Number(event.target.value))}
          />
          <span className="w-10 text-right text-xs tabular-nums text-[var(--color-text-secondary)]">
            {draft.zoom}%
          </span>
        </SettingsRow>

        <SettingsRow title={t('settings.wallpaper.blurLabel')} layout="inline">
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            value={draft.blur}
            disabled={!hasSource}
            aria-label={t('settings.wallpaper.blurLabel')}
            className="w-40 accent-[var(--color-btn-primary-bg)]"
            onChange={(event) => updateNumber('blur', Number(event.target.value))}
          />
          <span className="w-10 text-right text-xs tabular-nums text-[var(--color-text-secondary)]">{draft.blur}px</span>
        </SettingsRow>

        <SettingsRow title={t('settings.wallpaper.panelOpacityLabel')} layout="inline">
          <input
            type="range"
            min={60}
            max={100}
            step={1}
            value={draft.panelOpacity}
            disabled={!hasSource}
            aria-label={t('settings.wallpaper.panelOpacityLabel')}
            className="w-40 accent-[var(--color-btn-primary-bg)]"
            onChange={(event) => updateNumber('panelOpacity', Number(event.target.value))}
          />
          <span className="w-10 text-right text-xs tabular-nums text-[var(--color-text-secondary)]">
            {draft.panelOpacity}%
          </span>
        </SettingsRow>

      </SettingsGroup>

      {message ? (
        <p role="alert" className="mt-2 px-0.5 text-xs text-[var(--color-error)]">
          {message}
        </p>
      ) : null}
    </SettingsSection>
  )
}