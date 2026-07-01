import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { PluginPrerequisitesModal } from './PluginPrerequisitesModal'
import type { PluginPrerequisiteRow } from '../../types/plugin'

// Mock dependencies
vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string>) => {
    const translations: Record<string, string> = {
      'pluginPrereq.title': `Missing prerequisites for ${params?.name || ''}`,
      'pluginPrereq.intro': `Some host commands this plugin depends on are not on your PATH (${params?.count || 0} missing).`,
      'pluginPrereq.affectedServers': `Required by: ${params?.servers || ''}`,
      'pluginPrereq.homepageLink': 'Docs ↗',
      'pluginPrereq.copy': 'Copy',
      'pluginPrereq.copied': 'Copied',
      'pluginPrereq.copyTooltip': 'Copy command to clipboard',
      'pluginPrereq.openInTerminal': 'Open in terminal',
      'pluginPrereq.openInTerminalTooltip': 'Open a new terminal tab with the command on the clipboard.',
      'pluginPrereq.openedTerminalToast': 'Opened a new terminal tab.',
      'pluginPrereq.copyFailed': 'Failed to copy to clipboard',
      'pluginPrereq.recheck': 'I installed them, recheck',
      'pluginPrereq.dismiss': 'Later',
      'pluginPrereq.allInstalledToast': 'All prerequisites are now installed.',
      'pluginPrereq.noPlatformInstall': `No automated install command for ${params?.platform || ''}.`,
      'pluginPrereq.safetyNote': 'cc-haha never runs install commands automatically.',
    }
    return translations[key] || key
  },
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: () => ({
    addToast: vi.fn(),
  }),
}))

vi.mock('../../stores/tabStore', () => ({
  useTabStore: {
    getState: () => ({
      openTerminalTab: vi.fn(),
    }),
  },
}))

vi.mock('../chat/clipboard', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}))

const createMockRow = (overrides: Partial<PluginPrerequisiteRow> = {}): PluginPrerequisiteRow => ({
  command: 'uvx',
  label: 'uv (Python tool runner)',
  homepage: 'https://github.com/astral-sh/uv',
  installed: false,
  resolvedPath: null,
  install: {
    win32: [{ manager: 'winget', cmd: 'winget install astral-sh.uv' }],
    darwin: [{ manager: 'brew', cmd: 'brew install uv' }],
    linux: [{ manager: 'shell', cmd: 'curl -LsSf https://astral.sh/uv/install.sh | sh' }],
  },
  affectedServers: [
    { name: 'apktool', displayName: 'APKTool' },
    { name: 'jadx', displayName: 'JADX' },
  ],
  ...overrides,
})

const baseProps = {
  open: true,
  pluginName: 'Reverse Engineering',
  rows: [createMockRow()],
  onRecheck: vi.fn(),
  isRechecking: false,
  onClose: vi.fn(),
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PluginPrerequisitesModal', () => {
  it('renders the modal when open is true', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    expect(screen.getByText('Missing prerequisites for Reverse Engineering')).toBeInTheDocument()
  })

  it('does not render when open is false', () => {
    render(<PluginPrerequisitesModal {...baseProps} open={false} />)
    expect(screen.queryByText('Missing prerequisites for Reverse Engineering')).not.toBeInTheDocument()
  })

  it('displays missing prerequisites count', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    expect(screen.getByText(/1 missing/)).toBeInTheDocument()
  })

  it('displays the command name', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    expect(screen.getByText('uvx')).toBeInTheDocument()
  })

  it('displays the label when provided', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    expect(screen.getByText('uv (Python tool runner)')).toBeInTheDocument()
  })

  it('displays affected servers', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    expect(screen.getByText(/APKTool, JADX/)).toBeInTheDocument()
  })

  it('displays homepage link when provided', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    const link = screen.getByText('Docs ↗')
    expect(link).toBeInTheDocument()
    expect(link.closest('a')).toHaveAttribute('href', 'https://github.com/astral-sh/uv')
  })

  it('displays install steps for the current platform', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    // Should show at least one install step
    expect(screen.getByTestId(/prereq-copy-/)).toBeInTheDocument()
  })

  it('calls onClose when dismiss button is clicked', () => {
    const onClose = vi.fn()
    render(<PluginPrerequisitesModal {...baseProps} onClose={onClose} />)
    fireEvent.click(screen.getByText('Later'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onRecheck when recheck button is clicked', () => {
    const onRecheck = vi.fn()
    render(<PluginPrerequisitesModal {...baseProps} onRecheck={onRecheck} />)
    fireEvent.click(screen.getByText('I installed them, recheck'))
    expect(onRecheck).toHaveBeenCalled()
  })

  it('shows loading state on recheck button when isRechecking is true', () => {
    render(<PluginPrerequisitesModal {...baseProps} isRechecking={true} />)
    const recheckButton = screen.getByText('I installed them, recheck').closest('button')
    expect(recheckButton).toBeDisabled()
  })

  it('displays safety note', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    expect(screen.getByText(/cc-haha never runs install commands automatically/)).toBeInTheDocument()
  })

  it('filters out installed prerequisites', () => {
    const rows = [
      createMockRow({ command: 'uvx', installed: false }),
      createMockRow({ command: 'node', installed: true }),
    ]
    render(<PluginPrerequisitesModal {...baseProps} rows={rows} />)
    expect(screen.getByText('uvx')).toBeInTheDocument()
    expect(screen.queryByText('node')).not.toBeInTheDocument()
  })

  it('renders multiple missing prerequisites', () => {
    const rows = [
      createMockRow({ command: 'uvx', installed: false }),
      createMockRow({
        command: 'radare2',
        label: 'Reverse engineering framework',
        installed: false,
        affectedServers: [{ name: 'radare2-server', displayName: 'Radare2 Server' }],
      }),
    ]
    render(<PluginPrerequisitesModal {...baseProps} rows={rows} />)
    expect(screen.getByText('uvx')).toBeInTheDocument()
    expect(screen.getByText('radare2')).toBeInTheDocument()
    expect(screen.getByText(/2 missing/)).toBeInTheDocument()
  })

  it('shows no platform install message when no install steps for platform', () => {
    const rows = [
      createMockRow({
        command: 'custom-tool',
        install: {}, // No install steps for any platform
      }),
    ]
    render(<PluginPrerequisitesModal {...baseProps} rows={rows} />)
    expect(screen.getByText(/No automated install command/)).toBeInTheDocument()
  })

  it('renders copy buttons for install steps', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    const copyButtons = screen.getAllByText('Copy')
    expect(copyButtons.length).toBeGreaterThan(0)
  })

  it('renders open in terminal buttons for install steps', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    const terminalButtons = screen.getAllByText('Open in terminal')
    expect(terminalButtons.length).toBeGreaterThan(0)
  })

  it('has correct data-testid attributes', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    expect(screen.getByTestId('plugin-prereq-rows')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-prereq-row-uvx')).toBeInTheDocument()
  })

  it('displays warning icon for each row', () => {
    render(<PluginPrerequisitesModal {...baseProps} />)
    const warningIcons = screen.getAllByText('warning')
    expect(warningIcons.length).toBeGreaterThan(0)
  })
})
