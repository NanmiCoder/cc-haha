import { useEffect, useState } from 'react'

import { AgentTeamsWorkbench } from '@/components/agentTeams/AgentTeamsWorkbench'
import { SessionChatHeader, SessionChatSurface } from '@/components/chat/SessionChatSurface'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dropdown } from '@/components/ui/Dropdown'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton, type IconButtonSize, type IconButtonTone } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { Modal } from '@/components/ui/Modal'
import { Progress } from '@/components/ui/Progress'
import { SearchField } from '@/components/ui/SearchField'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SelectField } from '@/components/ui/SelectField'
import { SkeletonCards, SkeletonRows } from '@/components/ui/Skeleton'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { TextArea } from '@/components/ui/TextArea'
import { Tooltip } from '@/components/ui/Tooltip'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { useTeamStore } from '@/stores/teamStore'
import { THEME_MODES } from '@/types/settings'
import type {
  AgentColor,
  TeamDetail,
  TeamWorkbenchMessage,
  TeamWorkbenchSnapshot,
  TeamWorkbenchTask,
} from '@/types/team'

/**
 * A dev-only page rendering every `components/ui` primitive under each theme.
 *
 * Unit tests assert structure and ARIA; they cannot tell whether a token
 * resolves to a readable color, whether an overlay lands above the thing it is
 * supposed to cover, or whether an entrance animation actually plays. This page
 * is where those get checked by eye, and it takes no backend to open.
 *
 * Reachable at `/gallery.html` under `bun run dev` only — it is not referenced
 * from the app and never enters the production bundle.
 */

/** Sourced from the type rather than restated, so a new palette shows up here. */
const THEMES = THEME_MODES
const TONES: Tone[] = ['neutral', 'brand', 'success', 'warning', 'danger', 'info']
const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'tonal', 'tonal-outline', 'ghost', 'danger', 'danger-outline', 'link', 'inverse']
const SIZES: ButtonSize[] = ['xs', 'sm', 'base', 'md', 'lg']
const ICON_SIZES: IconButtonSize[] = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl']
const ICON_TONES: IconButtonTone[] = ['default', 'secondary', 'muted', 'brand', 'danger']
const AGENT_TEAMS_GALLERY_SESSION_ID = 'gallery-agent-teams-lead'

type GalleryTaskSpec = {
  id: string
  owner: string
  blockedBy: string[]
  subject: string
  description: string
}

const AGENT_TEAMS_GALLERY_TASKS: GalleryTaskSpec[] = [
  { id: '1', owner: 'backend-dev', blockedBy: [], subject: '初始化 FastAPI 骨架与依赖', description: 'uvicorn 起在 8000，CORS 已开' },
  { id: '2', owner: 'frontend-dev', blockedBy: [], subject: 'Vite + React + Tailwind 脚手架', description: 'dev server 1420' },
  { id: '3', owner: 'code-reviewer', blockedBy: [], subject: '拆解需求并冻结 API 契约', description: '契约写入 docs/api.md' },
  { id: '4', owner: 'backend-dev', blockedBy: ['1', '3'], subject: 'models.py 与 schemas.py', description: 'Todo / Tag 两张表' },
  { id: '5', owner: 'frontend-dev', blockedBy: ['2'], subject: 'TaskCard 与 FilterBar 组件', description: '纯展示层，不接口' },
  { id: '6', owner: 'test-runner', blockedBy: ['3'], subject: '测试计划与用例清单', description: '共 24 条用例' },
  { id: '7', owner: 'backend-dev', blockedBy: ['4'], subject: 'routes.py 全部 API 端点', description: '/todos /tags /stats' },
  { id: '8', owner: 'frontend-dev', blockedBy: ['3', '5'], subject: 'useTodos / useTags hooks', description: '按契约先行打桩' },
  { id: '9', owner: 'ui-reviewer', blockedBy: ['5'], subject: '建立 UI 走查基线', description: '对比度 / 焦点 / 命中区' },
  { id: '10', owner: 'frontend-dev', blockedBy: ['7', '8'], subject: '列表页组装与状态接线', description: '真实接口替换打桩' },
  { id: '11', owner: 'code-reviewer', blockedBy: ['7'], subject: '后端代码审查', description: '发现 7 项问题' },
  { id: '12', owner: 'test-runner', blockedBy: ['6', '7'], subject: '接口自测 curl 全通', description: '24/24 通过' },
  { id: '13', owner: 'backend-dev', blockedBy: ['11'], subject: '修复审查发现的 7 项问题', description: 'race condition 已修' },
  { id: '14', owner: 'ui-reviewer', blockedBy: ['9', '10'], subject: '产出 UI_REVIEW.md 报告', description: '5 严重 + 7 重点' },
  { id: '15', owner: 'test-runner', blockedBy: ['10', '12'], subject: '端到端回归', description: '零错误' },
  { id: '16', owner: 'frontend-dev', blockedBy: ['14'], subject: '修复 UI 审查问题', description: 'aria / debounce / 焦点' },
]

const AGENT_TEAMS_GALLERY_COLORS: Record<string, AgentColor> = {
  'team-lead': 'purple',
  'backend-dev': 'blue',
  'frontend-dev': 'yellow',
  'ui-reviewer': 'cyan',
  'code-reviewer': 'red',
  'test-runner': 'green',
}

function galleryTeam(
  createdAt: string,
  activeTaskByMember: Record<string, string | undefined>,
): TeamDetail {
  const member = (
    agentId: string,
    role: string,
    status: TeamDetail['members'][number]['status'],
    model?: string,
  ): TeamDetail['members'][number] => ({
    agentId,
    name: agentId,
    role,
    status,
    activity: activeTaskByMember[agentId] ? 'active' : 'idle',
    currentTask: activeTaskByMember[agentId],
    color: AGENT_TEAMS_GALLERY_COLORS[agentId],
    sessionId: `gallery-${agentId}`,
    ...(model ? { model } : {}),
  })

  return {
    name: 'todo-app-v2',
    incarnationId: 'gallery-agent-teams-v2',
    leadAgentId: 'team-lead',
    leadSessionId: AGENT_TEAMS_GALLERY_SESSION_ID,
    createdAt,
    members: [
      member('team-lead', '队长', 'running', 'claude-opus-4-8'),
      member('backend-dev', '后端实现', 'running', 'claude-sonnet-5'),
      member('frontend-dev', '前端实现', 'running', 'claude-sonnet-5'),
      member('ui-reviewer', 'UI 走查', 'running', 'claude-haiku-4-5'),
      member('code-reviewer', '代码审查', 'running', 'qwen3.7-plus[1m]'),
      member('test-runner', '测试验证', 'running'),
    ],
  }
}

function galleryTasks(
  completedIds: string[],
  runningProgress: Record<string, Record<string, number> | undefined>,
): TeamWorkbenchTask[] {
  const completed = new Set(completedIds)
  const running = new Set(Object.keys(runningProgress))
  return AGENT_TEAMS_GALLERY_TASKS.map((spec) => ({
    ...spec,
    activeForm: running.has(spec.id) ? `正在执行：${spec.subject}` : undefined,
    status: completed.has(spec.id)
      ? 'completed'
      : running.has(spec.id)
        ? 'in_progress'
        : 'pending',
    blocks: AGENT_TEAMS_GALLERY_TASKS
      .filter((candidate) => candidate.blockedBy.includes(spec.id))
      .map((candidate) => candidate.id),
    metadata: runningProgress[spec.id],
    taskListId: 'gallery-todo-app',
  }))
}

function createAgentTeamsGallerySnapshots(now = Date.now()): TeamWorkbenchSnapshot[] {
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString()
  const assignment = (
    id: string,
    taskId: string,
    recipient: string,
    offsetMs: number,
  ): TeamWorkbenchMessage => {
    const task = AGENT_TEAMS_GALLERY_TASKS.find((candidate) => candidate.id === taskId)!
    return {
      id,
      from: 'team-lead',
      to: recipient,
      recipients: [recipient],
      kind: 'system',
      text: JSON.stringify({ type: 'task_assignment', taskId, subject: task.subject }),
      timestamp: at(offsetMs),
      taskId,
      protocolType: 'task_assignment',
    }
  }
  const initialAssignments = [
    assignment('gallery-assign-1', '1', 'backend-dev', -292_000),
    assignment('gallery-assign-2', '2', 'frontend-dev', -290_000),
    assignment('gallery-assign-3', '3', 'code-reviewer', -288_000),
  ]
  const qaAssignment = assignment('gallery-assign-6', '6', 'test-runner', -226_000)
  const uiAssignment = assignment('gallery-assign-9', '9', 'ui-reviewer', -102_000)
  const systemMessage: TeamWorkbenchMessage = {
    id: 'gallery-system-idle',
    from: 'ui-reviewer',
    to: 'team-lead',
    recipients: ['team-lead'],
    kind: 'system',
    text: JSON.stringify({ type: 'idle_notification', message: '等待 TaskCard 交付后开始 UI 走查' }),
    timestamp: at(-228_000),
    protocolType: 'idle_notification',
  }
  const contractReport: TeamWorkbenchMessage = {
    id: 'gallery-report-3',
    from: 'code-reviewer',
    to: 'team-lead',
    recipients: ['team-lead'],
    kind: 'direct',
    text: '**#3 API 契约** 已冻结，字段命名统一写入 `docs/api.md`。',
    timestamp: at(-224_000),
    taskId: '3',
  }
  const contractPeer: TeamWorkbenchMessage = {
    id: 'gallery-peer-3-4',
    from: 'code-reviewer',
    to: 'backend-dev',
    recipients: ['backend-dev'],
    kind: 'direct',
    text: '#3 已交付：`todo.tags` 使用 `string[]`，时间字段统一为 ISO 8601。',
    timestamp: at(-220_000),
    taskId: '4',
  }
  const reportMessage: TeamWorkbenchMessage = {
    id: 'gallery-report-5',
    from: 'frontend-dev',
    to: 'team-lead',
    recipients: ['team-lead'],
    kind: 'direct',
    text: '**#5 TaskCard 与 FilterBar 组件** 已完成。\n\n- 纯展示层已交付\n- 焦点态和空态已补齐',
    timestamp: at(-110_000),
    taskId: '5',
  }
  const peerMessage: TeamWorkbenchMessage = {
    id: 'gallery-peer-5-9',
    from: 'frontend-dev',
    to: 'ui-reviewer',
    recipients: ['ui-reviewer'],
    kind: 'direct',
    text: '**#5 已交付 → 你的 #9 解锁了。**\n\n组件在 `src/components`，请按这版布局建立走查基线。',
    timestamp: at(-106_000),
    taskId: '9',
  }
  const claimMessage: TeamWorkbenchMessage = {
    id: 'gallery-claim-10',
    from: 'frontend-dev',
    to: 'frontend-dev',
    recipients: ['frontend-dev'],
    kind: 'system',
    text: JSON.stringify({ type: 'task_assignment', taskId: '10', subject: '列表页组装与状态接线' }),
    timestamp: at(-52_000),
    taskId: '10',
    protocolType: 'task_assignment',
  }
  const latestReport: TeamWorkbenchMessage = {
    id: 'gallery-report-9',
    from: 'ui-reviewer',
    to: 'team-lead',
    recipients: ['team-lead'],
    kind: 'direct',
    text: '**#9 建立 UI 走查基线** 已完成。\n\n- 对比度、焦点环、命中区均已记录\n- 报告位于 `UI_BASELINE.md`',
    timestamp: at(-46_000),
    taskId: '9',
  }
  const createdAt = at(-300_000)

  return [
    {
      version: 'gallery-v1',
      generatedAt: at(-260_000),
      taskListRevision: 1,
      team: galleryTeam(createdAt, {
        'backend-dev': '1',
        'frontend-dev': '2',
        'code-reviewer': '3',
      }),
      tasks: galleryTasks([], {
        '1': { progressPercent: 72 },
        '2': { completedSteps: 3, totalSteps: 5 },
        '3': undefined,
      }),
      messages: initialAssignments,
    },
    {
      version: 'gallery-v2',
      generatedAt: at(-132_000),
      taskListRevision: 2,
      team: galleryTeam(createdAt, {
        'backend-dev': '4',
        'frontend-dev': '5',
        'test-runner': '6',
      }),
      tasks: galleryTasks(['1', '2', '3'], {
        '4': { progress: 0.64 },
        '5': { progressPercent: 88 },
        '6': undefined,
      }),
      messages: [
        ...initialAssignments,
        systemMessage,
        qaAssignment,
        contractReport,
        contractPeer,
      ],
    },
    {
      version: 'gallery-v3',
      generatedAt: at(-40_000),
      taskListRevision: 3,
      team: galleryTeam(createdAt, {
        'frontend-dev': '10',
        'code-reviewer': '11',
        'test-runner': '12',
      }),
      tasks: galleryTasks(['1', '2', '3', '4', '5', '6', '7', '8', '9'], {
        '10': { completedSteps: 3, totalSteps: 5 },
        '11': undefined,
        '12': { progressPercent: 68 },
      }),
      messages: [
        ...initialAssignments,
        systemMessage,
        qaAssignment,
        contractReport,
        contractPeer,
        reportMessage,
        peerMessage,
        uiAssignment,
        claimMessage,
        latestReport,
      ],
    },
  ]
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-[var(--color-border)] py-6">
      <div>
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{note}</p>}
      </div>
      {children}
    </section>
  )
}

function SessionSurfacePreview({ kind }: { kind: 'main' | 'agent' }) {
  const isAgent = kind === 'agent'

  return (
    <div
      data-testid={`gallery-${kind}-session`}
      className="flex h-[390px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
    >
      <SessionChatSurface
        surfaceKind={kind}
        agentRunKind={isAgent ? 'subagent' : undefined}
        isMobileLayout={false}
        activityRailOpen
        activityRail={(
          <aside className="absolute inset-y-0 right-0 z-10 w-[352px] border-l border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Activity</span>
              <Badge tone="success">2 / 2</Badge>
            </div>
            <div className="mt-4 space-y-3 text-xs text-[var(--color-text-secondary)]">
              <div className="rounded-[var(--radius-md)] bg-[var(--color-surface)] p-3">Inspect session UI</div>
              <div className="rounded-[var(--radius-md)] bg-[var(--color-surface)] p-3">Verify shared layout</div>
            </div>
          </aside>
        )}
      >
        <SessionChatHeader
          title={isAgent ? 'teams-analyst' : 'Main session'}
          leading={isAgent ? <Button variant="ghost" size="xs">← Back</Button> : undefined}
          titleAddon={<Badge tone={isAgent ? 'warning' : 'success'}>{isAgent ? 'running' : 'ready'}</Badge>}
          metadata={[
            { key: 'project', content: <span>claude-code-haha</span> },
            { key: 'scope', content: <span>{isAgent ? 'commit-analysis / teams-analyst' : 'main'}</span> },
          ]}
          actions={<IconButton icon="refresh" label={`Refresh ${kind} session`} size="sm" />}
        />
        <div className="min-h-0 flex-1 overflow-hidden px-8 py-6">
          <div className="mx-auto max-w-[900px] space-y-4">
            <div className="max-w-[72%] rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-4 text-sm">
              {isAgent ? 'Review the assigned module and report findings.' : 'Coordinate the task and keep Agent Teams in its workbench.'}
            </div>
            <div className="ml-auto max-w-[72%] rounded-[var(--radius-lg)] bg-[var(--color-primary-container)] p-4 text-sm text-[var(--color-on-primary-container)]">
              {isAgent ? 'I am using the same session surface as the main chat.' : 'The main session keeps only its own activity.'}
            </div>
          </div>
        </div>
        <div className="px-8 pb-5">
          <div className="mx-auto max-w-[900px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-tertiary)] shadow-[var(--shadow-composer)]">
            Message this {isAgent ? 'Agent' : 'session'}…
          </div>
        </div>
      </SessionChatSurface>
    </div>
  )
}

export function ComponentGallery() {
  const [theme, setTheme] = useState<(typeof THEMES)[number]>('white')
  const [agentTeamsSnapshots] = useState(createAgentTeamsGallerySnapshots)
  const [modalOpen, setModalOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [segment, setSegment] = useState('all')
  const [checked, setChecked] = useState(true)
  const [switched, setSwitched] = useState(true)
  const [model, setModel] = useState('sonnet')
  const [transport, setTransport] = useState('stdio')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
  }, [theme])

  useEffect(() => {
    const initialState = useTeamStore.getState()
    const previousTimeline = initialState.workbenchesBySession[AGENT_TEAMS_GALLERY_SESSION_ID]
    const previousHistoryIndex = initialState
      .workbenchHistoryIndexBySession[AGENT_TEAMS_GALLERY_SESSION_ID]

    useTeamStore.setState((state) => ({
      workbenchesBySession: {
        ...state.workbenchesBySession,
        [AGENT_TEAMS_GALLERY_SESSION_ID]: {
          teamName: agentTeamsSnapshots.at(-1)!.team.name,
          snapshots: agentTeamsSnapshots,
          loading: false,
          error: null,
        },
      },
      workbenchHistoryIndexBySession: {
        ...state.workbenchHistoryIndexBySession,
        [AGENT_TEAMS_GALLERY_SESSION_ID]: null,
      },
    }))

    return () => {
      useTeamStore.setState((state) => {
        const workbenchesBySession = { ...state.workbenchesBySession }
        const workbenchHistoryIndexBySession = { ...state.workbenchHistoryIndexBySession }
        if (previousTimeline === undefined) delete workbenchesBySession[AGENT_TEAMS_GALLERY_SESSION_ID]
        else workbenchesBySession[AGENT_TEAMS_GALLERY_SESSION_ID] = previousTimeline
        if (previousHistoryIndex === undefined) {
          delete workbenchHistoryIndexBySession[AGENT_TEAMS_GALLERY_SESSION_ID]
        } else {
          workbenchHistoryIndexBySession[AGENT_TEAMS_GALLERY_SESSION_ID] = previousHistoryIndex
        }
        return { workbenchesBySession, workbenchHistoryIndexBySession }
      })
    }
  }, [agentTeamsSnapshots])

  return (
    <div className="min-h-screen bg-[var(--color-background)] px-8 py-6 text-[var(--color-text-primary)]">
      <header className="sticky top-0 z-[var(--z-sticky)] -mx-8 mb-2 border-b border-[var(--color-border)] bg-[var(--color-background)] px-8 py-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg font-bold">components/ui gallery</h1>
          <SegmentedControl
            items={THEMES.map((value) => ({ value, label: value }))}
            value={theme}
            onChange={setTheme}
            label="Theme"
            data-testid="theme-switch"
          />
        </div>
      </header>

      <Section
        title="AgentTeamsWorkbench"
        note="Offline v2 fixture: 5 workers, 6 dependency lanes, live/replay controls, 56px communication rail, 400px feed/inspector, and all four message categories."
      >
        <div
          data-testid="gallery-agent-teams-workbench"
          className="h-[820px] min-h-[820px] min-w-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
        >
          <AgentTeamsWorkbench sessionId={AGENT_TEAMS_GALLERY_SESSION_ID} />
        </div>
      </Section>

      <Section
        title="SessionChatSurface"
        note="Main and child Agents share this exact header, centered transcript measure, Activity rail spacing, and composer frame."
      >
        <div className="grid gap-4">
          <SessionSurfacePreview kind="main" />
          <SessionSurfacePreview kind="agent" />
        </div>
      </Section>

      <Section title="Button" note="Every variant x size. Tab through to check the focus ring.">
        <div className="flex flex-col gap-2">
          {VARIANTS.map((variant) => (
            <div key={variant} className="flex flex-wrap items-center gap-2">
              <code className="w-32 shrink-0 text-xs text-[var(--color-text-tertiary)]">{variant}</code>
              {SIZES.map((size) => (
                <Button key={size} variant={variant} size={size}>{size}</Button>
              ))}
              <Button variant={variant} loading>loading</Button>
              <Button variant={variant} disabled>disabled</Button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="IconButton" note="Icon-only controls; each has a required accessible name.">
        <div className="flex flex-col gap-2">
          {ICON_TONES.map((tone) => (
            <div key={tone} className="flex flex-wrap items-center gap-2">
              <code className="w-32 shrink-0 text-xs text-[var(--color-text-tertiary)]">{tone}</code>
              {ICON_SIZES.map((size) => (
                <IconButton key={size} icon="settings" label={`Settings ${size}`} tone={tone} size={size} />
              ))}
              <IconButton icon="close" label="Filled" tone={tone} filled />
              <IconButton icon="tune" label="Bordered" tone={tone} bordered />
              <IconButton icon="refresh" label="Circle" tone={tone} shape="circle" />
              <IconButton icon="sync" label="Loading" tone={tone} loading />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-2">
            <code className="w-32 shrink-0 text-xs text-[var(--color-text-tertiary)]">states</code>
            <IconButton icon="delete" label="Danger on hover only" tone="muted" hoverTone="danger" />
            <IconButton icon="filter_alt" label="Pressed off" pressed={false} />
            <IconButton icon="filter_alt" label="Pressed on" pressed />
            <IconButton icon="close" label="Solid danger" tone="danger" solid size="2xs" shape="circle" />
            <IconButton icon="check" label="Solid brand" tone="brand" solid />
            <IconButton icon="more_horiz" label="Solid default" solid />
          </div>
          {/* `solid` has to stay legible over arbitrary content — this strip
              stands in for a user-supplied image behind a remove badge. */}
          <div
            className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] p-2"
            style={{ backgroundImage: 'linear-gradient(45deg, #8b5cf6, #ec4899, #f59e0b)' }}
          >
            <code className="w-32 shrink-0 text-xs text-white">solid over image</code>
            <IconButton icon="close" label="Remove" tone="danger" solid size="2xs" shape="circle" />
            <IconButton icon="close" label="Remove tinted" tone="danger" filled size="2xs" shape="circle" />
          </div>
          <div
            className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-sidebar)] p-2"
          >
            <code className="w-32 shrink-0 text-xs text-[var(--color-text-tertiary)]">on sidebar</code>
            {/* The sidebar hover token differs from surface-hover in all three
                themes; hover these against the sidebar fill to check it. */}
            {ICON_TONES.map((tone) => (
              <IconButton key={tone} icon="folder" label={`Sidebar ${tone}`} tone={tone} surface="sidebar" />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Badge / StatusDot" note="Contrast check: the label must stay readable on its own fill in all three themes.">
        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((tone) => <Badge key={tone} tone={tone}>{tone}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((tone) => <Badge key={tone} tone={tone} variant="outline">{tone}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((tone) => <Badge key={tone} tone={tone} size="md" bordered>{tone}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {TONES.map((tone) => (
            <span key={tone} className="flex items-center gap-1.5 text-xs">
              <StatusDot tone={tone} pulse />
              {tone}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Form controls">
        <div className="grid max-w-3xl grid-cols-2 gap-4">
          <Input label="Server name" placeholder="my-server" />
          <Input label="Port" error="Must be a number" defaultValue="abc" />
          <Input label="Disabled" disabled defaultValue="locked" />
          <Input label="With hint" hint="Between 1024 and 65535" />
          <SelectField
            label="Transport"
            options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }]}
            value={transport}
            onChange={setTransport}
          />
          <SearchField label="Search sessions" clearLabel="Clear search" value={search} onChange={setSearch} />
          <TextArea label="System prompt" hint="Markdown is supported" />
          <TextArea label="Broken" error="Cannot be empty" />
        </div>
        <div className="flex flex-wrap items-center gap-8">
          <Checkbox label="Include archived" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <Checkbox label="Indeterminate" indeterminate />
          <Checkbox label="Disabled" disabled />
          <div className="w-64"><Switch label="Auto update" description="Checks on launch." checked={switched} onChange={setSwitched} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <SegmentedControl
            items={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'done', label: 'Done' }]}
            value={segment}
            onChange={setSegment}
            label="Filter (solid)"
          />
          <SegmentedControl
            items={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }]}
            value={segment}
            onChange={setSegment}
            label="Filter (raised)"
            appearance="raised"
          />
          <SegmentedControl
            items={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }]}
            value={segment}
            onChange={setSegment}
            label="Filter (underline)"
            appearance="underline"
          />
        </div>
      </Section>

      <Section title="States">
        <div className="grid grid-cols-3 gap-4">
          <EmptyState title="No sessions yet" description="Start one from the sidebar." action={{ label: 'New session', onClick: () => {} }} />
          <ErrorState title="Could not load plugins" detail="HTTP 502 from the gateway." onRetry={() => {}} retryLabel="Try again" />
          <ErrorState title="Fatal" detail="Strong tone." tone="strong" />
          <LoadingState label="Loading sessions" variant="dashed" size="lg" />
          <div className="flex flex-col gap-3">
            <LoadingState label="Loading" variant="inline" />
            <Spinner size={24} tone="brand" />
            <Progress label="Uploading" value={35} />
            <Progress label="Complete" value={100} tone="auto" />
            <Progress label="Working" indeterminate />
          </div>
          <SkeletonRows label="Loading rows" count={2} divided />
        </div>
        <SkeletonCards label="Loading cards" count={3} withAvatar className="grid-cols-3" />
      </Section>

      <Section title="Card">
        <div className="flex flex-wrap gap-3">
          <Card>base</Card>
          <Card surface="low">low</Card>
          <Card surface="lowest">lowest</Card>
          <Card surface="high">high</Card>
          <Card border="dashed">dashed</Card>
          <Card interactive>interactive (hover / focus)</Card>
          <Card shadow="card">shadow=card</Card>
          <Card shadow="composer">shadow=composer</Card>
          <Card interactive lift>lift (hover raises 2px)</Card>
        </div>
      </Section>

      <Section title="BrandSeal" note="The cc-haha mark, a vector rebuild of the app icon. It sheds parts as it shrinks — sparkles only at xl, cursor drops at sm — so check each size against its neighbours.">
        <div className="flex flex-wrap items-end gap-4">
          <BrandSeal size="sm" />
          <BrandSeal size="md" />
          <BrandSeal size="lg" />
          <BrandSeal size="xl" />
        </div>
      </Section>

      <Section
        title="Overlays"
        note="Layering check: open the sheet, then raise a toast — the toast must stay visible. Open the modal, then the dropdown inside it."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setModalOpen(true)}>Open Modal</Button>
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>Open BottomSheet</Button>
          <Tooltip content="This is a tooltip. It should flip near the viewport edge.">
            <Button variant="ghost">Hover / focus me</Button>
          </Tooltip>
          <Tooltip appearance="surface" content={<span className="flex items-center gap-3">Toggle bottom panel <kbd>⌘J</kbd></span>}>
            <Button variant="ghost">Workspace tooltip</Button>
          </Tooltip>
          <Dropdown
            items={[
              { value: 'sonnet', label: 'Sonnet', description: 'Balanced' },
              { value: 'opus', label: 'Opus', description: 'Most capable' },
              { value: 'haiku', label: 'Haiku', description: 'Fastest', disabled: true },
            ]}
            value={model}
            onChange={setModel}
            label="Model"
            trigger={<Button variant="secondary">Model: {model}</Button>}
          />
        </div>

        <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Dialog with a dropdown inside">
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            The dropdown below must render above this dialog. Escape should close only the dropdown first.
          </p>
          <Dropdown
            items={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }]}
            value={transport}
            onChange={setTransport}
            label="Transport"
            trigger={<Button variant="secondary">Transport: {transport}</Button>}
          />
        </Modal>

        <MobileBottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Bottom sheet">
          <p className="text-sm text-[var(--color-text-secondary)]">
            A toast raised while this is open must appear above it.
          </p>
        </MobileBottomSheet>
      </Section>

      <Section title="Overlay entrance animations" note="These classes replaced tailwindcss-animate; a static render means they are dead again.">
        <div className="flex flex-wrap gap-3">
          {['animate-overlay-in', 'animate-overlay-in-top', 'animate-overlay-in-bottom', 'animate-overlay-in-right'].map((cls) => (
            <div
              key={cls}
              className={`${cls} rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2 text-xs`}
            >
              {cls}
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}
