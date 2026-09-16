import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { SettingsPageHeader } from '../../../components/settings/SettingsSection'
import { Button } from '../../../components/ui/Button'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { cx } from '../../../lib/cx'
import { useConceptKnowledgeStore } from '../stores/conceptKnowledgeStore'
import type { Concept } from '../types/resourceTypes'
import type { HostManagementError } from '../api/hostManagementApi'
import type { TranslationKey } from '../../../i18n'
import { ConceptEditor, type ConceptDraft } from './concepts/ConceptEditor'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * The one place a concept error becomes user-facing text. Notably
 * `DEPENDENCY_CYCLE` prints the full cycle path the main process forwarded
 * (`[A, B, C, A]`), which never reached the renderer before M5.
 */
export function conceptErrorText(error: HostManagementError, t: Translate): string {
  switch (error.code) {
    case 'DEPENDENCY_CYCLE':
      return t('managedResources.concepts.cycleDetected', {
        path: (error.cycle ?? []).join(' -> '),
      })
    case 'REVISION_CONFLICT': {
      const actual = error.params?.actualRevision
      if (typeof actual === 'number') {
        return `${t('managedResources.concepts.revisionConflict')} ${t(
          'managedResources.concepts.revisionConflictHint',
          { actual },
        )}`
      }
      return t('managedResources.concepts.revisionConflict')
    }
    case 'CONTEXT_LIMIT_EXCEEDED':
      return t('managedResources.concepts.limitExceeded', {
        limit: String(error.params?.limit ?? ''),
        actual: String(error.params?.actual ?? ''),
      })
    default: {
      // The main process writes `managedResources.errors.<code>`; codes with no
      // translation would otherwise render as a raw key string.
      const key = error.messageKey as TranslationKey
      const translated = t(key)
      if (translated !== key) return translated
      return t(
        error.code === 'UNAVAILABLE'
          ? 'managedResources.concepts.loadFailed'
          : 'managedResources.concepts.saveFailed',
      )
    }
  }
}

export function ConceptKnowledgeSettings() {
  const t = useTranslation()

  const concepts = useConceptKnowledgeStore((state) => state.concepts)
  const tags = useConceptKnowledgeStore((state) => state.tags)
  const selectedConceptId = useConceptKnowledgeStore((state) => state.selectedConceptId)
  const searchQuery = useConceptKnowledgeStore((state) => state.searchQuery)
  const loading = useConceptKnowledgeStore((state) => state.loading)
  const saving = useConceptKnowledgeStore((state) => state.saving)
  const error = useConceptKnowledgeStore((state) => state.error)
  const deleteBlocked = useConceptKnowledgeStore((state) => state.deleteBlocked)
  const filteredConcepts = useConceptKnowledgeStore((state) => state.filteredConcepts)
  const setSearchQuery = useConceptKnowledgeStore((state) => state.setSearchQuery)
  const setSelectedConceptId = useConceptKnowledgeStore((state) => state.setSelectedConceptId)
  const clearError = useConceptKnowledgeStore((state) => state.clearError)
  const dismissDeleteBlocked = useConceptKnowledgeStore((state) => state.dismissDeleteBlocked)
  const fetchConcepts = useConceptKnowledgeStore((state) => state.fetchConcepts)
  const fetchTags = useConceptKnowledgeStore((state) => state.fetchTags)
  const createTag = useConceptKnowledgeStore((state) => state.createTag)
  const saveConcept = useConceptKnowledgeStore((state) => state.saveConcept)
  const deleteConcept = useConceptKnowledgeStore((state) => state.deleteConcept)

  const [isCreating, setIsCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Concept | null>(null)

  useEffect(() => {
    void fetchConcepts()
    void fetchTags()
  }, [fetchConcepts, fetchTags])

  const selectedConcept = concepts.find((concept) => concept.id === selectedConceptId) ?? null
  const visibleConcepts = filteredConcepts()

  const handleSubmit = async (draft: ConceptDraft) => {
    if (isCreating || !selectedConcept) {
      const result = await saveConcept({ mode: 'create', ...draft })
      if (result.success) setIsCreating(false)
      return
    }
    await saveConcept({
      mode: 'update',
      id: selectedConcept.id,
      expectedRevision: selectedConcept.revision,
      changes: draft,
    })
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    // The store surfaces a blocked delete (`RESOURCE_IN_USE`) itself; this
    // dialog only owns the plain "are you sure".
    setDeleteTarget(null)
    await deleteConcept(deleteTarget.id, deleteTarget.revision)
  }

  const handleRemoveEdgesAndDelete = async () => {
    const target = deleteBlocked
      ? concepts.find((concept) => concept.id === deleteBlocked.conceptId) ?? null
      : null
    if (!target) return
    // The blocked dialog owns the retry: removing the `referenceIds` edges and
    // deleting happens in one repository transaction.
    await deleteConcept(target.id, target.revision, true)
    dismissDeleteBlocked()
  }

  const blockedReferences = deleteBlocked?.references ?? []

  return (
    <div className="flex flex-col">
      <SettingsPageHeader
        title={t('managedResources.concepts.title')}
        description={t('managedResources.concepts.subtitle')}
        action={
          <Button
            variant="primary"
            onClick={() => {
              clearError()
              setIsCreating(true)
            }}
          >
            {t('managedResources.concepts.new')}
          </Button>
        }
      />

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-xs text-[var(--color-on-error-container)]"
        >
          {conceptErrorText(error, t)}
        </p>
      ) : null}

      <div className="flex min-h-0 gap-6">
        <div className="flex w-[260px] flex-shrink-0 flex-col gap-3">
          <Input
            label={t('managedResources.concepts.searchLabel')}
            placeholder={t('managedResources.concepts.searchPlaceholder')}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <ul
            aria-label={t('managedResources.concepts.listLabel')}
            className="flex max-h-[520px] flex-col gap-0.5 overflow-y-auto"
          >
            {visibleConcepts.map((concept) => {
              const active = !isCreating && concept.id === selectedConceptId
              return (
                <li key={concept.id}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      setIsCreating(false)
                      clearError()
                      setSelectedConceptId(concept.id)
                    }}
                    className={cx(
                      'w-full truncate rounded-[var(--radius-md)] px-3 py-2 text-left text-[13px] transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
                      active
                        ? 'bg-[var(--color-surface-hover)] font-medium text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
                    )}
                  >
                    {concept.title || t('managedResources.concepts.untitled')}
                  </button>
                </li>
              )
            })}
          </ul>
          {visibleConcepts.length === 0 ? (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              {loading
                ? t('common.loading')
                : concepts.length === 0
                  ? t('managedResources.concepts.empty')
                  : t('managedResources.concepts.noResults')}
            </p>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          {isCreating ? (
            <ConceptEditor
              key="concept-editor:create"
              mode="create"
              concept={null}
              concepts={concepts}
              tags={tags}
              saving={saving}
              onSubmit={handleSubmit}
              onCancel={() => setIsCreating(false)}
              onDelete={() => undefined}
              onCreateTag={(name) => void createTag(name)}
            />
          ) : selectedConcept ? (
            <ConceptEditor
              key={`concept-editor:${selectedConcept.id}:${selectedConcept.revision}`}
              mode="edit"
              concept={selectedConcept}
              concepts={concepts}
              tags={tags}
              saving={saving}
              onSubmit={handleSubmit}
              onCancel={() => setSelectedConceptId(null)}
              onDelete={() => setDeleteTarget(selectedConcept)}
              onCreateTag={(name) => void createTag(name)}
            />
          ) : (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              {t('managedResources.concepts.selectPrompt')}
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleConfirmDelete()}
        title={t('managedResources.concepts.deleteConfirmTitle')}
        body={t('managedResources.concepts.deleteConfirmBody', {
          title: deleteTarget?.title ?? '',
        })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={saving}
      />

      {deleteBlocked ? (
        <Modal
          open
          onClose={dismissDeleteBlocked}
          title={t('managedResources.concepts.deleteBlockedTitle')}
          width={480}
          footer={(
            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" onClick={dismissDeleteBlocked}>
                {t('common.close')}
              </Button>
              {deleteBlocked.canRemoveReferenceEdges ? (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => void handleRemoveEdgesAndDelete()}
                >
                  {t('managedResources.concepts.removeEdgesAndDelete')}
                </Button>
              ) : null}
            </div>
          )}
        >
          <div className="flex flex-col gap-2 py-1">
            <p className="text-xs text-[var(--color-text-secondary)]">
              {t('managedResources.concepts.deleteBlockedDesc')}
            </p>
            <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto">
              {blockedReferences.map((reference) => (
                <li
                  key={`${reference.id}:${reference.description ?? ''}`}
                  data-testid="concept-blocker"
                  className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-2.5 py-2 text-xs"
                >
                  <span className="font-medium text-[var(--color-text-primary)]">
                    {reference.name ?? reference.id}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
                    {reference.description === 'dependsOnIds'
                      ? t('managedResources.concepts.fieldDependsOn')
                      : t('managedResources.concepts.fieldReferences')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
