import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Shield } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { MobileComposerSheet } from './MobileComposerSheet'

describe('MobileComposerSheet', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('uses V6C pressable control-radius sheet rows for session settings', () => {
    const onSelect = vi.fn()
    render(
      <MobileComposerSheet
        open
        onClose={vi.fn()}
        menuId="composer-menu"
        settings={[
          {
            key: 'mode',
            icon: <Shield size={16} strokeWidth={1.75} aria-hidden="true" />,
            label: 'Permission mode',
            value: 'Ask',
            onSelect,
          },
        ]}
        sections={[]}
        onAction={vi.fn()}
      />,
    )

    const sheet = screen.getByTestId('mobile-composer-sheet')
    const row = within(sheet).getByRole('button', { name: /Permission mode/ })
    expect(row).toHaveClass('v6c-pressable', 'rounded-[var(--radius-control)]', 'hover:bg-[var(--color-surface-hover)]')
    expect(row.firstElementChild).toHaveClass('rounded-[var(--radius-control)]')

    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
