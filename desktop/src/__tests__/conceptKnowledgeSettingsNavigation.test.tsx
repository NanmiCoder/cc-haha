import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

vi.mock('../features/pets/PetSettings', () => ({
  PetSettings: () => <div>Pet settings content</div>,
}))

vi.mock('../features/managed-resources/ui/ConceptKnowledgeSettings', () => ({
  ConceptKnowledgeSettings: () => <div>Concept knowledge content</div>,
}))

describe('Settings concept-knowledge navigation (M5 / U04)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null, activeView: 'settings' })
    localStorage.removeItem('cc-haha-active-settings-tab')
  })

  it('opens the concept knowledge tab from the rail and persists it as active', () => {
    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: 'Concept knowledge' }))

    expect(screen.getByText('Concept knowledge content')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Concept knowledge' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(useUIStore.getState().activeSettingsTab).toBe('conceptKnowledge')
    expect(localStorage.getItem('cc-haha-active-settings-tab')).toBe('conceptKnowledge')
  })

  it('leaves the other settings pages working and the shell view untouched', () => {
    render(<Settings />)
    const before = useUIStore.getState().activeView

    fireEvent.click(screen.getByRole('button', { name: 'Concept knowledge' }))
    expect(screen.getByText('Concept knowledge content')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pets' }))
    expect(screen.getByText('Pet settings content')).toBeInTheDocument()
    expect(screen.queryByText('Concept knowledge content')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pets' })).toHaveAttribute('aria-current', 'page')

    // Switching settings tabs never navigates the app or opens a modal.
    expect(useUIStore.getState().activeView).toBe(before)
    expect(useUIStore.getState().activeModal).toBeNull()
    expect(useUIStore.getState().activeSettingsTab).toBe('pets')
  })
})
