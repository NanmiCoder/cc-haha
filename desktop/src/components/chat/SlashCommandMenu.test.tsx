import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { translate } from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'
import { SlashCommandMenu, getSlashCommandOptionId } from './SlashCommandMenu'

describe('SlashCommandMenu', () => {
  it('renders ordered command groups with stable option ids and accurate skill sources', () => {
    const onSelect = vi.fn()
    const itemRefs = { current: [] as (HTMLElement | null)[] }

    render(
      <SlashCommandMenu
        ref={createRef<HTMLDivElement>()}
        id="slash-menu"
        groups={{
          system: [{ name: 'status', description: 'Show status', kind: 'command' }],
          skills: [
            {
              name: 'project-audit',
              description: 'Audit project UX',
              kind: 'skill',
              source: 'project',
            },
          ],
          ordered: [],
        }}
        selectedIndex={1}
        itemRefs={itemRefs}
        onSelect={onSelect}
        onHighlight={vi.fn()}
        showKeyboardHints
      />,
    )

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('id', getSlashCommandOptionId('slash-menu', 0))
    expect(options[1]).toHaveAttribute('id', getSlashCommandOptionId('slash-menu', 1))
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveTextContent(
      translate(useSettingsStore.getState().locale, 'chat.slashSkillProject'),
    )
    expect(itemRefs.current[1]).toBe(options[1])

    fireEvent.click(options[1]!)
    expect(onSelect).toHaveBeenCalledWith('project-audit')
  })
})

it('uses safe skill branding and keeps the description beside its name without changing selection values', () => {
  const onSelect = vi.fn()
  render(<SlashCommandMenu id="brand-slash" groups={{ system: [], skills: [{ name: 'video', description: 'Make a video', kind: 'skill' }], ordered: [] }} selectedIndex={0} itemRefs={{ current: [] }} onSelect={onSelect} onHighlight={vi.fn()} showKeyboardHints={false} references={[{ kind: 'skill', id: 'video', name: 'video', displayName: 'Video', description: 'Make a video', source: 'plugin', modelText: '/video', icon: '/connectors/hyperframes.svg' }]} />)
  const option = screen.getByRole('option')
  expect(option.querySelector('img')).toHaveAttribute('src', '/connectors/hyperframes.svg')
  expect(screen.getByText('Make a video')).not.toHaveClass('text-right')
  fireEvent.click(option)
  expect(onSelect).toHaveBeenCalledWith('video')
})

it('resolves brand icons against the packaged asset base instead of the document root', () => {
  vi.stubEnv('BASE_URL', './')
  try {
    render(<SlashCommandMenu id="brand-base" groups={{ system: [], skills: [{ name: 'video', description: 'Make a video', kind: 'skill' }], ordered: [] }} selectedIndex={0} itemRefs={{ current: [] }} onSelect={vi.fn()} onHighlight={vi.fn()} showKeyboardHints={false} references={[{ kind: 'skill', id: 'video', name: 'video', displayName: 'Video', description: 'Make a video', source: 'plugin', modelText: '/video', icon: '/connectors/hyperframes.svg' }]} />)
    expect(screen.getByRole('option').querySelector('img')).toHaveAttribute('src', './connectors/hyperframes.svg')
  } finally { vi.unstubAllEnvs() }
})

it('falls back to the shared icon vocabulary so skills match the mention menu', () => {
  const { container } = render(<SlashCommandMenu id="fallback-slash" groups={{ system: [], plugins: [{ name: 'hyperframes', description: 'Videos', kind: 'plugin' }], skills: [{ name: 'video', description: 'Make a video', kind: 'skill', source: 'user' }], ordered: [] }} selectedIndex={0} itemRefs={{ current: [] }} onSelect={vi.fn()} onHighlight={vi.fn()} showKeyboardHints={false} references={[]} />)
  expect(container.querySelector('.lucide-package')).toBeInTheDocument()
  expect(container.querySelector('.lucide-box')).toBeInTheDocument()
  expect(screen.getByText('Personal')).toBeInTheDocument()
})

it('uses the same command-plugin-skill order for option ids and keyboard references', () => {
  const onSelect = vi.fn()
  const itemRefs = { current: [] as (HTMLElement | null)[] }
  render(<SlashCommandMenu id="mixed-slash" groups={{ system: [{ name: 'help', description: 'Help', kind: 'command' }], plugins: [{ name: 'plugin:video', description: 'Video tools', kind: 'plugin' }], skills: [{ name: 'render', description: 'Render video', kind: 'skill' }], ordered: [] }} selectedIndex={1} itemRefs={itemRefs} onSelect={onSelect} onHighlight={vi.fn()} showKeyboardHints={false} references={[{ kind: 'plugin', id: 'plugin:video', name: 'video', displayName: 'Video plugin', description: 'Video tools', source: 'plugin', modelText: 'Use video' }]} />)
  const options = screen.getAllByRole('option')
  expect(options.map(option => option.id)).toEqual(['mixed-slash-option-0', 'mixed-slash-option-1', 'mixed-slash-option-2'])
  expect(screen.getByRole('option', { name: 'Video plugin' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(options[1]!)
  expect(onSelect).toHaveBeenCalledWith('plugin:video')
  expect(itemRefs.current[2]).toBe(options[2])
})
