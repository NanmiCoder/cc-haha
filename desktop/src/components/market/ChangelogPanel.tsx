import { ExternalLink } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import type { NormalizedSkillDetail } from '../../types/market'
import { formatIsoDate, safeUrl } from './marketFormat'

/**
 * The latest release note, as upstream published it. Upstream keeps only the
 * newest one; the registry page has the rest, so it is linked when known.
 */
export function ChangelogPanel({
  changelog,
  version,
  pageUrl,
}: {
  changelog?: NormalizedSkillDetail['changelog']
  /** The skill's current version, used when the note does not name its own. */
  version?: string
  pageUrl?: string
}) {
  const t = useTranslation()
  const href = safeUrl(pageUrl)
  const releaseVersion = changelog?.version || version
  const published = formatIsoDate(changelog?.publishedAt)

  return (
    <Card
      radius="lg"
      surface="lowest"
      padding="none"
      className="overflow-hidden"
      data-testid="market-changelog-panel"
    >
      <h2 className="flex h-10 items-center border-b border-[var(--color-border)] px-4 text-[13px] font-medium text-[var(--color-text-primary)]">{t('market.detail.changelog')}</h2>
      <div className="px-4 py-3">
        {changelog ? (
          <article>
            <header className="flex flex-wrap items-center gap-2">
              {releaseVersion && (
                <Badge variant="outline" size="xs" mono>
                  {releaseVersion.startsWith('v') ? releaseVersion : `v${releaseVersion}`}
                </Badge>
              )}
              {published && <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{published}</span>}
            </header>
            <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-[var(--color-text-secondary)]">
              {changelog.text}
            </p>
          </article>
        ) : (
          <p className="text-[13px] text-[var(--color-text-tertiary)]">{t('market.detail.noChangelog')}</p>
        )}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-flex w-fit items-center gap-1 rounded-[var(--radius-xs)] text-xs text-[var(--color-text-accent)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            {t('market.detail.sourcePage')}
            <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
          </a>
        )}
      </div>
    </Card>
  )
}
