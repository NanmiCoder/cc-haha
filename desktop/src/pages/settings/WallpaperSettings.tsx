import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { useTranslation } from '../../i18n'
import { WALLPAPER_ACCEPT } from '../../lib/wallpaper'
import { useWallpaperStore } from '../../stores/wallpaperStore'

const DEBOUNCE_MS = 250
/** The preview keeps the window's shape; cap how tall that can get. */
const PREVIEW_MAX_HEIGHT = 400

type WallpaperNumbers = { blur: number; panelOpacity: number; zoom: number }
type Focus = { focusX: number; focusY: number }
type DragState = Focus & { pointerId: number; startX: number; startY: number }

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

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [draft, setDraft] = useState<WallpaperNumbers>({
    blur: preferences.blur,
    panelOpacity: preferences.panelOpacity,
    zoom: preferences.zoom,
  })
  const [aspectRatio, setAspectRatio] = useState(windowAspectRatio)
  const [dragFocus, setDragFocus] = useState<Focus | null>(null)

  useEffect(() => {
    setDraft({
      blur: preferences.blur,
      panelOpacity: preferences.panelOpacity,
      zoom: preferences.zoom,
    })
  }, [preferences.blur, preferences.panelOpacity, preferences.zoom])

  useEffect(() => {
    const update = () => setAspectRatio(windowAspectRatio())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  const hasImage = preferences.file !== null
  const controlsDisabled = !hasImage || loading

  function updateNumber(field: keyof WallpaperNumbers, value: number) {
    const next = { ...draft, [field]: value }
    setDraft(next)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void setOption(next)
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
    const zoom = Math.max(1, preferences.zoom / 100)
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
      focusX: preferences.focusX,
      focusY: preferences.focusY,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragFocus({ focusX: preferences.focusX, focusY: preferences.focusY })
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
    if (next && (next.focusX !== preferences.focusX || next.focusY !== preferences.focusY)) {
      void setOption(next)
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
    void setOption({
      focusX: clampPercent(preferences.focusX + deltaX),
      focusY: clampPercent(preferences.focusY + deltaY),
    })
  }

  const focus = dragFocus ?? { focusX: preferences.focusX, focusY: preferences.focusY }

  return (
    <SettingsSection
      title={t('settings.wallpaper.title')}
      description={t('settings.wallpaper.description')}
    >
      <SettingsGroup>
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

        <SettingsRow title={t('settings.wallpaper.zoomLabel')} layout="inline">
          <input
            type="range"
            min={100}
            max={300}
            step={1}
            value={draft.zoom}
            disabled={!hasImage}
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
            disabled={!hasImage}
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
            disabled={!hasImage}
            aria-label={t('settings.wallpaper.panelOpacityLabel')}
            className="w-40 accent-[var(--color-btn-primary-bg)]"
            onChange={(event) => updateNumber('panelOpacity', Number(event.target.value))}
          />
          <span className="w-10 text-right text-xs tabular-nums text-[var(--color-text-secondary)]">
            {draft.panelOpacity}%
          </span>
        </SettingsRow>

      </SettingsGroup>

      {error ? (
        <p role="alert" className="mt-2 px-0.5 text-xs text-[var(--color-error)]">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  )
}