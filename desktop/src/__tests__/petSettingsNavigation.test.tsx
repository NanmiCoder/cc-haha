import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DesktopSettings as Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

vi.mock('../features/pets/PetSettings', () => ({
  PetSettings: () => <div>Pet settings content</div>,
}))

describe('Settings pet navigation', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  })

  it('opens the dedicated pet settings tab and persists it as active', () => {
    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: 'Pets' }))

    expect(screen.getByText('Pet settings content')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pets' })).toHaveAttribute('aria-current', 'page')
    expect(useUIStore.getState().activeSettingsTab).toBe('pets')
  })
})
