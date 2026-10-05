import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getRecentProjects: vi.fn(),
  },
}))

vi.mock('../../api/filesystem', () => ({
  filesystemApi: {
    browse: vi.fn(),
  },
}))

import { DirectoryPicker } from './DirectoryPicker'
import { sessionsApi } from '../../api/sessions'
import { filesystemApi } from '../../api/filesystem'
import { browserHost } from '../../lib/desktopHost/browserHost'
import {
  captureProjectDisplayNameHydrationRevision,
  hydrateProjectDisplayNames,
} from '../../stores/projectDisplayNameStore'

describe('DirectoryPicker', () => {
  let originalInnerWidth: number

  beforeEach(() => {
    originalInnerWidth = window.innerWidth
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
  })

  afterEach(() => {
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    Reflect.deleteProperty(window, 'desktopHost')
    vi.restoreAllMocks()
  })

  it('uses the source repository name as the fallback label for desktop worktree paths', () => {
    render(
      <DirectoryPicker
        value="/workspace/checkout/.claude/worktrees/desktop-feature-rail-12345678"
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button')).toHaveTextContent('checkout')
    expect(screen.getByRole('button')).not.toHaveTextContent('desktop-feature-rail-12345678')
  })

  it('reactively updates an exact selected path to its custom display name while retaining its raw path tooltip', () => {
    const projectPath = '/workspace/project'
    render(<DirectoryPicker value={projectPath} onChange={vi.fn()} />)

    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('project')

    act(() => {
      hydrateProjectDisplayNames(
        { [projectPath]: 'Custom project' },
        captureProjectDisplayNameHydrationRevision(),
      )
    })

    expect(trigger).toHaveTextContent('Custom project')
    expect(trigger).toHaveAttribute('title', projectPath)
  })

  it('uses a custom display name for an exact recent project while selecting its real path', async () => {
    const projectPath = '/workspace/project'
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{
        projectPath,
        realPath: projectPath,
        projectName: 'project',
        repoName: 'NanmiCoder/OpenCutSkill',
        branch: 'main',
        isGit: true,
        modifiedAt: '2026-05-07T00:00:00.000Z',
        sessionCount: 1,
      }],
    })
    const onChange = vi.fn()

    render(<DirectoryPicker value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button'))
    await screen.findByText('NanmiCoder/OpenCutSkill')
    act(() => {
      hydrateProjectDisplayNames(
        { [projectPath]: 'Custom project' },
        captureProjectDisplayNameHydrationRevision(),
      )
    })
    const label = await screen.findByText('Custom project')
    fireEvent.click(label.closest('button')!)

    expect(onChange).toHaveBeenCalledWith(projectPath)
  })

  it('does not duplicate the branch in the selected project chip', async () => {
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{
        projectPath: '/workspace/project',
        realPath: '/workspace/project',
        projectName: 'project',
        repoName: 'NanmiCoder/OpenCutSkill',
        branch: 'main',
        isGit: true,
        modifiedAt: '2026-05-07T00:00:00.000Z',
        sessionCount: 1,
      }],
    })

    render(
      <DirectoryPicker
        value="/workspace/project"
        onChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button'))

    const trigger = await waitFor(() => screen.getAllByRole('button', { name: /NanmiCoder\/OpenCutSkill/ })[0])
    expect(trigger).toHaveTextContent('NanmiCoder/OpenCutSkill')
    expect(trigger).not.toHaveTextContent('main')
  })

  it('supports the flat workbar trigger variant without changing the selected label', () => {
    render(
      <DirectoryPicker
        value="/workspace/project"
        onChange={vi.fn()}
        variant="workbar"
      />,
    )

    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('project')
    // The workbar trigger is a form field in ProjectEditorModal, where it stands
    // in for a secondary button: the same h-9 hairline-bordered 8px block.
    expect(trigger.className).toContain('rounded-[var(--radius-md)]')
    expect(trigger.className).toContain('border-[var(--color-border)]')
    expect(trigger.className).not.toContain('rounded-full')
  })

  it('constrains long workbar project names without hiding the full path from hover users', () => {
    const longProjectName = 'project-with-a-very-long-directory-name-that-should-not-stretch-the-launch-bar'
    const longPath = `/workspace/${longProjectName}`

    render(
      <DirectoryPicker
        value={longPath}
        onChange={vi.fn()}
        variant="workbar"
      />,
    )

    const trigger = screen.getByRole('button')
    const label = screen.getByText(longProjectName)
    const triggerClasses = trigger.className.split(/\s+/)
    expect(trigger).toHaveAttribute('title', longPath)
    expect(triggerClasses).toContain('max-w-full')
    expect(triggerClasses).not.toContain('w-full')
    expect(trigger.parentElement?.className).toContain('max-w-[320px]')
    expect(label.className).toContain('truncate')
  })

  it('can show a Git icon for workbar projects before the recent-project cache is loaded', () => {
    render(
      <DirectoryPicker
        value="/workspace/project"
        onChange={vi.fn()}
        variant="workbar"
        isGitProject
      />,
    )

    expect(screen.getByRole('button').querySelector('svg')).toBeInTheDocument()
  })

  it('keeps the recent-project menu inside the viewport when the trigger is near the right edge', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({ projects: [] })

    render(
      <DirectoryPicker
        value="/workspace/project"
        onChange={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 920,
      y: 24,
      top: 24,
      left: 920,
      right: 1010,
      bottom: 60,
      width: 90,
      height: 36,
      toJSON: () => ({}),
    } as DOMRect)

    fireEvent.click(trigger)

    const menu = await screen.findByTestId('directory-picker-menu')
    expect(menu).toHaveStyle({ left: '612px', width: '400px' })
  })

  it('renders browse entries without nesting interactive buttons', async () => {
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({ projects: [] })
    vi.mocked(filesystemApi.browse).mockResolvedValue({
      currentPath: '/workspace',
      parentPath: '/Users/nanmi',
      entries: [{ name: 'project', path: '/workspace/project', isDirectory: true }],
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<DirectoryPicker value="" onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /选择项目|Select a project/ }))
    fireEvent.click(await screen.findByText(/选择其他文件夹|Choose a different folder/))

    expect(await screen.findByRole('button', { name: /project/ })).toBeInTheDocument()
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('validateDOMNesting'))

    errorSpy.mockRestore()
  })

  it('uses the injected desktop host for native folder selection', async () => {
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({ projects: [] })
    const open = vi.fn().mockResolvedValue('/workspace/native-project')
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        dialogs: true,
      },
      dialogs: {
        ...browserHost.dialogs,
        open,
      },
    }
    const onChange = vi.fn()

    render(<DirectoryPicker value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /选择项目|Select a project/ }))
    fireEvent.click(await screen.findByText(/选择其他文件夹|Choose a different folder/))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/workspace/native-project'))
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: expect.any(String),
    })
    expect(filesystemApi.browse).not.toHaveBeenCalled()
  })
})
