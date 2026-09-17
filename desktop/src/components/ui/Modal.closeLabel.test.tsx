import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Modal } from './Modal'
import { ConfirmDialog } from './ConfirmDialog'

describe('Modal localized close label', () => {
  it('uses the caller label and closes through the actual button', () => {
    const close = vi.fn()
    render(<Modal open title="Fixture" closeLabel="关闭" onClose={close}><span>Fixture</span></Modal>)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('forwards the localized close label through confirmation dialogs', () => {
    const close = vi.fn()
    render(<ConfirmDialog open title="Fixture" body="Fixture" closeLabel="关闭" confirmLabel="删除" cancelLabel="取消" onClose={close} onConfirm={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('preserves the existing default for callers not supplying a label', () => {
    render(<Modal open title="Fixture" onClose={() => {}}><span>Fixture</span></Modal>)
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument()
  })
})
