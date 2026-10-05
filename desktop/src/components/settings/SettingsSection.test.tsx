import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsPill,
  SettingsRow,
  SettingsSection,
  SettingsStat,
  SettingsSwitchRow,
} from './SettingsSection'

describe('SettingsPageHeader', () => {
  it('renders the title as a heading so panes are navigable by landmark', () => {
    render(<SettingsPageHeader title="Providers" description="Pick a default" />)
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeInTheDocument()
    expect(screen.getByText('Pick a default')).toBeInTheDocument()
  })

  it('is the pane-level h2 at the 22px page-title size', () => {
    render(<SettingsPageHeader title="Providers" />)
    const heading = screen.getByRole('heading', { level: 2, name: 'Providers' })
    expect(heading.className).toContain('text-[22px]')
    expect(heading.className).toContain('font-semibold')
  })

  it('omits the description line when none is given', () => {
    const { container } = render(<SettingsPageHeader title="Providers" />)
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders the action slot', () => {
    render(<SettingsPageHeader title="Providers" action={<button type="button">Add</button>} />)
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})

describe('SettingsSection', () => {
  it('labels its children with a heading', () => {
    render(
      <SettingsSection title="Appearance" description="Theme and density">
        <span>body</span>
      </SettingsSection>,
    )
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('renders as a section element so the heading scopes a region', () => {
    const { container } = render(<SettingsSection title="Appearance">x</SettingsSection>)
    expect(container.firstElementChild?.tagName).toBe('SECTION')
  })

  it('labels the section with an h3 under the pane title', () => {
    render(<SettingsSection title="Appearance">x</SettingsSection>)
    expect(screen.getByRole('heading', { level: 3, name: 'Appearance' })).toBeInTheDocument()
  })
})

describe('SettingsGroup / SettingsRow', () => {
  it('puts rows in one bordered card with a hairline between each', () => {
    render(
      <SettingsGroup aria-label="Rows">
        <SettingsRow title="First">a</SettingsRow>
        <SettingsRow title="Second">b</SettingsRow>
      </SettingsGroup>,
    )
    const group = screen.getByLabelText('Rows')
    expect(group.className).toContain('rounded-[var(--radius-lg)]')
    expect(group.className).toContain('border')
    expect(group.className).toContain('divide-y')
    // Not overflow-hidden: rows host Dropdowns whose menus would be clipped.
    expect(group.className).not.toContain('overflow-hidden')
  })

  it('shows the title, the description and the control of a row', () => {
    render(
      <SettingsRow title="Language" description="Pick one">
        <button type="button">Choose</button>
      </SettingsRow>,
    )
    expect(screen.getByText('Language')).toBeInTheDocument()
    expect(screen.getByText('Pick one')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose' })).toBeInTheDocument()
  })

  it('labels a bare input through htmlFor', () => {
    render(
      <SettingsRow title="Proxy URL" htmlFor="proxy">
        <input id="proxy" />
      </SettingsRow>,
    )
    expect(screen.getByLabelText('Proxy URL')).toHaveAttribute('id', 'proxy')
  })

  it('renders the footer below the row', () => {
    render(<SettingsRow title="Retention" footer={<p>Failed</p>}>x</SettingsRow>)
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('wraps free-form content in a padded block', () => {
    render(<SettingsBlock>free</SettingsBlock>)
    expect(screen.getByText('free').className).toContain('px-4')
  })
})

describe('SettingsSwitchRow', () => {
  it('names the switch with the visible title and reports changes', () => {
    const onChange = vi.fn()
    render(<SettingsSwitchRow title="Enable thinking" description="New sessions" checked={false} onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Enable thinking' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText('Enable thinking')).toBeVisible()
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('can be disabled', () => {
    render(<SettingsSwitchRow title="Enable" checked onChange={() => {}} disabled />)
    expect(screen.getByRole('switch', { name: 'Enable' })).toBeDisabled()
  })
})

describe('SettingsPill', () => {
  it('reports its selection through aria-pressed', () => {
    render(
      <>
        <SettingsPill selected onClick={() => {}}>Paper</SettingsPill>
        <SettingsPill selected={false} onClick={() => {}}>Dark</SettingsPill>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('defaults to type="button" so it cannot submit a surrounding form', () => {
    render(<SettingsPill selected={false} onClick={() => {}}>Paper</SettingsPill>)
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('type', 'button')
  })

  it('fills with ink when selected and tone is ink', () => {
    render(<SettingsPill selected onClick={() => {}}>Paper</SettingsPill>)
    expect(screen.getByRole('button', { name: 'Paper' }).className)
      .toContain('bg-[var(--color-btn-primary-bg)]')
  })

  it('outlines in terracotta when selected and tone is terracotta', () => {
    render(<SettingsPill selected tone="terracotta" onClick={() => {}}>DeepSeek</SettingsPill>)
    const className = screen.getByRole('button', { name: 'DeepSeek' }).className
    expect(className).toContain('border-[var(--color-primary-fixed-dim)]')
    // The soft fill's own accent is too low-contrast on it under the two ink
    // palettes; the paired token is the readable one.
    expect(className).toContain('text-[var(--color-on-brand-soft)]')
  })

  it('calls onClick', () => {
    const onClick = vi.fn()
    render(<SettingsPill selected={false} onClick={onClick}>Paper</SettingsPill>)
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('can be disabled', () => {
    render(<SettingsPill selected={false} disabled onClick={() => {}}>Paper</SettingsPill>)
    expect(screen.getByRole('button', { name: 'Paper' })).toBeDisabled()
  })
})

describe('SettingsStat', () => {
  it('renders the value as a tabular 22px figure and keeps the label readable', () => {
    render(<SettingsStat label="Sessions" value="128" />)
    expect(screen.getByText('128').className).toContain('tabular-nums')
    expect(screen.getByText('128').className).toContain('text-[22px]')
    expect(screen.getByText('Sessions')).toBeInTheDocument()
  })

  it('renders the optional hint line', () => {
    render(<SettingsStat label="Sessions" value="128" hint="last 30 days" />)
    expect(screen.getByText('last 30 days')).toBeInTheDocument()
  })
})
