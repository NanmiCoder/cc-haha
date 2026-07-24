import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import { useMarketStore } from '../../stores/marketStore'
import type { NormalizedSkill } from '../../types/market'
import { MarketHome } from './MarketHome'

vi.mock('./InstalledSkillsOverview', () => ({
  InstalledSkillsOverview: () => <section>Installed skills overview</section>,
}))

function makeSkill(overrides: Partial<NormalizedSkill> = {}): NormalizedSkill {
  return {
    id: 'clawhub:demo',
    source: 'clawhub',
    slug: 'demo',
    name: 'Demo Skill',
    summary: 'A focused demo skill',
    author: { handle: 'alice', displayName: 'Alice' },
    stats: { downloads: 1_240, stars: 18 },
    tags: ['workflow'],
    version: '1.0.0',
    securityStatus: 'benign',
    installState: 'installable',
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
  useMarketStore.setState({
    items: [makeSkill()],
    nextCursor: null,
    sources: {
      clawhub: { status: 'ok' },
      skillhub: { status: 'cached', fetchedAt: 1_700_000_000_000 },
    },
    query: '',
    filters: { source: 'all', security: 'all', installed: 'all' },
    isLoading: false,
    isLoadingMore: false,
    error: null,
    installingIds: new Set(),
  })
})

describe('MarketHome', () => {
  it('renders the compact catalog header, command bar, sources and semantic cards', () => {
    render(<MarketHome onRequestInstall={vi.fn()} />)

    expect(screen.getByText('Installed skills overview')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Skills Market' })).toBeInTheDocument()
    expect(screen.getByTestId('market-search-input')).toBeInTheDocument()
    expect(screen.getByTestId('market-filter-bar')).toBeInTheDocument()
    expect(screen.getByTestId('market-source-status-clawhub')).toHaveTextContent('Online')
    expect(screen.getByTestId('market-source-status-skillhub')).toHaveTextContent('Cached')
    expect(screen.getByTestId('market-grid')).toContainElement(screen.getByRole('article'))
    expect(screen.getByRole('button', { name: 'Demo Skill' })).toBeInTheDocument()
    expect(screen.getByText('1 skills')).toBeInTheDocument()
  })

  it('uses a catalog-shaped skeleton while the first page is loading', () => {
    useMarketStore.setState({ items: [], isLoading: true })

    render(<MarketHome onRequestInstall={vi.fn()} />)

    expect(screen.getByTestId('market-loading')).toHaveAttribute('aria-label', 'Loading skills…')
    expect(screen.queryByTestId('market-grid')).not.toBeInTheDocument()
  })
})
