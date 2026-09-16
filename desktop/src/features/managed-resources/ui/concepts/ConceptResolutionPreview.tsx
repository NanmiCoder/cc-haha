import { useTranslation } from '../../../../i18n'
import {
  resolveConceptClosure,
  type ConceptDependencyNode,
} from '../../../../../electron/services/managedResources/conceptDependencyService'

export type ConceptResolutionPreviewProps = {
  /** Every concept the picker can reach, as dependency-graph nodes. */
  nodes: ConceptDependencyNode[]
  /** The current `dependsOnIds` selection, in the order the user picked it. */
  rootIds: string[]
}

/**
 * Read-only preview of the resolved context order.
 *
 * It runs the same deterministic closure the context resolver uses (root order
 * → depth-first postorder → dedupe → root marking), so a user can see that a
 * shared dependency lands once, ahead of the nodes that depend on it.
 */
export function ConceptResolutionPreview({ nodes, rootIds }: ConceptResolutionPreviewProps) {
  const t = useTranslation()
  const result = resolveConceptClosure({ nodes, rootIds })

  if (!result.ok) {
    return (
      <p
        role="alert"
        data-testid="concept-resolution-cycle"
        className="rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-xs text-[var(--color-on-error-container)]"
      >
        {t('managedResources.concepts.cycleDetected', { path: result.cycle.join(' -> ') })}
      </p>
    )
  }

  if (result.entries.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-tertiary)]">
        {t('managedResources.concepts.resolvedOrderEmpty')}
      </p>
    )
  }

  return (
    <ol
      aria-label={t('managedResources.concepts.resolvedOrderTitle')}
      className="flex flex-col gap-1"
    >
      {result.entries.map((entry) => (
        <li
          key={entry.id}
          data-testid="concept-resolution-entry"
          className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-2.5 py-1.5 text-xs"
        >
          <span
            data-testid="concept-resolution-title"
            className="font-medium text-[var(--color-text-primary)]"
          >
            {entry.title}
          </span>
          <span
            data-testid="concept-resolution-role"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]"
          >
            {entry.includedAs === 'root'
              ? t('managedResources.concepts.roleRoot')
              : t('managedResources.concepts.roleDependency')}
          </span>
          <span className="text-[10px] text-[var(--color-text-tertiary)]">
            {t('managedResources.concepts.fieldDependsOn')} d{entry.depth}
          </span>
        </li>
      ))}
    </ol>
  )
}
