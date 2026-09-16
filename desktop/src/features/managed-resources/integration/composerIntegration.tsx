/**
 * U05/U06 composer seam — the single place both composers plug the
 * managed-resources picker into.
 *
 * `ChatInput` and `EmptySession` each call this hook and render `node` before
 * their model selector. Everything else (store, popover, slash classification,
 * Enter/Esc routing) lives here or behind the store, so the two composers cannot
 * drift into two state machines: they both write to
 * `useContextSelectionStore`.
 */
import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { findContextSlash } from '../../../components/chat/composerUtils'
import { isHostManagementSupported } from '../api/desktopHostCapabilities'
import type { EditorRange } from '../composer/contextPicker'
import { useContextSelectionStore, type ContextScope } from '../stores/contextSelectionStore'
import { ContextEntryButtons } from '../ui/context/ContextEntryButtons'

export type ComposerTriggerInput = {
  value: string
  /** Caret offset in the composer text; text after it is never a trigger. */
  cursorPos: number
  /** True while an IME composition is in flight — provisional text, no trigger. */
  composing?: boolean
  /** Ranges the composer already consumed (mention pills). */
  tokenRanges?: ReadonlyArray<EditorRange>
}

export type ComposerContextEntry = {
  /** The Hosts/Concepts buttons + popover, to place before the model selector. */
  node: ReactNode
  /** Feed every composer text change through this. */
  syncTrigger: (input: ComposerTriggerInput) => void
  /** Composer keydown intercept: returns true when the picker consumed it. */
  handleKeyDown: (event: KeyboardEvent) => boolean
  close: () => void
}

export type ComposerContextEntryOptions = {
  scope: ContextScope
  sessionId?: string | null
  compact?: boolean
  /** False when the runtime has no host-management capability. */
  enabled?: boolean
}

export function useComposerContextEntry({
  scope,
  sessionId = null,
  compact = false,
  enabled = false,
}: ComposerContextEntryOptions): ComposerContextEntry {
  // A host that never advertised the capability reads as `undefined`, not
  // `false`, so only an explicit `true` may mount the buttons or read the
  // catalog: treating "key missing" as available would call through an absent
  // `desktop.hostManagement` surface.
  const active = enabled === true

  useEffect(() => {
    if (!active) return
    // `setScope` is a no-op when nothing changed, so this cannot loop.
    useContextSelectionStore.getState().setScope(scope, sessionId)
  }, [active, scope, sessionId])

  useEffect(() => {
    if (!active) return
    void useContextSelectionStore.getState().loadCatalog()
  }, [active])

  const syncTrigger = useCallback((input: ComposerTriggerInput) => {
    const state = useContextSelectionStore.getState()
    // Mid-composition text is provisional: opening the picker on it would fight
    // the IME candidate window and confirm on a half-typed query.
    if (input.composing) return

    const classification = findContextSlash(input.value, input.cursorPos, {
      excludedRanges: input.tokenRanges,
    })

    if (classification.type === 'none') {
      if (state.pickerKind !== null || state.unavailableCommand !== null) state.closePicker()
      return
    }

    if (classification.type === 'unavailable') {
      state.openUnavailable(classification.command)
      return
    }

    if (state.pickerKind !== classification.kind) state.openPicker(classification.kind)
    if (useContextSelectionStore.getState().pickerFilter !== classification.filter) {
      useContextSelectionStore.getState().setPickerFilter(classification.filter)
    }
  }, [])

  const handleKeyDown = useCallback((event: KeyboardEvent): boolean => {
    const state = useContextSelectionStore.getState()
    if (state.pickerKind === null && state.unavailableCommand === null) return false

    switch (event.key) {
      case 'ArrowDown':
        state.moveHighlight(1)
        event.preventDefault()
        return true
      case 'ArrowUp':
        state.moveHighlight(-1)
        event.preventDefault()
        return true
      case 'Escape':
        state.closePicker()
        event.preventDefault()
        return true
      case 'Enter': {
        // Confirm the highlighted option and consume the key: a picker confirm
        // must never fall through to the composer's send path.
        event.preventDefault()
        const options = state.options()
        const option = options[state.highlightedIndex]
        if (option) state.toggleOption(option)
        return true
      }
      default:
        return false
    }
  }, [])

  const close = useCallback(() => {
    useContextSelectionStore.getState().closePicker()
  }, [])

  const node = useMemo(
    () => (active ? <ContextEntryButtons compact={compact} /> : null),
    [active, compact],
  )

  // The trigger/keyboard callbacks are stable, so re-rendering on every picker
  // open would only churn the composer. Keep the object stable too.
  return useMemo(
    () => ({ node, syncTrigger, handleKeyDown, close }),
    [node, syncTrigger, handleKeyDown, close],
  )
}

/** Whether this runtime can list host/concept resources at all. */
export function managedContextAvailable(): boolean {
  return isHostManagementSupported()
}
