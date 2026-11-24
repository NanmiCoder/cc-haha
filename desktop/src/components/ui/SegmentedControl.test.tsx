import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { SegmentedControl } from './SegmentedControl'

const ITEMS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
] as const

describe('SegmentedControl', () => {
  it('exposes a named radiogroup by default', () => {
    render(<SegmentedControl items={ITEMS} value="all" onChange={() => {}} label="Filter" />)
    expect(screen.getByRole('radiogroup', { name: 'Filter' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('exposes a tablist when switching views', () => {
    // The four hand-rolled `role="tab"` sites had no `role="tablist"` parent,
    // so the roles announced nothing.
    render(<SegmentedControl items={ITEMS} value="all" onChange={() => {}} label="View" as="tablist" />)
    expect(screen.getByRole('tablist', { name: 'View' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('marks the selected segment', () => {
    render(<SegmentedControl items={ITEMS} value="active" onChange={() => {}} label="Filter" />)
    expect(screen.getByRole('radio', { name: 'Active' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'false')
  })

  it('reports the picked value', () => {
    const onChange = vi.fn()
    render(<SegmentedControl items={ITEMS} value="all" onChange={onChange} label="Filter" />)

    fireEvent.click(screen.getByRole('radio', { name: 'Done' }))
    expect(onChange).toHaveBeenCalledWith('done')
  })

  it('moves between segments with the arrow keys', () => {
    // None of the 10 hand-rolled versions supported this.
    const onChange = vi.fn()
    render(<SegmentedControl items={ITEMS} value="all" onChange={onChange} label="Filter" />)

    const first = screen.getByRole('radio', { name: 'All' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })

    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Active' }))
    expect(onChange).toHaveBeenCalledWith('active')
  })

  it('wraps around at the ends', () => {
    const onChange = vi.fn()
    render(<SegmentedControl items={ITEMS} value="all" onChange={onChange} label="Filter" />)

    const first = screen.getByRole('radio', { name: 'All' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowLeft' })

    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Done' }))
  })

  it('keeps the group to a single tab stop', () => {
    render(<SegmentedControl items={ITEMS} value="active" onChange={() => {}} label="Filter" />)

    expect(screen.getByRole('radio', { name: 'Active' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('tabindex', '-1')
  })

  it('skips disabled segments when arrowing', () => {
    const items = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
      { value: 'c', label: 'C' },
    ] as const
    render(<SegmentedControl items={items} value="a" onChange={() => {}} label="Filter" />)

    const first = screen.getByRole('radio', { name: 'A' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })

    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'C' }))
  })

  it('gives every segment a focus ring in all four appearances', () => {
    for (const appearance of ['solid', 'raised', 'underline', 'chip'] as const) {
      const { unmount } = render(
        <SegmentedControl items={ITEMS} value="all" onChange={() => {}} label="Filter" appearance={appearance} />,
      )
      expect(screen.getByRole('radio', { name: 'All' }).className).toContain('focus-visible:ring-2')
      unmount()
    }
  })

  describe('chip appearance', () => {
    it('wraps separate pills instead of pinning one framed track height', () => {
      // A long category list in a single fixed-height track clips or forces a
      // sideways scroll; chips have to be free to wrap onto the next line.
      render(<SegmentedControl items={ITEMS} value="all" onChange={() => {}} label="Category" appearance="chip" />)

      const group = screen.getByRole('radiogroup', { name: 'Category' })
      expect(group.className).toContain('flex-wrap')
      expect(group.className).not.toMatch(/\bh-8\b/)
      for (const radio of screen.getAllByRole('radio')) {
        expect(radio.className).toContain('rounded-full')
        expect(radio.className).toMatch(/\bh-8\b/)
      }
    })

    it('keeps the radiogroup semantics and arrow-key movement', () => {
      const onChange = vi.fn()
      render(<SegmentedControl items={ITEMS} value="active" onChange={onChange} label="Category" appearance="chip" />)

      const active = screen.getByRole('radio', { name: 'Active' })
      expect(active).toHaveAttribute('aria-checked', 'true')
      expect(active).toHaveAttribute('tabindex', '0')

      active.focus()
      fireEvent.keyDown(active, { key: 'ArrowRight' })
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Done' }))
      expect(onChange).toHaveBeenCalledWith('done')
    })

    it('fills the picked chip with the primary ink pair', () => {
      render(<SegmentedControl items={ITEMS} value="all" onChange={() => {}} label="Category" appearance="chip" />)

      expect(screen.getByRole('radio', { name: 'All' }).className).toContain('bg-[var(--color-btn-primary-bg)]')
      expect(screen.getByRole('radio', { name: 'Done' }).className).toContain('bg-[var(--color-surface)]')
    })
  })
})
