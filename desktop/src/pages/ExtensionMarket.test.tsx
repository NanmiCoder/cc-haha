import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { it, expect, vi } from 'vitest'
import { ExtensionMarket } from './ExtensionMarket'
import { useUIStore } from '@/stores/uiStore'
vi.mock('@/i18n', () => ({ useTranslation: () => (key: string) => key }))
vi.mock('@/pages/Connectors', () => ({ Connectors: ({ mode, embedded, externalQuery, installedFilter, management, focusConnectorId }: { mode?: string, management?: boolean, embedded?: boolean, externalQuery?: string, installedFilter?: string, focusConnectorId?: string }) => <div data-testid={`catalog-${mode || "plugins"}`} data-management={management} data-embedded={embedded} data-query={externalQuery} data-filter={installedFilter} data-focus={focusConnectorId} /> }))
vi.mock('@/pages/InstalledSkills', () => ({ InstalledSkills: () => <div data-testid="installed-skills" /> }))
vi.mock('@/pages/Market', () => ({ Market: ({ featured }: { featured: React.ReactNode }) => <div data-testid="existing-skill-market">{featured}</div> }))
it('defaults to plugins and shows only the skill market on the skills tab', () => {
  render(<ExtensionMarket />)
  expect(screen.getByRole('heading', { name: 'sidebar.extensions' })).toBeInTheDocument()
  expect(screen.getByTestId('catalog-plugins')).toBeInTheDocument()
  expect(screen.queryByTestId('existing-skill-market')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('radio', { name: 'extensions.skills' }))
  expect(screen.getByTestId('existing-skill-market')).toBeInTheDocument()
  // Curated skill packages are withdrawn from the market for now: the skills
  // tab must not mount the connector catalog again.
  expect(screen.queryByTestId('catalog-skills')).not.toBeInTheDocument()
  expect(screen.queryByTestId('catalog-plugins')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('radio', { name: 'extensions.plugins' }))
  expect(screen.getByTestId('catalog-plugins')).toBeInTheDocument()
})

it('opens installed management from the current section without adding another navigation row', () => {
  render(<ExtensionMarket />)
  fireEvent.click(screen.getByRole('button', { name: 'extensions.myPlugins' }))
  expect(screen.getByRole('heading', { name: 'extensions.myPlugins' })).toBeInTheDocument()
  expect(screen.getByTestId('catalog-plugins')).toHaveAttribute('data-management', 'true')
  expect(screen.getAllByRole('radiogroup')).toHaveLength(1)
  fireEvent.click(screen.getByRole('radio', { name: 'extensions.skills' }))
  expect(screen.getByTestId('installed-skills')).toBeInTheDocument()
  expect(screen.queryByTestId('existing-skill-market')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'extensions.mySkills' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'extensions.browse' }))
  expect(screen.getByTestId('existing-skill-market')).toBeInTheDocument()
  expect(screen.queryByTestId('installed-skills')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'extensions.mySkills' }))
  expect(screen.getByTestId('installed-skills')).toBeInTheDocument()
})

it('opens at the section and connector the composer menu asked for, once', () => {
  useUIStore.setState({ pendingMarketTarget: null })
  render(<ExtensionMarket />)
  fireEvent.click(screen.getByRole('radio', { name: 'extensions.skills' }))
  fireEvent.click(screen.getByRole('button', { name: 'extensions.mySkills' }))
  expect(screen.getByTestId('installed-skills')).toBeInTheDocument()

  // Already open in a tab: the request still lands, in the catalog view.
  act(() => useUIStore.getState().setPendingMarketTarget({ section: 'plugins', connectorId: 'github' }))
  expect(screen.getByTestId('catalog-plugins')).toHaveAttribute('data-focus', 'github')
  expect(screen.getByTestId('catalog-plugins')).not.toHaveAttribute('data-management', 'true')
  expect(useUIStore.getState().pendingMarketTarget).toBeNull()

  act(() => useUIStore.getState().setPendingMarketTarget({ section: 'skills' }))
  expect(screen.getByTestId('existing-skill-market')).toBeInTheDocument()
})
