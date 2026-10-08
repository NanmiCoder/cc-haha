import { fireEvent, render, screen, within } from '@testing-library/react'
import { Plug } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { ComposerCapabilityMenu } from './ComposerCapabilityMenu'
import { sessionCollaborationApi } from '@/api/sessionCollaboration'
import { filesystemApi } from '@/api/filesystem'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { CapabilityMenuSection } from './capabilityMenuModel'

vi.mock('@/api/sessionCollaboration', () => ({ sessionCollaborationApi: { list: vi.fn() } }))
vi.mock('@/api/filesystem', () => ({ filesystemApi: { browse: vi.fn(), search: vi.fn() } }))
const initialWidth = window.innerWidth
beforeEach(() => {
  vi.mocked(sessionCollaborationApi.list).mockClear().mockResolvedValue({ sessions: [] })
  vi.mocked(filesystemApi.search).mockResolvedValue({ currentPath: '/work', parentPath: '/', entries: [] })
})
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth })
})

const designSkill: ComposerReferenceCandidate = { kind: 'skill', id: 'design', name: 'design', displayName: 'Design', description: 'Create interfaces', source: 'user', modelText: 'Use design' }
const videoPlugin: ComposerReferenceCandidate = { kind: 'plugin', id: 'video', name: 'video', displayName: 'Video Studio', description: 'Create videos', source: 'plugin', modelText: 'Use video' }

function fixtureSections(): CapabilityMenuSection[] {
  return [
    {
      id: 'use',
      title: 'For this task',
      showTitle: true,
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
              group: 'Recently used',
              action: { type: 'insertMention', reference: designSkill },
            },
            {
              key: 'skills:all',
              label: 'All skills',
              icon: { kind: 'slash' },
              count: 1,
              children: [{
                key: 'skill:design',
                label: 'Design',
                icon: { kind: 'slash' },
                action: { type: 'insertMention', reference: designSkill },
              }],
            },
            {
              key: 'market-skill:pptx',
              label: 'pptx',
              description: 'Build slides',
              icon: { kind: 'slash' },
              group: 'Popular',
              action: { type: 'installSkill', id: 'pptx', name: 'pptx' },
              button: { label: 'Install', action: { type: 'installSkill', id: 'pptx', name: 'pptx' } },
            },
            {
              key: 'skills:browse',
              label: 'Browse the skill market',
              icon: { kind: 'slash' },
              action: { type: 'market', section: 'skills' },
            },
          ],
        },
        {
          key: 'connectors',
          label: 'Connectors',
          icon: { kind: 'slash' },
          children: [{
            key: 'connector:github',
            label: 'GitHub',
            icon: { kind: 'slash' },
            status: 'ok',
            group: 'Connected',
            action: { type: 'market', section: 'plugins', connectorId: 'github' },
          }],
        },
        {
          key: 'add-files',
          label: 'Add files or photos',
          icon: { kind: 'slash' },
          action: { type: 'attachment' },
        },
      ],
    },
    {
      id: 'run',
      title: 'How it runs',
      showTitle: true,
      items: [{
        key: 'computer-use',
        label: 'Computer Use',
        description: 'Let Claude operate apps',
        icon: { kind: 'slash' },
        switch: { checked: false, disabled: false },
        action: { type: 'toggleComputerUse' },
      }],
    },
    {
      id: 'more',
      title: 'More tools',
      showTitle: false,
      items: [{
        key: 'more',
        label: 'More tools',
        icon: { kind: 'slash' },
        children: [{
          key: 'slash-commands',
          label: 'Slash commands',
          icon: { kind: 'slash' },
          action: { type: 'slashTrigger' },
        }],
      }],
      searchOnly: [{ key: 'plugin:video', label: 'Video Studio', icon: { kind: 'slash' }, action: { type: 'insertMention', reference: videoPlugin } }],
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

function rootList(): HTMLElement {
  return screen.getByRole('listbox', { name: 'Open composer tools' })
}

describe('ComposerCapabilityMenu', () => {
  it('titles the two groups and dispatches a leaf action on click', () => {
    const { onAction } = renderMenu()
    expect(within(rootList()).getByText('For this task')).toBeInTheDocument()
    expect(within(rootList()).getByText('How it runs')).toBeInTheDocument()
    // More is one row; its group needs no visible title.
    expect(within(rootList()).queryByText('More tools', { selector: '[role="presentation"]' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /Add files or photos/ }))
    expect(onAction).toHaveBeenCalledWith({ type: 'attachment' })
  })

  it('opens a category beside the root on hover and keeps the root in view', () => {
    const { onAction } = renderMenu()
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Skills/ }))
    const flyout = screen.getByTestId('capability-flyout')
    expect(within(flyout).getByText('Skills')).toBeInTheDocument()
    expect(within(flyout).getByText('Recently used')).toBeInTheDocument()
    expect(within(flyout).getByText('Create interfaces')).toBeInTheDocument()
    // The root list is still there, its open category marked.
    expect(within(rootList()).getByRole('option', { name: /Skills/ })).toHaveAttribute('aria-selected', 'true')

    // Hovering a sibling category swaps the panel; a leaf closes it.
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Connectors/ }))
    expect(within(screen.getByTestId('capability-flyout')).getByRole('option', { name: 'GitHub' })).toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Add files or photos/ }))
    expect(screen.queryByTestId('capability-flyout')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /Skills/ }))
    fireEvent.click(within(screen.getByTestId('capability-flyout')).getByRole('option', { name: /Design/ }))
    expect(onAction).toHaveBeenCalledWith({ type: 'insertMention', reference: designSkill })
  })

  it('opens the side panel level with its row and keeps it inside the window', () => {
    const rowTops: Record<string, number> = { Skills: 160, Connectors: 192 }
    let flyoutHeight = 120
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const label = this.getAttribute('role') === 'option' ? Object.keys(rowTops).find(key => this.querySelector(`#${this.id}-label`)?.textContent === key) : undefined
      const top = label ? rowTops[label]! : this.className.includes('bottom-full') ? 100 : 0
      return { top, height: label ? 32 : 0, bottom: top + (label ? 32 : 0), left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'capability-flyout' ? flyoutHeight : 0
    })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    try {
      renderMenu()
      // Row top relative to the menu, title bar centred on the 32px row.
      fireEvent.mouseEnter(screen.getByRole('option', { name: /Skills/ }))
      expect(screen.getByTestId('capability-flyout').style.top).toBe('56px')
      fireEvent.mouseEnter(screen.getByRole('option', { name: /Connectors/ }))
      expect(screen.getByTestId('capability-flyout').style.top).toBe('88px')

      // Near the window bottom it lifts just enough to stay 8px clear.
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
      fireEvent.mouseEnter(screen.getByRole('option', { name: /Skills/ }))
      expect(screen.getByTestId('capability-flyout').style.top).toBe('56px')
      fireEvent.mouseEnter(screen.getByRole('option', { name: /Connectors/ }))
      expect(screen.getByTestId('capability-flyout').style.top).toBe('72px')

      // A panel taller than the window keeps its top edge on screen.
      flyoutHeight = 400
      fireEvent.mouseEnter(screen.getByRole('option', { name: /Skills/ }))
      expect(screen.getByTestId('capability-flyout').style.top).toBe('-92px')
    } finally {
      vi.restoreAllMocks()
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
    }
  })

  it('walks into a category with the keyboard and steps back one panel per Escape', () => {
    const { onAction, onClose } = renderMenu()
    const input = searchInput()

    // Root order: Skills → Connectors → Add files → Computer Use → More.
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    const flyout = screen.getByTestId('capability-flyout')
    expect(input).toHaveAttribute('aria-controls', 'cap-sub-list')
    expect(input).not.toHaveAttribute('aria-activedescendant')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const first = within(flyout).getByRole('option', { name: /Design/ })
    expect(input).toHaveAttribute('aria-activedescendant', first.id)
    fireEvent.keyDown(input, { key: 'ArrowLeft' })
    expect(screen.queryByTestId('capability-flyout')).not.toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).toHaveBeenCalledWith({ type: 'insertMention', reference: designSkill })

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('capability-flyout')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('runs a row button once without also running the row', () => {
    const { onAction } = renderMenu()
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Skills/ }))
    const flyout = screen.getByTestId('capability-flyout')
    expect(within(flyout).getByText('Popular')).toBeInTheDocument()
    fireEvent.click(within(flyout).getByRole('button', { name: 'Install' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ type: 'installSkill', id: 'pptx', name: 'pptx' })
  })

  it('browses the full skill list in the side panel and returns with its back button', () => {
    renderMenu()
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Skills/ }))
    fireEvent.click(within(screen.getByTestId('capability-flyout')).getByRole('option', { name: /All skills/ }))
    const flyout = screen.getByTestId('capability-flyout')
    expect(within(flyout).getByText('All skills')).toBeInTheDocument()
    expect(within(flyout).getByRole('listbox', { name: 'References' })).toBeInTheDocument()
    expect(within(flyout).getByRole('option', { name: 'Design' })).toBeInTheDocument()

    fireEvent.click(within(flyout).getByRole('button', { name: 'Back' }))
    expect(within(screen.getByTestId('capability-flyout')).getByText('Recently used')).toBeInTheDocument()
  })

  it('toggles a switch row without double-firing from the row click', () => {
    const { onAction } = renderMenu()
    const row = screen.getByRole('option', { name: 'Computer Use: Disabled' })
    fireEvent.click(row.querySelector('input[type="checkbox"]')!)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ type: 'toggleComputerUse' })
  })

  it('searches everything from the root, closing an open category', async () => {
    const { onAction } = renderMenu()
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Connectors/ }))
    fireEvent.change(searchInput(), { target: { value: 'Design' } })
    expect(screen.queryByTestId('capability-flyout')).not.toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Design' })).toBeInTheDocument()

    // Plugins that no sub-list shows are still found and mentioned.
    fireEvent.change(searchInput(), { target: { value: 'video' } })
    const option = await screen.findByRole('option', { name: 'Video Studio' })
    expect(searchInput()).toHaveAttribute('aria-activedescendant', option.id)
    fireEvent.keyDown(searchInput(), { key: 'Enter' })
    expect(onAction).toHaveBeenCalledWith({ type: 'insertMention', reference: videoPlugin })

    fireEvent.change(searchInput(), { target: { value: 'no-such-capability' } })
    expect(await screen.findByText('No matching references')).toBeInTheDocument()
    expect(sessionCollaborationApi.list).toHaveBeenCalledWith('no-such-capability', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

it('opens a searched category in the side panel', () => {
  renderMenu()
  fireEvent.change(searchInput(), { target: { value: 'Connectors' } })
  fireEvent.keyDown(searchInput(), { key: 'Enter' })
  expect(searchInput()).toHaveValue('')
  expect(within(screen.getByTestId('capability-flyout')).getByRole('option', { name: 'GitHub' })).toBeInTheDocument()
})

it('keeps the root a list of names and leaves descriptions to the categories', () => {
  renderMenu()
  expect(screen.queryByText('Add a skill to this chat')).not.toBeInTheDocument()
  fireEvent.mouseEnter(screen.getByRole('option', { name: 'Skills' }))
  expect(screen.getByText('Build slides')).toBeInTheDocument()
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

it('opens categories in place when the window has no room for a side panel', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 })
  const { onClose } = renderMenu()
  fireEvent.mouseEnter(screen.getByRole('option', { name: /Skills/ }))
  expect(screen.queryByTestId('capability-flyout')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: /Skills/ }))
  expect(screen.queryByRole('listbox', { name: 'Open composer tools' })).not.toBeInTheDocument()
  expect(screen.getByRole('option', { name: /Design/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(rootList()).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
})

it('drills in place inside the phone sheet and backs up one level per Escape', () => {
  const { onClose } = renderMenu({ presentation: 'sheet' })
  fireEvent.click(screen.getByRole('option', { name: /More tools/ }))
  expect(screen.queryByTestId('capability-flyout')).not.toBeInTheDocument()
  expect(screen.getByRole('option', { name: /Slash commands/ })).toBeInTheDocument()
  fireEvent.keyDown(searchInput(), { key: 'Escape' })
  expect(screen.getByRole('option', { name: /More tools/ })).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
})

it('swaps a logo that fails to load for its fallback and keeps absolute icon URLs', () => {
  const sections = fixtureSections()
  const connectors = sections[0]!.items[1]!
  connectors.children = [
    { key: 'connector:github', label: 'GitHub', icon: { kind: 'image', src: 'connectors/github.svg', fallback: Plug }, action: { type: 'market', section: 'plugins', connectorId: 'github' } },
    { key: 'connector:remote', label: 'Remote', icon: { kind: 'image', src: 'https://cdn.example.test/icon.png' }, action: { type: 'market', section: 'plugins' } },
  ]
  renderMenu({ sections })
  fireEvent.mouseEnter(screen.getByRole('option', { name: /Connectors/ }))
  const flyout = screen.getByTestId('capability-flyout')
  const github = within(flyout).getByRole('option', { name: 'GitHub' })
  const remote = within(flyout).getByRole('option', { name: 'Remote' })
  expect(remote.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.test/icon.png')
  const logo = github.querySelector('img')!
  expect(logo.getAttribute('src')).toMatch(/\/connectors\/github\.svg$/)
  fireEvent.error(logo)
  expect(github.querySelector('img')).toBeNull()
  expect(github.querySelector('svg.lucide-plug')).toBeInTheDocument()
})
