import { Download, Star } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type { NormalizedSkill } from '../../types/market'
import { skillSummary, useMarketLocale, visibleTags } from './catalogLocale'
import { InstallStateBadge } from './InstallStateBadge'
import { formatCount } from './marketFormat'
import { SecurityBadge } from './SecurityBadge'
import { SkillAvatar } from './SkillAvatar'

const MAX_VISIBLE_TAGS = 3

/**
 * One catalog card: identity (avatar, name, version pill, source · author), a
 * two-line summary, a single chip row (scan verdict, featured mark, tags) and
 * a footer with the counts and the install action.
 *
 * The structure is fixed top to bottom with the footer pinned by `mt-auto`,
 * so a grid row lines up even when one card has no tags. The chip row is
 * clipped to one line for the same reason.
 *
 * The open affordance is one stretched `<button>` under the content: it is
 * focusable and keyboard-operable, and the card never pretends a div is a
 * link. The content above it is `pointer-events-none`, and the install button
 * opts back in — drop either half and the card stops opening or the button
 * stops installing.
 *
 * Hover deepens the hairline and nothing else: the old lift-and-shadow made a
 * grid of 24 cards jump under the pointer while the reader was scanning it.
 */
export function SkillCard({
  skill,
  onOpen,
  onInstall,
  installing,
}: {
  skill: NormalizedSkill
  onOpen: (id: string) => void
  onInstall?: (id: string) => void
  installing?: boolean
}) {
  const t = useTranslation()
  const locale = useMarketLocale()
  const tags = visibleTags(skill, locale)
  const extraTags = Math.max(0, tags.length - MAX_VISIBLE_TAGS)
  const showInstallButton = Boolean(onInstall) && skill.installState === 'installable'
  const author = skill.author.displayName || skill.author.handle
  const summary = skillSummary(skill, locale)

  return (
    <Card
      as="article"
      radius="lg"
      surface="lowest"
      padding="none"
      className="group relative isolate flex min-h-[200px] min-w-0 flex-col p-4 transition-colors duration-150 hover:border-[var(--color-outline)]"
    >
      <button
        type="button"
        aria-label={skill.name}
        data-market-skill-open-id={skill.id}
        onClick={() => onOpen(skill.id)}
        className="absolute inset-0 z-0 rounded-[var(--radius-lg)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      />

      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-3">
        <SkillAvatar skill={skill} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold leading-5 text-[var(--color-text-primary)]">
              {skill.name}
            </h3>
            {skill.version && (
              <Badge variant="outline" size="xs" mono>
                v{skill.version}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-[18px] text-[var(--color-text-tertiary)]">
            <span className="flex-shrink-0">{t(`market.source.${skill.source}`)}</span>
            {author && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{author}</span>
              </>
            )}
          </p>
        </div>
      </div>

      <p className="pointer-events-none relative z-10 mt-3 line-clamp-2 min-h-9 break-words text-xs leading-[18px] text-[var(--color-text-secondary)]">
        {summary || t('market.detail.noDescription')}
      </p>

      <div
        data-testid="market-card-chips"
        className="pointer-events-none relative z-10 mt-3 flex max-h-5 min-w-0 flex-wrap items-center gap-1.5 overflow-hidden"
      >
        <SecurityBadge status={skill.securityStatus} short />
        {skill.featured && (
          <Badge tone="info" size="xs" data-testid="market-card-featured">
            {t('market.featured')}
          </Badge>
        )}
        {tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
          <Badge key={tag} size="xs">
            {tag}
          </Badge>
        ))}
        {extraTags > 0 && (
          <Badge size="xs">
            {t('market.card.moreTags', { count: String(extraTags) })}
          </Badge>
        )}
      </div>

      <footer className="pointer-events-none relative z-10 mt-auto flex min-h-8 items-center justify-between gap-2.5 pt-3">
        <div className="flex min-w-0 items-center gap-3 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          <span className="inline-flex items-center gap-1" title={t('market.detail.downloads')}>
            <Download size={12} strokeWidth={1.75} aria-hidden="true" />
            {formatCount(skill.stats.downloads)}
          </span>
          {typeof skill.stats.stars === 'number' && skill.stats.stars > 0 && (
            <span className="inline-flex items-center gap-1" title={t('market.detail.stars')}>
              <Star size={12} strokeWidth={1.75} aria-hidden="true" />
              {formatCount(skill.stats.stars)}
            </span>
          )}
        </div>
        {showInstallButton ? (
          // The footer is `pointer-events-none` for the stretched open button
          // underneath, so the install button opts back in and sits above it.
          <Button
            variant="secondary"
            size="sm"
            className="pointer-events-auto relative z-20 flex-shrink-0"
            loading={installing}
            data-market-skill-action-id={skill.id}
            icon={<Download size={12} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => onInstall?.(skill.id)}
          >
            {installing ? t('market.install.installing') : t('market.install.action')}
          </Button>
        ) : (
          <InstallStateBadge state={skill.installState} />
        )}
      </footer>
    </Card>
  )
}
