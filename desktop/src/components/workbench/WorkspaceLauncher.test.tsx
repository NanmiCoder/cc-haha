import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WorkspaceLauncher } from './WorkspaceLauncher'
import { en } from '../../i18n/locales/en'
import { zh } from '../../i18n/locales/zh'
import { zh as zhTW } from '../../i18n/locales/zh-TW'
import { jp } from '../../i18n/locales/jp'
import { kr } from '../../i18n/locales/kr'

describe('WorkspaceLauncher', () => {
  it('offers the four content kinds in the reference order', () => {
    render(<WorkspaceLauncher onSelect={vi.fn()} />)

    const items = screen.getAllByRole('button')
    expect(items.map((item) => item.getAttribute('data-testid'))).toEqual([
      'workspace-launcher-review',
      'workspace-launcher-terminal',
      'workspace-launcher-browser',
      'workspace-launcher-file',
    ])
  })

  it('advertises the four global resource shortcuts while clicks retain their dock', () => {
    render(<WorkspaceLauncher onSelect={vi.fn()} />)
    // The hint is what makes the launcher teach its own shortcuts rather than
    // being the only way in.
    for (const testId of [
      'workspace-launcher-review',
      'workspace-launcher-browser',
      'workspace-launcher-file',
    ]) {
      expect(screen.getByTestId(testId).querySelector('kbd')).not.toBeNull()
    }
    expect(screen.getByTestId('workspace-launcher-terminal').querySelector('kbd')).toHaveTextContent('`')
  })

  it('keeps all four actions available in the compact bottom picker', () => {
    render(<WorkspaceLauncher onSelect={vi.fn()} dock="bottom" />)
    expect(screen.getAllByRole('button').map((item) => item.getAttribute('data-testid'))).toEqual([
      'workspace-launcher-review',
      'workspace-launcher-terminal',
      'workspace-launcher-browser',
      'workspace-launcher-file',
    ])
    expect(screen.getByTestId('workspace-launcher-terminal').querySelector('kbd')).not.toBeNull()
  })

  it('reports the chosen kind', () => {
    const onSelect = vi.fn()
    render(<WorkspaceLauncher onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('workspace-launcher-browser'))
    expect(onSelect).toHaveBeenCalledWith('browser')
  })

  it('keeps review visible but disabled, with the reason, outside a Git repository', () => {
    const onSelect = vi.fn()
    render(<WorkspaceLauncher onSelect={onSelect} reviewUnavailableReason="Not a Git repository" />)

    const review = screen.getByTestId('workspace-launcher-review')
    // Visible-and-explained rather than hidden: the absence is a fact about the
    // folder, not a missing feature.
    expect(review).toBeDisabled()
    expect(review).toHaveTextContent('Not a Git repository')
    expect(screen.getByTestId('workspace-launcher-terminal')).toBeEnabled()
  })

  it('leaves the other entries usable when review is unavailable', () => {
    const onSelect = vi.fn()
    render(<WorkspaceLauncher onSelect={onSelect} reviewUnavailableReason="Not a Git repository" />)

    fireEvent.click(screen.getByTestId('workspace-launcher-file'))
    expect(onSelect).toHaveBeenCalledWith('file')
  })
})

/**
 * The workbench components defined three strings nothing ever rendered:
 * `workspace.launcher.bottomTerminalOnly` (both docks now offer the same entry
 * list), `workspace.review.stats` (the toolbar
 * composes its own +/- spans so it can colour them) and
 * `workspace.review.readOnly` (a read-only comparison drops the write actions
 * rather than captioning them). A string that is translated five times and
 * shown zero times invites someone to wire it back in, so it stays deleted.
 *
 * This guard lives with the launcher because the launcher owned one of the
 * three keys and the other two belong to sibling components in this directory.
 */
describe('retired workbench translation keys', () => {
  const locales = { en, zh, 'zh-TW': zhTW, jp, kr }
  const retired = [
    'workspace.launcher.bottomTerminalOnly',
    'workspace.review.stats',
    'workspace.review.readOnly',
  ]

  it.each(Object.entries(locales))('%s defines none of them', (name, locale) => {
    const found = retired.filter((key) => key in locale)
    expect(found, `${name} still defines ${found.join(', ')}`).toEqual([])
  })
})
