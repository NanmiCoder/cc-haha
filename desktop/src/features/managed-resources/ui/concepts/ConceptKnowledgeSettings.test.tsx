import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ConceptKnowledgeSettings } from '../ConceptKnowledgeSettings'
import { useConceptKnowledgeStore } from '../../stores/conceptKnowledgeStore'
import { createConceptHarness, type ConceptHarness } from '../../../../test/conceptKnowledgeHarness'
import type { Concept } from '../../types/resourceTypes'

/**
 * The C/A/B/D acceptance fixture, driven from the DOM:
 *
 *   C depends on A and B; A and B both depend on D.
 *
 * The preview under the editor runs the same closure the context resolver runs,
 * so selecting roots [C, A] here must render `D, A, B, C` with A marked root.
 */
describe('M5 ConceptKnowledgeSettings: resolver preview + accessibility', () => {
  let harness: ConceptHarness

  async function seed(title: string, dependsOnIds: string[] = []): Promise<Concept> {
    return harness.seedConcept({
      title,
      summary: '',
      bodyMarkdown: `body ${title}`,
      tagIds: [],
      dependsOnIds,
      referenceIds: [],
    })
  }

  let a: Concept
  let b: Concept
  let c: Concept
  let d: Concept

  beforeEach(async () => {
    harness = await createConceptHarness('mr-concept-ui-')
    d = await seed('D')
    a = await seed('A', [d.id])
    b = await seed('B', [d.id])
    c = await seed('C', [a.id, b.id])
  })

  afterEach(async () => {
    cleanup()
    await harness.dispose()
  })

  async function openCreateEditor(): Promise<void> {
    render(<ConceptKnowledgeSettings />)
    await screen.findByRole('button', { name: 'D' })
    fireEvent.click(screen.getByRole('button', { name: 'New concept' }))
  }

  function dependsOnGroup(): HTMLElement {
    return screen.getByRole('group', { name: 'Depends on' })
  }

  function resolutionTitles(): string[] {
    return screen
      .getAllByTestId('concept-resolution-entry')
      .map((entry) => within(entry).getByTestId('concept-resolution-title').textContent ?? '')
  }

  function resolutionRole(title: string): string {
    const entry = screen
      .getAllByTestId('concept-resolution-entry')
      .find((row) => within(row).getByTestId('concept-resolution-title').textContent === title)
    if (!entry) throw new Error(`no resolution entry for ${title}`)
    return within(entry).getByTestId('concept-resolution-role').textContent ?? ''
  }

  it('renders D, A, B, C from roots [C, A] with A marked root and D once', async () => {
    await openCreateEditor()

    fireEvent.click(within(dependsOnGroup()).getByRole('checkbox', { name: 'C' }))
    fireEvent.click(within(dependsOnGroup()).getByRole('checkbox', { name: 'A' }))

    expect(resolutionTitles()).toEqual(['D', 'A', 'B', 'C'])
    expect(resolutionRole('A')).toBe('root')
    expect(screen.getAllByTestId('concept-resolution-title').filter((node) => node.textContent === 'D')).toHaveLength(1)
  })

  it('renders the same order for roots [A, C]', async () => {
    await openCreateEditor()

    fireEvent.click(within(dependsOnGroup()).getByRole('checkbox', { name: 'A' }))
    fireEvent.click(within(dependsOnGroup()).getByRole('checkbox', { name: 'C' }))

    expect(resolutionTitles()).toEqual(['D', 'A', 'B', 'C'])
    expect(resolutionRole('A')).toBe('root')
  })

  it('demotes A to dependency once it stops being a selected root', async () => {
    await openCreateEditor()

    fireEvent.click(within(dependsOnGroup()).getByRole('checkbox', { name: 'C' }))
    fireEvent.click(within(dependsOnGroup()).getByRole('checkbox', { name: 'A' }))
    expect(resolutionRole('A')).toBe('root')

    fireEvent.click(within(dependsOnGroup()).getByRole('checkbox', { name: 'A' }))

    expect(resolutionTitles()).toEqual(['D', 'A', 'B', 'C'])
    expect(resolutionRole('A')).toBe('dependency')
    expect(resolutionRole('C')).toBe('root')
  })

  it('shows the full cycle path after a rejected save', async () => {
    render(<ConceptKnowledgeSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'A' }))

    // C already depends on A; making A depend on C closes the cycle.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Depends on' })).getByRole('checkbox', { name: 'C' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(useConceptKnowledgeStore.getState().error?.code).toBe('DEPENDENCY_CYCLE')
    })
    const error = useConceptKnowledgeStore.getState().error
    expect(error?.cycle).toHaveLength(3)
    expect(error?.cycle?.[0]).toBe(error?.cycle?.[2])

    const messages = (await screen.findAllByRole('alert')).map((node) => node.textContent ?? '')
    expect(
      messages.some(
        (message) => message.includes(a.id) && message.includes(c.id) && message.includes('->'),
      ),
    ).toBe(true)
  })

  it('exposes accessible names on every control and writes no raw i18n key', async () => {
    await openCreateEditor()

    expect(screen.getByRole('button', { name: 'New concept' })).toBeInTheDocument()
    expect(screen.getByLabelText('Search concepts')).toBeInTheDocument()
    expect(screen.getByLabelText(/Title/)).toBeInTheDocument()
    expect(screen.getByLabelText('Summary')).toBeInTheDocument()
    expect(screen.getByLabelText('Body (Markdown)')).toBeInTheDocument()
    expect(screen.getByLabelText('New tag name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create tag' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Tags' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'References (title only)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    // The preview list needs a selected root to render at all.
    fireEvent.click(within(dependsOnGroup()).getByRole('checkbox', { name: 'A' }))
    expect(screen.getByRole('list', { name: 'Resolved order preview' })).toBeInTheDocument()
    // Every checkbox is named by the concept it toggles.
    const checkboxes = within(dependsOnGroup()).getAllByRole('checkbox')
    expect(checkboxes.map((box) => box.getAttribute('aria-label') ?? box.closest('label')?.textContent)).toEqual([
      'D',
      'A',
      'B',
      'C',
    ])

    expect(document.body.textContent ?? '').not.toMatch(/managedResources\.[a-zA-Z]+\./)
  })

  it('opens a ConfirmDialog for deletion instead of window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    render(<ConceptKnowledgeSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('dialog', { name: 'Delete concept' })).toBeInTheDocument()
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})
