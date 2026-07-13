import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { SAFE_DOCTOR_STORAGE_KEYS } from '../lib/doctorRepair'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

const diagnosticsApiMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getEvents: vi.fn(),
  getIssueReport: vi.fn(),
  exportBundle: vi.fn(),
  openLogDir: vi.fn(),
  clear: vi.fn(),
}))

const doctorApiMock = vi.hoisted(() => ({
  report: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function doctorReport(path: string) {
  return {
    report: {
      generatedAt: '2026-07-11T00:00:00.000Z',
      items: [{
        id: `finding:${path}`,
        label: 'Finding',
        kind: 'json' as const,
        scope: 'user' as const,
        path,
        protected: true,
        exists: true,
        status: 'invalid_schema' as const,
        bytes: 42,
      }],
      protectedSkips: [],
      summary: { total: 1, protectedCount: 1, neutralCount: 0, missingCount: 0, invalidCount: 1 },
    },
  }
}

vi.mock('../api/diagnostics', () => ({
  diagnosticsApi: diagnosticsApiMock,
}))

vi.mock('../api/doctor', () => ({
  doctorApi: doctorApiMock,
}))

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
    vi.clearAllMocks()
    diagnosticsApiMock.getStatus.mockResolvedValue({
      logDir: '/tmp/claude/cc-haha/diagnostics',
      diagnosticsPath: '/tmp/claude/cc-haha/diagnostics/diagnostics.jsonl',
      cliDiagnosticsPath: '/tmp/claude/cc-haha/diagnostics/cli-diagnostics.jsonl',
      runtimeErrorsPath: '/tmp/claude/cc-haha/diagnostics/runtime-errors.log',
      exportDir: '/tmp/claude/cc-haha/diagnostics/exports',
      retentionDays: 7,
      maxBytes: 50 * 1024 * 1024,
      totalBytes: 4096,
      eventCount: 600,
      physicalLineCount: 601,
      corruptLineCount: 1,
      storageLimitExceeded: false,
      recentErrorCount: 1,
      lastEventAt: '2026-05-02T00:00:00.000Z',
    })
    diagnosticsApiMock.getEvents.mockResolvedValue({
      events: [
        {
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
        },
        ...Array.from({ length: 99 }, (_, index) => ({
          id: `event-${index + 2}`,
          timestamp: '2026-05-02T00:00:00.000Z',
          type: `runtime_event_${index + 2}`,
          severity: 'info' as const,
          summary: `Runtime event ${index + 2}`,
        })),
      ],
    })
    diagnosticsApiMock.exportBundle.mockResolvedValue({
      bundle: {
        path: '/tmp/claude/cc-haha/diagnostics/exports/cc-haha-diagnostics.tar.gz',
        fileName: 'cc-haha-diagnostics.tar.gz',
        bytes: 1024,
      },
    })
    diagnosticsApiMock.getIssueReport.mockResolvedValue({
      report: '## Diagnostic report\n\n- Event IDs: event-1\n- Private metadata: review before sharing',
    })
    diagnosticsApiMock.openLogDir.mockResolvedValue({ ok: true })
    diagnosticsApiMock.clear.mockResolvedValue({ ok: true })
    doctorApiMock.report.mockResolvedValue({
      report: {
        generatedAt: '2026-07-11T00:00:00.000Z',
        items: [
          {
            id: 'cc-haha-providers',
            label: 'Managed providers',
            kind: 'json',
            scope: 'user',
            path: '~/.claude/cc-haha/providers.json',
            protected: true,
            exists: true,
            status: 'invalid_schema',
            bytes: 42,
            error: 'providers.0.presetId: expected string',
          },
          {
            id: 'project-skills',
            label: 'Project skills',
            kind: 'directory',
            scope: 'project',
            path: '<project>/.claude/skills',
            protected: true,
            exists: true,
            status: 'ok',
            bytes: 0,
          },
        ],
        protectedSkips: [],
        summary: { total: 2, protectedCount: 2, neutralCount: 0, missingCount: 0, invalidCount: 1 },
      },
    })

    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null, toasts: [] })
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        title: 'Session',
        createdAt: '2026-07-11T00:00:00.000Z',
        modifiedAt: '2026-07-11T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: 'session-1',
    })
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
    expect(screen.getByText('600 complete events')).toBeInTheDocument()
    expect(screen.getByText(/evidence of 1 corrupt diagnostic record/)).toBeInTheDocument()
    expect(screen.getByText('100 visible events')).toBeInTheDocument()
    expect(screen.getAllByText('Event ID:')).toHaveLength(100)
    expect(screen.getByText('event-1')).toBeInTheDocument()
    expect(screen.getByText(/best-effort/i)).toHaveTextContent(/review.*private metadata/i)

    const eventRow = screen.getByText('cli_start_failed').closest('.grid')
    expect(eventRow).toHaveClass('grid-cols-1', 'md:grid-cols-[120px_92px_1fr]')
  })

  it('describes persisted corruption evidence accurately when current logs have no physical lines', async () => {
    diagnosticsApiMock.getStatus.mockResolvedValueOnce({
      logDir: '/tmp/claude/cc-haha/diagnostics',
      diagnosticsPath: '/tmp/claude/cc-haha/diagnostics/diagnostics.jsonl',
      cliDiagnosticsPath: '/tmp/claude/cc-haha/diagnostics/cli-diagnostics.jsonl',
      runtimeErrorsPath: '/tmp/claude/cc-haha/diagnostics/runtime-errors.log',
      exportDir: '/tmp/claude/cc-haha/diagnostics/exports',
      retentionDays: 7,
      maxBytes: 50 * 1024 * 1024,
      totalBytes: 0,
      eventCount: 0,
      physicalLineCount: 0,
      corruptLineCount: 2,
      storageLimitExceeded: false,
      recentErrorCount: 0,
      lastEventAt: null,
    })

    render(<Settings />)
    fireEvent.click(screen.getByText('Diagnostics'))

    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent('Detected or retained evidence of 2 corrupt diagnostic records.')
    expect(warning).toHaveTextContent('Current diagnostic files contain 0 physical lines.')
    expect(warning).not.toHaveTextContent(/among 0 physical lines/i)
  })

  it('explains temporary target overflow while active diagnostic segments are still open', async () => {
    diagnosticsApiMock.getStatus.mockResolvedValueOnce({
      logDir: '/tmp/claude/cc-haha/diagnostics',
      diagnosticsPath: '/tmp/claude/cc-haha/diagnostics/diagnostics.jsonl',
      cliDiagnosticsPath: '/tmp/claude/cc-haha/diagnostics/cli-diagnostics.jsonl',
      runtimeErrorsPath: '/tmp/claude/cc-haha/diagnostics/runtime-errors.log',
      exportDir: '/tmp/claude/cc-haha/diagnostics/exports',
      retentionDays: 7,
      maxBytes: 50 * 1024 * 1024,
      totalBytes: 52 * 1024 * 1024,
      eventCount: 10,
      physicalLineCount: 10,
      corruptLineCount: 0,
      storageLimitExceeded: true,
      recentErrorCount: 0,
      lastEventAt: '2026-07-11T00:00:00.000Z',
    })

    render(<Settings />)
    fireEvent.click(screen.getByText('Diagnostics'))

    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent('One or more diagnostic surfaces or active writers temporarily exceed their own retention target.')
    expect(warning).toHaveTextContent('Cleanup will occur as their segments close or age out.')
    expect(warning).not.toHaveTextContent(/50 MB|strict|hard cap/i)
  })

  it('marks the active settings tab and its decorative icon accessibly', async () => {
    render(<Settings />)

    const diagnosticsTab = screen.getByRole('button', { name: 'Diagnostics' })
    fireEvent.click(diagnosticsTab)
    await screen.findByText('Log directory')

    expect(diagnosticsTab).toHaveAttribute('aria-current', 'page')
    expect(diagnosticsTab.querySelector('.material-symbols-outlined')).toHaveAttribute('aria-hidden', 'true')
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

  it('asks with the shared confirm dialog before clearing diagnostics', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm should not be used')
    })

    try {
      render(<Settings />)

      fireEvent.click(screen.getByText('Diagnostics'))
      fireEvent.click(await screen.findByRole('button', { name: /Clear Logs/i }))

      const dialog = await screen.findByRole('dialog', { name: 'Clear Logs' })
      expect(within(dialog).getByText('Clear all local diagnostic logs and exported bundles?')).toBeInTheDocument()

      fireEvent.click(within(dialog).getByRole('button', { name: /Cancel/i }))
      expect(diagnosticsApiMock.clear).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: /Clear Logs/i }))
      const confirmDialog = await screen.findByRole('dialog', { name: 'Clear Logs' })
      fireEvent.click(within(confirmDialog).getByRole('button', { name: /Clear Logs/i }))

      await waitFor(() => {
        expect(diagnosticsApiMock.clear).toHaveBeenCalledTimes(1)
      })
      expect(confirmSpy).not.toHaveBeenCalled()
    } finally {
      confirmSpy.mockRestore()
    }
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

  it('copies the share-safe issue Markdown with the legacy clipboard fallback', async () => {
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
      fireEvent.click(await screen.findByRole('button', { name: /Copy issue report/i }))

      await waitFor(() => {
        expect(execCommand).toHaveBeenCalledWith('copy')
      })
      expect(diagnosticsApiMock.getIssueReport).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('## Diagnostic report\n\n- Event IDs: event-1\n- Private metadata: review before sharing')
      expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Issue report copied.')
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

  it('copies the exact Event ID and reports success', async () => {
    const originalClipboard = navigator.clipboard
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    try {
      render(<Settings />)

      fireEvent.click(screen.getByText('Diagnostics'))
      fireEvent.click(await screen.findByRole('button', { name: 'Copy event ID: event-1' }))

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('event-1')
      })
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Event ID copied.')
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      })
    }
  })

  it('reports a meaningful error when Event ID copy fails', async () => {
    const originalClipboard = navigator.clipboard
    const originalExecCommand = document.execCommand
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard blocked')) },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    })

    try {
      render(<Settings />)

      fireEvent.click(screen.getByText('Diagnostics'))
      fireEvent.click(await screen.findByRole('button', { name: 'Copy event ID: event-1' }))

      await waitFor(() => {
        expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Failed to copy event ID.')
      })
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

  it('checks findings first and confirms before resetting only safe desktop state', async () => {
    window.localStorage.clear()
    for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
      window.localStorage.setItem(key, `${key}-value`)
    }
    window.localStorage.setItem('cc-haha-chat-history', 'keep')

    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))
    fireEvent.click(await screen.findByRole('button', { name: /Run Doctor/i }))

    await waitFor(() => {
      expect(doctorApiMock.report).toHaveBeenCalledWith('/workspace/project')
    })
    expect(window.localStorage.getItem('cc-haha-theme')).toBe('cc-haha-theme-value')
    expect(screen.getByText('~/.claude/cc-haha/providers.json')).toBeInTheDocument()
    expect(screen.getByText(/Invalid schema/i)).toBeInTheDocument()
    expect(screen.getByText(/User and active project/i)).toBeInTheDocument()
    expect(screen.getByText('Healthy: 1 · Not configured: 0 · Missing: 0 · Invalid: 1')).toBeInTheDocument()
    expect(screen.queryByText('<project>/.claude/skills')).not.toBeInTheDocument()
    expect(screen.getByText(/cc-haha-app-zoom/)).toBeInTheDocument()
    expect(screen.getByText(/cc-haha-ui-zoom/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Reset safe UI state/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Reset safe UI state' })
    expect(window.localStorage.getItem('cc-haha-theme')).toBe('cc-haha-theme-value')
    fireEvent.click(within(dialog).getByRole('button', { name: /Reset safe UI state/i }))

    await waitFor(() => {
      expect(doctorApiMock.report).toHaveBeenCalledTimes(2)
    })
    for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key)).toBeNull()
    }
    expect(window.localStorage.getItem('cc-haha-chat-history')).toBe('keep')
    expect(screen.getByText(/Removed keys:.*cc-haha-app-zoom/)).toBeInTheDocument()
  })

  it('counts not-configured optional checks separately and excludes them from findings', async () => {
    doctorApiMock.report.mockResolvedValueOnce({
      report: {
        generatedAt: '2026-07-11T00:00:00.000Z',
        items: [
          {
            id: 'user-settings',
            label: 'User settings',
            kind: 'json' as const,
            scope: 'user' as const,
            path: '~/.claude/settings.json',
            protected: true,
            exists: true,
            status: 'ok' as const,
            bytes: 2,
          },
          {
            id: 'adapters',
            label: 'Adapters config',
            kind: 'json' as const,
            scope: 'user' as const,
            path: '~/.claude/adapters.json',
            protected: true,
            exists: false,
            status: 'not_configured' as const,
            bytes: 0,
          },
          {
            id: 'cc-haha-providers',
            label: 'Managed providers',
            kind: 'json' as const,
            scope: 'user' as const,
            path: '~/.claude/cc-haha/providers.json',
            protected: true,
            exists: true,
            status: 'invalid_schema' as const,
            bytes: 10,
          },
        ],
        protectedSkips: [],
        summary: { total: 3, protectedCount: 3, neutralCount: 1, missingCount: 0, invalidCount: 1 },
      },
    })

    render(<Settings />)
    fireEvent.click(screen.getByText('Diagnostics'))
    fireEvent.click(await screen.findByRole('button', { name: /Run Doctor/i }))

    expect(await screen.findByText('Healthy: 1 · Not configured: 1 · Missing: 0 · Invalid: 1')).toBeInTheDocument()
    expect(screen.getByText('~/.claude/cc-haha/providers.json')).toBeInTheDocument()
    expect(screen.queryByText('~/.claude/adapters.json')).not.toBeInTheDocument()
  })

  it('uses user-only Doctor scope when the active work directory is unavailable', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({ ...session, workDirExists: false })),
    }))

    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))
    expect(await screen.findByText(/User only/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Run Doctor/i }))

    await waitFor(() => {
      expect(doctorApiMock.report).toHaveBeenCalledWith(undefined)
    })
  })

  it('clears an existing Doctor report when the active cwd changes', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))
    fireEvent.click(await screen.findByRole('button', { name: /Run Doctor/i }))
    expect(await screen.findByText('~/.claude/cc-haha/providers.json')).toBeInTheDocument()

    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          {
            ...state.sessions[0]!,
            id: 'session-missing-workdir',
            workDir: '/workspace/missing',
            projectRoot: '/workspace/missing',
            workDirExists: false,
          },
        ],
        activeSessionId: 'session-missing-workdir',
      }))
    })

    await waitFor(() => {
      expect(screen.queryByText('~/.claude/cc-haha/providers.json')).not.toBeInTheDocument()
    })
    expect(screen.getByText(/User only/i)).toBeInTheDocument()
  })

  it('keeps newer Doctor loading active when an older response resolves first', async () => {
    const oldRequest = deferred<ReturnType<typeof doctorReport>>()
    const newRequest = deferred<ReturnType<typeof doctorReport>>()
    doctorApiMock.report
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise)

    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))
    fireEvent.click(await screen.findByRole('button', { name: /Run Doctor/i }))
    expect(doctorApiMock.report).toHaveBeenCalledWith('/workspace/project')

    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          {
            ...state.sessions[0]!,
            id: 'session-new',
            workDir: '/workspace/new',
            projectRoot: '/workspace/new',
          },
        ],
        activeSessionId: 'session-new',
      }))
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Run Doctor/i })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: /Run Doctor/i }))
    expect(doctorApiMock.report).toHaveBeenCalledWith('/workspace/new')
    expect(screen.getByRole('button', { name: /Run Doctor/i })).toBeDisabled()

    await act(async () => {
      oldRequest.resolve(doctorReport('<project>/old-finding.json'))
      await Promise.resolve()
    })
    expect(screen.queryByText('<project>/old-finding.json')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run Doctor/i })).toBeDisabled()

    await act(async () => {
      newRequest.resolve(doctorReport('<project>/new-finding.json'))
      await Promise.resolve()
    })
    expect(await screen.findByText('<project>/new-finding.json')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run Doctor/i })).not.toBeDisabled()
  })

  it('preserves reset results and releases reset loading when cwd changes during refresh', async () => {
    const stalledRefresh = deferred<ReturnType<typeof doctorReport>>()
    doctorApiMock.report.mockReturnValueOnce(stalledRefresh.promise)
    window.localStorage.clear()
    for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
      window.localStorage.setItem(key, `${key}-value`)
    }

    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))
    fireEvent.click(await screen.findByRole('button', { name: /Reset safe UI state/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Reset safe UI state' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Reset safe UI state/i }))

    expect(await screen.findByText(/Removed keys:.*cc-haha-app-zoom/)).toBeInTheDocument()
    expect(screen.getByText('Failed keys: None')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reset safe UI state/i })).toBeDisabled()

    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          {
            ...state.sessions[0]!,
            id: 'session-reset-new',
            workDir: '/workspace/reset-new',
            projectRoot: '/workspace/reset-new',
          },
        ],
        activeSessionId: 'session-reset-new',
      }))
    })

    expect(screen.getByText(/Removed keys:.*cc-haha-app-zoom/)).toBeInTheDocument()
    expect(screen.getByText('Failed keys: None')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reset safe UI state/i })).not.toBeDisabled()

    await act(async () => {
      stalledRefresh.resolve(doctorReport('<project>/stale-reset-finding.json'))
      await Promise.resolve()
    })
    expect(screen.queryByText('<project>/stale-reset-finding.json')).not.toBeInTheDocument()
  })

  it('ignores a stale reset refresh rejection after cwd changes', async () => {
    const stalledRefresh = deferred<ReturnType<typeof doctorReport>>()
    doctorApiMock.report.mockReturnValueOnce(stalledRefresh.promise)

    render(<Settings />)

    fireEvent.click(screen.getByText('Diagnostics'))
    fireEvent.click(await screen.findByRole('button', { name: /Reset safe UI state/i }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Reset safe UI state' }))
      .getByRole('button', { name: /Reset safe UI state/i }))

    await act(async () => {
      useSessionStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          {
            ...state.sessions[0]!,
            id: 'session-reject-new',
            workDir: '/workspace/reject-new',
            projectRoot: '/workspace/reject-new',
          },
        ],
        activeSessionId: 'session-reject-new',
      }))
    })

    await act(async () => {
      stalledRefresh.reject(new Error('stale reset refresh failed'))
      await Promise.resolve()
    })

    expect(useUIStore.getState().toasts.map((toast) => toast.message)).not.toContain('stale reset refresh failed')
    expect(screen.getByRole('button', { name: /Reset safe UI state/i })).not.toBeDisabled()
  })
})
