import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { InlineTaskSummary } from './InlineTaskSummary'
import { useSettingsStore } from '../../stores/settingsStore'

describe('InlineTaskSummary', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('counts finished tasks and marks each status with a lucide icon in its state colour', () => {
    const { container } = render(
      <InlineTaskSummary
        tasks={[
          { id: '1', subject: 'Write the parser', status: 'completed' },
          { id: '2', subject: 'Wire the store', status: 'in_progress' },
          { id: '3', subject: 'Ship it', status: 'pending' },
        ]}
      />,
    )

    expect(screen.getByText('1/3')).toBeInTheDocument()
    // Material ligature names used to be the icons' text, which find-in-chat
    // and copy both picked up.
    expect(container.querySelector('.material-symbols-outlined')).toBeNull()
    expect(container.textContent).not.toMatch(/check_circle|radio_button_unchecked|task_alt/)

    const row = (subject: string) => screen.getByText(subject).parentElement as HTMLElement
    expect(row('Write the parser').querySelector('svg.lucide-circle-check')).toHaveStyle({ color: 'var(--color-success)' })
    // In progress is a running state: info, never the brand accent.
    expect(row('Wire the store').querySelector('svg.lucide-circle-dot')).toHaveStyle({ color: 'var(--color-info)' })
    expect(row('Ship it').querySelector('svg.lucide-circle')).toHaveStyle({ color: 'var(--color-text-tertiary)' })
    expect(screen.getByText('Write the parser')).toHaveClass('line-through')
    expect(screen.getByText('#2')).toHaveClass('font-mono')
  })
})
