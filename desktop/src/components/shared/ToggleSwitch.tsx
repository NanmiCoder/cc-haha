/**
 * Shared toggle switch — mirrors the visual + a11y treatment used across the
 * settings surface (MCP server enable, plugin enable, etc). Kept deliberately
 * thin: callers own the labelled context (button group / list row) and pass
 * `aria-label` if the switch needs an accessible name beyond its row.
 */

type ToggleSwitchProps = {
  checked: boolean
  disabled?: boolean
  onChange: () => void
  /**
   * Optional accessible label. When omitted, the surrounding row is expected
   * to provide context via aria-labelledby on a parent. `aria-checked` is set
   * automatically.
   */
  ariaLabel?: string
  /**
   * Called for the click event before `onChange` fires. Useful for stopping
   * propagation when the switch lives inside a clickable list row.
   */
  onClickCapture?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

export function ToggleSwitch({
  checked,
  disabled,
  onChange,
  ariaLabel,
  onClickCapture,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClickCapture={onClickCapture}
      onClick={onChange}
      className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${
        checked ? 'bg-[var(--color-switch-checked-bg)]' : 'bg-[var(--color-border)]'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-6 w-6 transform rounded-full bg-[var(--color-switch-thumb)] shadow-sm transition-transform ${
          checked ? 'translate-x-7' : 'translate-x-1'
        }`}
      />
    </button>
  )
}
