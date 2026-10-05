import { CircleAlert, CircleCheck, CircleX, Info, X, type LucideIcon } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useUIStore, type Toast as ToastType } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'

// The tone lives in the leading glyph rather than a tinted body or a coloured
// rule: on paper a filled banner fights the surrounding surface layering, and
// the glyph is what carries the state in every other 「素」 surface.
const TONE: Record<ToastType['type'], { icon: LucideIcon; color: string }> = {
  success: { icon: CircleCheck, color: 'text-[var(--color-success)]' },
  error: { icon: CircleX, color: 'text-[var(--color-error)]' },
  warning: { icon: CircleAlert, color: 'text-[var(--color-warning)]' },
  info: { icon: Info, color: 'text-[var(--color-info)]' },
}

function ToastItem({ toast }: { toast: ToastType }) {
  const t = useTranslation()
  const removeToast = useUIStore((s) => s.removeToast)
  const isUrgent = toast.type === 'warning' || toast.type === 'error'
  const { icon: Icon, color } = TONE[toast.type]

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-tone={toast.type}
      className="animate-overlay-in-right flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-2.5 pl-3 pr-2 text-[13px] text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)]"
    >
      <Icon size={16} strokeWidth={1.75} className={`mt-0.5 shrink-0 ${color}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 leading-5">{toast.message}</span>
      <IconButton
        icon={<X size={14} strokeWidth={1.75} aria-hidden="true" />}
        label={t('common.dismissNotification')}
        onClick={() => removeToast(toast.id)}
        size="xs"
        tone="muted"
      />
    </div>
  )
}

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[var(--z-toast)] flex max-w-sm flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
