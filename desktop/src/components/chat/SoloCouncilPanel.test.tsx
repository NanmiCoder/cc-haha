import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  SoloCouncilPanel,
  buildSoloCouncilRows,
  getSoloCouncilRole,
  parseSoloCouncilVerdict,
  parseSoloCouncilReviewArtifact,
  extractSoloCouncilSynthesis,
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
      'soloCouncil.status.standby': 'Standby',
      'soloCouncil.verdict.planReady': 'Plan ready',
      'soloCouncil.verdict.approve': 'Approve',
      'soloCouncil.verdict.changesNeeded': 'Changes needed',
      'soloCouncil.verdict.pending': 'Pending',
      'soloCouncil.debateActive': 'Debate active',
      'soloCouncil.panel.expand': 'Expand',
      'soloCouncil.panel.collapse': 'Collapse',
      'soloCouncil.output.showFull': 'Show full output',
      'soloCouncil.output.collapse': 'Collapse',
      'soloCouncil.output.toggleLabel': 'Toggle full Solo Council output',
      'soloCouncil.output.standby.planner': 'Standing by, ready to shape the implementation plan.',
      'soloCouncil.output.standby.reviewer': 'Standing by, waiting to review the draft plan.',
      'soloCouncil.output.standby.critic': 'Standing by, waiting to check risks and counterexamples.',
      'soloCouncil.flow.planner': 'Planner',
      'soloCouncil.flow.reviewer': 'Reviewer',
      'soloCouncil.flow.critic': 'Critic',
      'soloCouncil.flow.synthesis': 'Final plan',
      'soloCouncil.synthesis.title': 'Final execution plan',
      'soloCouncil.synthesis.subtitle': 'Synthesized after Planner, Reviewer, and Critic finish.',
      'soloCouncil.synthesis.showFull': 'Show full plan',
      'soloCouncil.synthesis.collapse': 'Collapse plan',
      'soloCouncil.synthesis.toggleLabel': 'Toggle full final plan',
      'soloCouncil.synthesis.approvalHint': 'Review this plan, then approve before implementation starts.',
      'soloCouncil.objections.title': 'Blocking objections',
      'soloCouncil.actions.title': 'Executable actions',
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

  it('prefers structured JSON verdict over conflicting sentinel text', () => {
    const artifact = parseSoloCouncilReviewArtifact(
      'reviewer',
      'SOLO_COUNCIL_REVIEW_JSON: {"role":"reviewer","verdict":"changes_needed","blockingObjections":["Missing tests"],"executableActions":["Add tests"]}\nPLAN_REVIEWER: APPROVE',
    )

    expect(artifact?.verdict).toBe('changes-needed')
    expect(parseSoloCouncilVerdict('reviewer', baseTask({ status: 'completed' }), baseNotification({ result: 'PLAN_REVIEWER: APPROVE' }), artifact)).toBe('changes-needed')
  })

  it('falls back to sentinel text when structured JSON is malformed', () => {
    const result = 'SOLO_COUNCIL_REVIEW_JSON: {not-json}\nPLAN_REVIEW: CHANGES_NEEDED'

    expect(parseSoloCouncilReviewArtifact('critic', result)).toBeNull()
    expect(parseSoloCouncilVerdict('critic', baseTask({ status: 'completed' }), baseNotification({ result }))).toBe('changes-needed')
  })

  it('ignores invalid structured artifact shapes safely', () => {
    expect(parseSoloCouncilReviewArtifact('critic', 'SOLO_COUNCIL_REVIEW_JSON: {"role":"reviewer","verdict":"approve","blockingObjections":[],"executableActions":[]}')).toBeNull()
    expect(parseSoloCouncilReviewArtifact('critic', 'SOLO_COUNCIL_REVIEW_JSON: {"role":"critic","verdict":"maybe","blockingObjections":[],"executableActions":[]}')).toBeNull()
    expect(parseSoloCouncilReviewArtifact('critic', 'SOLO_COUNCIL_REVIEW_JSON: {"role":"critic","verdict":"approve","blockingObjections":[123],"executableActions":[]}')).toBeNull()
    expect(parseSoloCouncilReviewArtifact('critic', `SOLO_COUNCIL_REVIEW_JSON: {"role":"critic","verdict":"approve","blockingObjections":["${'x'.repeat(241)}"],"executableActions":[]}`)).toBeNull()
    expect(parseSoloCouncilReviewArtifact('critic', 'SOLO_COUNCIL_REVIEW_JSON: {"role":"critic","verdict":"approve","blockingObjections":["1","2","3","4","5","6"],"executableActions":[]}')).toBeNull()
  })

  it('extracts synthesis only from the latest assistant text exact marker', () => {
    expect(extractSoloCouncilSynthesis([
      { id: 'm1', type: 'assistant_text', content: 'SOLO_COUNCIL_SYNTHESIS_START\nOld plan\nSOLO_COUNCIL_SYNTHESIS_END', timestamp: 1 },
      { id: 'm2', type: 'user_text', content: 'SOLO_COUNCIL_SYNTHESIS_START\nIgnore me\nSOLO_COUNCIL_SYNTHESIS_END', timestamp: 2 },
      { id: 'm3', type: 'assistant_text', content: 'SOLO_COUNCIL_SYNTHESIS_START\nLatest plan\nSOLO_COUNCIL_SYNTHESIS_END', timestamp: 3 },
    ])).toBe('Latest plan')
    expect(extractSoloCouncilSynthesis([
      { id: 'm1', type: 'assistant_text', content: 'SOLO_COUNCIL_SYNTHESIS_START\nOld plan\nSOLO_COUNCIL_SYNTHESIS_END', timestamp: 1 },
      { id: 'm2', type: 'assistant_text', content: 'Latest assistant text without marker', timestamp: 2 },
    ])).toBeNull()
    expect(extractSoloCouncilSynthesis([
      { id: 'm1', type: 'assistant_text', content: 'Final execution plan\nLoose heading only', timestamp: 1 },
    ])).toBeNull()
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
    }, {}, [], false)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.task?.taskId).toBe('newPlanner')
    expect(rows[0]?.text).toBe('new plan')
  })
})

describe('SoloCouncilPanel', () => {
  it('collapses all-standby council cards by default and expands manually', () => {
    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('solo-council-panel-body')).not.toBeInTheDocument()
    expect(screen.queryByTestId('solo-council-card-planner')).not.toBeInTheDocument()

    const toggle = screen.getByTestId('solo-council-panel-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('Expand')

    fireEvent.click(toggle)

    expect(screen.getByTestId('solo-council-panel-body')).toBeInTheDocument()
    expect(screen.getByTestId('solo-council-card-planner')).toHaveTextContent('Standby')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('Collapse')
  })

  it('supports manually collapsing active council cards', () => {
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
              summary: 'Live plan ready',
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-panel-body')).toBeInTheDocument()
    const toggle = screen.getByTestId('solo-council-panel-toggle')
    fireEvent.click(toggle)

    expect(screen.queryByTestId('solo-council-panel-body')).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders standby role cards when manually expanded and there are no council tasks or messages', () => {
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

    render(<SoloCouncilPanel sessionId="s1" />)
    fireEvent.click(screen.getByTestId('solo-council-panel-toggle'))

    expect(screen.getByTestId('solo-council-panel')).toBeInTheDocument()
    expect(screen.getByTestId('solo-council-card-planner')).toHaveTextContent('Standby')
    expect(screen.getByTestId('solo-council-card-planner')).toHaveTextContent('Standing by, ready to shape the implementation plan.')
    expect(screen.getByTestId('solo-council-card-reviewer')).toHaveTextContent('Standing by, waiting to review the draft plan.')
    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('Standing by, waiting to check risks and counterexamples.')
  })

  it('live background agent tasks override standby rows', () => {
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
              summary: 'Live plan ready',
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-card-planner')).toHaveTextContent('Live plan ready')
    expect(screen.getByTestId('solo-council-card-planner')).not.toHaveTextContent('Standing by')
    expect(screen.getByTestId('solo-council-card-reviewer')).toHaveTextContent('Standby')
    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('Standby')
  })

  it('renders fallback role cards from Solo background task messages', () => {
    const reviewerTask = baseTask({
      taskId: 'reviewer',
      toolUseId: 'reviewerTool',
      status: 'completed',
      description: '[Solo Council: Reviewer] audit',
      summary: 'Fallback review summary',
    })
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          backgroundAgentTasks: {},
          messages: [
            { id: 'm1', type: 'background_task', task: reviewerTask, timestamp: 10 },
          ],
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-card-reviewer')).toHaveTextContent('Fallback review summary')
    expect(screen.getByTestId('solo-council-card-planner')).toHaveTextContent('Standby')
    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('Standby')
  })

  it('joins notification by toolUseId for fallback rows', () => {
    const criticTask = baseTask({
      taskId: 'critic',
      toolUseId: 'criticTool',
      status: 'completed',
      description: '[Solo Council: Critic] challenge',
      summary: 'fallback summary',
    })
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          backgroundAgentTasks: {},
          messages: [
            { id: 'm1', type: 'background_task', task: criticTask, timestamp: 10 },
          ],
          agentTaskNotifications: {
            criticTool: baseNotification({
              taskId: 'critic',
              toolUseId: 'criticTool',
              result: 'Tool result wins. PLAN_REVIEW: CHANGES_NEEDED',
              usage: { totalTokens: 1234, toolUses: 2 },
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('Tool result wins')
    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('Changes needed')
    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('1,234 t')
    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('2 tools')
  })

  it('does not duplicate a role when live task and fallback message both exist', () => {
    const fallbackPlanner = baseTask({
      taskId: 'fallbackPlanner',
      toolUseId: 'fallbackTool',
      status: 'completed',
      description: '[Solo Council: Planner] fallback',
      summary: 'Fallback plan',
    })
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          backgroundAgentTasks: {
            planner: baseTask({
              taskId: 'livePlanner',
              toolUseId: 'liveTool',
              status: 'completed',
              description: '[Solo Council: Planner] live',
              summary: 'Live plan wins',
            }),
          },
          messages: [
            { id: 'm1', type: 'background_task', task: fallbackPlanner, timestamp: 10 },
          ],
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getAllByTestId('solo-council-card-planner')).toHaveLength(1)
    expect(screen.getByTestId('solo-council-card-planner')).toHaveTextContent('Live plan wins')
    expect(screen.queryByText('Fallback plan')).not.toBeInTheDocument()
  })

  it('ignores non-Solo background task messages while standby fills missing roles', () => {
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          backgroundAgentTasks: {},
          messages: [
            {
              id: 'm1',
              type: 'background_task',
              task: baseTask({ description: 'ordinary agent task', summary: 'Should not render' }),
              timestamp: 10,
            },
          ],
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)
    fireEvent.click(screen.getByTestId('solo-council-panel-toggle'))

    expect(screen.queryByText('Should not render')).not.toBeInTheDocument()
    expect(screen.getByTestId('solo-council-card-planner')).toHaveTextContent('Standby')
    expect(screen.getByTestId('solo-council-card-reviewer')).toHaveTextContent('Standby')
    expect(screen.getByTestId('solo-council-card-critic')).toHaveTextContent('Standby')
  })

  it('keeps expanded output when the same task updatedAt changes', () => {
    const longOutput = Array.from({ length: 80 }, (_, index) => `Planner line ${index + 1}`).join('\n')
    const session = useChatStore.getState().getSession('s1')
    useChatStore.setState({
      sessions: {
        s1: {
          ...session,
          backgroundAgentTasks: {
            planner: baseTask({
              taskId: 'planner',
              toolUseId: 'plannerTool',
              status: 'completed',
              description: '[Solo Council: Planner] propose',
              summary: longOutput,
              updatedAt: 1,
            }),
          },
        },
      },
    })

    const { rerender } = render(<SoloCouncilPanel sessionId="s1" />)
    fireEvent.click(screen.getByTestId('solo-council-toggle-planner'))

    act(() => {
      useChatStore.setState({
        sessions: {
          s1: {
            ...session,
            backgroundAgentTasks: {
              planner: baseTask({
                taskId: 'planner',
                toolUseId: 'plannerTool',
                status: 'completed',
                description: '[Solo Council: Planner] propose',
                summary: longOutput,
                updatedAt: 2,
              }),
            },
          },
        },
      })
    })
    rerender(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-output-planner')).not.toHaveClass('line-clamp-3')
    expect(screen.getByTestId('solo-council-toggle-planner')).toHaveAttribute('aria-expanded', 'true')
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

  it('renders short multiline output fully without a toggle or line clamp', () => {
    const shortMultilineOutput = 'Line one\nLine two\nLine three\nLine four'
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
              summary: shortMultilineOutput,
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    const output = screen.getByTestId('solo-council-output-planner')
    expect(output).toHaveTextContent('Line one')
    expect(output).toHaveTextContent('Line two')
    expect(output).toHaveTextContent('Line three')
    expect(output).toHaveTextContent('Line four')
    expect(output).not.toHaveClass('line-clamp-3')
    expect(screen.queryByTestId('solo-council-toggle-planner')).not.toBeInTheDocument()
  })

  it('renders long output collapsed by default and toggles expanded state', () => {
    const longOutput = Array.from({ length: 80 }, (_, index) => `Planner line ${index + 1}`).join('\n')
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
              summary: longOutput,
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    const output = screen.getByTestId('solo-council-output-planner')
    const toggle = screen.getByTestId('solo-council-toggle-planner')

    expect(output).toHaveClass('line-clamp-3')
    expect(toggle).toHaveAttribute('type', 'button')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'solo-council-output-planner')
    expect(toggle).toHaveTextContent('Show full output')

    fireEvent.click(toggle)

    expect(output).not.toHaveClass('line-clamp-3')
    expect(output).toHaveClass('max-h-64', 'overflow-auto')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('Collapse')

    fireEvent.click(toggle)

    expect(output).toHaveClass('line-clamp-3')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('Show full output')
  })

  it('toggles long Planner, Reviewer, and Critic cards independently', () => {
    const longOutput = (role: string) => Array.from({ length: 80 }, (_, index) => `${role} line ${index + 1}`).join('\n')
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
              summary: longOutput('Planner'),
              updatedAt: 1,
            }),
            reviewer: baseTask({
              taskId: 'reviewer',
              toolUseId: 'reviewerTool',
              status: 'completed',
              description: '[Solo Council: Reviewer] audit',
              summary: longOutput('Reviewer'),
              updatedAt: 2,
            }),
            critic: baseTask({
              taskId: 'critic',
              toolUseId: 'criticTool',
              status: 'completed',
              description: '[Solo Council: Critic] challenge',
              summary: longOutput('Critic'),
              updatedAt: 3,
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    fireEvent.click(screen.getByTestId('solo-council-toggle-reviewer'))

    expect(screen.getByTestId('solo-council-output-planner')).toHaveClass('line-clamp-3')
    expect(screen.getByTestId('solo-council-output-reviewer')).not.toHaveClass('line-clamp-3')
    expect(screen.getByTestId('solo-council-output-critic')).toHaveClass('line-clamp-3')
    expect(screen.getByTestId('solo-council-toggle-planner')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('solo-council-toggle-reviewer')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('solo-council-toggle-critic')).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders the four-step causal flow when expanded', () => {
    render(<SoloCouncilPanel sessionId="s1" />)
    fireEvent.click(screen.getByTestId('solo-council-panel-toggle'))

    expect(screen.getByTestId('solo-council-flow')).toBeInTheDocument()
    expect(screen.getByTestId('solo-council-flow-step-planner')).toHaveTextContent('Planner')
    expect(screen.getByTestId('solo-council-flow-step-reviewer')).toHaveTextContent('Reviewer')
    expect(screen.getByTestId('solo-council-flow-step-critic')).toHaveTextContent('Critic')
    expect(screen.getByTestId('solo-council-flow-step-synthesis')).toHaveTextContent('Final plan')
  })

  it('renders final plan card only from exact synthesis markers', () => {
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          messages: [
            { id: 'm1', type: 'assistant_text', content: 'SOLO_COUNCIL_SYNTHESIS_START\nImplement the final plan.\nSOLO_COUNCIL_SYNTHESIS_END', timestamp: 1 },
          ],
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-synthesis')).toHaveTextContent('Final execution plan')
    expect(screen.getByTestId('solo-council-synthesis')).toHaveTextContent('Review this plan, then approve before implementation starts.')
    expect(screen.getByTestId('solo-council-synthesis-output')).toHaveTextContent('Implement the final plan.')
  })

  it('does not render synthesis card for loose final execution plan heading', () => {
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          messages: [
            { id: 'm1', type: 'assistant_text', content: 'Final execution plan\nThis should not be extracted.', timestamp: 1 },
          ],
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.queryByTestId('solo-council-synthesis')).not.toBeInTheDocument()
  })

  it('renders structured objections and executable actions for changes-needed review artifacts', () => {
    useChatStore.setState({
      sessions: {
        s1: {
          ...useChatStore.getState().getSession('s1'),
          backgroundAgentTasks: {
            reviewer: baseTask({
              taskId: 'reviewer',
              toolUseId: 'reviewerTool',
              status: 'completed',
              description: '[Solo Council: Reviewer] audit',
            }),
          },
          agentTaskNotifications: {
            reviewerTool: baseNotification({
              taskId: 'reviewer',
              toolUseId: 'reviewerTool',
              result: 'SOLO_COUNCIL_REVIEW_JSON: {"role":"reviewer","verdict":"changes_needed","blockingObjections":["Need bounded marker"],"executableActions":["Add parser test"]}\nPLAN_REVIEWER: APPROVE',
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-card-reviewer')).toHaveTextContent('Changes needed')
    expect(screen.getByTestId('solo-council-objections-reviewer')).toHaveTextContent('Blocking objections')
    expect(screen.getByTestId('solo-council-objections-reviewer')).toHaveTextContent('Need bounded marker')
    expect(screen.getByTestId('solo-council-actions-reviewer')).toHaveTextContent('Executable actions')
    expect(screen.getByTestId('solo-council-actions-reviewer')).toHaveTextContent('Add parser test')
  })

  it('does not fold medium role output below the safer threshold', () => {
    const mediumOutput = Array.from({ length: 30 }, (_, index) => `Medium Solo Council line ${index + 1}`).join('\n')
    expect(mediumOutput.length).toBeGreaterThan(220)
    expect(mediumOutput.length).toBeLessThan(900)
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
              summary: mediumOutput,
            }),
          },
        },
      },
    })

    render(<SoloCouncilPanel sessionId="s1" />)

    expect(screen.getByTestId('solo-council-output-planner')).not.toHaveClass('line-clamp-3')
    expect(screen.queryByTestId('solo-council-toggle-planner')).not.toBeInTheDocument()
  })
})
