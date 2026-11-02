import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConversationFindController } from '../search/conversationFindBridge'
import { FindInPageModal } from '../search/FindInPageModal'
import { useSettingsStore } from '../../stores/settingsStore'
import type { TeamMember, TeamWorkbenchMessage, TeamWorkbenchSnapshot } from '../../types/team'
import { AgentTeamsCommunicationFeed } from './AgentTeamsCommunicationFeed'
import { formatWorkbenchMessageTime } from './agentTeamsModel'
import { REVEAL_PAGE_SIZE } from './useProgressiveReveal'

// Every mounted row formats its time once per render, which makes the spy a
// count of row renders.
vi.mock('./agentTeamsModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentTeamsModel')>()
  return { ...actual, formatWorkbenchMessageTime: vi.fn(actual.formatWorkbenchMessageTime) }
})

function message(overrides: Partial<TeamWorkbenchMessage> & { id: string }): TeamWorkbenchMessage {
  return {
    from: 'builder',
    to: 'reviewer',
    recipients: ['reviewer'],
    kind: 'direct',
    text: 'body',
    timestamp: '2026-08-08T07:42:16.666Z',
    ...overrides,
  }
}

const MEMBERS: TeamMember[] = [
  { agentId: 'lead@team-a', name: 'lead', role: 'orchestrator', status: 'running' },
  { agentId: 'builder@team-a', name: 'builder', role: 'server engineer', status: 'running' },
  { agentId: 'reviewer@team-a', name: 'reviewer', role: 'qa engineer', status: 'idle' },
]

function snapshot(
  messages: TeamWorkbenchMessage[],
  members: TeamMember[] = MEMBERS,
): TeamWorkbenchSnapshot {
  return {
    version: 'v1',
    generatedAt: '2026-08-08T08:00:00.000Z',
    team: {
      name: 'team-a',
      leadAgentId: 'lead@team-a',
      leadSessionId: 'lead-session',
      members,
    },
    tasks: [],
    messages,
  }
}

function categoryOf(id: string): string | null {
  return screen.getByTestId(`agent-teams-message-${id}`).getAttribute('data-message-category')
}

/** Oldest first, as the server sends them; even ids report to the lead, odd ones go to a peer. */
function longHistory(count: number): TeamWorkbenchMessage[] {
  const start = Date.parse('2026-08-08T07:00:00.000Z')
  return Array.from({ length: count }, (_, index) => message({
    id: `m-${index}`,
    text: `Update ${index}`,
    timestamp: new Date(start + index * 1000).toISOString(),
    ...(index % 2 === 0 ? { to: 'lead', recipients: ['lead'] } : {}),
  }))
}

function mountedIds(): string[] {
  return Array.from(document.querySelectorAll('article[data-message-category]'))
    .map((row) => row.getAttribute('data-testid')!.replace('agent-teams-message-', ''))
}

type FakeObserver = {
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit | undefined
  targets: Element[]
  disconnected: boolean
}

describe('AgentTeamsCommunicationFeed', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('explains direct task delivery without inventing a message, then shows the first report', () => {
    const view = render(<AgentTeamsCommunicationFeed snapshot={snapshot([])} />)
    expect(screen.getByText(/Approved tasks are delivered directly to members/)).toBeTruthy()
    expect(screen.getByTestId('agent-teams-message-count').textContent).toBe('0 messages')
    view.rerender(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'first-report', from: 'builder', to: 'lead', recipients: ['lead'], text: 'Analysis complete.' }),
    ])} />)
    expect(screen.queryByText(/Approved tasks are delivered directly to members/)).toBeNull()
    expect(screen.getByText('Analysis complete.')).toBeTruthy()
    expect(categoryOf('first-report')).toBe('report')
  })

  it('maps real CLI routes into assignment, peer, report, and system categories', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({
        id: 'protocol-assignment',
        from: 'lead',
        to: 'builder@team-a',
        recipients: ['builder@team-a'],
        kind: 'system',
        protocolType: 'task_assignment',
        taskId: '2',
        text: '{"type":"task_assignment","taskId":"2","subject":"Build it"}',
      }),
      message({
        id: 'self-claim',
        from: 'builder',
        to: 'builder@team-a',
        recipients: ['builder@team-a'],
        kind: 'system',
        protocolType: 'task_assignment',
        taskId: '3',
        text: '{"type":"task_assignment","taskId":"3","subject":"Claim it"}',
      }),
      message({ id: 'lead-direct', from: 'lead', to: 'builder@team-a', recipients: ['builder@team-a'], text: 'Please own the API.' }),
      message({ id: 'peer-direct', from: 'builder@team-a', to: 'reviewer', recipients: ['reviewer'], text: 'Can you verify the route?' }),
      message({ id: 'worker-report', from: 'builder', to: 'lead@team-a', recipients: ['lead@team-a'], text: 'API implementation is ready.' }),
      message({
        id: 'lifecycle',
        from: 'builder@team-a',
        to: 'team-lead@team-a',
        recipients: ['team-lead@team-a'],
        kind: 'system',
        text: '{"type":"idle_notification","idleReason":"available"}',
      }),
      message({ id: 'lead-broadcast', from: 'lead@team-a', kind: 'broadcast', to: '*', recipients: ['*'], text: 'Everyone take the next ready task.' }),
      message({ id: 'worker-broadcast', from: 'reviewer@team-a', kind: 'broadcast', to: '*', recipients: ['*'], text: 'Review summary is published.' }),
    ])} />)

    expect(categoryOf('protocol-assignment')).toBe('assignment')
    expect(categoryOf('self-claim')).toBe('system')
    expect(categoryOf('lead-direct')).toBe('assignment')
    expect(categoryOf('lead-broadcast')).toBe('assignment')
    expect(categoryOf('peer-direct')).toBe('peer')
    expect(categoryOf('worker-report')).toBe('report')
    expect(categoryOf('worker-broadcast')).toBe('report')
    expect(categoryOf('lifecycle')).toBe('system')
    expect(within(screen.getByTestId('agent-teams-message-worker-report')).getByText('Reports')).toBeTruthy()
    expect(within(screen.getByTestId('agent-teams-message-peer-direct')).getByText('Direct').className).toContain('color-tertiary')
    expect(within(screen.getByTestId('agent-teams-message-worker-report')).getByText('Reports').className).toContain('color-text-secondary')
    expect(screen.getByText('Review summary is published.')).toBeTruthy()
  })

  it('always shows the five semantic filters and filters without using transport kind', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'assignment', from: 'lead', to: 'builder', recipients: ['builder'], text: 'Take task one.' }),
      message({ id: 'peer', from: 'builder', to: 'reviewer', recipients: ['reviewer'], text: 'Private review.' }),
      message({ id: 'report', from: 'builder', to: 'lead', recipients: ['lead'], text: 'Task one is done.' }),
      message({ id: 'system', kind: 'system', protocolType: 'custom_event', text: '{"type":"custom_event","message":"Context loaded"}' }),
    ])} />)

    expect(screen.getByTestId('agent-teams-message-count').textContent).toBe('4 messages')
    expect(screen.getByTestId('agent-teams-filter-all')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-filter-assignment').getAttribute('data-count')).toBe('1')
    expect(screen.getByTestId('agent-teams-filter-peer').getAttribute('data-count')).toBe('1')
    expect(screen.getByTestId('agent-teams-filter-report').getAttribute('data-count')).toBe('1')
    expect(screen.getByTestId('agent-teams-filter-system').getAttribute('data-count')).toBe('1')

    for (const category of ['assignment', 'peer', 'report', 'system'] as const) {
      fireEvent.click(screen.getByTestId(`agent-teams-filter-${category}`))
      expect(screen.getByTestId(`agent-teams-message-${category}`)).toBeTruthy()
      for (const other of ['assignment', 'peer', 'report', 'system']) {
        if (other !== category) expect(screen.queryByTestId(`agent-teams-message-${other}`)).toBeNull()
      }
    }
  })

  it('narrates assignment and lifecycle protocols in one line without leaking JSON', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({
        id: 'assignment',
        from: 'lead',
        to: 'builder',
        recipients: ['builder'],
        kind: 'system',
        protocolType: 'task_assignment',
        taskId: '7',
        text: '{"type":"task_assignment","taskId":"7","subject":"Repair queue"}',
      }),
      message({
        id: 'idle',
        from: 'builder',
        to: 'lead',
        recipients: ['lead'],
        kind: 'system',
        text: '{"type":"idle_notification","idleReason":"available"}',
      }),
    ])} />)

    expect(screen.getByText(/Assigned #7 Repair queue to builder/)).toBeTruthy()
    expect(screen.getByText(/Went idle, waiting for work · available/)).toBeTruthy()
    expect(screen.getByTestId('agent-teams-message-assignment-body').className).toContain('truncate')
    expect(screen.getByTestId('agent-teams-message-idle-body').className).toContain('truncate')
    expect(document.body.textContent).not.toContain('"taskId"')
    expect(document.body.textContent).not.toContain('idle_notification')
  })

  it('localizes an unknown structured protocol instead of inventing an English label', () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({
        id: 'custom',
        kind: 'system',
        protocolType: 'custom_event',
        text: '{"type":"custom_event","payload":42}',
      }),
    ])} />)

    expect(screen.getByTestId('agent-teams-message-custom-body').textContent).toBe('系统')
    expect(document.body.textContent).not.toContain('Custom event')
  })

  it('keeps authored Markdown readable and uses compact 22px routing figures', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({
        id: 'markdown',
        from: 'builder@team-a',
        to: 'reviewer',
        text: '## Finding A\n\n**Key evidence**\n\n```ts\nconst fixed = true\n```',
      }),
    ])} />)

    const row = screen.getByTestId('agent-teams-message-markdown')
    expect(row.querySelector('h2')?.textContent).toBe('Finding A')
    expect(row.querySelector('strong')?.textContent).toBe('Key evidence')
    expect(row.textContent).not.toContain('## Finding A')
    expect(screen.getByTestId('agent-teams-message-markdown-from').textContent).toBe('builder@team-a')
    expect(screen.getByTestId('agent-teams-message-markdown-to').textContent).toBe('reviewer')
    expect(screen.getByTestId('agent-teams-message-markdown-from-avatar').className).toContain('h-[22px]')
    expect(screen.getByTestId('agent-teams-message-markdown-from-avatar').getAttribute('data-avatar-key')).toBe('server-engineer')
    expect(screen.getByTestId('agent-teams-message-markdown-to-avatar').getAttribute('data-avatar-key')).toBe('security-reviewer')
  })

  it('keeps a long human message behind an explicit expander', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'long', kind: 'broadcast', to: '*', recipients: ['*'], text: 'x'.repeat(400) }),
    ])} />)

    expect(screen.getByTestId('agent-teams-message-long-body').getAttribute('data-collapsed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByTestId('agent-teams-message-long-body').getAttribute('data-collapsed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByTestId('agent-teams-message-long-body').getAttribute('data-collapsed')).toBe('true')
  })

  it('folds adjacent duplicate lifecycle signals into the newest row', () => {
    const idle = (id: string) => message({
      id,
      from: 'builder',
      to: 'lead',
      recipients: ['lead'],
      kind: 'system',
      text: '{"type":"idle_notification","idleReason":"available"}',
    })
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'report', from: 'builder', to: 'lead', recipients: ['lead'], text: 'Ready for more work.' }),
      idle('i1'),
      idle('i2'),
      idle('i3'),
    ])} />)

    expect(screen.getByTestId('agent-teams-message-count').textContent).toBe('4 messages')
    expect(screen.getByTestId('agent-teams-message-i3-repeats').textContent).toBe('×3')
    expect(screen.queryByTestId('agent-teams-message-i2')).toBeNull()
    expect(screen.queryByTestId('agent-teams-message-i1')).toBeNull()
  })

  it('keeps task hover focus and its reset callback', () => {
    const onFocusTask = vi.fn()
    render(<AgentTeamsCommunicationFeed
      snapshot={snapshot([message({ id: 'task', taskId: '42', text: 'Please review task 42.' })])}
      onFocusTask={onFocusTask}
    />)

    const row = screen.getByTestId('agent-teams-message-task')
    fireEvent.mouseEnter(row)
    fireEvent.mouseLeave(row)

    expect(onFocusTask.mock.calls).toEqual([['42'], [null]])
  })

  it('keeps per-message wall time but removes the local early/middle/late controls', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'first', text: 'first', timestamp: '2026-08-08T07:42:00.000Z' }),
      message({ id: 'second', text: 'second', timestamp: '2026-08-08T09:15:00.000Z' }),
    ])} />)

    const times = ['first', 'second'].map((id) => (
      screen.getByTestId(`agent-teams-message-${id}`).querySelector('time')?.textContent
    ))
    expect(times[0]).toBeTruthy()
    expect(times[0]).not.toBe(times[1])
    expect(screen.queryByTestId('agent-teams-time-range')).toBeNull()
    expect(screen.queryByTestId('agent-teams-time-early')).toBeNull()
    expect(screen.queryByTestId('agent-teams-time-middle')).toBeNull()
    expect(screen.queryByTestId('agent-teams-time-late')).toBeNull()
    expect(screen.queryByTestId('agent-teams-lifecycle-toggle')).toBeNull()
  })

  it('keeps route figures available when archived member metadata is missing', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'unknown', from: 'unknown-builder', to: 'unknown-reviewer' }),
    ], [])} />)

    expect(screen.getByTestId('agent-teams-message-unknown-from-avatar').getAttribute('data-avatar-key')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-message-unknown-to-avatar').getAttribute('data-avatar-key')).toBeTruthy()
  })

  describe('long histories', () => {
    // Opening the panel used to mount every message with its Markdown: 553
    // messages took ~250ms and ~13k nodes on the click.
    it('mounts the newest page on open and pages the rest in, keeping whole-history counts', () => {
      render(<AgentTeamsCommunicationFeed snapshot={snapshot(longHistory(553))} />)

      expect(screen.getByTestId('agent-teams-message-count').textContent).toBe('553 messages')
      expect(screen.getByTestId('agent-teams-filter-all').getAttribute('data-count')).toBe('553')
      const firstPage = mountedIds()
      expect(firstPage).toHaveLength(REVEAL_PAGE_SIZE)
      expect(firstPage[0]).toBe('m-552')
      expect(firstPage.at(-1)).toBe(`m-${553 - REVEAL_PAGE_SIZE}`)

      fireEvent.click(screen.getByRole('button', {
        name: `Show earlier messages (${553 - REVEAL_PAGE_SIZE} more)`,
      }))
      expect(mountedIds()).toHaveLength(REVEAL_PAGE_SIZE * 2)
      expect(mountedIds().slice(0, REVEAL_PAGE_SIZE)).toEqual(firstPage)
    })

    // Kept small: mounting hundreds of Markdown rows in jsdom takes seconds and
    // timed out under the parallel suite.
    it('pages all the way to the oldest message, then stops offering more', () => {
      render(<AgentTeamsCommunicationFeed snapshot={snapshot(longHistory(130))} />)

      let pages = 1
      while (screen.queryByRole('button', { name: /Show earlier messages/ })) {
        fireEvent.click(screen.getByRole('button', { name: /Show earlier messages/ }))
        pages += 1
      }
      expect(pages).toBe(Math.ceil(130 / REVEAL_PAGE_SIZE))
      expect(mountedIds()).toHaveLength(130)
      expect(mountedIds().at(-1)).toBe('m-0')
    })

    it('starts every filter from its own newest page', () => {
      render(<AgentTeamsCommunicationFeed snapshot={snapshot(longHistory(200))} />)
      fireEvent.click(screen.getByRole('button', { name: /Show earlier messages/ }))
      expect(mountedIds()).toHaveLength(REVEAL_PAGE_SIZE * 2)

      fireEvent.click(screen.getByTestId('agent-teams-filter-report'))
      const reports = mountedIds()
      expect(reports).toHaveLength(REVEAL_PAGE_SIZE)
      expect(reports[0]).toBe('m-198')
      expect(reports.every((id) => categoryOf(id) === 'report')).toBe(true)
      expect(screen.getByRole('button', { name: `Show earlier messages (${100 - REVEAL_PAGE_SIZE} more)` })).toBeTruthy()

      fireEvent.click(screen.getByTestId('agent-teams-filter-all'))
      expect(mountedIds()).toHaveLength(REVEAL_PAGE_SIZE)
    })

    it('leaves mounted rows alone when re-rendered with the same snapshot', () => {
      const history = snapshot(longHistory(553))
      const onFocusTask = vi.fn()
      const view = render(<AgentTeamsCommunicationFeed snapshot={history} onFocusTask={onFocusTask} />)
      const rowRenders = vi.mocked(formatWorkbenchMessageTime)

      // The workbench re-renders the feed every second while following live.
      rowRenders.mockClear()
      view.rerender(<AgentTeamsCommunicationFeed snapshot={history} onFocusTask={onFocusTask} />)
      expect(rowRenders).not.toHaveBeenCalled()

      // A new snapshot re-renders what is mounted, and only that.
      view.rerender(<AgentTeamsCommunicationFeed snapshot={{ ...history }} onFocusTask={onFocusTask} />)
      expect(rowRenders).toHaveBeenCalledTimes(REVEAL_PAGE_SIZE)
    })

    describe('with a scroll observer', () => {
      let observers: FakeObserver[]

      beforeEach(() => {
        observers = []
        vi.stubGlobal('IntersectionObserver', class {
          private readonly record: FakeObserver

          constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
            this.record = { callback, options, targets: [], disconnected: false }
            observers.push(this.record)
          }

          observe(target: Element) { this.record.targets.push(target) }
          unobserve() {}
          disconnect() { this.record.disconnected = true }
          takeRecords() { return [] }
        })
      })

      afterEach(() => {
        vi.unstubAllGlobals()
      })

      function liveObserver(): FakeObserver {
        const live = observers.filter((observer) => !observer.disconnected)
        expect(live).toHaveLength(1)
        return live[0]!
      }

      function report(observer: FakeObserver, isIntersecting: boolean) {
        act(() => {
          observer.callback(
            [{ isIntersecting, target: observer.targets[0]! } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          )
        })
      }

      it('mounts the next page as the end of the list nears the viewport, until none is left', () => {
        render(<AgentTeamsCommunicationFeed snapshot={snapshot(longHistory(100))} />)

        expect(screen.queryByRole('button', { name: /Show earlier messages/ })).toBeNull()
        const sentinel = screen.getByTestId('agent-teams-reveal-sentinel')
        const first = liveObserver()
        expect(first.targets).toEqual([sentinel])
        // Watched against the feed's own scroller, not the window.
        expect(first.options?.root).toBe(sentinel.parentElement)
        expect(sentinel.parentElement?.className).toContain('overflow-y-auto')

        report(first, false)
        expect(mountedIds()).toHaveLength(REVEAL_PAGE_SIZE)

        report(first, true)
        expect(mountedIds()).toHaveLength(REVEAL_PAGE_SIZE * 2)
        // A fresh observer reports a sentinel that is still in range, so a tall
        // pane keeps filling instead of stalling after one page.
        const second = liveObserver()
        expect(second).not.toBe(first)

        report(second, true)
        expect(mountedIds()).toHaveLength(100)
        expect(screen.queryByTestId('agent-teams-reveal-sentinel')).toBeNull()
        expect(observers.every((observer) => observer.disconnected)).toBe(true)
      })
    })
  })

  // Find-in-page walks the DOM, so rows not mounted yet used to be unfindable.
  describe('find in page', () => {
    let highlights: Map<string, { ranges: Range[] }>

    beforeEach(() => {
      highlights = new Map()
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
      vi.stubGlobal('CSS', { highlights })
      vi.stubGlobal('Highlight', class {
        ranges: Range[] = []
        priority?: number
        add(range: Range) { this.ranges.push(range) }
      })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function findCount(): string | null | undefined {
      return document.querySelector('[data-find-bar] span.font-mono')?.textContent
    }

    function activeRange(): Range | undefined {
      return highlights.get('cc-find-active')?.ranges[0]
    }

    function activeRow(): string | null | undefined {
      return activeRange()?.startContainer.parentElement?.closest('[data-find-row]')?.getAttribute('data-find-row')
    }

    function withOldest(count: number, text: string): TeamWorkbenchMessage[] {
      const history = longHistory(count)
      history[0] = { ...history[0]!, text }
      return history
    }

    it('finds a message that is not mounted yet and mounts the page holding it', async () => {
      render(<>
        <AgentTeamsCommunicationFeed snapshot={snapshot(withOldest(REVEAL_PAGE_SIZE + 10, 'Kickoff checklist for the release'))} fill />
        <FindInPageModal open onClose={() => {}} />
      </>)
      expect(screen.queryByTestId('agent-teams-message-m-0')).toBeNull()

      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'kickoff checklist' } })

      await waitFor(() => expect(findCount()).toBe('1 / 1'))
      expect(screen.getByTestId('agent-teams-message-m-0')).toBeTruthy()
      expect(activeRow()).toBe('m-0')
      expect(activeRange()?.toString().toLowerCase()).toBe('kickoff checklist')
    })

    it('keeps the rest of the page searchable and steps from it into the messages', async () => {
      render(<>
        <AgentTeamsCommunicationFeed snapshot={snapshot(withOldest(REVEAL_PAGE_SIZE + 10, 'Communication plan approved'))} fill />
        <FindInPageModal open onClose={() => {}} />
      </>)

      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'communication' } })

      // The panel title, then the unmounted oldest message.
      await waitFor(() => expect(findCount()).toBe('1 / 2'))
      expect(activeRange()?.startContainer.parentElement?.tagName).toBe('H3')
      expect(screen.queryByTestId('agent-teams-message-m-0')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Next match' }))

      expect(findCount()).toBe('2 / 2')
      expect(activeRow()).toBe('m-0')
      expect(highlights.get('cc-find-results')?.ranges).toHaveLength(2)
    })

    it('reruns an open search when a new message arrives', async () => {
      const history = longHistory(50)
      const view = render(<>
        <AgentTeamsCommunicationFeed snapshot={snapshot(history)} fill />
        <FindInPageModal open onClose={() => {}} />
      </>)
      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'deploy window' } })
      await waitFor(() => expect(findCount()).toBe('0'))

      view.rerender(<>
        <AgentTeamsCommunicationFeed
          snapshot={snapshot([
            ...history,
            message({ id: 'late', text: 'Deploy window moved to Friday', timestamp: '2026-08-08T09:00:00.000Z' }),
          ])}
          fill
        />
        <FindInPageModal open onClose={() => {}} />
      </>)

      await waitFor(() => expect(findCount()).toBe('1 / 1'))
      expect(activeRow()).toBe('late')
    })

    it('hands find back to the page once the feed closes', () => {
      const view = render(<AgentTeamsCommunicationFeed snapshot={snapshot(longHistory(5))} fill />)
      expect(getConversationFindController()).not.toBeNull()

      view.unmount()
      expect(getConversationFindController()).toBeNull()
    })
  })
})
