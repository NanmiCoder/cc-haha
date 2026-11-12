import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { FrontmatterPanel } from './FrontmatterPanel'
import { useSettingsStore } from '../../stores/settingsStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('FrontmatterPanel', () => {
  it('renders each key next to its value', () => {
    render(<FrontmatterPanel frontmatter={{ model: 'opus', 'allowed-tools': 'Read, Write' }} />)

    const row = screen.getByTestId('skill-frontmatter-row-model')
    expect(within(row).getByText('model')).toBeInTheDocument()
    expect(within(row).getByText('opus')).toBeInTheDocument()
    expect(screen.getByTestId('skill-frontmatter-row-allowed-tools')).toHaveTextContent('Read, Write')
  })

  it('renders sequences as individual chips rather than one joined string', () => {
    render(<FrontmatterPanel frontmatter={{ xiaping_tags: ['AI工具', 'Skill discovery', 'WorkBuddy'] }} />)

    const row = screen.getByTestId('skill-frontmatter-row-xiaping_tags')
    expect(within(row).getByText('AI工具')).toBeInTheDocument()
    expect(within(row).getByText('Skill discovery')).toBeInTheDocument()
    expect(within(row).getByText('WorkBuddy')).toBeInTheDocument()
  })

  it('renders booleans as a chip', () => {
    render(<FrontmatterPanel frontmatter={{ agent_created: true }} />)

    expect(screen.getByTestId('skill-frontmatter-row-agent_created')).toHaveTextContent('true')
  })

  it('renders multi-line values in a scrollable pre block', () => {
    const { container } = render(<FrontmatterPanel frontmatter={{ hooks: 'PreToolUse:\n  - matcher: Bash' }} />)

    const pre = container.querySelector('pre')
    expect(pre).toBeInTheDocument()
    expect(pre).toHaveTextContent('PreToolUse:')
  })

  it('omits keys already shown in the detail header', () => {
    render(<FrontmatterPanel frontmatter={{ name: 'find-skills', version: '1.7.0', model: 'opus' }} />)

    expect(screen.queryByTestId('skill-frontmatter-row-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-frontmatter-row-version')).not.toBeInTheDocument()
    expect(screen.getByTestId('skill-frontmatter-row-model')).toBeInTheDocument()
  })

  it('renders nothing when every field is filtered out', () => {
    render(<FrontmatterPanel frontmatter={{ name: 'find-skills', description: 'x' }} />)

    expect(screen.queryByTestId('skill-frontmatter-panel')).not.toBeInTheDocument()
  })

  it('renders nothing for absent frontmatter', () => {
    render(<FrontmatterPanel frontmatter={null} />)

    expect(screen.queryByTestId('skill-frontmatter-panel')).not.toBeInTheDocument()
  })

  it('offers no toggle for a short block', () => {
    render(<FrontmatterPanel frontmatter={{ model: 'opus', effort: 'high' }} />)

    expect(screen.queryByTestId('skill-frontmatter-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('skill-frontmatter-row-model')).toBeInTheDocument()
  })

  it('stacks arrays but keeps short scalars opposite their label in the sidebar', () => {
    render(<FrontmatterPanel variant="sidebar" frontmatter={{ model: 'opus', tags: ['a', 'b'] }} />)

    // Short scalars mirror the market meta rows above them (label left, value
    // right); arrays need the full width, so they drop to their own line.
    expect(screen.getByTestId('skill-frontmatter-row-model').className).toContain('justify-between')
    expect(screen.getByTestId('skill-frontmatter-row-tags').className).toContain('flex-col')
  })

  it('renders the same fields in either variant', () => {
    const frontmatter = { model: 'opus', tags: ['a', 'b'], license: 'MIT' }
    const grid = render(<FrontmatterPanel variant="grid" frontmatter={frontmatter} />)
    const gridKeys = [...grid.container.querySelectorAll('dt')].map((n) => n.textContent)
    grid.unmount()

    const sidebar = render(<FrontmatterPanel variant="sidebar" frontmatter={frontmatter} />)
    const sidebarKeys = [...sidebar.container.querySelectorAll('dt')].map((n) => n.textContent)

    expect(sidebarKeys).toEqual(gridKeys)
  })

  it('collapses and expands a long block', () => {
    const frontmatter = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`field_${i}`, `value ${i}`]),
    )
    render(<FrontmatterPanel frontmatter={frontmatter} />)

    const toggle = screen.getByTestId('skill-frontmatter-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('skill-frontmatter-row-field_0')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('skill-frontmatter-row-field_0')).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.getByTestId('skill-frontmatter-row-field_0')).toBeInTheDocument()
  })
})
