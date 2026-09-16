import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { WorkspaceBrowserAddressBar } from '@/components/workbench/WorkspaceBrowserAddressBar'
import { normalizeBrowserAddress } from '@/lib/workspace/browserAddress'
import { useOverlayStore } from '@/stores/overlayStore'
import { useSettingsStore } from '@/stores/settingsStore'

const visits = Array.from({ length: 8 }, (_, index) => ({
  url: `https://fixture.test/${index}`, title: `Fixture ${index}`, visitedAt: index,
}))
const onNavigate = vi.fn()
const props = {
  currentAddress: 'https://current.test/', active: true, disabled: false, blank: false,
  visits, onNavigate, resolveAddress: normalizeBrowserAddress, onOpenExternal: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useOverlayStore.setState({ count: 0, snapshotCount: 0 })
})
afterEach(cleanup)

describe('WorkspaceBrowserAddressBar', () => {
  it('forwards focus to the address and bounds recent suggestions to six keyboard-addressable rows', () => {
    const ref = createRef<HTMLInputElement>()
    render(<WorkspaceBrowserAddressBar {...props} ref={ref} />)
    act(() => ref.current!.focus())
    expect(ref.current).toHaveFocus()
    expect(ref.current!.selectionEnd).toBe(props.currentAddress.length)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(6)
    expect(options[0]).toHaveTextContent('Fixture 7')
    fireEvent.keyDown(ref.current!, { key: 'ArrowUp' })
    expect(ref.current).toHaveAttribute('aria-activedescendant', options[5]!.id)
    fireEvent.keyDown(ref.current!, { key: 'ArrowDown' })
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(ref.current!, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('https://fixture.test/7', expect.any(Function))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('filters URL matches, highlights the match, and labels direct addresses as navigation', () => {
    render(<WorkspaceBrowserAddressBar {...props} />)
    const address = screen.getByRole('combobox')
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'fixture.test/3' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('Go to address')
    expect(options[1]).toHaveTextContent('Fixture 3')
    expect(options[1]!.querySelector('strong')).toHaveTextContent('fixture.test/3')
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('fixture.test/3', expect.any(Function))
  })

  it('preserves a blank draft across workspace switching but Escape explicitly discards it', () => {
    const { rerender } = render(<WorkspaceBrowserAddressBar {...props} currentAddress="" blank />)
    const address = screen.getByRole('combobox')
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'in progress' } })
    rerender(<WorkspaceBrowserAddressBar {...props} currentAddress="" blank active={false} />)
    expect(address).toHaveValue('in progress')
    expect(useOverlayStore.getState().count).toBe(0)
    act(() => address.blur())
    rerender(<WorkspaceBrowserAddressBar {...props} currentAddress="" blank />)
    act(() => address.focus())
    expect(screen.getByRole('option')).toHaveTextContent('in progress')
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(address).toHaveValue('')
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does not create actionable suggestions for an unsupported scheme and balances overlays on unmount', () => {
    const { unmount } = render(<WorkspaceBrowserAddressBar {...props} />)
    const address = screen.getByRole('combobox')
    act(() => address.focus())
    expect(useOverlayStore.getState().count).toBe(1)
    fireEvent.change(address, { target: { value: 'javascript:alert(1)' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(onNavigate).not.toHaveBeenCalled()
    fireEvent.change(address, { target: { value: 'fixture' } })
    expect(useOverlayStore.getState().snapshotCount).toBe(1)
    unmount()
    expect(useOverlayStore.getState().count).toBe(0)
  })

  it('shows the new address only after navigation is accepted, allowing selection-discard confirmation first', () => {
    render(<WorkspaceBrowserAddressBar {...props} />)
    const address = screen.getByRole('combobox')
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'pending.test' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(address).toHaveValue(props.currentAddress)
    expect(screen.queryByRole('listbox')).toBeNull()
    act(() => onNavigate.mock.calls[0]![1]())
    expect(address).toHaveValue('https://pending.test')
  })
})
