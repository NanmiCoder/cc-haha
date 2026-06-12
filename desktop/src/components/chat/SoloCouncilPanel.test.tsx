import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  SoloCouncilPanel,
  buildSoloCouncilRows,
  getSoloCouncilRole,
  parseSoloCouncilVerdict,
} from './SoloCouncilPanel'
import { useChatStore } from '../../stores/chatStore'
import type { AgentTaskNotification, BackgroundAgentTask } from '../../types/chat'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => {
    const translations: Record<string, string> = {
      'soloCouncil.title': 'Solo Council',
      'soloCouncil.subtitle': 'Planner, Reviewer, and Critic are debating the plan before implementation.',
      'soloCouncil.role.planner': 'Planner',
      'soloCouncil.role.reviewer': 'Reviewer',
      'soloCouncil.role.critic': 'Critic',
      'soloCouncil.status.running': 'Running',
      'soloCouncil.status.completed': 'Done',
      'soloCouncil.status.failed': 'Failed',
      'soloCouncil.status.stopped': 'Stopped',
      'soloCouncil.verdict.planReady': 'Plan ready',
      'soloCouncil.verdict.approve': 'Approve',
      'soloCouncil.verdict.changesNeeded': 'Changes needed',
      'soloCouncil.verdict.pending': 'Pending',
      'soloCouncil.debateActive': 'Debate active',
    }
    return translations[key] ?? key
  },
}))

const baseTask = (overrides: Partial<BackgroundAgentTask>): BackgroundAgentTask => ({
  taskId: overrides.taskId ?? 'task-1',
  toolUseId: overrides.toolUseId ?? 'tool-1',
  status: overrides.status ?? 'running',
  description: overrides.description,
  summary: overrides.summary,
  usage: overrides.usage,
  startedAt: overrides.startedAt ?? 1,
  updatedAt: overrides.updatedAt ?? 1,
})

const baseNotification = (overrides: Partial<AgentTaskNotification>): AgentTaskNotification => ({
  taskId: overrides.taskId ?? 'task-1',
  toolUseId: overrides.toolUseId ?? 'tool-1',
  status: overrides.status ?? 'completed',
  summary: overrides.summary,
  result: overrides.result,
  usage: overrides.usage,
})

afterEach(() => {
  cleanup()
  useChatStore.setState({ sessions: {} })
})

describe('SoloCouncilPanel helpers', () => {
  it('detects council roles by exact description prefix', () => {
    expect(getSoloCouncilRole('[Solo Council: Planner] propose')).toBe('planner')
    expect(getSoloCouncilRole('[Solo Council: Reviewer] audit')).toBe('reviewer')
    expect(getSoloCouncilRole('[Solo Council: Critic] challenge')).toBe('critic')
    expect(getSoloCouncilRole('ordinary agent task')).toBeNull()
    expect(getSoloCouncilRole('noise [Solo Council: Planner] embedded')).toBeNull()
  })

  it('parses reviewer and critic verdicts from results', () => {
    const task = baseTask({ status: 'completed' })
    expect(parseSoloCouncilVerdict('reviewer', task, baseNotification({ result: 'PLAN_REVIEWER: APPROVE' }))).toBe('approve')
    expect(parseSoloCouncilVerdict('critic', task, baseNotification({ result: 'PLAN_REVIEW: CHANGES_NEEDED' }))).toBe('changes-needed')
    expect(parseSoloCouncilVerdict('planner', task)).toBe('plan-ready')
  })

  it('keeps only the latest task for each council role', () => {
    const rows = buildSoloCouncilRows({
      oldPlanner: baseTask({
        taskId: 'oldPlanner',
        toolUseId: 'oldTool',
        description: '[Solo Council: Planner] old',
        summary: 'old plan',
        updatedAt: 1,
      }),
      newPlanner: baseTask({
        taskId: 'newPlanner',
        toolUseId: 'newTool',
        description: '[Solo Council: Planner] new',
        summary: 'new plan',
        updatedAt: 2,
      }),
    }, {})

    expect(rows).toHaveLength(1)
    expect(rows[0]?.task.taskId).toBe('newPlanner')
    expect(rows[0]?.text).toBe('new plan')
  })
})

describe('SoloCouncilPanel', () => {
  it('renders nothing when there are no council tasks', () => {
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          backgroundAgentTasks: {
            other: baseTask({ description: 'ordinary agent task' }),
          },
        },
      },
    })

    const { container } = render(<SoloCouncilPanel sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders Planner, Reviewer, and Critic cards from council tasks', () => {
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          backgroundAgentTasks: {
            planner: baseTask({
              taskId: 'planner',
              toolUseId: 'plannerTool',
              status: 'completed',
              description: '[Solo Council: Planner] propose',
              summary: 'Plan ready',
              updatedAt: 1,
            }),
            reviewer: baseTask({
              taskId: 'reviewer',
              toolUseId: 'reviewerTool',
              status: 'running',
              description: '[Solo Council: Reviewer] audit',
              summary: 'Reviewing',
              updatedAt: 2,
            }),
            critic: baseTask({
              taskId: 'critic',
              toolUseId: 'criticTool',
              status: 'completed',
              description: '[Solo Council: Critic] challenge',
              summary: 'Critiqued',
              updatedAt: 3,
            }),
          },
          agentTaskNotifications: {
            criticTool: baseNotification({
              taskId: 'critic',
              toolUseId: 'criticTool',
              result: 'Found scope risk. PLAN_REVIEW: CHANGES_NEEDED',
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-panel')).toBeInTheDocument()
    expect(screen.getByTestId('solo-council-card-planner')).toHaveTextContent('Planner')
    expect(screen.getByTestId('solo-council-card-reviewer')).toHaveTextContent('Running')
    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('Changes needed')
    expect(screen.getByText('Debate active')).toBeInTheDocument()
  })
})
