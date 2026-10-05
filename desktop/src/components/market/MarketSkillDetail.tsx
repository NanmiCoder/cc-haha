import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  CircleAlert,
  Download,
  ExternalLink,
  History,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { cx } from '@/lib/cx'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Skeleton, SkeletonGroup } from '@/components/ui/Skeleton'
import { formatBytes } from '../../lib/formatBytes'
import { readingMinutes } from '../../lib/skillInsights'
import { useMarketStore } from '../../stores/marketStore'
import { CapabilityPanel, useSkillInsights } from './CapabilityPanel'
import { ChangelogPanel } from './ChangelogPanel'
import { resolveCategory, skillSummary, useMarketLocale, visibleTags } from './catalogLocale'
import { formatCount, formatIsoDate, safeUrl } from './marketFormat'
import { SecurityBadge } from './SecurityBadge'
import { SecurityReportPanel } from './SecurityReportPanel'
import { EXTENSION_PAGE_COLUMN } from './pageLayout'
import {
  SkillDetailView,
  type SkillDetailMetaItem,
  type SkillDetailStat,
  type SkillDetailTab,
} from './SkillDetailView'

/** Tags beside the category in the hero; the card shows three, the hero has less room to spare. */
const HERO_TAGS = 2

export function MarketSkillDetail({
  onRequestInstall,
  onRequestUninstall,
}: {
  onRequestInstall: (id: string, owner?: string) => void
  onRequestUninstall: (id: string) => void
}) {
  const t = useTranslation()
  const locale = useMarketLocale()
  const selectedId = useMarketStore((s) => s.selectedId)
  const selectedOwner = useMarketStore((s) => s.selectedOwner)
  const detail = useMarketStore((s) => s.detail)
  const categories = useMarketStore((s) => s.categories)
  const isDetailLoading = useMarketStore((s) => s.isDetailLoading)
  const detailError = useMarketStore((s) => s.detailError)
  const installingIds = useMarketStore((s) => s.installingIds)
  const installError = useMarketStore((s) => s.installError)
  const backToList = useMarketStore((s) => s.backToList)
  const refreshDetail = useMarketStore((s) => s.refreshDetail)
  const fetchFileContent = useMarketStore((s) => s.fetchFileContent)
  const { capabilities, triggers } = useSkillInsights(detail)

  // Tab state is owned here, not by the view: the capability panel's "full
  // report" link switches tabs from inside the overview.
  const [tab, setTab] = useState('overview')
  useEffect(() => setTab('overview'), [selectedId])

  const loadFile = useCallback(
    (path: string) => {
      if (!selectedId) return Promise.reject(new Error('No skill selected'))
      return fetchFileContent(selectedId, path, selectedOwner ?? undefined)
    },
    [selectedId, selectedOwner, fetchFileContent],
  )

  const categoryName = detail ? resolveCategory(detail, categories, locale) : undefined
  const updated = formatIsoDate(detail?.updatedAt)
  const author = detail ? detail.author.displayName || detail.author.handle : ''

  const meta = useMemo<SkillDetailMetaItem[]>(() => {
    if (!detail) return []
    const items: SkillDetailMetaItem[] = [
      { label: t('market.detail.author'), value: author || '—' },
      { label: t('market.filter.source'), value: t(`market.source.${detail.source}`) },
    ]
    if (categoryName) items.push({ label: t('market.detail.category'), value: categoryName })
    if (detail.version) items.push({ label: t('market.detail.version'), value: `v${detail.version}` })
    if (detail.license) items.push({ label: t('market.detail.license'), value: detail.license })
    items.push({ label: t('market.detail.updated'), value: updated || '—' })
    if (detail.requiresApiKey) {
      items.push({
        label: t('market.detail.requiresApiKey'),
        value: <KeyRound className="ml-auto text-[var(--color-warning)]" size={14} strokeWidth={1.75} aria-hidden="true" />,
      })
    }
    return items
  }, [detail, t, author, categoryName, updated])

  if (!selectedId) return null

  if (isDetailLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-surface)]" data-testid="market-detail-loading">
        <div className={cx(EXTENSION_PAGE_COLUMN, 'pb-6 pt-5')}>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            icon={<ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />}
            onClick={backToList}
          >
            {t('market.detail.back')}
          </Button>
          <SkeletonGroup label={t('market.loading')} className="mt-4">
            <div className="flex items-start gap-4 pb-5">
              <Skeleton shape="block" width="56px" height="56px" radius="lg" tone="strong" className="flex-shrink-0" />
              <div className="min-w-0 flex-1 pt-1">
                <Skeleton height="2rem" tone="strong" className="w-64 max-w-full" />
                <Skeleton height="0.75rem" className="mt-3 w-48" />
                <Skeleton height="0.75rem" className="mt-4 w-[min(100%,36rem)]" />
              </div>
            </div>
            <div className="h-[74px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]" />
            <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-8">
              <div>
                <Skeleton height="2.75rem" className="w-72" />
                <div className="mt-5 h-72 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]" />
              </div>
              <div className="order-first h-72 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] lg:order-none" />
            </div>
          </SkeletonGroup>
        </div>
      </div>
    )
  }

  if (detailError || !detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-20 text-center" data-testid="market-detail-error">
        <span className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]">
          <CircleAlert size={20} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <p className="text-sm font-semibold text-[var(--color-text-primary)]">{t('market.detail.loadError')}</p>
        {detailError && <p className="max-w-md break-words text-xs text-[var(--color-text-tertiary)]">{detailError}</p>}
        <div className="mt-1 flex items-center gap-2">
          <Button
            variant="secondary"
            size="base"
            icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => void refreshDetail(selectedId)}
          >
            {t('market.retry')}
          </Button>
          <Button variant="ghost" size="base" onClick={backToList}>
            {t('market.detail.back')}
          </Button>
        </div>
      </div>
    )
  }

  const installing = installingIds.has(detail.id)
  const pageUrl = safeUrl(detail.pageUrl)
  const flagged = detail.securityStatus === 'flagged'
  const skillMd = detail.files.find((file) => file.path === 'SKILL.md')
  const mirrorSource = detail.mirrors?.length
    ? detail.mirrors[0]!.split(':')[0]
    : detail.upstream
      ? detail.upstream.source
      : null

  const metaFacts: ReactNode[] = [
    author ? <span key="author">{t('market.detail.by', { author })}</span> : null,
    <span key="source">{t(`market.source.${detail.source}`)}</span>,
    detail.license ? <span key="license">{detail.license}</span> : null,
    updated ? <span key="updated">{t('market.detail.updatedOn', { date: updated })}</span> : null,
  ].filter(Boolean)
  const metaLine = metaFacts.map((fact, index) => (
    <Fragment key={index}>
      {index > 0 && <span aria-hidden="true">·</span>}
      {fact}
    </Fragment>
  ))

  const chips = (
    <>
      <SecurityBadge status={detail.securityStatus} />
      {detail.featured && (
        <Badge tone="info" size="md" pill={false} data-testid="market-detail-featured">
          {t('market.featured')}
        </Badge>
      )}
      {categoryName && (
        <Badge size="md" pill={false}>
          {categoryName}
        </Badge>
      )}
      {visibleTags(detail, locale).slice(0, HERO_TAGS).map((tag) => (
        <Badge key={tag} size="md" pill={false}>
          {tag}
        </Badge>
      ))}
    </>
  )

  const stats: SkillDetailStat[] = [
    { label: t('market.detail.downloads'), value: formatCount(detail.stats.downloads) },
    ...(detail.stats.installs === undefined
      ? []
      : [{ label: t('market.detail.installs'), value: formatCount(detail.stats.installs) }]),
    ...(detail.stats.stars === undefined
      ? []
      : [{ label: t('market.detail.stars'), value: formatCount(detail.stats.stars) }]),
    { label: t('market.detail.files'), value: String(detail.files.length) },
  ]

  const extraTabs: SkillDetailTab[] = [
    {
      key: 'security',
      label: t('market.detail.security'),
      icon: ShieldCheck,
      badge: flagged ? (
        <span data-testid="market-detail-flagged-dot" className="inline-flex items-center">
          <StatusDot tone="warning" size="md" />
          <span className="sr-only">{t('market.detail.flaggedDot')}</span>
        </span>
      ) : undefined,
      content: (
        <SecurityReportPanel
          capabilities={capabilities}
          reports={detail.securityReports ?? []}
          securityNote={detail.securityNote}
        />
      ),
    },
    // A tab that can only say "nothing here" is not worth the slot.
    ...(detail.changelog
      ? [
          {
            key: 'changelog',
            label: t('market.detail.changelog'),
            icon: History,
            content: <ChangelogPanel changelog={detail.changelog} version={detail.version} pageUrl={pageUrl} />,
          },
        ]
      : []),
  ]

  const actions = (
    <>
      {pageUrl && (
        <a
          href={pageUrl}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="market-source-page-link"
          className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-md)] px-2 text-[13px] font-medium text-[var(--color-text-secondary)] underline-offset-2 transition-colors hover:text-[var(--color-text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          {t('market.detail.sourcePage')}
          <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
        </a>
      )}
      {detail.installState === 'installable' && (
        <Button
          size="base"
          data-testid="market-install-button"
          data-market-skill-action-id={detail.id}
          loading={installing}
          icon={<Download size={14} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => onRequestInstall(detail.id, selectedOwner ?? undefined)}
        >
          {installing ? t('market.install.installing') : t('market.install.action')}
        </Button>
      )}
      {detail.installState === 'installed' && (
        <Button
          variant="danger-outline"
          size="base"
          data-testid="market-uninstall-button"
          data-market-skill-action-id={detail.id}
          loading={installing}
          icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => onRequestUninstall(detail.id)}
        >
          {installing ? t('market.uninstall.uninstalling') : t('market.uninstall.action')}
        </Button>
      )}
    </>
  )

  const banner = (
    <>
      {mirrorSource && (
        <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">
          {t('market.detail.mirror', { source: t(`market.source.${mirrorSource as 'clawhub' | 'skillhub'}`) })}
        </p>
      )}
      {installError && installError.id === detail.id && (
        <div
          data-testid="market-install-error"
          className="mt-4 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-[13px] text-[var(--color-on-error-container)]"
        >
          <CircleAlert className="mt-[3px] flex-shrink-0" size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="break-words">
            {installError.kind === 'generic'
              ? t('market.installError.generic', { message: installError.message })
              : t(`market.installError.${installError.kind}`)}
          </span>
        </div>
      )}
    </>
  )

  const sideCards = triggers.length > 0 && (
    <Card radius="lg" surface="lowest" padding="none" className="px-4 py-3.5" data-testid="market-detail-triggers">
      <h2 className="text-[13px] font-semibold text-[var(--color-text-primary)]">{t('market.detail.whenToUse')}</h2>
      <ol className="mt-3 flex flex-col gap-2.5">
        {triggers.map((trigger, index) => (
          <li key={trigger} className="flex items-start gap-2 text-[13px] leading-5 text-[var(--color-text-secondary)]">
            <Badge size="xs" mono className="mt-0.5">
              {index + 1}
            </Badge>
            <span className="min-w-0 break-words">{trigger}</span>
          </li>
        ))}
      </ol>
    </Card>
  )

  return (
    <SkillDetailView
      name={detail.name}
      version={detail.version}
      iconUrl={detail.iconUrl}
      sourceLabel={t(`market.source.${detail.source}`)}
      summary={skillSummary(detail, locale)}
      securityStatus={detail.securityStatus}
      installState={detail.installState}
      notInstallableReason={detail.notInstallableReason}
      actions={actions}
      actionsPlacement="hero"
      banner={banner}
      meta={meta}
      metaTitle={t('market.detail.info')}
      metaLine={metaLine}
      chips={chips}
      stats={stats}
      extraTabs={extraTabs}
      activeTab={tab}
      onTabChange={setTab}
      overviewLead={<CapabilityPanel capabilities={capabilities} onViewReport={() => setTab('security')} />}
      docHeader={
        <>
          <span className="font-mono">SKILL.md</span>
          <span>
            {skillMd ? `${formatBytes(skillMd.size)} · ` : ''}
            {t('market.detail.readingTime', { minutes: String(readingMinutes(detail.description)) })}
          </span>
        </>
      }
      sideCards={sideCards || undefined}
      description={detail.description}
      descriptionFrontmatter={detail.descriptionFrontmatter}
      files={detail.files.map((f) => ({ path: f.path, size: f.size, language: f.language, tooBig: f.tooBig }))}
      loadFile={loadFile}
      onBack={backToList}
      backLabel={t('market.detail.back')}
    />
  )
}
