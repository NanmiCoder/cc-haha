import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

const diagnosticsApiMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getEvents: vi.fn(),
  exportBundle: vi.fn(),
  openLogDir: vi.fn(),
  clear: vi.fn(),
}))

const doctorRepairMock = vi.hoisted(() => ({
  runDoctorRepair: vi.fn(),
}))

vi.mock('../api/diagnostics', () => ({
  diagnosticsApi: diagnosticsApiMock,
}))

vi.mock('../lib/doctorRepair', () => doctorRepairMock)

vi.mock('../stores/providerStore', () => ({
  useProviderStore: () => ({
    providers: [],
    activeId: null,
    hasLoadedProviders: true,
    presets: [],
    isLoading: false,
    isPresetsLoading: false,
    fetchProviders: vi.fn(),
    fetchPresets: vi.fn(),
    deleteProvider: vi.fn(),
    activateProvider: vi.fn(),
    activateOfficial: vi.fn(),
    testProvider: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    testConfig: vi.fn(),
  }),
}))

vi.mock('../api/providers', () => ({
  providersApi: {
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('../components/settings/ClaudeOfficialLogin', () => ({
  ClaudeOfficialLogin: () => <div />,
}))

vi.mock('../pages/AdapterSettings', () => ({
  AdapterSettings: () => <div />,
}))

vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({
    activeAgents: [],
    allAgents: [],
    isLoading: false,
    error: null,
    selectedAgent: null,
    fetchAgents: vi.fn(),
    selectAgent: vi.fn(),
  }),
}))

vi.mock('../stores/skillStore', () => ({
  useSkillStore: () => ({
    skills: [],
    selectedSkill: null,
    isLoading: false,
    isDetailLoading: false,
    error: null,
    fetchSkills: vi.fn(),
    fetchSkillDetail: vi.fn(),
    clearSelection: vi.fn(),
  }),
}))

vi.mock('../components/chat/CodeViewer', () => ({
  CodeViewer: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

describe('Settings > Diagnostics tab', () => {
  beforeEach(() => {
    diagnosticsApiMock.getStatus.mockResolvedValue({
      logDir: '/tmp/claude/cc-haha/diagnostics',
      diagnosticsPath: '/tmp/claude/cc-haha/diagnostics/diagnostics.jsonl',
      cliDiagnosticsPath: '/tmp/claude/cc-haha/diagnostics/cli-diagnostics.jsonl',
      runtimeErrorsPath: '/tmp/claude/cc-haha/diagnostics/runtime-errors.log',
      exportDir: '/tmp/claude/cc-haha/diagnostics/exports',
      retentionDays: 7,
      maxBytes: 50 * 1024 * 1024,
      totalBytes: 4096,
      eventCount: 2,
      recentErrorCount: 1,
      lastEventAt: '2026-05-02T00:00:00.000Z',
    })
    diagnosticsApiMock.getEvents.mockResolvedValue({
      events: [{
        id: 'event-1',
        timestamp: '2026-05-02T00:00:00.000Z',
        type: 'cli_start_failed',
        severity: 'error',
        summary: 'CLI exited during startup with code 1',
        sessionId: 'session-1',
        details: {
          exitCode: 1,
          capturedOutput: 'stderr:\nprovider rejected request',
        },
      }],
    })
    diagnosticsApiMock.exportBundle.mockResolvedValue({
      bundle: {
        path: '/tmp/claude/cc-haha/diagnostics/exports/cc-haha-diagnostics.tar.gz',
        fileName: 'cc-haha-diagnostics.tar.gz',
        bytes: 1024,
      },
    })
    diagnosticsApiMock.openLogDir.mockResolvedValue({ ok: true })
    diagnosticsApiMock.clear.mockResolvedValue({ ok: true })
    doctorRepairMock.runDoctorRepair.mockResolvedValue({
      local: {
        removedKeys: ['cc-haha-open-tabs', 'cc-haha-session-runtime'],
        missingKeys: ['cc-haha-theme', 'cc-haha-locale', 'cc-haha.persistence.schemaVersion'],
        failedKeys: [],
      },
      server: {
        ok: true,
      },
      serverError: null,
    })

    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ pendingSettingsTab: null, toasts: [] })
  })

  it('shows diagnostics status, actions, and recent events', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))

    expect(await screen.findByText('Log directory')).toBeInTheDocument()
    expect(screen.getByText('/tmp/claude/cc-haha/diagnostics')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Export Bundle/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy Error Summary/i })).toBeInTheDocument()
    expect(screen.getByText('cli_start_failed')).toBeInTheDocument()
    expect(screen.getByText('CLI exited during startup with code 1')).toBeInTheDocument()
    expect(screen.getByText('Details')).toBeInTheDocument()
  })

  it('exports a diagnostics bundle from the settings page', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))
    fireEvent.click(await screen.findByRole('button', { name: /Export Bundle/i }))

    await waitFor(() => {
      expect(diagnosticsApiMock.exportBundle).toHaveBeenCalled()
    })
    expect(await screen.findByText('/tmp/claude/cc-haha/diagnostics/exports/cc-haha-diagnostics.tar.gz')).toBeInTheDocument()
  })

  it('copies the recent error summary with the legacy clipboard fallback', async () => {
    const originalClipboard = navigator.clipboard
    const originalExecCommand = document.execCommand
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    })
    const execCommand = vi.mocked(document.execCommand)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('clipboard blocked')),
      },
    })
    const writeText = vi.mocked(navigator.clipboard.writeText)

    try {
      render(<Settings />)

      fireEvent.click(screen.getByText('Diagnostics'))
      fireEvent.click(await screen.findByRole('button', { name: /Copy Error Summary/i }))

      await waitFor(() => {
        expect(execCommand).toHaveBeenCalledWith('copy')
      })
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('capturedOutput'))
      const toasts = useUIStore.getState().toasts
      expect(toasts[toasts.length - 1]?.message).toBe('Error summary copied.')
    } finally {
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: originalExecCommand,
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      })
    }
  })

  it('runs Doctor from Diagnostics without clearing unrelated desktop state', async () => {
    window.localStorage.setItem('cc-haha-open-tabs', '{"activeTabId":"__settings__"}')
    window.localStorage.setItem('cc-haha-theme', 'dark')
    window.localStorage.setItem('cc-haha-chat-history', 'keep')

    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))
    fireEvent.click(await screen.findByRole('button', { name: /Run Doctor/i }))

    await waitFor(() => {
      expect(doctorRepairMock.runDoctorRepair).toHaveBeenCalled()
    })

    const toasts = useUIStore.getState().toasts
    expect(toasts[toasts.length - 1]?.message).toContain('Doctor')
    expect(window.localStorage.getItem('cc-haha-chat-history')).toBe('keep')
  })
})
