import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'
import { Modal } from './Modal'

describe('Modal', () => {
  it('portals the dialog to body so the scrim covers the full app shell', () => {
    const onClose = vi.fn()
    const { container } = render(
      <div data-testid="stacking-parent" className="relative z-10">
        <Modal open onClose={onClose} title="Provider">
          <span>Provider form</span>
        </Modal>
      </div>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Provider' })

    expect(container.contains(dialog)).toBe(false)
    expect(document.body.contains(dialog)).toBe(true)
  })

  it('carries an opaque panel rather than the blur-dependent glass fill', () => {
    // `.glass-panel` only hides what is behind it when `backdrop-filter` runs.
    // Where it does not, the blur is skipped without error and the page reads
    // through the panel — which is how the provider list stayed legible behind
    // the provider form. Dialogs are too large and too long-lived to bet on it.
    render(
      <Modal open onClose={vi.fn()} title="Provider">
        <span>Provider form</span>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Provider' })
    expect(dialog).toHaveClass('dialog-panel')
    expect(dialog).not.toHaveClass('glass-panel')
  })

  it('sits on the modal scrim, not the lighter non-modal one', () => {
    render(
      <Modal open onClose={vi.fn()} title="Provider">
        <span>Provider form</span>
      </Modal>,
    )

    const backdrop = screen.getByRole('dialog', { name: 'Provider' }).previousElementSibling
    expect(backdrop).toHaveClass('bg-[var(--color-modal-scrim)]')
  })

  it('gives media a viewport stage instead of wrapping it in a dialog card', () => {
    render(
      <Modal open onClose={vi.fn()} title="Preview" variant="media">
        <img src="preview.png" alt="Preview" />
      </Modal>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Preview' })
    expect(dialog).toHaveClass('bg-[var(--color-terminal-bg)]')
    expect(dialog).toHaveClass('h-[calc(100dvh-24px)]')
    expect(dialog).not.toHaveClass('dialog-panel')
    expect(screen.getByRole('img', { name: 'Preview' }).parentElement).not.toHaveClass('px-6')
  })

  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose}>
        <span>Provider form</span>
      </Modal>,
    )

    const backdrop = screen.getByRole('dialog').previousElementSibling
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop!)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus inside, loops Tab at both edges, and restores the trigger after close', async () => {
    const onClose = vi.fn()
    const view = (open: boolean) => (
      <>
        <button type="button">Open provider</button>
        <Modal open={open} onClose={onClose} title="Provider">
          <label>
            Name
            <input aria-label="Provider name" />
          </label>
          <button type="button">Save provider</button>
        </Modal>
      </>
    )
    const { rerender } = render(view(false))
    const trigger = screen.getByRole('button', { name: 'Open provider' })
    trigger.focus()

    rerender(view(true))
    const dialog = await screen.findByRole('dialog', { name: 'Provider' })
    const close = within(dialog).getByRole('button', { name: 'Close dialog' })
    const last = within(dialog).getByRole('button', { name: 'Save provider' })
    await waitFor(() => expect(document.activeElement).toBe(close))

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    rerender(view(false))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('keeps a busy confirmation open for Escape, backdrop, and close-button attempts', async () => {
    const onClose = vi.fn()
    const view = (open: boolean) => (
      <>
        <button type="button">Start rebuild</button>
        <ConfirmDialog
          open={open}
          onClose={onClose}
          onConfirm={vi.fn()}
          title="Rebuild local index"
          body="Rebuild?"
          confirmLabel="Rebuild"
          cancelLabel="Cancel"
          loading
        />
      </>
    )
    const { rerender } = render(view(false))
    screen.getByRole('button', { name: 'Start rebuild' }).focus()
    rerender(view(true))

    const dialog = await screen.findByRole('dialog', { name: 'Rebuild local index' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(dialog.previousElementSibling!)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }))

    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.contains(dialog)).toBe(true)
  })
})
