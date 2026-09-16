/**
 * M6-A picker surface: the side-by-side "Hosts" / "Concepts" entry buttons that
 * sit before the model selector in both composers, plus the popover they open.
 *
 * Every entry has a real accessible name (`Button` `aria-label` /
 * `Checkbox` label / `IconButton` `label`), and the popover is deliberately NOT
 * a modal: the composer keeps focus while it is open so `/hh 生产` keeps
 * filtering as the user types and Enter confirms the highlighted option without
 * ever reaching the send path.
 */
import { useMemo } from 'react'
import { X } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Checkbox } from '../../../../components/ui/Checkbox'
import { IconButton } from '../../../../components/ui/IconButton'
import { useTranslation } from '../../../../i18n'
import {
  deriveResolvedIds,
  useContextSelectionStore,
  type ContextKind,
  type ContextPickerOption,
} from '../../stores/contextSelectionStore'

export type ContextEntryButtonsProps = {
  /** Tighter controls for the compact composer toolbar. */
  compact?: boolean
}

type SelectedSource = {
  key: string
  label: string
  remove: () => void
}

export function ContextEntryButtons({ compact = false }: ContextEntryButtonsProps) {
  const t = useTranslation()
  const pickerKind = useContextSelectionStore((s) => s.pickerKind)
  const unavailableCommand = useContextSelectionStore((s) => s.unavailableCommand)
  const pickerFilter = useContextSelectionStore((s) => s.pickerFilter)
  const highlightedIndex = useContextSelectionStore((s) => s.highlightedIndex)
  const pick = useContextSelectionStore((s) => s.pick)
  const catalog = useContextSelectionStore((s) => s.catalog)
  const options = useContextSelectionStore((s) => s.options)
  const openPicker = useContextSelectionStore((s) => s.openPicker)
  const closePicker = useContextSelectionStore((s) => s.closePicker)
  const toggleOption = useContextSelectionStore((s) => s.toggleOption)
  const removeSourceTag = useContextSelectionStore((s) => s.removeSourceTag)
  const removeDirectId = useContextSelectionStore((s) => s.removeDirectId)
  const includePasswords = useContextSelectionStore((s) => s.includePasswords)
  const setIncludePasswords = useContextSelectionStore((s) => s.setIncludePasswords)

  // Recomputed on every change, never read from a stored id set.
  const resolved = useMemo(() => deriveResolvedIds(pick, catalog), [pick, catalog])
  // The highlight index is a flat position over the tags-then-resources list.
  const optionList = pickerKind ? options() : []

  const entries: Array<{ kind: ContextKind; label: string; count: number }> = [
    { kind: 'host', label: t('managedResources.context.hosts'), count: resolved.host.length },
    { kind: 'concept', label: t('managedResources.context.concepts'), count: resolved.concept.length },
    { kind: 'database', label: t('managedResources.context.databases'), count: resolved.database.length },
    { kind: 'redis', label: t('managedResources.context.redis'), count: resolved.redis.length },
  ]

  const optionLabel = (option: ContextPickerOption): string => option.label

  const optionDescription = (option: ContextPickerOption): string =>
    option.kind === 'tag'
      ? t('managedResources.context.tagMembers', { count: option.memberIds.length })
      : option.hint

  const tagCatalogFor = (kind: ContextKind) => {
    if (kind === 'host') return catalog.hostTags
    if (kind === 'concept') return catalog.conceptTags
    if (kind === 'database') return catalog.databaseTags
    return catalog.redisTags
  }

  const resourceCatalogFor = (kind: ContextKind) => {
    if (kind === 'host') return catalog.hosts
    if (kind === 'concept') return catalog.concepts
    return catalog.dataConnections.filter((connection) => connection.kind === kind)
  }

  const resourceName = (kind: ContextKind, source: unknown): string | undefined => {
    if (!source || typeof source !== 'object') return undefined
    if (kind === 'concept') return (source as { title?: string }).title
    return (source as { name?: string }).name
  }

  const selectedSources = (kind: ContextKind): SelectedSource[] => {
    const tags: SelectedSource[] = pick.sourceTags
      .filter((tag) => tag.namespace === kind)
      .map((tag) => {
        const name = tagCatalogFor(kind).find((tagDef) => tagDef.id === tag.id)?.name
        const label = name ?? tag.id
        return {
          key: `tag:${tag.namespace}:${tag.id}`,
          label,
          remove: () => removeSourceTag(tag),
        }
      })
    const directs: SelectedSource[] = pick.directIds
      .filter((direct) => direct.namespace === kind)
      .map((direct) => {
        const source = resourceCatalogFor(kind).find((candidate) => candidate.id === direct.id)
        const label = resourceName(kind, source)
        return {
          key: `resource:${direct.namespace}:${direct.id}`,
          label: label ?? direct.id,
          remove: () => removeDirectId(direct),
        }
      })
    return [...tags, ...directs]
  }

  const popoverTitle = pickerKind === 'host'
    ? t('managedResources.context.hostsTitle')
    : pickerKind === 'concept'
      ? t('managedResources.context.conceptsTitle')
      : pickerKind === 'database'
        ? t('managedResources.context.databasesTitle')
        : pickerKind === 'redis'
          ? t('managedResources.context.redisTitle')
          : t('managedResources.context.unavailableTitle')

  return (
    <div className="relative flex shrink-0 items-center gap-1" data-testid="context-entry-buttons">
      {entries.map(({ kind, label, count }) => {
        const isOpen = pickerKind === kind
        return (
          <Button
            key={kind}
            size={compact ? 'sm' : 'base'}
            variant={isOpen || count > 0 ? 'tonal' : 'secondary'}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-label={t('managedResources.context.entryLabel', { name: label, count })}
            data-testid={`context-entry-${kind}`}
            data-count={count}
            onClick={() => (isOpen ? closePicker() : openPicker(kind))}
          >
            <span>{label}</span>
            <span aria-hidden="true" className="tabular-nums opacity-70" data-testid={`context-entry-${kind}-count`}>
              {count}
            </span>
          </Button>
        )
      })}

      {(pickerKind || unavailableCommand) && (
        <div
          role="dialog"
          aria-label={popoverTitle}
          data-testid="context-picker"
          data-filter={pickerFilter}
          className="absolute bottom-full left-0 z-[60] mb-2 max-h-80 w-72 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-lg)]"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-[var(--color-text-primary)]">{popoverTitle}</span>
            <IconButton
              icon={<X size={14} strokeWidth={2} />}
              label={t('managedResources.context.close')}
              size="xs"
              tone="muted"
              onClick={() => closePicker()}
            />
          </div>

          {unavailableCommand ? (
            <div data-testid="context-picker-unavailable" role="status" className="space-y-1">
              <p className="text-sm text-[var(--color-text-primary)]">
                {t('managedResources.context.unavailableTitle')}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {t('managedResources.context.unavailableBody')}
              </p>
            </div>
          ) : (
            <ContextPickerBody
              options={optionList}
              highlightedIndex={highlightedIndex}
              filter={pickerFilter}
              optionLabel={optionLabel}
              optionDescription={optionDescription}
              onToggle={toggleOption}
              selected={pickerKind ? selectedSources(pickerKind) : []}
              includePasswords={includePasswords}
              onIncludePasswordsChange={setIncludePasswords}
            />
          )}
        </div>
      )}
    </div>
  )
}

type ContextPickerBodyProps = {
  options: ContextPickerOption[]
  highlightedIndex: number
  filter: string
  optionLabel: (option: ContextPickerOption) => string
  optionDescription: (option: ContextPickerOption) => string
  onToggle: (option: ContextPickerOption) => void
  selected: SelectedSource[]
  includePasswords: boolean
  onIncludePasswordsChange: (include: boolean) => void
}

function ContextPickerBody({
  options,
  highlightedIndex,
  filter,
  optionLabel,
  optionDescription,
  onToggle,
  selected,
  includePasswords,
  onIncludePasswordsChange,
}: ContextPickerBodyProps) {
  const t = useTranslation()
  // The highlight index is a flat position over the tags-then-resources list, so
  // the sections carry the index they had in `options`, not their local one.
  const indexed = options.map((option, index) => ({ option, index }))
  const tagOptions = indexed.filter((entry) => entry.option.kind === 'tag')

  if (options.length === 0) {
    return (
      <div data-testid="context-picker-empty" role="status">
        <p className="text-xs text-[var(--color-text-secondary)]">
          {filter
            ? t('managedResources.context.noMatches', { query: filter })
            : t('managedResources.context.noResources')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <section aria-label={t('managedResources.context.tagsSection')}>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
          {t('managedResources.context.tagsSection')}
        </h3>
        {tagOptions.length === 0 ? (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {t('managedResources.context.noTags')}
          </p>
        ) : (
          <ul className="space-y-1">
            {tagOptions.map(({ option, index }) => (
              <li key={`tag:${option.kind === 'tag' ? option.tag.id : index}`}>
                <Checkbox
                  label={optionLabel(option)}
                  description={optionDescription(option)}
                  checked={option.selected}
                  data-testid={`context-option-tag-${option.kind === 'tag' ? option.tag.id : index}`}
                  data-highlighted={highlightedIndex === index ? 'true' : 'false'}
                  containerClassName={highlightedIndex === index ? 'rounded-[var(--radius-sm)] ring-1 ring-[var(--color-border-focus)]' : undefined}
                  onChange={() => onToggle(option)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t('managedResources.context.resourcesSection')}>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
          {t('managedResources.context.resourcesSection')}
        </h3>
        {options.length === tagOptions.length ? (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {t('managedResources.context.noResources')}
          </p>
        ) : (
          <ul className="space-y-1">
            {indexed
              .filter((entry) => entry.option.kind === 'resource')
              .map(({ option, index }) => (
                <li key={`resource:${option.kind === 'resource' ? option.id.id : index}`}>
                  <Checkbox
                    label={optionLabel(option)}
                    description={optionDescription(option)}
                    checked={option.selected}
                    data-testid={`context-option-resource-${option.kind === 'resource' ? option.id.id : index}`}
                    data-highlighted={highlightedIndex === index ? 'true' : 'false'}
                    containerClassName={highlightedIndex === index ? 'rounded-[var(--radius-sm)] ring-1 ring-[var(--color-border-focus)]' : undefined}
                    onChange={() => onToggle(option)}
                  />
                </li>
              ))}
          </ul>
        )}
      </section>

      <section aria-label={t('managedResources.context.credentialsSection')}>
        <Checkbox
          label={t('managedResources.context.includePasswords')}
          description={t('managedResources.context.includePasswordsDescription')}
          checked={includePasswords}
          disabled={selected.length === 0}
          data-testid="context-include-passwords"
          onChange={(event) => onIncludePasswordsChange(event.currentTarget.checked)}
        />
      </section>

      <section aria-label={t('managedResources.context.selectedSection')}>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
          {t('managedResources.context.selectedSection')}
        </h3>
        {selected.length === 0 ? (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {t('managedResources.context.emptySelection')}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {selected.map((source) => (
              <li
                key={source.key}
                data-testid={`context-selected-${source.key}`}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--color-brand-soft)] px-2 py-0.5 text-xs text-[var(--color-on-brand-soft)]"
              >
                <span>{source.label}</span>
                <IconButton
                  icon={<X size={11} strokeWidth={2.4} />}
                  label={t('managedResources.context.removeSource', { name: source.label })}
                  size="2xs"
                  tone="muted"
                  onClick={source.remove}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
