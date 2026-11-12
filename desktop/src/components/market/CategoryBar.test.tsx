import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import type { MarketCategory } from '../../types/market'
import { CategoryBar } from './CategoryBar'

const CATEGORIES: MarketCategory[] = [
  { key: 'dev', name: '开发编程', nameEn: 'Development', count: 40 },
  { key: 'office', name: '办公文档', nameEn: 'Office', count: 36 },
]

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('CategoryBar', () => {
  it('renders "All" plus one counted chip per catalog category', () => {
    render(<CategoryBar categories={CATEGORIES} value="all" onChange={vi.fn()} />)

    const group = screen.getByRole('radiogroup', { name: 'Category' })
    expect(group).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Development 40' })).toBeInTheDocument()
  })

  it('reports the picked category key', () => {
    const onChange = vi.fn()
    render(<CategoryBar categories={CATEGORIES} value="all" onChange={onChange} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Office 36' }))
    expect(onChange).toHaveBeenCalledWith('office')
  })

  it('renders nothing before the server sent any categories', () => {
    render(<CategoryBar categories={[]} value="all" onChange={vi.fn()} />)

    expect(screen.queryByTestId('market-category-bar')).not.toBeInTheDocument()
  })
})
