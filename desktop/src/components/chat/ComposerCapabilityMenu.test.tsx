import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { ComposerCapabilityMenu } from './ComposerCapabilityMenu'
import { sessionCollaborationApi } from '@/api/sessionCollaboration'
import { filesystemApi } from '@/api/filesystem'
import type { CapabilityMenuSection } from './capabilityMenuModel'

vi.mock('@/api/sessionCollaboration', () => ({ sessionCollaborationApi: { list: vi.fn() } }))
vi.mock('@/api/filesystem', () => ({ filesystemApi: { browse: vi.fn(), search: vi.fn() } }))
beforeEach(() => {
  vi.mocked(sessionCollaborationApi.list).mockClear().mockResolvedValue({ sessions: [] })
  vi.mocked(filesystemApi.search).mockResolvedValue({ currentPath: '/work', parentPath: '/', entries: [] })
})

function fixtureSections(): CapabilityMenuSection[] {
  return [
    {
      id: 'add',
      title: 'Add',
      items: [{
        key: 'add-files',
        label: 'Add files or photos',
        icon: { kind: 'slash' },
        action: { type: 'attachment' },
      }],
    },
    {
      id: 'capabilities',
      title: 'Capabilities',
      items: [
        {
          key: 'skills',
          label: 'Skills',
          description: 'Add a skill to this chat',
          icon: { kind: 'slash' },
          count: 1,
          children: [
            {
              key: 'skill:design',
              label: 'Design',
              description: 'Create interfaces',
              icon: { kind: 'slash' },
              action: { type: 'insertSlashText', command: 'design' },
            },
            {
              key: 'skills:manage',
              label: 'Manage skills',
              icon: { kind: 'slash' },
              action: { type: 'settings', tab: 'skills' },
            },
          ],
        },
        {
          key: 'computer-use',
          label: 'Computer Use',
          description: 'Let Claude operate apps',
          icon: { kind: 'slash' },
          switch: { checked: false, disabled: false },
          action: { type: 'toggleComputerUse' },
        },
      ],
    },
    {
      id: 'commands',
      title: 'Commands',
      items: [{
        key: 'slash-commands',
        label: 'Slash commands',
        icon: { kind: 'slash' },
        action: { type: 'slashTrigger' },
      }],
    },
  ]
}

function renderMenu(overrides: Partial<Parameters<typeof ComposerCapabilityMenu>[0]> = {}) {
  const onAction = vi.fn()
  const onClose = vi.fn()
  render(
    <ComposerCapabilityMenu
      id="cap"
      sections={fixtureSections()}
      onAction={onAction}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onAction, onClose }
}

function searchInput(): HTMLElement {
  return screen.getByRole('combobox')
}

describe('ComposerCapabilityMenu', () => {
  it('renders section titles and dispatches a leaf action on click', () => {
    const { onAction } = renderMenu()
    expect(screen.getByRole('group', { name: 'Add' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Capabilities' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Commands' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /Add files or photos/ }))
    expect(onAction).toHaveBeenCalledWith({ type: 'attachment' })
  })

  it('drills into a sub-list and returns with the back row', () => {
    const { onAction } = renderMenu()

    // Parent rows open their sub-list instead of firing an action.
    fireEvent.click(screen.getByRole('option', { name: /Skills/ }))
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.getByRole('option', { name: /Design/ })).toBeInTheDocument()

    // Back navigation restores the top-level sections.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('group', { name: 'Commands' })).toBeInTheDocument()

    // Drilling again and picking a leaf fires its action.
    fireEvent.click(screen.getByRole('option', { name: /Skills/ }))
    fireEvent.click(screen.getByRole('option', { name: /Design/ }))
    expect(onAction).toHaveBeenCalledWith({ type: 'insertSlashText', command: 'design' })
  })

  it('navigates with the keyboard from the search input', () => {
    const { onClose } = renderMenu()
    const input = searchInput()

    // Order: Add files → Skills → Computer Use → Slash commands.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('option', { name: /Design/ })).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    // Esc inside a sub-list steps back first, then closes.
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toggles a switch row without double-firing from the row click', () => {
    const { onAction } = renderMenu()
    const row = screen.getByRole('option', { name: 'Computer Use: Disabled' })
    expect(row).toHaveAccessibleName('Computer Use: Disabled')

    fireEvent.click(row.querySelector('input[type="checkbox"]')!)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ type: 'toggleComputerUse' })
  })

  it('filters rows through the search box and flattens sub-list matches', async () => {
    renderMenu()
    fireEvent.change(searchInput(), { target: { value: 'Design' } })
    expect(screen.getByRole('option', { name: /Design/ })).toBeInTheDocument()
    expect(screen.queryByText('Commands')).not.toBeInTheDocument()

    fireEvent.change(searchInput(), { target: { value: 'no-such-capability' } })
    expect(await screen.findByText('No matching references')).toBeInTheDocument()
    expect(sessionCollaborationApi.list).toHaveBeenCalledWith('no-such-capability', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

// Searching a category previously produced an inert parent row.
it('opens a searched category and scopes subsequent searches to its children', () => {
  const { onAction } = renderMenu()
  fireEvent.change(searchInput(), { target: { value: 'Skills' } })
  fireEvent.keyDown(searchInput(), { key: 'Enter' })
  expect(searchInput()).toHaveValue('')
  expect(screen.getByRole('option', { name: 'Design' })).toBeInTheDocument()
  fireEvent.change(searchInput(), { target: { value: 'Design' } })
  fireEvent.keyDown(searchInput(), { key: 'Enter' })
  expect(onAction).toHaveBeenCalledWith({ type: 'insertSlashText', command: 'design' })
})

it('keeps the root menu concise and exposes descriptions inside a category', () => {
  renderMenu()
  expect(screen.queryByText('Add a skill to this chat')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: 'Skills' }))
  expect(screen.getByText('Create interfaces')).toBeInTheDocument()
})

it('uses the shared reference search to insert a plugin without a connector', async () => {
  const reference = { kind: 'plugin' as const, id: 'video', name: 'video', displayName: 'Video Studio', description: 'Create videos', source: 'plugin', modelText: 'Use video' }
  const sections = fixtureSections()
  sections[1]!.items.unshift({ key: 'plugins', label: 'Plugins', icon: { kind: 'slash' }, children: [{ key: 'plugin:video', label: 'Video Studio', icon: { kind: 'slash' }, action: { type: 'insertMention', reference } }] })
  const { onAction } = renderMenu({ sections })
  fireEvent.change(searchInput(), { target: { value: 'video' } })
  const option = await screen.findByRole('option', { name: 'Video Studio' })
  expect(searchInput()).toHaveAttribute('aria-activedescendant', option.id)
  fireEvent.keyDown(searchInput(), { key: 'Enter' })
  expect(onAction).toHaveBeenCalledWith({ type: 'insertMention', reference })
})

it('finds project files through the same search and preserves their structured path', async () => {
  vi.mocked(filesystemApi.search).mockResolvedValue({ currentPath: '/work', parentPath: '/', entries: [{ name: 'README.md', path: '/work/README.md', isDirectory: false }] })
  const onSelectFile = vi.fn()
  const { onClose } = renderMenu({ cwd: '/work', onSelectFile })
  fireEvent.change(searchInput(), { target: { value: 'README' } })
  fireEvent.click(await screen.findByRole('option', { name: 'README.md' }))
  expect(onSelectFile).toHaveBeenCalledWith({ label: 'README.md', path: '/work/README.md', isDirectory: false })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('keeps nested tools accessible and backs up one level per Escape', () => {
  const sections = fixtureSections()
  const skills = sections[1]!.items[0]!
  sections[1]!.items = [{ key: 'more', label: 'More tools', icon: { kind: 'slash' }, children: [skills] }]
  const { onClose } = renderMenu({ sections })
  fireEvent.click(screen.getByRole('option', { name: 'More tools' }))
  fireEvent.click(screen.getByRole('option', { name: 'Skills' }))
  expect(screen.getByRole('option', { name: 'Design' })).toBeInTheDocument()
  fireEvent.keyDown(searchInput(), { key: 'Escape' })
  expect(screen.getByRole('option', { name: 'Skills' })).toBeInTheDocument()
  fireEvent.keyDown(searchInput(), { key: 'Escape' })
  expect(screen.getByRole('option', { name: 'More tools' })).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
})
