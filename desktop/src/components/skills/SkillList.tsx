import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  FileStack,
  Folder,
  Layers,
  Package,
  Puzzle,
  Search,
  SearchX,
  Share2,
  Sparkles,
  User,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useSkillStore } from '../../stores/skillStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
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

/** Fill plus its AA-checked foreground — never the accent on its own tint. */
const SOURCE_ACCENT_CLASSES: Record<SkillSource, string> = {
  user: 'bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)]',
  project: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]',
  plugin: 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]',
  mcp: 'bg-[var(--color-info-container)] text-[var(--color-on-info-container)]',
  bundled: 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]',
}

function estimateTokens(contentLength: number) {
  return Math.ceil(contentLength / 4)
}

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
        icon={<Sparkles size={20} strokeWidth={1.6} aria-hidden="true" />}
        title={t('settings.skills.empty')}
        description={t('settings.skills.emptyHint')}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {compact ? (
        <SearchField
          label={t('settings.skills.searchLabel')}
          placeholder={t('settings.skills.searchPlaceholder')}
          value={searchQuery}
          onChange={setSearchQuery}
          onClear={() => setSearchQuery('')}
          clearLabel={t('settings.skills.clearSearch')}
        />
      ) : (
      <Card radius="xl" surface="low" padding="none" className="overflow-hidden">
        <div className="grid min-w-0 gap-5 px-5 py-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(400px,1fr)] xl:items-end">
          <div className="min-w-0">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">
              {t('settings.skills.browserEyebrow')}
            </div>
            <div className="mb-2 flex items-center gap-2.5">
              <Sparkles className="h-[22px] w-[22px] text-[var(--color-brand)]" strokeWidth={1.5} aria-hidden="true" />
              <h3
                style={{ fontFamily: 'var(--font-headline)' }}
                className="text-[21px] font-bold tracking-[-0.01em] text-[var(--color-text-primary)]"
              >
                {t('settings.skills.browserTitle')}
              </h3>
            </div>
            <p className="max-w-3xl text-sm leading-6 text-[var(--color-text-secondary)]">
              {t('settings.skills.browserDescription')}
            </p>
            <div className="mt-4 max-w-2xl">
              <label className="sr-only" htmlFor="settings-skill-search">
                {t('settings.skills.searchLabel')}
              </label>
              <div className="flex min-h-11 items-center gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 transition-colors focus-within:border-[var(--color-border-focus)] focus-within:shadow-[var(--shadow-focus-ring)]">
                <Search className="h-[15px] w-[15px] flex-shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={1.6} aria-hidden="true" />
                <input
                  id="settings-skill-search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t('settings.skills.searchPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
                />
                {searchQuery && (
                  <IconButton
                    icon={<X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
                    label={t('settings.skills.clearSearch')}
                    size="sm"
                    shape="circle"
                    tone="muted"
                    onClick={() => setSearchQuery('')}
                  />
                )}
              </div>
              {normalizedSearchQuery && (
                <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
                  {t('settings.skills.searchResultCount', {
                    count: String(filteredSkills.length),
                    total: String(skills.length),
                  })}
                </p>
              )}
            </div>
          </div>

          {/* Column count follows the track width, not the viewport: `sm:grid-cols-3` kept
              forcing three columns into a 320px sidebar column and clipped the CJK labels. */}
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(116px,1fr))] gap-3">
            <SummaryCard
              label={t('settings.skills.summary.totalSkills')}
              value={String(filteredSkills.length)}
              icon={Sparkles}
            />
            <SummaryCard
              label={t('settings.skills.summary.sources')}
              value={String(
                SOURCE_ORDER.filter((source) => (grouped[source] ?? []).length > 0)
                  .length,
              )}
              icon={Layers}
            />
            <SummaryCard
              label={t('settings.skills.summary.tokens')}
              value={t('settings.skills.tokenEstimateShort', { count: String(totalTokens) })}
              icon={FileStack}
            />
          </div>
        </div>
      </Card>
      )}

      {filteredSkills.length === 0 && (
        <EmptyState
          icon={<SearchX size={20} strokeWidth={1.6} aria-hidden="true" />}
          title={t('settings.skills.noSearchResults')}
          description={t('settings.skills.noSearchResultsHint')}
          action={{ label: t('settings.skills.clearSearch'), onClick: () => setSearchQuery('') }}
        />
      )}

      <div className={`grid gap-4 ${visibleGroupCount >= 2 ? 'xl:grid-cols-2' : ''}`}>
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
            <Card
              key={source}
              as="section"
              radius="xl"
              surface="base"
              padding="none"
              className="min-w-0 overflow-hidden"
            >
              <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4">
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${SOURCE_ACCENT_CLASSES[source]}`}>
                      <SourceIcon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
                    </span>
                    <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                      {sourceLabel}
                    </h4>
                    <span className="font-mono text-xs text-[var(--color-text-tertiary)]">
                      {group.length}
                    </span>
                  </div>
                  <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
                    {t('settings.skills.groupHint', {
                      source: sourceLabel,
                      count: String(group.length),
                    })}
                  </p>
                </div>
                <div className="whitespace-nowrap font-mono text-[11px] text-[var(--color-text-tertiary)]">
                  {t('settings.skills.tokenEstimateShort', { count: String(sourceTokenCount) })}
                </div>
              </div>

              <div className="flex flex-col p-2">
                {group.map((skill) => (
                  <button
                    key={`${skill.source}-${skill.name}`}
                    onClick={() =>
                      skill.hasDirectory &&
                      fetchSkillDetail(skill.source, skill.name, currentWorkDir, 'skills')
                    }
                    disabled={!skill.hasDirectory}
                    className="group rounded-[var(--radius-lg)] border border-transparent px-3 py-3 text-left transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-transparent disabled:hover:bg-transparent"
                  >
                    <div className="flex items-start gap-3">
                      <Sparkles className="mt-0.5 h-[18px] w-[18px] flex-shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={1.5} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="break-all text-sm font-semibold text-[var(--color-text-primary)]">
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
                        <p className="mt-1 break-words text-xs leading-5 text-[var(--color-text-secondary)]">
                          {skill.description}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                          <span>{sourceLabel}</span>
                          <span className="font-mono">{t('settings.skills.tokenEstimateShort', { count: String(estimateTokens(skill.contentLength)) })}</span>
                          <span>{skill.hasDirectory ? t('settings.skills.ready') : t('settings.skills.unavailable')}</span>
                        </div>
                      </div>
                      <ChevronRight
                        className="h-[18px] w-[18px] flex-shrink-0 text-[var(--color-text-tertiary)] opacity-60 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:opacity-100 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                        strokeWidth={1.6}
                        aria-hidden="true"
                      />
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  className = '',
}: {
  label: string
  value: string
  icon: LucideIcon
  className?: string
}) {
  return (
    <Card radius="lg" padding="sm" className={`min-w-0 ${className}`}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
        <Icon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.6} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      {/* Statistic, so it takes the serif face the handoff pins on big numbers. */}
      <div
        style={{ fontFamily: 'var(--font-headline)' }}
        className="mt-2 truncate text-[21px] font-bold text-[var(--color-text-primary)]"
      >
        {value}
      </div>
    </Card>
  )
}
