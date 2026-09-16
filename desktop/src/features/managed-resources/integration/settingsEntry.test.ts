import { beforeEach, describe, expect, it } from 'vitest'
import { CONCEPT_KNOWLEDGE_SETTINGS_SECTION_ID } from './settingsEntry'
import { useUIStore } from '../../../stores/uiStore'

/**
 * The host keeps its own `SettingsTab` union and persisted allow-list in
 * `stores/uiStore.ts`; this feature owns the section id. Nothing links the two
 * at compile time beyond the union, so pin the join behaviourally: the id the
 * seam exports must be the id the store round-trips into storage, otherwise the
 * tab silently stops being restorable.
 */
describe('concept-knowledge settings section id (U04 seam)', () => {
  beforeEach(() => {
    useUIStore.setState({ activeSettingsTab: 'providers' })
    localStorage.removeItem('cc-haha-active-settings-tab')
  })

  it('is accepted by uiStore and persisted as the active settings tab', () => {
    useUIStore.getState().setActiveSettingsTab(CONCEPT_KNOWLEDGE_SETTINGS_SECTION_ID)

    expect(useUIStore.getState().activeSettingsTab).toBe('conceptKnowledge')
    expect(localStorage.getItem('cc-haha-active-settings-tab')).toBe('conceptKnowledge')
  })
})
