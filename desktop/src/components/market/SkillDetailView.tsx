import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, CircleSlash2, ExternalLink, FileText, Folder, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { cx } from '@/lib/cx'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type {
  InstallState,
  NotInstallableReason,
  SecurityReport,
  SecurityStatus,
} from '../../types/market'
import { InstallStateBadge } from './InstallStateBadge'
import { SecurityBadge } from './SecurityBadge'
import { FilePreview, type PreviewFile, type PreviewFileContent } from './FilePreview'
import { FrontmatterPanel } from './FrontmatterPanel'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { SkillAvatar } from './SkillAvatar'
import { EXTENSION_PAGE_COLUMN } from './pageLayout'
import { splitFrontmatter, type SkillFrontmatter } from '../../lib/skillFrontmatter'

export type SkillDetailMetaItem = {
  label: string
  value: ReactNode
}

export type SkillDetailTab = {
  key: string
  label: string
  icon?: LucideIcon
  /** Small trailing marker: a count, or a warning dot. */
  badge?: ReactNode
  content: ReactNode
}

export type SkillDetailStat = {
  label: string
  value: string
}

export type SkillDetailViewProps = {
  name: string
  version?: string
  iconUrl?: string
  sourceLabel: string
  summary?: string
  securityStatus?: SecurityStatus
  securityReports?: SecurityReport[]
  installState?: InstallState
  notInstallableReason?: NotInstallableReason
  /** Action buttons rendered in the decision area (install / uninstall / open). */
  actions?: ReactNode
  /** Optional banner below the header (e.g. install errors). */
  banner?: ReactNode
  meta: SkillDetailMetaItem[]
  description: string
  /**
   * Frontmatter the caller already parsed. Used when `description` arrives with
   * its YAML block stripped upstream, so the overview can still show it.
   */
  descriptionFrontmatter?: SkillFrontmatter
  files: PreviewFile[]
  loadFile: (path: string) => Promise<PreviewFileContent>
  onBack: () => void
  backLabel: string
  /**
   * The host already lays out a page column (the settings pane). Without this
   * the view centres and pads itself, as it does when it is the whole page.
   */
  framed?: boolean

  // Everything below is optional and only the market detail passes it. The
  // installed-skill page renders exactly as it did before these existed.

  /** One line of facts under the title ("by … · source · license · updated"). Replaces the source label above it. */
  metaLine?: ReactNode
  /** Replaces the default security / install badge row under the title. */
  chips?: ReactNode
  /** Headline numbers in a strip under the header. */
  stats?: SkillDetailStat[]
  /** Tabs after Overview and Files. */
  extraTabs?: SkillDetailTab[]
  /** Controlled tab; pair with `onTabChange`. Uncontrolled when omitted. */
  activeTab?: string
  onTabChange?: (tab: string) => void
  /** Rendered above the document in the overview tab. */
  overviewLead?: ReactNode
  /** A header row inside the overview document card (file name, size, reading time). */
  docHeader?: ReactNode
  /** Cards stacked above the meta card in the side rail. */
  sideCards?: ReactNode
  /** Heading for the meta card. */
  metaTitle?: string
  /**
   * `hero` puts the actions at the header's trailing edge. The side rail then
   * belongs to the overview alone, and the other tabs take the full width.
   */
  actionsPlacement?: 'sidebar' | 'hero'
}

/**
 * Shared, data-source-agnostic skill detail layout. Both the online market
 * detail and the locally-installed skill detail render through this view so
 * the reading experience stays identical.
 *
 * The two-column layout follows the width of the view itself (a container
 * query), not the window: the same view renders as the whole extensions page
 * and inside the 700px settings column, where a 280px rail beside the
 * document left the document a third of the pane.
 */
export function SkillDetailView(props: SkillDetailViewProps) {
  const t = useTranslation()
  const [uncontrolledTab, setUncontrolledTab] = useState('overview')
  const tab = props.activeTab ?? uncontrolledTab
  const setTab = (next: string) => {
    if (props.activeTab === undefined) setUncontrolledTab(next)
    props.onTabChange?.(next)
  }
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // Some sources hand us the raw SKILL.md (frontmatter included), others strip
  // it upstream and pass the parsed block separately. Handle both.
  const overview = useMemo(() => splitFrontmatter(props.description), [props.description])
  const skillFrontmatter = overview.frontmatter ?? props.descriptionFrontmatter

  const heroActions = props.actionsPlacement === 'hero'
  const sidebarActions = heroActions ? undefined : props.actions
  const showAside = !heroActions || tab === 'overview'
  const extraTabs = props.extraTabs ?? []
  const activeExtra = extraTabs.find((extra) => extra.key === tab)

  const tabs: Array<{ key: string; label: string; icon: LucideIcon; badge?: ReactNode }> = [
    { key: 'overview', label: t('market.detail.overview'), icon: FileText },
    {
      key: 'files',
      label: t('market.detail.files'),
      icon: Folder,
      badge: <Badge size="xs" mono>{props.files.length}</Badge>,
    },
    ...extraTabs.map((extra) => ({ key: extra.key, label: extra.label, icon: extra.icon ?? FileText, badge: extra.badge })),
  ]

  return (
    <div
      className="@container min-h-0 flex-1 overflow-y-auto bg-[var(--color-surface)]"
      data-testid="skill-detail-view"
    >
      {/*
        `@4xl:h-full` (not `min-h-full`) on purpose: a flex column sized by
        min-height stays `height: auto`, so `flex-1`'s `flex-basis: 0%` cannot
        resolve and the panel below falls back to content height — which is what
        left the bottom of the page empty. A definite height makes the tab panel
        claim the leftover space. Narrow layouts keep the page scrolling.
      */}
      <div className={cx(props.framed ? 'w-full' : EXTENSION_PAGE_COLUMN, 'flex flex-col pb-12 @4xl:h-full', props.framed ? 'pt-0' : 'pt-5')}>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit"
          icon={<ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />}
          onClick={props.onBack}
        >
          {props.backLabel}
        </Button>

        <header className="mt-4 flex-shrink-0">
          <div className="flex min-w-0 flex-wrap items-start gap-4 sm:flex-nowrap">
            <SkillAvatar skill={{ name: props.name, iconUrl: props.iconUrl }} size={56} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  className="min-w-0 break-words text-[22px] font-semibold leading-[30px] text-[var(--color-text-primary)] outline-none"
                >
                  {props.name}
                </h1>
                {props.version && (
                  <Badge variant="outline" size="xs" mono data-testid="skill-detail-version">
                    v{props.version}
                  </Badge>
                )}
              </div>
              {props.metaLine ? (
                <p
                  data-testid="skill-detail-meta-line"
                  className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-text-tertiary)]"
                >
                  {props.metaLine}
                </p>
              ) : (
                <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{props.sourceLabel}</p>
              )}
              {props.summary && (
                <p className="mt-2 max-w-[72ch] break-words text-[13px] leading-[1.6] text-[var(--color-text-secondary)]">
                  {props.summary}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {props.chips ?? (
                  <>
                    {props.securityStatus && <SecurityBadge status={props.securityStatus} />}
                    {props.installState && <InstallStateBadge state={props.installState} />}
                  </>
                )}
              </div>
            </div>
            {heroActions && props.actions && (
              <div data-testid="skill-detail-hero-actions" className="flex flex-shrink-0 flex-wrap items-center gap-2">
                {props.actions}
              </div>
            )}
          </div>

          {props.installState === 'not-installable' && props.notInstallableReason && (
            <div
              data-testid="market-not-installable-reason"
              className="mt-4 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-[13px] text-[var(--color-on-error-container)]"
            >
              <CircleSlash2 className="mt-[3px] flex-shrink-0" size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t(`market.reason.${props.notInstallableReason}`)}</span>
            </div>
          )}

          {props.securityReports && props.securityReports.length > 0 && (
            <div
              className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]"
              data-testid="market-security-reports"
            >
              <span className="text-xs text-[var(--color-text-tertiary)]">{t('market.detail.securityReport')}</span>
              {props.securityReports.map((report) => (
                <span key={report.vendor} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-xs text-[var(--color-text-primary)]">{report.vendor}</span>
                  <span className="text-[var(--color-text-secondary)]">{report.statusText}</span>
                  {report.reportUrl && (
                    <a
                      href={report.reportUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] text-xs text-[var(--color-text-accent)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t('market.detail.viewReport')}
                      <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
                    </a>
                  )}
                </span>
              ))}
            </div>
          )}

          {props.stats && props.stats.length > 0 && (
            <dl
              data-testid="skill-detail-stats"
              className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3"
            >
              {props.stats.map((stat) => (
                <div
                  key={stat.label}
                  className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-3"
                >
                  <dt className="text-xs text-[var(--color-text-tertiary)]">{stat.label}</dt>
                  <dd className="mt-1 truncate text-[22px] font-semibold leading-7 tabular-nums text-[var(--color-text-primary)]">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {props.banner}
        </header>

        <div
          className={cx(
            'mt-5 grid gap-5 @4xl:min-h-0 @4xl:flex-1 @4xl:items-stretch @4xl:gap-8',
            showAside && '@4xl:grid-cols-[minmax(0,1fr)_280px]',
          )}
        >
          <main className="flex min-w-0 flex-col @4xl:min-h-0">
            <div
              role="tablist"
              aria-label={props.name}
              className="flex flex-shrink-0 flex-wrap items-center gap-x-5 border-b border-[var(--color-border)]"
            >
              {tabs.map((entry) => {
                const active = tab === entry.key
                const Icon = entry.icon
                return (
                  <button
                    key={entry.key}
                    id={`skill-detail-tab-${entry.key}-trigger`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`skill-detail-${entry.key}-panel`}
                    data-testid={`skill-detail-tab-${entry.key}`}
                    onClick={() => setTab(entry.key)}
                    className={`relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
                      active
                        ? 'border-[var(--color-brand)] text-[var(--color-text-primary)]'
                        : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                    }`}
                  >
                    <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                    {entry.label}
                    {entry.badge}
                  </button>
                )
              })}
            </div>

            {tab === 'overview' && (
              <div className="mt-5 flex flex-col gap-4 @4xl:min-h-0 @4xl:flex-1">
                {props.overviewLead}
                <section
                  id="skill-detail-overview-panel"
                  role="tabpanel"
                  aria-labelledby="skill-detail-tab-overview-trigger"
                  className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-6 py-6 sm:px-8 @4xl:min-h-0 @4xl:flex-1 @4xl:overflow-y-auto"
                  data-testid="skill-detail-overview"
                >
                  {props.docHeader && (
                    <header
                      data-testid="skill-detail-doc-header"
                      className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] pb-3 text-xs text-[var(--color-text-tertiary)]"
                    >
                      {props.docHeader}
                    </header>
                  )}
                  {overview.body.trim() ? (
                    <MarkdownRenderer content={overview.body} variant="document" className="mx-auto max-w-[72ch]" />
                  ) : (
                    <p className="py-6 text-center text-[13px] text-[var(--color-text-tertiary)]">{t('market.detail.noDescription')}</p>
                  )}
                </section>
              </div>
            )}

            {tab === 'files' && (
              <section
                id="skill-detail-files-panel"
                role="tabpanel"
                aria-labelledby="skill-detail-tab-files-trigger"
                className="mt-5 flex min-h-[22rem] flex-col @4xl:min-h-0 @4xl:flex-1"
                data-testid="skill-detail-files"
              >
                <FilePreview files={props.files} loadFile={props.loadFile} />
              </section>
            )}

            {activeExtra && (
              <section
                id={`skill-detail-${activeExtra.key}-panel`}
                role="tabpanel"
                aria-labelledby={`skill-detail-tab-${activeExtra.key}-trigger`}
                className="mt-5 flex flex-col gap-4"
                data-testid={`skill-detail-${activeExtra.key}`}
              >
                {activeExtra.content}
              </section>
            )}
          </main>

          {showAside && (
            <aside
              data-testid="skill-detail-sidebar"
              className="order-first flex min-w-0 flex-col gap-4 @4xl:order-none @4xl:max-h-full @4xl:self-start @4xl:overflow-y-auto"
            >
              {props.sideCards}
              <Card radius="lg" surface="lowest" padding="none" className="overflow-hidden">
                {props.metaTitle && (
                  <h2 className="px-4 pt-3.5 text-[13px] font-semibold text-[var(--color-text-primary)]">
                    {props.metaTitle}
                  </h2>
                )}
                {sidebarActions && (
                  <div className="px-4 pt-4 [&>button]:w-full [&>button]:justify-center">
                    {sidebarActions}
                  </div>
                )}
                {props.meta.length > 0 && (
                  <dl className="px-4 pt-1">
                    {props.meta.map((item) => (
                      <div
                        key={item.label}
                        className="flex min-w-0 items-baseline justify-between gap-4 border-b border-[var(--color-border)] py-2.5 last:border-b-0"
                      >
                        <dt className="text-xs text-[var(--color-text-tertiary)]">{item.label}</dt>
                        <dd className="max-w-[62%] break-words text-right text-[13px] font-medium text-[var(--color-text-primary)]">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {/*
                  The skill's own declared attributes belong with the market ones
                  above — same kind of data, different source. Keeping them here
                  leaves the overview tab free to answer "what is this skill?"
                  first, which is what a reader opens the page for.
                */}
                <FrontmatterPanel
                  frontmatter={skillFrontmatter}
                  variant="sidebar"
                  className={sidebarActions || props.meta.length > 0 ? 'border-t border-[var(--color-border)]' : ''}
                />
              </Card>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
