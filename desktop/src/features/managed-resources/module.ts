import type { ConversationContextSelectionV2 } from './types/resourceTypes.js'

export type ComposerScope =
  | { kind: 'draft'; draftId: string }
  | { kind: 'session'; sessionId: string }

export type ManagedContextTriggerInput = {
  text: string
  cursorOffset: number
  excludedRanges: { from: number; to: number }[]
  isComposing: boolean
}

export type ManagedContextTrigger = {
  kind: 'host' | 'concept' | 'database' | 'redis'
  query: string
  replacementRange: { from: number; to: number }
}

export type ManagedResourcesRendererDependencies = {
  resolveManagedContextTrigger(input: ManagedContextTriggerInput): ManagedContextTrigger | null
  moveManagedContextScope(from: ComposerScope, to: ComposerScope): void
  snapshotManagedContext(scope: ComposerScope): ConversationContextSelectionV2 | undefined
}

export type ManagedResourcesRendererModule = {
  resolveManagedContextTrigger(input: ManagedContextTriggerInput): ManagedContextTrigger | null
  moveManagedContextScope(from: ComposerScope, to: ComposerScope): void
  snapshotManagedContext(scope: ComposerScope): ConversationContextSelectionV2 | undefined
}

export function createManagedResourcesRendererModule(
  deps: ManagedResourcesRendererDependencies,
): ManagedResourcesRendererModule {
  return {
    resolveManagedContextTrigger(input: ManagedContextTriggerInput): ManagedContextTrigger | null {
      return deps.resolveManagedContextTrigger(input)
    },
    moveManagedContextScope(from: ComposerScope, to: ComposerScope): void {
      deps.moveManagedContextScope(from, to)
    },
    snapshotManagedContext(scope: ComposerScope): ConversationContextSelectionV2 | undefined {
      return deps.snapshotManagedContext(scope)
    },
  }
}
