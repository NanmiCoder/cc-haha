import { useEffect, useMemo, useState } from 'react'
import {
  Blocks,
  Check,
  Folder,
  Network,
  PackageOpen,
  RefreshCw,
  Search,
  Sparkles,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useSessionStore } from '../../stores/sessionStore'
import { useSkillStore } from '../../stores/skillStore'
import type { SkillMeta, SkillSource } from '../../types/skill'

type InstalledSkillFilter = 'all' | 'personal' | 'system'

const COLLAPSED_SKILL_COUNT = 6

const SOURCE_ICONS: Record<SkillSource, LucideIcon> = {
  user: UserRound,
  project: Folder,
  plugin: Blocks,
  mcp: Network,
  bundled: PackageOpen,
}

const PERSONAL_SOURCES = new Set<SkillSource>(['user', 'project'])

function skillMatchesFilter(skill: SkillMeta, filter: InstalledSkillFilter) {
  if (filter === 'all') return true
  const personal = PERSONAL_SOURCES.has(skill.source)
  return filter === 'personal' ? personal : !personal
}

export function InstalledSkillsOverview() {
  const t = useTranslation()
  const skills = useSkillStore((state) => state.skills)
  const isLoading = useSkillStore((state) => state.isLoading)
  const error = useSkillStore((state) => state.error)
  const fetchSkills = useSkillStore((state) => state.fetchSkills)
  const fetchSkillDetail = useSkillStore((state) => state.fetchSkillDetail)
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<InstalledSkillFilter>('all')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    void fetchSkills(currentWorkDir)
  }, [currentWorkDir, fetchSkills])

  const filteredSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return skills
      .filter((skill) => skillMatchesFilter(skill, filter))
      .filter((skill) => {
        if (!normalizedQuery) return true
        return [
          skill.name,
          skill.displayName,
          skill.description,
          skill.pluginName,
          t(`settings.skills.source.${skill.source}`),
        ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
      })
      .sort((left, right) =>
        (left.displayName || left.name).localeCompare(right.displayName || right.name),
      )
  }, [filter, query, skills, t])

  const shouldCollapse = !query.trim() && filteredSkills.length > COLLAPSED_SKILL_COUNT
  const visibleSkills = shouldCollapse && !expanded
    ? filteredSkills.slice(0, COLLAPSED_SKILL_COUNT)
    : filteredSkills
  const hiddenCount = filteredSkills.length - visibleSkills.length

  return (
    <section data-testid="installed-skills-overview" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--color-border)]/60 pb-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
            {t('market.section.installed')}
          </h2>
          {!isLoading && (
            <span className="text-xs tabular-nums text-[var(--color-text-tertiary)]">
              {skills.length}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label={t('market.installedSkills.refresh')}
          title={t('market.installedSkills.refresh')}
          disabled={isLoading}
          onClick={() => void fetchSkills(currentWorkDir)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-h-10 flex-1 items-center gap-2.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 transition-colors focus-within:border-[var(--color-border-focus)] focus-within:shadow-[var(--shadow-focus-ring)]">
          <Search className="h-4 w-4 flex-shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={2} aria-hidden="true" />
          <input
            data-testid="installed-skills-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setExpanded(false)
            }}
            placeholder={t('market.installedSkills.searchPlaceholder')}
            aria-label={t('market.installedSkills.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          {query && (
            <button
              type="button"
              aria-label={t('settings.skills.clearSearch')}
              onClick={() => setQuery('')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-xl bg-[var(--color-surface-container-low)] p-1" aria-label={t('market.installedSkills.filterLabel')}>
          {(['all', 'personal', 'system'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value)
                setExpanded(false)
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
                filter === value
                  ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm'
                  : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {t(`market.installedSkills.filter.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {isLoading && skills.length === 0 && (
        <div className="grid grid-cols-1 gap-x-10 gap-y-1 md:grid-cols-2" data-testid="installed-skills-loading">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex min-h-[72px] animate-pulse items-center gap-3 border-b border-[var(--color-border)]/45 px-2 py-3">
              <div className="h-10 w-10 rounded-xl bg-[var(--color-surface-container-high)]" />
              <div className="min-w-0 flex-1">
                <div className="h-3 w-2/5 rounded bg-[var(--color-surface-container-high)]" />
                <div className="mt-2 h-2.5 w-4/5 rounded bg-[var(--color-surface-container)]" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && error && skills.length === 0 && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--color-error)]/25 bg-[var(--color-error-container)]/25 px-4 py-3">
          <p className="min-w-0 break-words text-sm text-[var(--color-error)]">{error}</p>
          <button
            type="button"
            onClick={() => void fetchSkills(currentWorkDir)}
            className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('market.retry')}
          </button>
        </div>
      )}

      {!isLoading && !error && skills.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6 py-10 text-center">
          <Sparkles className="mx-auto mb-2.5 h-8 w-8 text-[var(--color-text-tertiary)]" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.skills.empty')}</p>
          <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{t('settings.skills.emptyHint')}</p>
        </div>
      )}

      {!isLoading && skills.length > 0 && filteredSkills.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6 py-9 text-center">
          <p className="text-sm text-[var(--color-text-tertiary)]">{t('settings.skills.noSearchResults')}</p>
        </div>
      )}

      {visibleSkills.length > 0 && (
        <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2" data-testid="installed-skills-grid">
          {visibleSkills.map((skill) => {
            const Icon = SOURCE_ICONS[skill.source]
            const name = skill.displayName || skill.name
            return (
              <button
                key={`${skill.source}:${skill.name}`}
                type="button"
                aria-label={name}
                disabled={!skill.hasDirectory}
                onClick={() => void fetchSkillDetail(skill.source, skill.name, currentWorkDir, 'skills')}
                className="group flex min-h-[72px] min-w-0 items-center gap-3 border-b border-[var(--color-border)]/45 px-2 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] disabled:cursor-default disabled:opacity-55"
              >
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-surface-container-low)] text-[var(--color-text-secondary)] transition-colors group-hover:bg-[var(--color-surface-container)]">
                  <Icon className="h-[18px] w-[18px]" strokeWidth={1.7} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{name}</span>
                    {skill.version && (
                      <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">v{skill.version}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs leading-5 text-[var(--color-text-tertiary)]">
                    {skill.description}
                  </span>
                </span>
                <Check className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={1.8} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}

      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="self-start rounded-lg px-2 py-1 text-xs font-medium text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        >
          {expanded
            ? t('market.installedSkills.showLess')
            : t('market.installedSkills.showMore', { count: hiddenCount })}
        </button>
      )}
    </section>
  )
}
