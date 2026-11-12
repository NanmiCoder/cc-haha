import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

import { InstallConfirmDialog } from './InstallConfirmDialog'
import { useSettingsStore } from '../../stores/settingsStore'
import type { NormalizedSkill, NormalizedSkillDetail } from '../../types/market'

function makeSkill(overrides: Partial<NormalizedSkill> = {}): NormalizedSkill {
  return {
    id: 'skillhub:demo',
    source: 'skillhub',
    slug: 'demo',
    name: 'Example skill',
    summary: 'demo',
    author: { handle: 'alice' },
    stats: { downloads: 1 },
    tags: [],
    version: '2.0.0',
    securityStatus: 'benign',
    installState: 'installable',
    ...overrides,
  }
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('InstallConfirmDialog', () => {
  it('shows name, source, version, security and install location', () => {
    render(
      <InstallConfirmDialog skill={makeSkill()} open installing={false} onConfirm={vi.fn()} onClose={vi.fn()} />,
    )

    expect(screen.getByTestId('market-install-confirm')).toHaveTextContent('Example skill')
    expect(screen.getAllByText('SkillHub').length).toBeGreaterThan(0)
    expect(screen.getByText('v2.0.0')).toBeInTheDocument()
    expect(screen.getByTestId('security-badge-benign')).toBeInTheDocument()
    expect(screen.getByText('…/skills/demo/')).toBeInTheDocument()
    expect(screen.getByText(/new sessions/)).toBeInTheDocument()
  })

  it('warns strongly for flagged skills', () => {
    render(
      <InstallConfirmDialog
        skill={makeSkill({ securityStatus: 'flagged' })}
        open
        installing={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(/flagged this skill as potentially risky/)).toBeInTheDocument()
  })

  it('warns for unaudited skills', () => {
    render(
      <InstallConfirmDialog
        skill={makeSkill({ securityStatus: 'unknown' })}
        open
        installing={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(/has not been security-audited/)).toBeInTheDocument()
  })

  it('confirms and cancels', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<InstallConfirmDialog skill={makeSkill()} open installing={false} onConfirm={onConfirm} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('market-install-confirm-button'))
    expect(onConfirm).toHaveBeenCalled()

    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('disables both buttons while installing', () => {
    render(<InstallConfirmDialog skill={makeSkill()} open installing onConfirm={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByTestId('market-install-confirm-button')).toBeDisabled()
    expect(screen.getByText('Cancel').closest('button')).toBeDisabled()
  })
})

describe('InstallConfirmDialog acknowledgement gate', () => {
  it('arms a clean skill straight away, with no acknowledgement to tick', () => {
    for (const status of ['benign', 'verified'] as const) {
      const { unmount } = render(
        <InstallConfirmDialog skill={makeSkill({ securityStatus: status })} open installing={false} onConfirm={vi.fn()} onClose={vi.fn()} />,
      )
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(screen.getByTestId('market-install-confirm-button')).toBeEnabled()
      unmount()
    }
  })

  it.each(['flagged', 'unknown'] as const)('keeps confirm disabled for a %s skill until acknowledged', (status) => {
    const onConfirm = vi.fn()
    render(
      <InstallConfirmDialog skill={makeSkill({ securityStatus: status })} open installing={false} onConfirm={onConfirm} onClose={vi.fn()} />,
    )

    const confirm = screen.getByTestId('market-install-confirm-button')
    expect(confirm).toBeDisabled()

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I have read SKILL.md and the security report and understand these permissions',
      }),
    )
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('resets the acknowledgement when the dialog moves to another skill', () => {
    const props = { open: true, installing: false, onConfirm: vi.fn(), onClose: vi.fn() }
    const { rerender } = render(<InstallConfirmDialog skill={makeSkill({ securityStatus: 'flagged' })} {...props} />)

    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByTestId('market-install-confirm-button')).toBeEnabled()

    rerender(<InstallConfirmDialog skill={makeSkill({ id: 'skillhub:other', slug: 'other', securityStatus: 'flagged' })} {...props} />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByTestId('market-install-confirm-button')).toBeDisabled()
  })

  it('resets the acknowledgement when the same skill is confirmed again later', () => {
    const skill = makeSkill({ securityStatus: 'unknown' })
    const props = { installing: false, onConfirm: vi.fn(), onClose: vi.fn() }
    const { rerender } = render(<InstallConfirmDialog skill={skill} open {...props} />)

    fireEvent.click(screen.getByRole('checkbox'))
    rerender(<InstallConfirmDialog skill={skill} open={false} {...props} />)
    rerender(<InstallConfirmDialog skill={skill} open {...props} />)

    expect(screen.getByTestId('market-install-confirm-button')).toBeDisabled()
  })

  it('lists what the skill will be able to do when its detail is loaded', () => {
    const skill = makeSkill({ securityStatus: 'flagged' })
    const detail: NormalizedSkillDetail = {
      ...skill,
      description: '```bash\nmkdir -p .learnings\n```',
      files: [
        { path: 'SKILL.md', size: 10, language: 'markdown', tooBig: false },
        { path: 'scripts/extract.sh', size: 10, language: 'bash', tooBig: false },
      ],
      totalSize: 20,
    }
    render(<InstallConfirmDialog skill={skill} detail={detail} open installing={false} onConfirm={vi.fn()} onClose={vi.fn()} />)

    const list = screen.getByTestId('market-install-capabilities')
    expect(list).toHaveTextContent('This skill will be able to')
    expect(list).toHaveTextContent('Runs commands or scripts')
    expect(list).toHaveTextContent('scripts/extract.sh')
    expect(list).toHaveTextContent('High')
    expect(list).toHaveTextContent('Writes files')
  })

  it('ignores a detail that belongs to another skill', () => {
    const detail: NormalizedSkillDetail = {
      ...makeSkill({ id: 'skillhub:other' }),
      description: '```bash\nmkdir -p out\n```',
      files: [],
      totalSize: 0,
    }
    render(<InstallConfirmDialog skill={makeSkill()} detail={detail} open installing={false} onConfirm={vi.fn()} onClose={vi.fn()} />)

    expect(screen.queryByTestId('market-install-capabilities')).not.toBeInTheDocument()
  })
})
