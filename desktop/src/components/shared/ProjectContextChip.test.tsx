import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom'
import { ProjectContextChip } from './ProjectContextChip'

describe('ProjectContextChip', () => {
  it('keeps the source project label and adds worktree identity', () => {
    render(
      <ProjectContextChip
        workDir="/workspace/OpenCutSkill/.claude/worktrees/desktop-main-54a09f85"
        sourceWorkDir="/workspace/OpenCutSkill"
        repoName={null}
        branch="main"
        isWorktree
        worktreeSlug="desktop-main-54a09f85"
      />,
    )

    expect(screen.getByText('OpenCutSkill')).toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('worktree')).toBeInTheDocument()
    expect(screen.getByText('desktop-main-54a09f85')).toBeInTheDocument()
  })

  it('does not show worktree details for a normal checkout', () => {
    render(
      <ProjectContextChip
        workDir="/workspace/OpenCutSkill"
        repoName={null}
        branch="main"
      />,
    )

    expect(screen.getByText('OpenCutSkill')).toBeInTheDocument()
    expect(screen.queryByText('worktree')).not.toBeInTheDocument()
  })
})
