import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { SearchField } from './SearchField'

describe('SearchField', () => {
  it('forwards a ref to focus the actual search field from quick open', () => {
    const ref = createRef<HTMLInputElement>()
    render(<SearchField ref={ref} label="Files" clearLabel="Clear" value="" onChange={() => {}} />)
    ref.current?.focus()
    expect(screen.getByRole('searchbox')).toHaveFocus()
  })
  it('names itself from label even with no visible label', () => {
    render(<SearchField label="Search sessions" clearLabel="Clear search" value="" onChange={() => {}} />)
    expect(screen.getByRole('searchbox', { name: 'Search sessions' })).toBeInTheDocument()
  })

  it('shows a visible label on request', () => {
    render(<SearchField label="Search sessions" clearLabel="Clear search" showLabel value="" onChange={() => {}} />)
    expect(screen.getByText('Search sessions')).toBeInTheDocument()
    expect(screen.getByLabelText('Search sessions')).toBeInTheDocument()
  })

  it('reports typing', () => {
    const onChange = vi.fn()
    render(<SearchField label="Search" clearLabel="Clear search" value="" onChange={onChange} />)

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'abc' } })
    expect(onChange).toHaveBeenCalledWith('abc')
  })

  it('shows a keyboard-reachable clear button only when there is text', () => {
    const onChange = vi.fn()
    const onClear = vi.fn()
    const { rerender } = render(
      <SearchField label="Search" clearLabel="Clear search" value="" onChange={onChange} onClear={onClear} />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    rerender(
      <SearchField label="Search" clearLabel="Clear search" value="abc" onChange={onChange} onClear={onClear} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(onChange).toHaveBeenCalledWith('')
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('keeps the input and its clear button distinctly named', () => {
    // They must not share a name: getByLabelText would match both and throw.
    // The component also must not compose the name itself — an English
    // `Clear ${label}` makes adoption an i18n regression.
    render(<SearchField label="搜索会话" clearLabel="清除搜索" value="abc" onChange={() => {}} />)

    expect(screen.getByLabelText('搜索会话')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清除搜索' })).toBeInTheDocument()
  })

  it('can drop the clear button entirely', () => {
    render(<SearchField label="Search" clearLabel="Clear search" value="abc" onChange={() => {}} clearable={false} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('routes arrow keys to the result list without moving the caret', () => {
    const onNavigate = vi.fn()
    render(<SearchField label="Search" clearLabel="Clear search" value="" onChange={() => {}} onNavigate={onNavigate} />)

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' })
    expect(onNavigate).toHaveBeenCalledWith('down')

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowUp' })
    expect(onNavigate).toHaveBeenCalledWith('up')
  })

  it('still forwards other keys to onKeyDown', () => {
    const onKeyDown = vi.fn()
    render(<SearchField label="Search" clearLabel="Clear search" value="" onChange={() => {}} onKeyDown={onKeyDown} />)

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(onKeyDown).toHaveBeenCalled()
  })

  it('becomes a combobox when it controls a result list', () => {
    render(
      <SearchField
        label="Search"
        clearLabel="Clear search"
        value=""
        onChange={() => {}}
        controlsId="results"
        activeDescendantId="result-2"
      />,
    )
    const input = screen.getByRole('combobox')
    expect(input).toHaveAttribute('aria-controls', 'results')
    expect(input).toHaveAttribute('aria-activedescendant', 'result-2')
  })

  it('has a visible focus treatment', () => {
    // Three of the 11 hand-rolled search boxes had none at all.
    render(<SearchField label="Search" clearLabel="Clear search" value="" onChange={() => {}} />)
    expect(screen.getByRole('searchbox').className).toContain('focus:border-[var(--color-border-focus)]')
  })
})
