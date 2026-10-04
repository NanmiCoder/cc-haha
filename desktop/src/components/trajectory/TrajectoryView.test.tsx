import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrajectoryPage, TrajectoryRow, TrajectoryRowDetail, TrajectorySnapshotBlob } from '../../types/trajectory'

const getPage = vi.fn<(sessionId: string, page?: { cursor?: string; after?: string; agentId?: string }) => Promise<TrajectoryPage>>()
const getRow = vi.fn<(sessionId: string, rowId: string) => Promise<TrajectoryRowDetail>>()
const getSnapshot = vi.fn<(sessionId: string, hash: string) => Promise<TrajectorySnapshotBlob>>()

vi.mock('../../api/trajectory', () => ({
  trajectoryApi: {
    getPage: (sessionId: string, page?: { cursor?: string; after?: string; agentId?: string }) => getPage(sessionId, page),
    getRow: (sessionId: string, rowId: string) => getRow(sessionId, rowId),
    getSnapshot: (sessionId: string, hash: string) => getSnapshot(sessionId, hash),
  },
}))

import TrajectoryView from './TrajectoryView'
import { clearTrajectoryDataCache } from './useTrajectoryData'
import { clearTrajectoryDetailCache } from './useTrajectoryDetail'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTrajectoryViewStore } from '../../stores/trajectoryViewStore'

function at(seconds: number) {
  return new Date(Date.UTC(2026, 9, 4, 10, 0, 0) + seconds * 1000).toISOString()
}

let offset = 0
function row(partial: Partial<TrajectoryRow> & Pick<TrajectoryRow, 'id' | 'kind'>): TrajectoryRow {
  offset += 100
  return { turn: 1, ts: at(offset / 100), preview: '', loc: [[offset, offset + 50]], ...partial }
}

function page(rows: TrajectoryRow[], extra: Partial<TrajectoryPage> = {}): TrajectoryPage {
  return { rows, turnBase: 0, olderCursor: null, tailToken: 'tail-1', historyComplete: true, omittedOversizedEntries: 0, ...extra }
}

const SNAPSHOT = row({
  id: 's:main:0',
  kind: 'system',
  turn: null,
  // Written when the request is sent: after the prompt and its attachments, before the response.
  ts: at(2.5),
  loc: [],
  label: 'initial',
  preview: 'system prompt',
  snapshot: { scope: 'main', change: 'initial', sys: 'aaaaaaaaaaaaaaaa', tools: 'bbbbbbbbbbbbbbbb', toolCount: 2, sysChars: 1234 },
})

function baseRows() {
  offset = 0
  return [
    row({ id: 'u:p1', kind: 'user', preview: 'Build the console' }),
    row({ id: 'c:skills', kind: 'context', label: 'skill_listing', attachmentType: 'skill_listing', preview: '3 skills' }),
    row({ id: 'a:m1', kind: 'assistant', preview: 'Checking the project', usage: { input: 10, output: 20, cacheRead: 1000, cacheWrite: 0 }, model: 'claude-x' }),
    row({ id: 't:toolu_1', kind: 'tool', toolName: 'Bash', toolUseId: 'toolu_1', parentId: 'a:m1', inputPreview: '{"command":"ls -la"}', resultPreview: 'package.json', resultTs: at(9) }),
  ]
}

function renderView(props: Partial<{ visible: boolean; running: boolean; activityKey: number }> = {}) {
  return render(
    <TrajectoryView sessionId="session-1" visible={props.visible ?? true} running={props.running ?? false} activityKey={props.activityKey ?? 0} />,
  )
}

describe('TrajectoryView', () => {
  beforeEach(() => {
    clearTrajectoryDataCache()
    clearTrajectoryDetailCache()
    getPage.mockReset()
    getRow.mockReset()
    getSnapshot.mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useTrajectoryViewStore.setState({ modes: {}, opened: {}, nav: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches nothing while hidden', () => {
    getPage.mockResolvedValue(page(baseRows()))
    renderView({ visible: false })
    expect(getPage).not.toHaveBeenCalled()
  })

  it('renders every row kind as one ledger line, with the snapshot placed before the response', async () => {
    getPage.mockResolvedValue(page(baseRows(), { snapshots: [SNAPSHOT] }))
    renderView()
    const table = await screen.findByRole('listbox', { name: 'Trajectory' })
    const options = within(table).getAllByRole('option')
    expect(options.map((option) => option.dataset.rowId)).toEqual(['u:p1', 'c:skills', 's:main:0', 'a:m1', 't:toolu_1'])
    expect(within(options[1]!).getByText('Skill list')).toBeInTheDocument()
    expect(within(options[2]!).getByText('Initial system prompt')).toBeInTheDocument()
    expect(within(options[4]!).getByText('Bash')).toBeInTheDocument()
    expect(within(options[4]!).getByText('package.json')).toBeInTheDocument()
    expect(within(table).getByText('Turn 1')).toBeInTheDocument()
    // The sticky bar names the turn in view even when its first row has scrolled away.
    expect(within(screen.getByTestId('trajectory-turn-bar')).getByText('Turn 1')).toBeInTheDocument()
    expect(screen.getByTestId('trajectory-totals').textContent).toContain('1 turns · 1 steps · 1 tool calls')
  })

  it('opens a tool row in the detail panel with its input and result tabs', async () => {
    getPage.mockResolvedValue(page(baseRows()))
    getRow.mockResolvedValue({
      rowId: 't:toolu_1',
      truncated: false,
      entries: [
        { type: 'assistant', uuid: 'e1', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }] } },
        { type: 'user', uuid: 'e2', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'package.json\nsrc', is_error: false }] } },
      ],
    })
    renderView()
    fireEvent.click(await screen.findByText('package.json'))
    const panel = await screen.findByTestId('trajectory-detail')
    expect(within(panel).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Input', 'Result', 'Raw'])
    fireEvent.click(within(panel).getByRole('tab', { name: 'Result' }))
    expect(await within(panel).findByText(/package\.json\s+src/)).toBeInTheDocument()
    expect(getRow).toHaveBeenCalledWith('session-1', 't:toolu_1')
  })

  it('shows the system prompt and tool catalog of a snapshot row', async () => {
    getPage.mockResolvedValue(page(baseRows(), { snapshots: [SNAPSHOT] }))
    getSnapshot.mockImplementation(async (_sessionId, hash) => hash === 'aaaaaaaaaaaaaaaa'
      ? { hash, kind: 'sys', text: 'You are Claude Code.' }
      : { hash, kind: 'tools', json: [{ name: 'Bash', description: 'Run shell' }, { name: 'Read', description: 'Read files' }] })
    renderView()
    fireEvent.click(await screen.findByText('Initial system prompt'))
    const panel = await screen.findByTestId('trajectory-detail')
    expect(await within(panel).findByText('You are Claude Code.')).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('tab', { name: 'Tools' }))
    expect(await within(panel).findByText('Read')).toBeInTheDocument()
  })

  it('diffs an updated system prompt against the previous snapshot', async () => {
    const updated = { ...SNAPSHOT, id: 's:main:1', ts: at(6), snapshot: { scope: 'main', change: 'system' as const, sys: 'cccccccccccccccc', tools: 'bbbbbbbbbbbbbbbb', prevSys: 'aaaaaaaaaaaaaaaa', prevTools: 'bbbbbbbbbbbbbbbb' } }
    getPage.mockResolvedValue(page(baseRows(), { snapshots: [SNAPSHOT, updated] }))
    getSnapshot.mockImplementation(async (_sessionId, hash) => (
      hash === 'aaaaaaaaaaaaaaaa' ? { hash, kind: 'sys', text: 'line one\nold rule' }
        : hash === 'cccccccccccccccc' ? { hash, kind: 'sys', text: 'line one\nnew rule' }
          : { hash, kind: 'tools', json: [] }
    ))
    renderView()
    fireEvent.click(await screen.findByText('System prompt updated'))
    const panel = await screen.findByTestId('trajectory-detail')
    fireEvent.click(within(panel).getByRole('tab', { name: 'Diff' }))
    const diff = await within(panel).findByTestId('trajectory-diff')
    expect(diff.querySelector('[data-diff="remove"]')?.textContent).toContain('old rule')
    expect(diff.querySelector('[data-diff="add"]')?.textContent).toContain('new rule')
  })

  it('folds a turn from its gutter label and hides tool rows from the toolbar', async () => {
    const rows = baseRows()
    rows[3] = { ...rows[3]!, isError: true }
    getPage.mockResolvedValue(page(rows))
    renderView()
    await screen.findByText('Build the console')
    const toggle = screen.getByRole('button', { name: /Hide tools/ })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(screen.queryByText('package.json')).not.toBeInTheDocument())
    // The response still says what it ran, and that it failed.
    const response = screen.getByText('Checking the project').closest('[role=option]') as HTMLElement
    expect(within(response).getByText('Bash')).toBeInTheDocument()
    expect(within(response).getByText('1 failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Turn 1' }))
    await waitFor(() => expect(screen.queryByText('Checking the project')).not.toBeInTheDocument())
    // Context, response and the (already hidden) tool call all fold under the prompt.
    expect(screen.getByText('3 more rows')).toBeInTheDocument()
  })

  it('selects the tool row a chat card asked to reveal', async () => {
    getPage.mockResolvedValue(page(baseRows()))
    getRow.mockResolvedValue({ rowId: 't:toolu_1', truncated: false, entries: [] })
    renderView()
    await screen.findByText('Build the console')
    act(() => useTrajectoryViewStore.getState().revealInTrajectory('session-1', 't:toolu_1'))
    await waitFor(() => expect(screen.getByRole('option', { selected: true }).dataset.rowId).toBe('t:toolu_1'))
    expect(useTrajectoryViewStore.getState().nav).toBeNull()
  })

  it('asks the chat to scroll to the tool call from "Locate in chat"', async () => {
    getPage.mockResolvedValue(page(baseRows()))
    getRow.mockResolvedValue({ rowId: 't:toolu_1', truncated: false, entries: [] })
    renderView()
    fireEvent.click(await screen.findByText('package.json'))
    fireEvent.click(await screen.findByRole('button', { name: 'Locate in chat' }))
    await waitFor(() => expect(useTrajectoryViewStore.getState().nav).toMatchObject({
      to: 'chat',
      sessionId: 'session-1',
      target: { toolUseId: 'toolu_1' },
    }))
    expect(useTrajectoryViewStore.getState().modes['session-1']).toBe('chat')
  })

  it('appends only new records while a turn runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getPage.mockResolvedValueOnce(page(baseRows()))
    const appended = row({ id: 'a:m2', kind: 'assistant', preview: 'All dependencies installed' })
    getPage.mockResolvedValueOnce(page([appended], { tailToken: 'tail-2' }))
    const view = renderView({ running: true, activityKey: 1 })
    await screen.findByText('Build the console')
    view.rerender(<TrajectoryView sessionId="session-1" visible running activityKey={2} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(getPage).toHaveBeenLastCalledWith('session-1', expect.objectContaining({ after: 'tail-1' }))
    expect(await screen.findByText('All dependencies installed')).toBeInTheDocument()
  })

  it('switches to a subagent trajectory and back', async () => {
    const rows = baseRows()
    rows[3] = { ...rows[3]!, toolName: 'Agent', agentId: 'abc123', inputPreview: 'Explore the repo' }
    getPage.mockImplementation(async (_sessionId, request) => request?.agentId
      ? page([row({ id: 'u:sub', kind: 'user', preview: 'Subagent prompt' })])
      : page(rows))
    getRow.mockResolvedValue({ rowId: 't:toolu_1', truncated: false, entries: [] })
    renderView()
    fireEvent.click(await screen.findByText('Agent'))
    fireEvent.click(await screen.findByRole('button', { name: 'View subagent trajectory' }))
    expect(await screen.findByText('Subagent prompt')).toBeInTheDocument()
    expect(getPage).toHaveBeenLastCalledWith('session-1', expect.objectContaining({ agentId: 'abc123' }))
    fireEvent.click(screen.getByRole('button', { name: 'Main session' }))
    expect(await screen.findByText('Build the console')).toBeInTheDocument()
    // The row that opened the subagent is selected again.
    await waitFor(() => expect(screen.getByRole('option', { selected: true }).dataset.rowId).toBe('t:toolu_1'))
  })

  it('counts search matches, and says so when nothing matches', async () => {
    getPage.mockResolvedValue(page(baseRows(), { olderCursor: 'older-1' }))
    renderView()
    await screen.findByText('Build the console')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search trajectory' }), { target: { value: 'ls -la' } })
    await waitFor(() => expect(screen.getByTestId('trajectory-totals')).toHaveTextContent('1 matches'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search trajectory' }), { target: { value: 'nothing-like-this' } })
    expect(await screen.findByText('No matching records')).toBeInTheDocument()
    // Older history is unloaded, so the empty state offers to load it.
    expect(screen.getByText(/Only loaded records were searched/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load earlier records' })).toBeInTheDocument()
  })

  it('keeps the selected row when the view changes around it', async () => {
    getPage.mockResolvedValue(page(baseRows()))
    getRow.mockResolvedValue({ rowId: 'c:skills', truncated: false, entries: [] })
    renderView()
    fireEvent.click(await screen.findByText('3 skills'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search trajectory' }), { target: { value: 'skills' } })
    await waitFor(() => expect(screen.getByTestId('trajectory-totals')).toHaveTextContent('matches'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search trajectory' }), { target: { value: '' } })
    await waitFor(() => expect(screen.getByTestId('trajectory-totals')).not.toHaveTextContent('matches'))
    expect(screen.getByRole('option', { selected: true }).dataset.rowId).toBe('c:skills')
    expect(screen.getByTestId('trajectory-detail')).toBeInTheDocument()
  })

  it('moves the selection with Home/End and closes the detail with Escape', async () => {
    getPage.mockResolvedValue(page(baseRows()))
    getRow.mockResolvedValue({ rowId: 'x', truncated: false, entries: [] })
    renderView()
    const table = await screen.findByRole('listbox', { name: 'Trajectory' })
    fireEvent.keyDown(table, { key: 'End' })
    expect(screen.getByRole('option', { selected: true }).dataset.rowId).toBe('t:toolu_1')
    fireEvent.keyDown(table, { key: 'Home' })
    expect(screen.getByRole('option', { selected: true }).dataset.rowId).toBe('u:p1')
    expect(table).toHaveAttribute('aria-activedescendant')
    expect(screen.getByTestId('trajectory-detail')).toBeInTheDocument()
    fireEvent.keyDown(table, { key: 'Escape' })
    expect(screen.queryByTestId('trajectory-detail')).not.toBeInTheDocument()
  })

  it('tells a tool that is still running from one that ended without a result', async () => {
    offset = 0
    const rows = [
      row({ id: 'u:p1', kind: 'user', preview: 'Go' }),
      row({ id: 't:open', kind: 'tool', toolName: 'Bash', toolUseId: 'open', inputSummary: 'sleep 100' }),
      row({ id: 't:big', kind: 'tool', toolName: 'Screenshot', toolUseId: 'big', resultOmittedBytes: 9_925_821, resultTs: at(9) }),
      row({ id: 't:orphan', kind: 'tool', toolUseId: 'orphan', resultPreview: 'ok shard 1500', resultTs: at(10), partial: true }),
    ]
    getPage.mockResolvedValue(page(rows))
    const view = renderView({ running: true })
    expect(await screen.findByText('Running…')).toBeInTheDocument()
    // The plain-text argument is shown instead of raw JSON.
    expect(screen.getByText('sleep 100')).toBeInTheDocument()
    expect(screen.getByText(/Result too large to load/)).toBeInTheDocument()
    expect(screen.getByText('(call is in earlier history)')).toBeInTheDocument()
    view.rerender(<TrajectoryView sessionId="session-1" visible running={false} activityKey={0} />)
    expect(await screen.findByText('No result')).toBeInTheDocument()
  })
})
