import { useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  detectCapabilities,
  extractTriggers,
  type Capability,
  type CapabilityLevel,
} from '../../lib/skillInsights'
import type { NormalizedSkillDetail } from '../../types/market'

type Translate = ReturnType<typeof useTranslation>

export const CAPABILITY_LEVEL_TONES: Record<CapabilityLevel, Tone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}

/** One capability, phrased with its evidence. */
export function capabilityText(t: Translate, capability: Capability): { title: string; detail: string } {
  const evidence = capability.evidence.join(capability.kind === 'shell' ? ' / ' : '、')
  return {
    title: t(`market.cap.${capability.kind}`),
    detail: t(`market.cap.${capability.kind}.detail`, { evidence }),
  }
}

/** Capabilities and triggers, read once per detail off its own SKILL.md and file list. */
export function useSkillInsights(detail: NormalizedSkillDetail | null | undefined): {
  capabilities: Capability[]
  triggers: string[]
} {
  return useMemo(() => {
    if (!detail) return { capabilities: [], triggers: [] }
    const description = detail.descriptionFrontmatter?.description
    return {
      capabilities: detectCapabilities({
        markdown: detail.description,
        frontmatter: detail.descriptionFrontmatter,
        files: detail.files,
      }),
      triggers: extractTriggers(typeof description === 'string' ? description : undefined),
    }
  }, [detail])
}

/**
 * "Before installing: what this skill does."
 *
 * Every card cites the file, command, variable or host it came from, so the
 * reader can check the claim rather than trust it. Renders nothing when no
 * rule fired: an empty "nothing risky here" panel would be a verdict these
 * rules cannot make.
 */
export function CapabilityPanel({
  capabilities,
  onViewReport,
}: {
  capabilities: readonly Capability[]
  /** Shown as the header link; omitted where the panel already sits in the report. */
  onViewReport?: () => void
}) {
  const t = useTranslation()
  if (capabilities.length === 0) return null

  return (
    // A white card with a hairline, like every other group on the page; the
    // caution is carried by the header icon and the per-row level badges, not
    // by painting the whole block amber.
    <section
      aria-labelledby="market-capabilities-title"
      data-testid="market-capability-panel"
      className="flex-shrink-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
    >
      <header className="flex min-h-10 items-center gap-2 border-b border-[var(--color-border)] py-1 pl-4 pr-2">
        <TriangleAlert className="flex-shrink-0 text-[var(--color-warning)]" size={15} strokeWidth={1.75} aria-hidden="true" />
        <h2
          id="market-capabilities-title"
          className="min-w-0 flex-1 text-[13px] font-medium text-[var(--color-text-primary)]"
        >
          {t('market.cap.title')}
        </h2>
        {onViewReport && (
          <Button variant="ghost" size="sm" data-testid="market-capability-view-report" onClick={onViewReport}>
            {t('market.cap.viewReport')}
          </Button>
        )}
      </header>
      <ul className="divide-y divide-[var(--color-border)]">
        {capabilities.map((capability) => {
          const text = capabilityText(t, capability)
          return (
            <li
              key={capability.kind}
              data-testid={`market-capability-${capability.kind}`}
              className="flex min-w-0 items-start gap-3 px-4 py-2.5"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-[var(--color-text-primary)]">{text.title}</span>
                <span className="break-words font-mono text-xs leading-5 text-[var(--color-text-secondary)]">
                  {text.detail}
                </span>
              </span>
              <Badge tone={CAPABILITY_LEVEL_TONES[capability.level]} size="xs" className="mt-0.5">
                {t(`market.cap.level.${capability.level}`)}
              </Badge>
            </li>
          )
        })}
      </ul>
      <p className="border-t border-[var(--color-border)] px-4 py-2.5 text-xs leading-5 text-[var(--color-text-tertiary)]">{t('market.cap.note')}</p>
    </section>
  )
}
