import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  ChevronRight,
  FileStack,
  Folder,
  Layers,
  Package,
  Puzzle,
  SearchX,
  Share2,
  User,
  type LucideIcon,
} from 'lucide-react'
import { useSkillStore } from '../../stores/skillStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { cx } from '@/lib/cx'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { SearchField } from '@/components/ui/SearchField'
import type { SkillMeta, SkillSource } from '../../types/skill'

const SOURCE_ORDER: SkillSource[] = ['user', 'project', 'plugin', 'mcp', 'bundled']

const SOURCE_ICONS: Record<SkillSource, LucideIcon> = {
  user: User,
  project: Folder,
  plugin: Puzzle,
  mcp: Share2,
  bundled: Package,
}

function estimateTokens(contentLength: number) {
  return Math.ceil(contentLength / 4)
}

/**
 * The installed-skill browser.
 *
 * It renders under a page head that already names it (the settings pane or the
 * extensions frame), so it opens on the search box rather than a title of its
 * own. Sources are grouped cards of rows with hairlines between them; the
 * source icons share one neutral tile — the four tinted chips they had were
 * status colors standing in for categories that have no state.
 */
export function SkillList({ compact = false }: { compact?: boolean }) {
  const { skills, isLoading, error, fetchSkills, fetchSkillDetail } =
    useSkillStore()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const t = useTranslation()
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined
  const [searchQuery, setSearchQuery] = useState('')
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase()

  useEffect(() => {
    fetchSkills(currentWorkDir)
  }, [fetchSkills, currentWorkDir])

  const filteredSkills = useMemo(() => {
    if (!normalizedSearchQuery) return skills

    return skills.filter((skill) => {
      const fields = [
        skill.name,
        skill.displayName,
        skill.description,
        skill.source,
        t(`settings.skills.source.${skill.source}`),
        skill.version,
        skill.pluginName,
      ]

      return fields.some((field) =>
        field?.toLocaleLowerCase().includes(normalizedSearchQuery),
      )
    })
  }, [skills, normalizedSearchQuery, t])

  const grouped = useMemo(() => {
    const result: Partial<Record<SkillSource, SkillMeta[]>> = {}
    for (const skill of filteredSkills) {
      const src = skill.source as SkillSource
      ;(result[src] ??= []).push(skill)
    }
    return result
  }, [filteredSkills])

  const totalTokens = useMemo(
    () => filteredSkills.reduce((sum, skill) => sum + estimateTokens(skill.contentLength), 0),
    [filteredSkills],
  )

  const visibleGroupCount = useMemo(
    () => SOURCE_ORDER.filter((source) => (grouped[source] ?? []).length > 0).length,
    [grouped],
  )

  if (isLoading) {
    return <LoadingState label={t('common.loading')} labelHidden />
  }

  if (error) {
    // Was a bare red line of text with no role, so a screen reader only found
    // the failure by walking into it.
    return <ErrorState title={error} />
  }

  if (skills.length === 0) {
    return (
      <EmptyState
        icon={<Box size={20} strokeWidth={1.75} aria-hidden="true" />}
        title={t('settings.skills.empty')}
        description={t('settings.skills.emptyHint')}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <SearchField
          label={t('settings.skills.searchLabel')}
          placeholder={t('settings.skills.searchPlaceholder')}
          value={searchQuery}
          onChange={setSearchQuery}
          onClear={() => setSearchQuery('')}
          clearLabel={t('settings.skills.clearSearch')}
        />
        {normalizedSearchQuery && (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {t('settings.skills.searchResultCount', {
              count: String(filteredSkills.length),
              total: String(skills.length),
            })}
          </p>
        )}
      </div>

      {!compact && (
        // Column count follows the track width, not the viewport: three fixed
        // columns clipped the CJK labels in a narrow settings pane.
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3">
          <SummaryCard
            label={t('settings.skills.summary.totalSkills')}
            value={String(filteredSkills.length)}
            icon={Box}
          />
          <SummaryCard
            label={t('settings.skills.summary.sources')}
            value={String(visibleGroupCount)}
            icon={Layers}
          />
          <SummaryCard
            label={t('settings.skills.summary.tokens')}
            value={t('settings.skills.tokenEstimateShort', { count: String(totalTokens) })}
            icon={FileStack}
          />
        </div>
      )}

      {filteredSkills.length === 0 && (
        <EmptyState
          icon={<SearchX size={20} strokeWidth={1.75} aria-hidden="true" />}
          title={t('settings.skills.noSearchResults')}
          description={t('settings.skills.noSearchResultsHint')}
          action={{ label: t('settings.skills.clearSearch'), onClick: () => setSearchQuery('') }}
        />
      )}

      {/* Two columns only where the list owns a wide page; the settings pane
          is one fixed column whatever the window width. */}
      <div className={cx('grid gap-5', compact && visibleGroupCount >= 2 && 'xl:grid-cols-2 xl:items-start')}>
        {SOURCE_ORDER.map((source) => {
          const group = grouped[source]
          if (!group?.length) return null

          const sourceLabel = t(`settings.skills.source.${source}`)
          const SourceIcon = SOURCE_ICONS[source]
          const sourceTokenCount = group.reduce(
            (sum, skill) => sum + estimateTokens(skill.contentLength),
            0,
          )

          return (
            <section key={source} className="min-w-0">
              <div
                className="mb-2 flex items-center gap-2 px-0.5"
                title={t('settings.skills.groupHint', { source: sourceLabel, count: String(group.length) })}
              >
                <SourceIcon className="flex-shrink-0 text-[var(--color-text-tertiary)]" size={14} strokeWidth={1.75} aria-hidden="true" />
                <h4 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
                  {sourceLabel}
                </h4>
                <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                  {group.length}
                </span>
                <span className="ml-auto whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                  {t('settings.skills.tokenEstimateShort', { count: String(sourceTokenCount) })}
                </span>
              </div>

              <Card
                radius="lg"
                surface="lowest"
                padding="none"
                className="divide-y divide-[var(--color-border)] overflow-hidden"
              >
                {group.map((skill) => (
                  <button
                    key={`${skill.source}-${skill.name}`}
                    onClick={() =>
                      skill.hasDirectory &&
                      fetchSkillDetail(skill.source, skill.name, currentWorkDir, 'skills')
                    }
                    disabled={!skill.hasDirectory}
                    className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]">
                      <Box size={14} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="break-all text-[13px] font-medium text-[var(--color-text-primary)]">
                          {skill.displayName || skill.name}
                        </span>
                        {skill.version && <Badge mono>v{skill.version}</Badge>}
                        {skill.userInvocable && (
                          <Badge variant="outline">{t('settings.skills.slashCommand')}</Badge>
                        )}
                        {/* Only flagged for `.agents`: `.claude` is the norm and
                            badging it would be noise on every existing skill. */}
                        {skill.rootFlavor === 'agents' && (
                          // The badge covers both scopes, and they are not
                          // equally trusted: a project one ships with the
                          // repository rather than being installed by the
                          // user — hence two hint strings.
                          <Badge
                            mono
                            title={t(skill.source === 'project'
                              ? 'settings.skills.agentsDirProjectHint'
                              : 'settings.skills.agentsDirHint')}
                          >
                            {t('settings.skills.agentsDirBadge')}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 break-words text-xs leading-5 text-[var(--color-text-secondary)]">
                        {skill.description}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-text-tertiary)]">
                        <span>{sourceLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-[11px] tabular-nums">{t('settings.skills.tokenEstimateShort', { count: String(estimateTokens(skill.contentLength)) })}</span>
                        <span aria-hidden="true">·</span>
                        <span>{skill.hasDirectory ? t('settings.skills.ready') : t('settings.skills.unavailable')}</span>
                      </div>
                    </div>
                    <ChevronRight
                      className="mt-1.5 flex-shrink-0 text-[var(--color-text-tertiary)] opacity-60 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none"
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </Card>
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** Label above, figure below: the figure is what the eye lands on. */
function SummaryCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: LucideIcon
}) {
  return (
    <Card radius="lg" surface="lowest" padding="none" className="min-w-0 px-4 py-3">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
        <Icon className="flex-shrink-0" size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate text-[22px] font-semibold leading-7 tabular-nums text-[var(--color-text-primary)]">
        {value}
      </div>
    </Card>
  )
}
