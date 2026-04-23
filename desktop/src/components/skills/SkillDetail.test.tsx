import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({
    content,
    variant,
    className,
  }: {
    content: string
    variant?: string
    className?: string
  }) => (
    <div
      data-testid="markdown-renderer"
      data-content={content}
      data-variant={variant}
      data-classname={className}
    />
  ),
}))

vi.mock('../chat/CodeViewer', () => ({
  CodeViewer: ({ code }: { code: string }) => <div data-testid="code-viewer">{code}</div>,
}))

import { SkillDetail } from './SkillDetail'
import { useSkillStore } from '../../stores/skillStore'
import { useSettingsStore } from '../../stores/settingsStore'

const fetchSkills = vi.fn()
const fetchSkillDetail = vi.fn()
const clearSelection = vi.fn(() => {
  useSkillStore.setState({ selectedSkill: null })
})

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useSkillStore.setState({
    skills: [],
    selectedSkill: null,
    isLoading: false,
    isDetailLoading: false,
    error: null,
    fetchSkills,
    fetchSkillDetail,
    clearSelection,
  })
  fetchSkills.mockReset()
  fetchSkillDetail.mockReset()
  clearSelection.mockClear()
})

describe('SkillDetail markdown presentation', () => {
  it('renders markdown files with the document variant and readable width', () => {
    useSkillStore.setState({
      selectedSkill: {
        meta: {
          name: 'skill-test',
          displayName: 'Skill Test',
          description: 'Skill description',
          source: 'user',
          userInvocable: true,
          contentLength: 120,
          hasDirectory: true,
        },
        tree: [{ name: 'SKILL.md', path: 'SKILL.md', type: 'file' }],
        files: [
          {
            path: 'SKILL.md',
            content: '# Skill Body',
            language: 'markdown',
            isEntry: true,
          },
        ],
        skillRoot: '/tmp/skill-test',
      },
    })

    render(<SkillDetail />)

    const markdown = screen.getByTestId('markdown-renderer')
    expect(markdown).toBeInTheDocument()
    expect(markdown).toHaveAttribute('data-variant', 'document')
    expect(markdown).toHaveAttribute('data-classname', 'mx-auto max-w-[72ch]')
    expect(markdown).toHaveAttribute('data-content', '# Skill Body')
  })
})
