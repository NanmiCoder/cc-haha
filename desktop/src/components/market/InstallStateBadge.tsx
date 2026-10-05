import { CheckCircle2, CircleSlash2, Download, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge, type Tone } from '@/components/ui/Badge'
import type { InstallState } from '../../types/market'

/**
 * Only the status-to-tone map is left; the shell it used to carry was
 * character-identical to `SecurityBadge`'s.
 *
 * `installable` is neutral: it is an absence of state, not a state, and the
 * brand color is reserved for the brand, the send key and selection.
 */
const TONES: Record<InstallState, Tone> = {
  installed: 'success',
  installable: 'neutral',
  'not-installable': 'danger',
}

const ICONS: Record<InstallState, LucideIcon> = {
  installed: CheckCircle2,
  installable: Download,
  'not-installable': CircleSlash2,
}

const LABEL_KEYS: Record<InstallState, 'market.install.state.installed' | 'market.install.state.installable' | 'market.install.state.notInstallable'> = {
  installed: 'market.install.state.installed',
  installable: 'market.install.state.installable',
  'not-installable': 'market.install.state.notInstallable',
}

export function InstallStateBadge({ state, className = '' }: { state: InstallState; className?: string }) {
  const t = useTranslation()
  const Icon = ICONS[state]
  return (
    <Badge
      data-testid={`install-badge-${state}`}
      tone={TONES[state]}
      size="sm"
      className={className}
      icon={<Icon size={12} strokeWidth={2} aria-hidden="true" />}
    >
      {t(LABEL_KEYS[state])}
    </Badge>
  )
}
