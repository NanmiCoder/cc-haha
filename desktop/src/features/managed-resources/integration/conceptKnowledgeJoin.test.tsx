import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ConceptKnowledgeSettings } from '../ui/ConceptKnowledgeSettings'
import { useConceptKnowledgeStore } from '../stores/conceptKnowledgeStore'
import { createConceptHarness, type ConceptHarness } from '../../../test/conceptKnowledgeHarness'
import type { Concept } from '../types/resourceTypes'

/**
 * Store → DesktopHost → IPC → repository → read-back, driven by real DOM
 * events. Nothing seeds the store directly: concepts go in through the
 * repository (via the IPC handlers) and come back out through the host API.
 */
describe('M5 concept knowledge join: UI -> IPC -> repository -> read-back', () => {
  let harness: ConceptHarness

  beforeEach(async () => {
    harness = await createConceptHarness('mr-concept-join-')
    useConceptKnowledgeStore.getState().clearError()
  })

  afterEach(async () => {
    cleanup()
    await harness.dispose()
  })

  async function storedConcepts(): Promise<Concept[]> {
    const result = await harness.host.conceptKnowledge.listConcepts()
    if (!result.ok) throw new Error(`listConcepts failed: ${result.error.code}`)
    return result.data
  }

  it('creates a concept from typed DOM input and reads the stored fields back', async () => {
    render(<ConceptKnowledgeSettings />)
    await waitFor(() => expect(useConceptKnowledgeStore.getState().loading).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'New concept' }))
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Deploy runbook' } })
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'how we deploy' } })
    fireEvent.change(screen.getByLabelText('Body (Markdown)'), {
      target: { value: '# Steps\n\n1. build' },
    })

    fireEvent.change(screen.getByLabelText('New tag name'), { target: { value: 'prod' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create tag' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'prod' }))

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(async () => {
      expect((await storedConcepts()).length).toBe(1)
    })

    const [stored] = await storedConcepts()
    expect(stored?.title).toBe('Deploy runbook')
    expect(stored?.summary).toBe('how we deploy')
    expect(stored?.bodyMarkdown).toBe('# Steps\n\n1. build')
    expect(stored?.tagIds).toHaveLength(1)
    expect(stored?.dependsOnIds).toEqual([])
    expect(stored?.referenceIds).toEqual([])

    // The tag really landed in the concept namespace, not the host namespace.
    const tags = await harness.host.hostManagement.listTags('concept')
    expect(tags.ok).toBe(true)
    if (!tags.ok) return
    expect(tags.data.map((tag) => tag.name)).toEqual(['prod'])
    expect(stored?.tagIds).toEqual([tags.data[0]!.id])

    const hostTags = await harness.host.hostManagement.listTags('host')
    expect(hostTags.ok && hostTags.data).toEqual([])

    // The new concept is re-read through the page: it shows up in the list.
    expect(await screen.findByRole('button', { name: 'Deploy runbook' })).toBeInTheDocument()
  })

  it('saves dependency and reference edges through the DOM and reads them back', async () => {
    const dependency = await harness.seedConcept({
      title: 'Dependency',
      summary: '',
      bodyMarkdown: 'dep body',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [],
    })
    const reference = await harness.seedConcept({
      title: 'Reference',
      summary: '',
      bodyMarkdown: 'ref body',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [],
    })

    render(<ConceptKnowledgeSettings />)
    // Wait until the seeded concepts are in the store before opening the editor:
    // the dependency picker is built from them.
    await screen.findByRole('button', { name: 'Dependency' })
    fireEvent.click(screen.getByRole('button', { name: 'New concept' }))
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Root' } })
    fireEvent.change(screen.getByLabelText('Body (Markdown)'), { target: { value: 'root body' } })
    // The dependency picker and the reference picker both list every concept,
    // so scope each pick to its own fieldset.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Depends on' })).getByRole('checkbox', {
        name: 'Dependency',
      }),
    )
    fireEvent.click(
      within(screen.getByRole('group', { name: 'References (title only)' })).getByRole('checkbox', {
        name: 'Reference',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(async () => {
      expect((await storedConcepts()).length).toBe(3)
    })

    const root = (await storedConcepts()).find((concept) => concept.title === 'Root')
    expect(root?.dependsOnIds).toEqual([dependency.id])
    expect(root?.referenceIds).toEqual([reference.id])
  })

  it('reports a real revision conflict instead of overwriting a newer write', async () => {
    const concept = await harness.seedConcept({
      title: 'Original',
      summary: '',
      bodyMarkdown: 'body',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [],
    })

    render(<ConceptKnowledgeSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Original' }))

    // Someone else writes the same concept while this editor is open.
    const external = await harness.host.conceptKnowledge.saveConcept({
      mode: 'update',
      id: concept.id,
      expectedRevision: concept.revision,
      changes: { title: 'Changed elsewhere' },
    })
    expect(external.ok).toBe(true)

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'My local edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This concept changed elsewhere. Reload it and reapply your edit.')
    expect(useConceptKnowledgeStore.getState().error?.code).toBe('REVISION_CONFLICT')

    // The newer write survived.
    const stored = await harness.host.conceptKnowledge.getConcept(concept.id)
    expect(stored.ok && stored.data.title).toBe('Changed elsewhere')
    expect(stored.ok && stored.data.revision).toBe(2)
  })

  it('blocks a delete on a real dependsOn referrer, naming it with its stored title', async () => {
    const target = await harness.seedConcept({
      title: 'Delete target',
      summary: '',
      bodyMarkdown: 'target body',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [],
    })
    await harness.seedConcept({
      title: 'Dependent concept',
      summary: '',
      bodyMarkdown: 'dependent body',
      tagIds: [],
      dependsOnIds: [target.id],
      referenceIds: [],
    })

    render(<ConceptKnowledgeSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete target' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    const confirm = await screen.findByRole('dialog', { name: 'Delete concept' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))

    const blocked = await screen.findByRole('dialog', { name: 'Cannot delete concept' })
    const blockers = within(blocked).getAllByTestId('concept-blocker')
    expect(blockers).toHaveLength(1)
    // The real referrer title, not a bare id: the IPC layer enriches it.
    expect(blockers[0]).toHaveTextContent('Dependent concept')
    // A dependsOn edge is not removable from this dialog.
    expect(
      within(blocked).queryByRole('button', { name: 'Remove reference edges and delete' }),
    ).toBeNull()

    expect((await storedConcepts()).map((concept) => concept.title).sort()).toEqual([
      'Delete target',
      'Dependent concept',
    ])
  })

  it('deletes after removing the referenceIds edges in the repository', async () => {
    const target = await harness.seedConcept({
      title: 'Reference target',
      summary: '',
      bodyMarkdown: 'target body',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [],
    })
    const referrer = await harness.seedConcept({
      title: 'Referrer concept',
      summary: '',
      bodyMarkdown: 'referrer body',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [target.id],
    })

    render(<ConceptKnowledgeSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reference target' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete concept' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))

    const blocked = await screen.findByRole('dialog', { name: 'Cannot delete concept' })
    expect(within(blocked).getAllByTestId('concept-blocker')[0]).toHaveTextContent('Referrer concept')
    fireEvent.click(within(blocked).getByRole('button', { name: 'Remove reference edges and delete' }))

    await waitFor(async () => {
      expect((await storedConcepts()).map((concept) => concept.title)).toEqual(['Referrer concept'])
    })

    const after = await harness.host.conceptKnowledge.getConcept(referrer.id)
    expect(after.ok && after.data.referenceIds).toEqual([])
  })

  it('forwards the full dependsOn cycle path to the renderer', async () => {
    const a = await harness.seedConcept({
      title: 'A',
      summary: '',
      bodyMarkdown: 'a',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [],
    })
    const c = await harness.seedConcept({
      title: 'C',
      summary: '',
      bodyMarkdown: 'c',
      tagIds: [],
      dependsOnIds: [a.id],
      referenceIds: [],
    })

    const result = await harness.host.conceptKnowledge.saveConcept({
      mode: 'update',
      id: a.id,
      expectedRevision: a.revision,
      changes: { dependsOnIds: [c.id] },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('DEPENDENCY_CYCLE')
    const cycle = result.error.cycle
    expect(cycle).toBeDefined()
    // Full path: first id repeated at the end, both concepts on it.
    expect(cycle).toHaveLength(3)
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1])
    expect(new Set(cycle)).toEqual(new Set([a.id, c.id]))
  })
})
