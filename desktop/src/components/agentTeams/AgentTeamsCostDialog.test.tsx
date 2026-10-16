import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { useSettingsStore } from '@/stores/settingsStore'
import { AgentTeamsCostDialog } from './AgentTeamsCostDialog'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

afterEach(() => {
  cleanup()
})

describe('AgentTeamsCostDialog', () => {
  it('states the token cost, the slowdown and the limited fit', () => {
    render(<AgentTeamsCostDialog open onClose={() => {}} onConfirm={() => {}} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Uses a lot of tokens')
    expect(dialog).toHaveTextContent('Slower to finish')
    expect(dialog).toHaveTextContent('Not suited to every task')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('confirms without a reminder preference when dismissal is not offered', () => {
    const onConfirm = vi.fn()
    render(<AgentTeamsCostDialog open onClose={() => {}} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: 'Turn on anyway' }))
    expect(onConfirm).toHaveBeenCalledWith({ dontRemind: false })
  })

  it('reports the reminder checkbox, and resets it each time it opens', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(<AgentTeamsCostDialog open allowDismiss onClose={() => {}} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('checkbox', { name: "Don't remind me again" }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on anyway' }))
    expect(onConfirm).toHaveBeenLastCalledWith({ dontRemind: true })

    rerender(<AgentTeamsCostDialog open={false} allowDismiss onClose={() => {}} onConfirm={onConfirm} />)
    rerender(<AgentTeamsCostDialog open allowDismiss onClose={() => {}} onConfirm={onConfirm} />)
    expect(screen.getByRole('checkbox', { name: "Don't remind me again" })).not.toBeChecked()
  })

  it('closes on cancel without confirming', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(<AgentTeamsCostDialog open onClose={onClose} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
