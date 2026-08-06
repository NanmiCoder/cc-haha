
/**
 * The few things every Settings panel needs.
 *
 * Extracted while splitting `Settings.tsx` into one module per panel. These three are
 * the only declarations more than one panel reaches for, so they get their own module
 * rather than staying behind — leaving them in Settings.tsx would make every panel
 * import from the file that imports it, and the resulting cycle is exactly the kind of
 * fragility a split is supposed to remove.
 */

export const SETTINGS_CHECKBOX_INPUT_CLASS = 'settings-checkbox-input peer'

export function SettingsCheckboxMark({ checked, disabled = false }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-md)] border transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-border-focus)] ${
        checked
          ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-on-primary)] shadow-[var(--shadow-button-primary)]'
          : 'border-[var(--color-border-focus)] bg-[var(--color-surface)] text-transparent'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="material-symbols-outlined text-[16px] leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>
        check
      </span>
    </span>
  )
}

export function isValidHttpProxyUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
