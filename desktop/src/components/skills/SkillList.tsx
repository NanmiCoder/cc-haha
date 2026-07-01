import { useEffect, useMemo, useState } from 'react'
import { useSkillStore } from '../../stores/skillStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import type { SkillMeta, SkillSource } from '../../types/skill'

const SOURCE_ORDER: SkillSource[] = ['user', 'project', 'plugin', 'mcp', 'bundled']

const SOURCE_ICONS: Record<SkillSource, string> = {
  user: 'person',
  project: 'folder',
  plugin: 'extension',
  mcp: 'hub',
  bundled: 'inventory_2',
}

const SOURCE_ACCENT_CLASSES: Record<SkillSource, string> = {
  user: 'bg-[var(--color-primary-fixed)] text-[var(--color-brand)]',
  project: 'bg-[var(--color-success-container)] text-[var(--color-success)]',
  plugin: 'bg-[var(--color-warning-container)] text-[var(--color-warning)]',
  mcp: 'bg-[var(--color-info-container)] text-[var(--color-info)]',
  bundled: 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]',
}

function estimateTokens(contentLength: number) {
  return Math.ceil(contentLength / 4)
}

// Localized labels for built-in catalog skills. Keyed by the stable catalog
// `name` / `category`; falls back to the server-provided English value when a
// key is absent (e.g. a newly added catalog entry without translations yet).
const CATALOG_DESC_KEY: Record<string, TranslationKey> = {
  'coderabbit-review': 'settings.skills.catalog.coderabbit-review.desc',
  'circleci-cli': 'settings.skills.catalog.circleci-cli.desc',
  'react-best-practices': 'settings.skills.catalog.react-best-practices.desc',
  'frontend-testing-debugging': 'settings.skills.catalog.frontend-testing-debugging.desc',
  'stripe-best-practices': 'settings.skills.catalog.stripe-best-practices.desc',
  'supabase-best-practices': 'settings.skills.catalog.supabase-best-practices.desc',
  'temporal-developer': 'settings.skills.catalog.temporal-developer.desc',
  'karpathy-guidelines': 'settings.skills.catalog.karpathy-guidelines.desc',
  'mattpocock-grilling': 'settings.skills.catalog.mattpocock-grilling.desc',
  'mattpocock-tdd': 'settings.skills.catalog.mattpocock-tdd.desc',
  'mattpocock-diagnosing-bugs': 'settings.skills.catalog.mattpocock-diagnosing-bugs.desc',
}

const CATEGORY_LABEL_KEY: Record<string, TranslationKey> = {
  'Code Review': 'settings.skills.category.codeReview',
  'CI/CD': 'settings.skills.category.cicd',
  Frontend: 'settings.skills.category.frontend',
  Payments: 'settings.skills.category.payments',
  Database: 'settings.skills.category.database',
  Workflows: 'settings.skills.category.workflows',
  Workflow: 'settings.skills.category.workflow',
  Productivity: 'settings.skills.category.productivity',
  Engineering: 'settings.skills.category.engineering',
}

export function SkillList() {
  const {
    skills,
    isLoading,
    error,
    fetchSkills,
    fetchSkillDetail,
    catalog,
    installingName,
    fetchCatalog,
    installSkill,
  } = useSkillStore()
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

  useEffect(() => {
    fetchCatalog()
  }, [fetchCatalog])

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

  const filteredCatalog = useMemo(() => {
    // Defensive: zustand store always seeds `catalog: []`, but a partial
    // store mock or an unexpected initialization race (e.g. SSR/hydration
    // timing) could surface `undefined`. Guarding here keeps the entire
    // Skills page from white-screening with `Cannot read properties of
    // undefined (reading 'length')` at the .length check below.
    const list = catalog ?? []
    if (!normalizedSearchQuery) return list
    return list.filter((entry) =>
      [entry.name, entry.displayName, entry.description, entry.category].some(
        (field) => field?.toLocaleLowerCase().includes(normalizedSearchQuery),
      ),
    )
  }, [catalog, normalizedSearchQuery])

  const totalTokens = useMemo(
    () => filteredSkills.reduce((sum, skill) => sum + estimateTokens(skill.contentLength), 0),
    [filteredSkills],
  )

  const visibleGroupCount = useMemo(
    () => SOURCE_ORDER.filter((source) => (grouped[source] ?? []).length > 0).length,
    [grouped],
  )

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin w-5 h-5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
      </div>
    )
  }

  if (error) {
    return <div className="text-sm text-[var(--color-error)] py-4">{error}</div>
  }

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] overflow-hidden">
        <div className="grid gap-4 px-5 py-5 min-w-0 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] xl:items-end">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)] mb-2">
              {t('settings.skills.browserEyebrow')}
            </div>
            <div className="flex items-center gap-3 mb-2">
              <span className="material-symbols-outlined text-[22px] text-[var(--color-brand)]">
                auto_awesome
              </span>
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
                {t('settings.skills.browserTitle')}
              </h3>
            </div>
            <p className="text-sm leading-6 text-[var(--color-text-secondary)] max-w-3xl">
              {t('settings.skills.browserDescription')}
            </p>
            <div className="mt-4 max-w-2xl">
              <label className="sr-only" htmlFor="settings-skill-search">
                {t('settings.skills.searchLabel')}
              </label>
              <div className="flex min-h-11 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 transition-colors focus-within:border-[var(--color-border-focus)] focus-within:ring-2 focus-within:ring-[var(--color-brand)]/20">
                <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
                  search
                </span>
                <input
                  id="settings-skill-search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t('settings.skills.searchPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label={t('settings.skills.clearSearch')}
                    onClick={() => setSearchQuery('')}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
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

          <div className="grid grid-cols-2 gap-3 min-w-0 sm:grid-cols-3">
            <SummaryCard
              label={t('settings.skills.summary.totalSkills')}
              value={String(filteredSkills.length)}
              icon="auto_awesome"
            />
            <SummaryCard
              label={t('settings.skills.summary.sources')}
              value={String(
                SOURCE_ORDER.filter((source) => (grouped[source] ?? []).length > 0)
                  .length,
              )}
              icon="layers"
            />
            <SummaryCard
              label={t('settings.skills.summary.tokens')}
              value={t('settings.skills.tokenEstimateShort', { count: String(totalTokens) })}
              icon="notes"
              className="col-span-2 sm:col-span-1"
            />
          </div>
        </div>
      </section>

      {filteredCatalog.length > 0 && (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden min-w-0">
          <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-primary-fixed)] text-[var(--color-brand)]">
                  <span className="material-symbols-outlined text-[16px]">download</span>
                </span>
                <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {t('settings.skills.recommended.title')}
                </h4>
                <span className="text-xs text-[var(--color-text-tertiary)]">
                  {filteredCatalog.length}
                </span>
              </div>
              <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
                {t('settings.skills.recommended.description')}
              </p>
            </div>
          </div>

          <div className="grid gap-2 p-2 sm:grid-cols-2">
            {filteredCatalog.map((entry) => {
              const isInstalling = installingName === entry.name
              const descKey = CATALOG_DESC_KEY[entry.name]
              const catKey = CATEGORY_LABEL_KEY[entry.category]
              return (
                <div
                  key={entry.name}
                  className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 min-w-0"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <span className="mt-0.5 material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
                      auto_awesome
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">
                          {entry.displayName}
                        </span>
                        <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                          {catKey ? t(catKey) : entry.category}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)] break-words">
                        {descKey ? t(descKey) : entry.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end">
                    {entry.installed ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-success)]">
                        <span className="material-symbols-outlined text-[16px]">check_circle</span>
                        {t('settings.skills.recommended.installed')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => installSkill(entry.name, currentWorkDir)}
                        disabled={isInstalling}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:opacity-60 disabled:cursor-default"
                      >
                        {isInstalling ? (
                          <>
                            <span className="animate-spin w-3.5 h-3.5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
                            {t('settings.skills.recommended.installing')}
                          </>
                        ) : (
                          <>
                            <span className="material-symbols-outlined text-[16px]">download</span>
                            {t('settings.skills.recommended.install')}
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {filteredSkills.length === 0 && normalizedSearchQuery && (
        <div className="text-center py-12 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6">
          <span className="material-symbols-outlined text-[40px] text-[var(--color-text-tertiary)] mb-2 block">
            search_off
          </span>
          <p className="text-sm text-[var(--color-text-tertiary)]">
            {t('settings.skills.noSearchResults')}
          </p>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
            {t('settings.skills.noSearchResultsHint')}
          </p>
        </div>
      )}

      {skills.length === 0 && !normalizedSearchQuery && (
        <div className="text-center py-12 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6">
          <span className="material-symbols-outlined text-[40px] text-[var(--color-text-tertiary)] mb-2 block">
            auto_awesome
          </span>
          <p className="text-sm text-[var(--color-text-tertiary)]">
            {t('settings.skills.empty')}
          </p>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
            {t('settings.skills.emptyHint')}
          </p>
        </div>
      )}

      <div className={`grid gap-4 ${visibleGroupCount >= 2 ? 'xl:grid-cols-2' : ''}`}>
        {SOURCE_ORDER.map((source) => {
          const group = grouped[source]
          if (!group?.length) return null

          const sourceLabel = t(`settings.skills.source.${source}`)
          const sourceTokenCount = group.reduce(
            (sum, skill) => sum + estimateTokens(skill.contentLength),
            0,
          )

          return (
            <section
              key={source}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden min-w-0"
            >
              <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${SOURCE_ACCENT_CLASSES[source]}`}>
                      <span className="material-symbols-outlined text-[16px]">
                        {SOURCE_ICONS[source]}
                      </span>
                    </span>
                    <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                      {sourceLabel}
                    </h4>
                    <span className="text-xs text-[var(--color-text-tertiary)]">
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
                <div className="text-[11px] text-[var(--color-text-tertiary)] whitespace-nowrap">
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
                    className="group rounded-xl border border-transparent px-3 py-3 text-left transition-all hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:border-transparent"
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
                        auto_awesome
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">
                            {skill.displayName || skill.name}
                          </span>
                          {skill.version && (
                            <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                              v{skill.version}
                            </span>
                          )}
                          {skill.userInvocable && (
                            <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                              {t('settings.skills.slashCommand')}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)] break-words">
                          {skill.description}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                          <span>{sourceLabel}</span>
                          <span>{t('settings.skills.tokenEstimateShort', { count: String(estimateTokens(skill.contentLength)) })}</span>
                          <span>{skill.hasDirectory ? t('settings.skills.ready') : t('settings.skills.unavailable')}</span>
                        </div>
                      </div>
                      <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100">
                        chevron_right
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  icon,
  className = '',
}: {
  label: string
  value: string
  icon: string
  className?: string
}) {
  return (
    <div className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 min-w-0 ${className}`}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)] min-w-0">
        <span className="material-symbols-outlined text-[14px] flex-shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-lg font-semibold text-[var(--color-text-primary)] truncate">
        {value}
      </div>
    </div>
  )
}
