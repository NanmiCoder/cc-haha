import { useId, useState } from 'react'
import { useTranslation } from '../../../../i18n'
import { Button } from '../../../../components/ui/Button'
import { Input, FIELD_BASE_CLASSES } from '../../../../components/ui/Input'
import { cx } from '../../../../lib/cx'
import type { Concept, ResourceTag } from '../../types/resourceTypes'
import type { ConceptDependencyNode } from '../../../../../electron/services/managedResources/conceptDependencyService'
import { ConceptResolutionPreview } from './ConceptResolutionPreview'

export type ConceptDraft = {
  title: string
  summary: string
  bodyMarkdown: string
  tagIds: string[]
  dependsOnIds: string[]
  referenceIds: string[]
}

export type ConceptEditorProps = {
  mode: 'create' | 'edit'
  /** Null while creating. */
  concept: Concept | null
  concepts: Concept[]
  tags: ResourceTag[]
  saving: boolean
  onSubmit: (draft: ConceptDraft) => void
  onCancel: () => void
  onDelete: () => void
  onCreateTag: (name: string) => void
}

type PickOption = { id: string; label: string }

function emptyDraft(): ConceptDraft {
  return { title: '', summary: '', bodyMarkdown: '', tagIds: [], dependsOnIds: [], referenceIds: [] }
}

function draftFrom(concept: Concept | null): ConceptDraft {
  if (!concept) return emptyDraft()
  return {
    title: concept.title,
    summary: concept.summary,
    bodyMarkdown: concept.bodyMarkdown,
    tagIds: [...concept.tagIds],
    dependsOnIds: [...concept.dependsOnIds],
    referenceIds: [...concept.referenceIds],
  }
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(existing => existing !== id) : [...ids, id]
}

function CheckboxPicker({
  legend,
  options,
  selected,
  onToggle,
  emptyText,
}: {
  legend: string
  options: PickOption[]
  selected: string[]
  onToggle: (id: string) => void
  emptyText: string
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-[var(--color-text-secondary)]">{legend}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-[var(--color-text-tertiary)]">{emptyText}</p>
      ) : (
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-2">
          {options.map(option => (
            <label
              key={option.id}
              className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={() => onToggle(option.id)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}

export function ConceptEditor({
  mode,
  concept,
  concepts,
  tags,
  saving,
  onSubmit,
  onCancel,
  onDelete,
  onCreateTag,
}: ConceptEditorProps) {
  const t = useTranslation()
  const [draft, setDraft] = useState<ConceptDraft>(() => draftFrom(concept))
  const [newTagName, setNewTagName] = useState('')
  const bodyId = useId()

  const update = <K extends keyof ConceptDraft>(key: K, value: ConceptDraft[K]) =>
    setDraft(current => ({ ...current, [key]: value }))

  const selfId = concept?.id ?? null
  const conceptOptions: PickOption[] = concepts
    .filter(candidate => candidate.id !== selfId)
    .map(candidate => ({ id: candidate.id, label: candidate.title || t('managedResources.concepts.untitled') }))
  const tagOptions: PickOption[] = tags.map(tag => ({ id: tag.id, label: tag.name }))

  const nodes: ConceptDependencyNode[] = concepts.map(candidate => ({
    id: candidate.id,
    dependsOnIds: candidate.dependsOnIds,
    referenceIds: candidate.referenceIds,
    title: candidate.title,
  }))

  const handleCreateTag = () => {
    const name = newTagName.trim()
    if (!name) return
    onCreateTag(name)
    setNewTagName('')
  }

  return (
    <form
      aria-label={
        mode === 'create'
          ? t('managedResources.concepts.newTitle')
          : t('managedResources.concepts.editTitle')
      }
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(draft)
      }}
    >
      <Input
        label={t('managedResources.concepts.fieldTitle')}
        value={draft.title}
        onChange={(event) => update('title', event.target.value)}
        required
      />
      <Input
        label={t('managedResources.concepts.fieldSummary')}
        value={draft.summary}
        placeholder={t('managedResources.concepts.summaryPlaceholder')}
        onChange={(event) => update('summary', event.target.value)}
      />
      <div className="flex flex-col gap-1">
        <label
          htmlFor={bodyId}
          className="text-sm font-medium text-[var(--color-text-primary)]"
        >
          {t('managedResources.concepts.fieldBody')}
        </label>
        <textarea
          id={bodyId}
          value={draft.bodyMarkdown}
          rows={10}
          placeholder={t('managedResources.concepts.bodyPlaceholder')}
          onChange={(event) => update('bodyMarkdown', event.target.value)}
          className={cx(FIELD_BASE_CLASSES, 'px-3 py-2 font-mono text-xs')}
        />
      </div>

      <CheckboxPicker
        legend={t('managedResources.concepts.fieldTags')}
        options={tagOptions}
        selected={draft.tagIds}
        onToggle={(id) => update('tagIds', toggleId(draft.tagIds, id))}
        emptyText={t('managedResources.concepts.noTags')}
      />
      <div className="flex items-end gap-2">
        <Input
          containerClassName="flex-1"
          label={t('managedResources.concepts.newTagPlaceholder')}
          value={newTagName}
          onChange={(event) => setNewTagName(event.target.value)}
        />
        <Button type="button" variant="secondary" onClick={handleCreateTag}>
          {t('managedResources.concepts.addTag')}
        </Button>
      </div>

      <CheckboxPicker
        legend={t('managedResources.concepts.fieldDependsOn')}
        options={conceptOptions}
        selected={draft.dependsOnIds}
        onToggle={(id) => update('dependsOnIds', toggleId(draft.dependsOnIds, id))}
        emptyText={t('managedResources.concepts.noConceptsToPick')}
      />
      <CheckboxPicker
        legend={t('managedResources.concepts.fieldReferences')}
        options={conceptOptions}
        selected={draft.referenceIds}
        onToggle={(id) => update('referenceIds', toggleId(draft.referenceIds, id))}
        emptyText={t('managedResources.concepts.noConceptsToPick')}
      />

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-[var(--color-text-secondary)]">
          {t('managedResources.concepts.resolvedOrderTitle')}
        </h3>
        <ConceptResolutionPreview nodes={nodes} rootIds={draft.dependsOnIds} />
      </section>

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={saving}>
          {mode === 'create'
            ? t('managedResources.concepts.create')
            : t('managedResources.concepts.save')}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {mode === 'edit' ? (
          <Button type="button" variant="danger-outline" onClick={onDelete} className="ml-auto">
            {t('managedResources.concepts.delete')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
