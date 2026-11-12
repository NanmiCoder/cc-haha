import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'

// The settings people ask about in the group chat, each with a "?" beside it.
const HELP_TRIGGERS = [
  { name: 'What is thinking mode?', row: 'Enable thinking mode' },
  { name: 'What is lean mode?', row: 'Enable lean mode' },
  { name: 'What is Ultracode?', row: 'Enable Ultracode keyword trigger' },
  { name: 'What are Agent Teams?', row: 'Enable Agent Teams' },
  { name: 'What is a SubAgent?', row: 'Ordinary SubAgent concurrency limit' },
  { name: 'What does auto-answer do?', row: 'Answer questions automatically after a timeout' },
  { name: 'What is Auto-dream?', row: 'Enable Auto-dream' },
  { name: 'What is the WebFetch domain preflight?', row: 'Skip WebFetch domain preflight' },
  { name: 'What is Agent Trace?', row: 'Collect agent traces' },
]

describe('General settings help cards', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      locale: 'en',
      fetchOutputStyles: async () => {},
      fetchAppMode: async () => {},
    })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
  })
  afterEach(() => {
    cleanup()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })

  it.each(HELP_TRIGGERS)('puts "$name" right after the "$row" title', ({ name, row }) => {
    render(<GeneralSettings />)
    const trigger = screen.getByRole('button', { name })
    expect(trigger.previousElementSibling).toHaveTextContent(row)
  })

  it('adds exactly these help triggers and none to self-explanatory settings', () => {
    render(<GeneralSettings />)
    const triggers = screen.getAllByRole('button', { name: /^What (is|are|does)/ })
    expect(triggers.map((trigger) => trigger.getAttribute('aria-label')).sort())
      .toEqual(HELP_TRIGGERS.map(({ name }) => name).sort())
  })

  it('explains Auto-dream in plain words when its "?" is clicked', () => {
    render(<GeneralSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'What is Auto-dream?' }))
    const card = screen.getByRole('dialog', { name: 'What is Auto-dream?' })
    expect(within(card).getByText('What it is')).toBeInTheDocument()
    expect(within(card).getByText('Use it when')).toBeInTheDocument()
    expect(within(card).getByText('Trade-off')).toBeInTheDocument()
    expect(card).toHaveTextContent('24 hours')
    expect(card).toHaveTextContent('never your code')
  })

  it('uses the "why" label for the WebFetch preflight card', () => {
    render(<GeneralSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'What is the WebFetch domain preflight?' }))
    const card = screen.getByRole('dialog', { name: 'What is the WebFetch domain preflight?' })
    expect(within(card).getByText('Why')).toBeInTheDocument()
    expect(within(card).queryByText('Trade-off')).not.toBeInTheDocument()
  })

  it('follows the interface language', () => {
    useSettingsStore.setState({ locale: 'en' })
    render(<GeneralSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'What is Auto-dream?' }))
    const card = screen.getByRole('dialog', { name: 'What is Auto-dream?' })
    expect(within(card).getByText('Trade-off')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })
})
