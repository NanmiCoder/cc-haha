import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { DocumentAnnotation } from './DocumentAnnotation'

beforeEach(() => useSettingsStore.setState({ locale: 'en' }))

it('supports empty-cell comments, trims notes and submits using the keyboard', () => {
  const onAdd = vi.fn()
  render(<DocumentAnnotation selection={{ location: "'Revenue'!B4", text: '' }} onAdd={onAdd} onClose={vi.fn()} />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '  ' } })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  expect(onAdd).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '  Add a formula here  ' } })
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true })
  expect(onAdd).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  expect(onAdd).toHaveBeenCalledWith('Add a formula here')
})

it('renders quoted content as text and allows Escape to cancel', () => {
  const onClose = vi.fn()
  render(<DocumentAnnotation selection={{ location: 'Page 1', text: '<img src=x onerror=alert(1)>' }} onAdd={vi.fn()} onClose={onClose} />)
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(onClose).toHaveBeenCalled()
})
