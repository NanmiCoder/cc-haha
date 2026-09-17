/**
 * U04 seam: the concept-knowledge settings section.
 *
 * `Settings.tsx` (rail button + content branch) only needs this section id and
 * this page binding, so the host never imports the feature UI directly — the
 * feature owns both sides of the boundary. The `SettingsTab` union and its
 * persisted allow-list stay in `stores/uiStore.ts`; they must keep listing the
 * same id.
 */
export const CONCEPT_KNOWLEDGE_SETTINGS_SECTION_ID = 'conceptKnowledge' as const

export { ConceptKnowledgeSettings as ConceptKnowledgeSettingsPage } from '../ui/ConceptKnowledgeSettings'
