import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { SettingsHelp } from './SettingsHelp'

const ENTRIES = [
  { label: 'What it is', body: 'Tidies memory in the background.' },
  { label: 'Trade-off', body: 'Uses extra tokens.' },
]

function renderHelp() {
  return render(
    <div>
      <SettingsHelp title="What is Auto-dream?" entries={ENTRIES} closeLabel="Close" />
      <button type="button">Elsewhere</button>
    </div>,
  )
}

describe('SettingsHelp', () => {
  it('names the trigger by the question it answers and starts collapsed', () => {
    renderHelp()
    const trigger = screen.getByRole('button', { name: 'What is Auto-dream?' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens a labelled card holding every entry, then focuses it', () => {
    renderHelp()
    const trigger = screen.getByRole('button', { name: 'What is Auto-dream?' })
    fireEvent.click(trigger)

    const card = screen.getByRole('dialog', { name: 'What is Auto-dream?' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', card.id)
    expect(card).toHaveTextContent('What it is')
    expect(card).toHaveTextContent('Tidies memory in the background.')
    expect(card).toHaveTextContent('Trade-off')
    expect(card).toHaveTextContent('Uses extra tokens.')
    // `IconButton` is a function component: if it stopped forwarding the ref,
    // the anchor would never measure and the card would stay hidden.
    expect(card).toBeVisible()
    expect(card).toHaveFocus()
  })

  it('toggles closed from the trigger without reopening on the same click', () => {
    renderHelp()
    const trigger = screen.getByRole('button', { name: 'What is Auto-dream?' })
    fireEvent.click(trigger)
    // The outside-click listener runs on pointerdown; the trigger is exempt,
    // so this press must not close the card only for the click to reopen it.
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on Escape and returns focus to the trigger', () => {
    renderHelp()
    const trigger = screen.getByRole('button', { name: 'What is Auto-dream?' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes from its own close button', () => {
    renderHelp()
    const trigger = screen.getByRole('button', { name: 'What is Auto-dream?' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('stays open for presses inside the card and closes for presses outside it', () => {
    renderHelp()
    fireEvent.click(screen.getByRole('button', { name: 'What is Auto-dream?' }))
    fireEvent.pointerDown(screen.getByText('Uses extra tokens.'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('colors the card from theme tokens only, so every theme restyles it', () => {
    renderHelp()
    fireEvent.click(screen.getByRole('button', { name: 'What is Auto-dream?' }))
    const card = screen.getByRole('dialog')
    expect(card.className).toContain('bg-[var(--color-surface-container-lowest)]')
    expect(card.className).toContain('border-[var(--color-border)]')
    expect(card.className).toContain('shadow-[var(--shadow-dropdown)]')
    expect(card.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(card.style.zIndex).toBe('var(--z-popover)')
  })
})
