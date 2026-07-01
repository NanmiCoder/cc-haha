import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { KnownLanguageServersPanel } from './PluginList'
import { useTranslation } from '../../i18n'
import { pluginsApi } from '../../api/plugins'
import { injectInstallScriptIntoNewTerminal } from '../../lib/terminalCommandInjection'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { KnownLanguageServerRow } from '../../types/plugin'

vi.mock('../../api/plugins', () => ({
  pluginsApi: {
    languageServers: vi.fn(),
  },
}))

vi.mock('../../lib/terminalCommandInjection', () => ({
  injectInstallScriptIntoNewTerminal: vi.fn().mockResolvedValue({
    runtimeId: 'term-1',
    commands: ['npm install -g pyright'],
  }),
}))

// Force a deterministic platform so install-step selection is stable.
vi.mock('../../lib/detectPlatform', () => ({
  detectPlatform: () => 'linux',
}))

const goInstalled: KnownLanguageServerRow = {
  language: 'go',
  label: 'Go (gopls)',
  command: 'gopls',
  install: {
    linux: [{ manager: 'go', cmd: 'go install golang.org/x/tools/gopls@latest' }],
  },
  installed: true,
  resolvedPath: '/usr/local/bin/gopls',
  resolvedCommand: 'gopls',
}

const pythonMissing: KnownLanguageServerRow = {
  language: 'python',
  label: 'Python (Pyright)',
  command: 'pyright-langserver',
  candidates: ['pyright'],
  homepage: 'https://github.com/microsoft/pyright',
  install: {
    linux: [{ manager: 'npm', cmd: 'npm install -g pyright' }],
  },
  installed: false,
  resolvedPath: null,
  resolvedCommand: null,
}

function Harness() {
  const t = useTranslation()
  return <KnownLanguageServersPanel t={t} />
}

describe('KnownLanguageServersPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
    ;(pluginsApi.languageServers as ReturnType<typeof vi.fn>).mockResolvedValue({
      servers: [goInstalled, pythonMissing],
    })
  })

  it('renders detected installed servers with resolved path and missing ones with an install button', async () => {
    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByText('Go (gopls)')).toBeInTheDocument()
    })

    // Installed server shows its resolved path.
    expect(screen.getByText('/usr/local/bin/gopls')).toBeInTheDocument()
    // Missing server shows an Install button.
    expect(screen.getByText('Python (Pyright)')).toBeInTheDocument()
    const installButtons = screen.getAllByRole('button', { name: /Install/i })
    expect(installButtons.length).toBeGreaterThan(0)
  })

  it('injects the platform install command into a new terminal when clicking Install', async () => {
    render(<Harness />)

    await waitFor(() => {
      expect(screen.getByText('Python (Pyright)')).toBeInTheDocument()
    })

    const installButton = screen.getByRole('button', { name: /download\s*Install/i })
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(injectInstallScriptIntoNewTerminal).toHaveBeenCalledTimes(1)
    })
    expect(injectInstallScriptIntoNewTerminal).toHaveBeenCalledWith([
      'npm install -g pyright',
    ])
  })

  it('rechecks with refresh=true', async () => {
    render(<Harness />)

    await waitFor(() => {
      expect(pluginsApi.languageServers).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByRole('button', { name: /Recheck/i }))

    await waitFor(() => {
      expect(pluginsApi.languageServers).toHaveBeenCalledTimes(2)
    })
    expect(pluginsApi.languageServers).toHaveBeenLastCalledWith(true)
  })
})
