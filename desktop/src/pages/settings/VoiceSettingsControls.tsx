import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dropdown } from '@/components/ui/Dropdown'
import { SettingsRow } from '@/components/settings/SettingsSection'

/**
 * Controls shared by the Voice input sections (recognition models,
 * microphone), so the page's rows all read the same.
 */

export type VoicePickerItem<T extends string> = { value: T; label: string }

/**
 * One "name on the left, picker on the right" row of the shared settings
 * skeleton; the hint is a `<p>` so an inline link reads as part of the sentence.
 */
export function VoiceSettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <SettingsRow title={label} description={hint ? <p>{hint}</p> : undefined}>
      <div className="w-full sm:w-[240px]">{children}</div>
    </SettingsRow>
  )
}

/** The library Dropdown (not the native select, whose menu is the OS's own); `label` is its accessible name. */
export function VoicePicker<T extends string>({ label, value, items, onChange, disabled = false }: {
  label: string
  value: T
  items: VoicePickerItem<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const selected = items.find(item => item.value === value)
  return (
    <Dropdown<T>
      items={items}
      value={value}
      onChange={onChange}
      label={label}
      width="100%"
      maxHeight={320}
      className="block w-full"
      trigger={
        <Button variant="secondary" size="base" block disabled={disabled} className="gap-2" aria-label={label}>
          <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</span>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        </Button>
      }
    />
  )
}
