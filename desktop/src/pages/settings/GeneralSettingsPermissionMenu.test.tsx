import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'

describe('General settings default permission menu', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      locale: 'zh',
      permissionMode: 'default',
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

  // The trigger sits at the end of a settings row, against the right edge of
  // the scrolling content column. A menu growing rightwards from the trigger's
  // left edge ran past the window and was clipped (#1474).
  it('opens the menu leftwards from the trigger at the end of the row', () => {
    render(<GeneralSettings />)

    fireEvent.click(screen.getByRole('button', { name: '询问权限' }))

    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: /询问权限/ })).toBeInTheDocument()
    expect(menu).toHaveClass('right-0')
    expect(menu).not.toHaveClass('left-0')
  })
})
