import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SettingsBlock, SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import { DEFAULT_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE } from '@/lib/terminalTheme'
import { useSettingsStore } from '@/stores/settingsStore'

export function TerminalAppearanceSettings() {
  const t = useTranslation()
  const preferences = useSettingsStore((state) => state.desktopTerminal)
  const setDesktopTerminal = useSettingsStore((state) => state.setDesktopTerminal)
  const [fontFamily, setFontFamily] = useState(preferences.fontFamily)
  const [fontSize, setFontSize] = useState(preferences.fontSize)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const familyId = useId()
  const sizeId = useId()

  useEffect(() => {
    setFontFamily(preferences.fontFamily)
    setFontSize(preferences.fontSize)
  }, [preferences.fontFamily, preferences.fontSize])

  const save = async (family: string, size: number) => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await setDesktopTerminal({ fontFamily: family.trim(), fontSize: size })
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection title={t('settings.terminal.appearance')} description={t('settings.terminal.appearanceHint')}>
      <SettingsGroup>
        <SettingsRow title={t('settings.terminal.fontFamily')} htmlFor={familyId} description={t('settings.terminal.fontFamilyHint')}>
          <Input
            id={familyId}
            value={fontFamily}
            placeholder={t('settings.terminal.fontExample')}
            size="md"
            containerClassName="w-full sm:w-[240px]"
            disabled={saving}
            onChange={(event) => { setFontFamily(event.target.value); setSaved(false); setError(null) }}
          />
        </SettingsRow>
        <SettingsRow title={t('settings.terminal.fontSize')} htmlFor={sizeId}>
          <div className="flex items-center gap-2.5">
            <input
              id={sizeId}
              type="range"
              min={MIN_TERMINAL_FONT_SIZE}
              max={MAX_TERMINAL_FONT_SIZE}
              step={1}
              value={fontSize}
              aria-valuetext={t('settings.terminal.fontSizeValue', { size: fontSize })}
              disabled={saving}
              onChange={(event) => { setFontSize(Number(event.target.value)); setSaved(false); setError(null) }}
              className="w-[150px] cursor-pointer accent-[var(--color-brand)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-border-focus)]"
            />
            <output htmlFor={sizeId} className="w-[38px] font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">{t('settings.terminal.fontSizeValue', { size: fontSize })}</output>
          </div>
        </SettingsRow>
        <SettingsBlock className="flex flex-wrap items-center justify-end gap-3">
          {error && <p role="alert" className="mr-auto text-xs text-[var(--color-error)]">{error}</p>}
          {saved && <span role="status" className="text-xs text-[var(--color-text-tertiary)]">{t('settings.terminal.fontSaved')}</span>}
          <Button variant="secondary" size="base" disabled={saving} onClick={() => void save('', DEFAULT_TERMINAL_FONT_SIZE)}>
            {t('settings.terminal.resetFont')}
          </Button>
          <Button size="base" loading={saving} onClick={() => void save(fontFamily, fontSize)}>
            {t('settings.terminal.saveFont')}
          </Button>
        </SettingsBlock>
      </SettingsGroup>
    </SettingsSection>
  )
}
