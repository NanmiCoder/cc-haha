import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { McpProjectTargets } from './McpProjectTargets'
import { useSettingsStore } from '@/stores/settingsStore'
import type { useMcpProjectSharing } from './useMcpProjectSharing'

describe('McpProjectTargets', () => {
  it('opens from the shared Button, supports native checkboxes and restores focus on Escape', () => {
    useSettingsStore.setState({ locale: 'en' })
    const toggle = vi.fn()
    const sharing: ReturnType<typeof useMcpProjectSharing> = {
      projects: [{ projectPath: 'C:/work/project', revision: '1', selected: true, checked: true }],
      loading: false, ready: true, error: undefined, canSave: true, targets: [],
      sourceConfig: undefined,
      addProject: vi.fn(), reload: vi.fn(), toggle, applyResults: vi.fn(),
    }
    render(<McpProjectTargets sharing={sharing} disabled={false} />)
    const trigger = screen.getByRole('button', { name: 'Target projects' })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('dialog', { name: 'Target projects' })).toBeInTheDocument()
    const checkbox = screen.getByRole('checkbox', { name: 'C:/work/project' })
    expect(checkbox).toHaveFocus()
    fireEvent.click(checkbox)
    expect(toggle).toHaveBeenCalledWith('C:/work/project')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
