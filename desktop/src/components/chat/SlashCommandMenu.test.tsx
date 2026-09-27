import { createRef } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

it('uses the same command-skill-plugin order for option ids and keyboard references', () => {
  const onSelect = vi.fn()
  const itemRefs = { current: [] as (HTMLElement | null)[] }
  render(<SlashCommandMenu id="mixed-slash" groups={{ system: [{ name: 'help', description: 'Help', kind: 'command' }], plugins: [{ name: 'plugin:video', description: 'Video tools', kind: 'plugin' }], skills: [{ name: 'render', description: 'Render video', kind: 'skill' }], ordered: [] }} selectedIndex={1} itemRefs={itemRefs} onSelect={onSelect} onHighlight={vi.fn()} showKeyboardHints={false} references={[{ kind: 'plugin', id: 'plugin:video', name: 'video', displayName: 'Video plugin', description: 'Video tools', source: 'plugin', modelText: 'Use video' }]} />)
  const options = screen.getAllByRole('option')
  expect(options.map(option => option.id)).toEqual(['mixed-slash-option-0', 'mixed-slash-option-1', 'mixed-slash-option-2'])
  expect(screen.getByRole('option', { name: 'render' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(options[1]!)
  expect(onSelect).toHaveBeenCalledWith('render')
  expect(itemRefs.current[2]).toBe(options[2])
})


it('explains default discovery and exposes command descriptions separately from option names', () => {
  const props = {
    id: 'frequent-slash',
    groups: { system: [{ name: 'compact', description: 'Compact context' }], skills: [], ordered: [] },
    selectedIndex: 0,
    itemRefs: { current: [] },
    onSelect: vi.fn(),
    onHighlight: vi.fn(),
    showKeyboardHints: false,
  }
  const { rerender } = render(<SlashCommandMenu {...props} />)
  expect(screen.getByRole('option', { name: '/compact' })).toHaveAccessibleDescription('Compact context')
  expect(screen.getByText(translate(useSettingsStore.getState().locale, 'chat.slashSearchHint'))).toBeInTheDocument()
  rerender(<SlashCommandMenu {...props} isSearching />)
  expect(screen.queryByText(translate(useSettingsStore.getState().locale, 'chat.slashSearchHint'))).not.toBeInTheDocument()
  expect(screen.getByText(translate(useSettingsStore.getState().locale, 'chat.slashSearchResults'))).toBeInTheDocument()
})

it('keeps command rows on one line while preserving searchable argument hints and full hover details', () => {
  const props = {
    id: 'compact-layout',
    groups: { system: [{ name: 'goal', description: 'Set a completion goal', argumentHint: '[<condition> | clear]' }], skills: [], ordered: [] },
    selectedIndex: 0,
    itemRefs: { current: [] },
    onSelect: vi.fn(),
    onHighlight: vi.fn(),
    showKeyboardHints: false,
  }
  const { container, rerender } = render(<SlashCommandMenu {...props} />)
  const option = screen.getByRole('option', { name: '/goal' })
  expect(option).toHaveAttribute('title', '/goal — [<condition> | clear] — Set a completion goal')
  expect(screen.queryByText('[<condition> | clear]')).not.toBeInTheDocument()
  expect(screen.getByText('/goal').parentElement).toBe(screen.getByText('Set a completion goal').parentElement)
  expect(container.firstElementChild).toHaveClass('left-0', 'right-0')
  expect(container.firstElementChild).not.toHaveClass('max-w-[560px]')
  rerender(<SlashCommandMenu {...props} isSearching />)
  expect(screen.getByText('[<condition> | clear]')).toHaveAttribute('title', '[<condition> | clear]')
})

it.each([
  ['en', 'Frequent commands', 'Type to search commands, skills and plugins', 'navigate', 'select', 'dismiss', 'Search results'],
  ['zh', '常用命令', '输入名称搜索命令、技能和插件', '导航', '选择', '关闭', '搜索结果'],
  ['zh-TW', '常用指令', '輸入名稱搜尋指令、技能和外掛', '導航', '選擇', '關閉', '搜尋結果'],
  ['jp', 'よく使うコマンド', '名前を入力してコマンド、スキル、プラグインを検索', '移動', '選択', '閉じる', '検索結果'],
  ['kr', '자주 쓰는 명령', '이름을 입력하여 명령, 스킬 및 플러그인 검색', '이동', '선택', '닫기', '검색 결과'],
] as const)('localizes slash discovery and navigation in %s with the frequent heading inside the scrolling group', (locale, frequent, hint, navigate, select, dismiss, results) => {
  const previousLocale = useSettingsStore.getState().locale
  act(() => useSettingsStore.setState({ locale }))
  const props = {
    id: `localized-${locale}`,
    groups: { system: [{ name: 'compact', description: 'Compact' }], skills: [{ name: 'audit', description: 'Audit', kind: 'skill' as const }], plugins: [{ name: 'tools', description: 'Tools', kind: 'plugin' as const }], ordered: [] },
    selectedIndex: 1,
    itemRefs: { current: [] },
    onSelect: vi.fn(),
    onHighlight: vi.fn(),
    showKeyboardHints: true,
  }
  const { rerender, unmount } = render(<SlashCommandMenu {...props} />)
  try {
    const listbox = screen.getByRole('listbox')
    const frequentGroup = within(listbox).getByRole('group', { name: frequent })
    expect(within(frequentGroup).getByText(frequent)).toBeInTheDocument()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['/compactCompact', 'auditAudit', 'toolsTools'])
    for (const text of [hint, navigate, select, dismiss, '↑↓']) expect(screen.getByText(text)).toBeInTheDocument()
    expect(screen.queryByText('Up/Down')).not.toBeInTheDocument()
    rerender(<SlashCommandMenu {...props} isSearching />)
    expect(screen.getByText(results)).toBeInTheDocument()
    expect(screen.queryByText(frequent)).not.toBeInTheDocument()
  } finally {
    unmount()
    act(() => useSettingsStore.setState({ locale: previousLocale }))
  }
})
