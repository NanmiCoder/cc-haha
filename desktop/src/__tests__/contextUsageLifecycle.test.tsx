import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { sessionsApi } from '../api/sessions'

vi.mock('../api/skills', () => ({ skillsApi: { list: vi.fn(async () => ({ skills: [] })) } }))
vi.mock('../api/providers', () => ({
  providersApi: { list: vi.fn(async () => ({ providers: [], activeId: null })) },
}))
vi.mock('../api/mcp', () => ({ mcpApi: { list: vi.fn(async () => ({ servers: [] })), status: vi.fn() } }))
vi.mock('../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sessions')>()
  return { ...actual, sessionsApi: { ...actual.sessionsApi, getInspection: vi.fn() } }
})

import { ActiveSession } from '../pages/ActiveSession'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSessionRuntimeStore } from '../stores/sessionRuntimeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'

/**
 * The context meter, driven through a whole session lifecycle instead of one hop at a
 * time.
 *
 * ContextUsageIndicator.tsx was fixed three times in ninety minutes — 2262973a4
 * (switching models blanked the percentage), b4807697f (after the switch the number
 * never moved again, and the stale number was relabelled with the new model's name),
 * 128f75ab5 (a brand-new session span on open). Each fix shipped a test, and each test
 * only covered its own hop:
 *
 *   - 2262973a4's test mocked the post-switch inspection as *succeeding*, so the real
 *     case — the CLI is restarting, the request fails, and nothing retries — was never
 *     modelled. It also asserted `getByText('deepseek-reasoner')` at a moment when the
 *     screen showed kimi-k2.6's 21%, i.e. it wrote the second bug in as a passing
 *     assertion. b4807697f had to invert that exact line 63 minutes later.
 *   - b4807697f's five tests all pass `messageCount >= 1`, so none of them can see
 *     128f75ab5's change at all.
 *   - 128f75ab5 had to rewrite five *other* tests' props (`messageCount={0}` -> `{1}`,
 *     `chatState="idle"` -> `"thinking"`) to keep them on their intended code paths —
 *     those combinations never described a real session, they were just parameters that
 *     reached the target branch.
 *
 * Coverage was never the problem: this file sits at 87% branch coverage. What no test
 * did was cross a transition and then check the same property again. So this one is
 * built the other way round — a single invariant, re-checked after every hop, instead
 * of a per-hop expected value that can be edited into agreement with the code.
 *
 * It deliberately renders `<ActiveSession />` against the real stores. Half of
 * b4807697f's repair lives in the store and in ChatInput's props arithmetic
 * (`refreshNonce = compactCount + runtimeConfigReadyCount`, ChatInput.tsx:1445), and a
 * component-level test can only hand-write `refreshNonce={1}` — which skips the one
 * link in the chain that nothing covers. Deleting the `runtimeConfigReadyCount` term
 * leaves 328 tests across the six most relevant files green.
 */

const SESSION_A = 'ctx-lifecycle-a'
const SESSION_B = 'ctx-lifecycle-b'
const PROVIDER = 'provider-deepseek'

function baseContext(percentage: number, model: string) {
  return {
    categories: [
      { name: 'System prompt', tokens: 6_800, color: '#8a8a8a' },
      { name: 'Free space', tokens: 100_000, color: '#9B928C', isDeferred: true },
    ],
    totalTokens: 28_000,
    maxTokens: 128_000,
    rawMaxTokens: 128_000,
    percentage,
    gridRows: [],
    model,
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  }
}

function emptyChatSession() {
  return {
    messages: [],
    chatState: 'idle' as const,
    connectionState: 'connected' as const,
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    agentTaskNotifications: {},
    elapsedTimer: null,
  }
}

function seedSessions(ids: string[], activeId: string) {
  useTabStore.setState({
    tabs: ids.map((sessionId) => ({ sessionId, title: sessionId, type: 'session' as const, status: 'idle' as const })),
    activeTabId: activeId,
  })
  useSessionStore.setState({
    sessions: ids.map((id) => ({
      id,
      title: id,
      createdAt: '2026-04-10T00:00:00.000Z',
      modifiedAt: '2026-04-10T00:00:00.000Z',
      messageCount: 0,
      projectPath: '/workspace/project',
      workDir: '/workspace/project',
      workDirExists: true,
    })),
    activeSessionId: activeId,
    isLoading: false,
    error: null,
  })
  useChatStore.setState({ sessions: Object.fromEntries(ids.map((id) => [id, emptyChatSession()])) })
}

const flush = () => act(async () => { await Promise.resolve() })

/**
 * Records what the app asked for and what actually settled, so the assertion can be
 * stated once as a property rather than re-derived at every step.
 */
function makeLedger() {
  const calls: string[] = []
  let settled: { sessionId: string; percent: number; model: string } | null = null
  let next: { percent: number; model: string } | { error: string } = { error: 'Context is not ready' }

  vi.mocked(sessionsApi.getInspection).mockImplementation((async (sessionId: string) => {
    calls.push(sessionId)
    const reply = next
    if ('error' in reply) {
      return { active: true, status: { sessionId, model: 'unknown' }, errors: { context: reply.error } }
    }
    settled = { sessionId, percent: reply.percent, model: reply.model }
    return {
      active: true,
      status: { sessionId, model: reply.model },
      context: baseContext(reply.percent, reply.model),
    }
  }) as never)

  return {
    calls,
    respondWith(reply: typeof next) { next = reply },
    /**
     * The invariant, not one step's expected value: the meter shows either the
     * placeholder or the result of a settled inspection for the session on screen, and
     * the model label belongs to that same inspection. Every failure in the cascade
     * violates one half of this sentence.
     */
    async expectConsistent(step: string) {
      const trigger = screen.getByTestId('context-usage-indicator')
      const activeId = useTabStore.getState().activeTabId
      if (!settled || settled.sessionId !== activeId) {
        expect(trigger, `${step}: nothing has settled for this session, so it must read --`)
          .toHaveTextContent('--')
        return
      }
      expect(trigger, `${step}: must show the settled percentage`).toHaveTextContent(`${settled.percent}%`)
      fireEvent.click(trigger)
      const popover = await screen.findByTestId('context-usage-popover')
      expect(popover, `${step}: the label must be the model that inspection returned`)
        .toHaveTextContent(settled.model)
      fireEvent.click(trigger)
    },
  }
}

describe('context usage across a session lifecycle', () => {
  beforeEach(() => {
    vi.mocked(sessionsApi.getInspection).mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useSessionRuntimeStore.setState({ selections: {} })
    seedSessions([SESSION_A], SESSION_A)
  })

  afterEach(() => {
    cleanup()
  })

  it('never shows a percentage that belongs to another model, session, or nothing at all', async () => {
    const ledger = makeLedger()
    useSessionRuntimeStore.getState().setSelection(SESSION_A, {
      providerId: PROVIDER,
      modelId: 'deepseek-chat',
    })

    render(<ActiveSession />)

    // 1) A session that has never run must not be inspected at all: the CLI is not up,
    //    so the request is guaranteed to fail and the meter would spin. [128f75ab5]
    await flush()
    expect(ledger.calls, 'an idle session with no messages must not be inspected').toHaveLength(0)
    await ledger.expectConsistent('fresh session')

    // 2) A real first turn starts. Asking is allowed now, but nothing has settled yet.
    //    Driven as actual frames rather than a bare status flip: the fetch gate is
    //    `messageCount > 0 || chatState !== 'idle'`, so a turn that produces no message
    //    closes the gate again on the way back to idle and never asks. A status-only
    //    sequence would be testing a session state that cannot occur.
    ledger.respondWith({ error: 'Context is not ready' })
    act(() => {
      const store = useChatStore.getState()
      store.handleServerMessage(SESSION_A, { type: 'status', state: 'thinking' } as never)
      store.handleServerMessage(SESSION_A, { type: 'content_start', blockType: 'text' } as never)
      store.handleServerMessage(SESSION_A, { type: 'content_delta', text: 'working on it' } as never)
    })
    await waitFor(() => expect(ledger.calls.length).toBeGreaterThan(0))
    await ledger.expectConsistent('first turn in flight')

    // 3) First turn ends and a real number arrives.
    ledger.respondWith({ percent: 21, model: 'deepseek-chat' })
    act(() => {
      const store = useChatStore.getState()
      store.handleServerMessage(SESSION_A, { type: 'message_complete', usage: {} } as never)
      store.handleServerMessage(SESSION_A, { type: 'status', state: 'idle' } as never)
    })
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('21%')
    })
    await ledger.expectConsistent('first turn complete')

    // 4) Model switch. The CLI restarts, so the inspection issued here FAILS — that is
    //    the semantics 2262973a4 installed server-side (Error('CLI session stopped')),
    //    and mocking it as a success is exactly what its own test got wrong. The meter
    //    must hold the last confirmed pair: 21% still labelled deepseek-chat, never
    //    21% relabelled deepseek-reasoner. [2262973a4 + b4807697f]
    const callsBeforeSwitch = ledger.calls.length
    ledger.respondWith({ error: 'CLI session stopped' })
    act(() => {
      useSessionRuntimeStore.getState().setSelection(SESSION_A, {
        providerId: PROVIDER,
        modelId: 'deepseek-reasoner',
      })
    })
    await waitFor(() => expect(ledger.calls.length).toBeGreaterThan(callsBeforeSwitch))
    await ledger.expectConsistent('runtime switching')

    // 5) The replacement runtime reports ready. This is the link nothing else covers:
    //    server event -> chatStore.runtimeConfigReadyCount -> ChatInput's refreshNonce
    //    -> the indicator. Break any part of it and this step times out on 21%.
    ledger.respondWith({ percent: 12, model: 'deepseek-reasoner' })
    act(() => {
      useChatStore.getState().handleServerMessage(SESSION_A, {
        type: 'runtime_config_applied',
        providerId: PROVIDER,
        modelId: 'deepseek-reasoner',
      } as never)
    })
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('12%')
    })
    await ledger.expectConsistent('runtime applied')

    // 6) Switching to a second, never-run session must neither inspect nor inherit the
    //    first session's number. [128f75ab5 + b4807697f]
    seedSessions([SESSION_A, SESSION_B], SESSION_B)
    const callsBeforeTabSwitch = ledger.calls.length
    act(() => {
      useTabStore.setState({ activeTabId: SESSION_B })
    })
    await flush()
    expect(ledger.calls.length, 'an unused session must not be inspected on tab switch')
      .toBe(callsBeforeTabSwitch)
    await ledger.expectConsistent('switched to an unused session')
  })
})
