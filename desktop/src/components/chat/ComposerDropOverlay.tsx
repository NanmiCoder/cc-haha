import { Upload } from 'lucide-react'

type ComposerDropOverlayProps = {
  title: string
  description: string
  testId: string
}

export function ComposerDropOverlay({ title, description, testId }: ComposerDropOverlayProps) {
  return (
    <div
      data-testid={testId}
      // Opaque tokens throughout: `--color-brand/45` and `/88` compile to a
      // color function the Safari 15 WebView drops, which left the drop target
      // with no edge and a fully transparent scrim there.
      className="composer-drop-overlay pointer-events-none absolute inset-0 z-[var(--z-scrim)] flex items-center justify-center rounded-[inherit] border border-dashed border-[var(--color-outline)] bg-[var(--color-surface-glass)] p-4 backdrop-blur-[2px]"
      aria-hidden="true"
    >
      <div className="flex max-w-[280px] items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-3 text-left shadow-[var(--shadow-dropdown)]">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]">
          <Upload size={16} strokeWidth={1.75} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-medium leading-5 text-[var(--color-text-primary)]">{title}</span>
          <span className="block text-xs leading-5 text-[var(--color-text-tertiary)]">{description}</span>
        </span>
      </div>
    </div>
  )
}
