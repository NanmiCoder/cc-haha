import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ProjectHeaderActions } from './sidebarComponents'

describe('ProjectHeaderActions', () => {
  it('renders the sort/menu and create-project buttons as always visible (no hover-gated opacity)', () => {
    render(
      <ProjectHeaderActions
        title="Projects"
        menuLabel="Sort and organize projects"
        createLabel="New project"
        onOpenMenu={vi.fn()}
        onOpenCreate={vi.fn()}
      />,
    )

    const menuBtn = screen.getByRole('button', { name: 'Sort and organize projects' })
    const createBtn = screen.getByRole('button', { name: 'New project' })
    const wrapper = menuBtn.parentElement as HTMLElement

    // The header action buttons must be reachable without hovering the parent
    // group: regression guard for the previous opacity-0/group-hover combo.
    expect(wrapper).not.toHaveClass('opacity-0')
    expect(wrapper.className).not.toMatch(/group-hover\/sidebar-projects:opacity-100/)

    // Both buttons remain rendered and clickable.
    expect(menuBtn).toBeInTheDocument()
    expect(createBtn).toBeInTheDocument()
  })

  it('invokes the corresponding handlers when buttons are clicked', () => {
    const onOpenMenu = vi.fn()
    const onOpenCreate = vi.fn()
    render(
      <ProjectHeaderActions
        title="Projects"
        menuLabel="Open menu"
        createLabel="Create project"
        onOpenMenu={onOpenMenu}
        onOpenCreate={onOpenCreate}
      />,
    )

    screen.getByRole('button', { name: 'Open menu' }).click()
    screen.getByRole('button', { name: 'Create project' }).click()

    expect(onOpenMenu).toHaveBeenCalledTimes(1)
    expect(onOpenCreate).toHaveBeenCalledTimes(1)
  })
})
