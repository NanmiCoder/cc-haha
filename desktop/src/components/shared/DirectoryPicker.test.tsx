import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

describe('DirectoryPicker', () => {
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
    expect(trigger.className).toContain('rounded-[7px]')
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
})
