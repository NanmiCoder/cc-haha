import { teamPlansApi } from '@/api/teamPlans'
import { ApiError } from '@/api/client'
import { useChatStore } from '@/stores/chatStore'
import { useTeamPlanStore } from '@/stores/teamPlanStore'
import { useProviderStore } from '@/stores/providerStore'
import { useHahaOAuthStore } from '@/stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '@/stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '@/stores/hahaGrokOAuthStore'
import type { TeamPlanRecord } from '../../../src/shared/teamPlan'
import type { SavedProvider } from '@/types/provider'

export const TEAM_PLAN_GALLERY_SESSION = 'gallery-team-plan'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export function createTeamPlanGalleryFixture(): TeamPlanRecord {
  return {
    schemaVersion: 1, planId: 'gallery-plan', sessionId: TEAM_PLAN_GALLERY_SESSION,
    teamName: 'Login redesign', incarnationId: 'gallery-incarnation', revision: 1,
    state: 'review_pending', workDir: '/tmp/team-plan-gallery', createdAt: 1, updatedAt: 1,
    leaderRuntime: { providerId: 'quality', modelId: 'quality-reasoning' },
    agentCatalog: {
      engineer: { systemPrompt: 'Implement accessible UI', source: 'built-in', sourceIdentity: { kind: 'builtin' }, model: 'sonnet' },
      reviewer: { systemPrompt: 'Review boundary correctness', source: 'projectSettings', model: 'opus' },
      researcher: { systemPrompt: 'Read documentation', source: 'userSettings', model: 'haiku' },
    },
    members: [
      { id: 'research', name: 'Researcher', agentType: 'researcher', prompt: 'Inspect existing login components and document reusable patterns.', runtime: { providerId: 'economy', modelId: 'economy-fast' }, suggestedRuntime: { providerId: 'economy', modelId: 'economy-fast' }, difficulty: 'low', reason: 'Read-only inventory with a limited scope.' },
      { id: 'build', name: 'Engineer', agentType: 'engineer', prompt: 'Implement the login flow with keyboard support and clear error states.', runtime: { providerId: 'economy', modelId: 'economy-balanced' }, suggestedRuntime: { providerId: 'economy', modelId: 'economy-balanced' }, difficulty: 'medium', reason: 'Implementation across UI and session boundaries.' },
      { id: 'review', name: 'Reviewer', agentType: 'reviewer', prompt: 'Review authentication boundaries and verify retry behavior.', runtime: { providerId: 'quality', modelId: 'quality-reasoning' }, suggestedRuntime: { providerId: 'quality', modelId: 'quality-reasoning' }, difficulty: 'high', reason: 'Complex security and concurrency review.' },
    ],
    tasks: [
      { id: 'inventory', subject: 'Inspect login components', ownerId: 'research', dependencies: [] },
      { id: 'implementation', subject: 'Implement accessible login', ownerId: 'build', dependencies: ['inventory'] },
      { id: 'review', subject: 'Review boundary behavior', ownerId: 'review', dependencies: ['implementation'] },
    ],
  }
}

/** Dev-only, in-memory transports: opening a picker never accesses saved providers or credentials. */
export function installTeamPlanGalleryFixture() {
  let plan = createTeamPlanGalleryFixture()
  const oldApi = { ...teamPlansApi }
  const oldStop = useChatStore.getState().stopGeneration
  useChatStore.setState({ stopGeneration: sessionId => {
    if (sessionId !== TEAM_PLAN_GALLERY_SESSION) return oldStop(sessionId)
    plan = { ...plan, revision: plan.revision + 1, state: 'interrupted' }
    void useTeamPlanStore.getState().refresh(TEAM_PLAN_GALLERY_SESSION)
  } })
  const providerState = useProviderStore.getState()
  const oldClaudeFetch = useHahaOAuthStore.getState().fetchStatus
  const oldOpenAIFetch = useHahaOpenAIOAuthStore.getState().fetchStatus
  const oldGrokFetch = useHahaGrokOAuthStore.getState().fetchStatus
  const providers: SavedProvider[] = ['economy', 'quality'].map(id => ({
    id, presetId: 'custom', name: id === 'economy' ? 'Economy (fixture)' : 'Quality (fixture)',
    apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1', apiFormat: 'anthropic',
    models: { main: `${id}-balanced`, haiku: `${id}-fast`, sonnet: `${id}-balanced`, opus: `${id}-reasoning` },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }))
  useProviderStore.setState({ providers, activeId: 'economy', hasLoadedProviders: true })
  useHahaOAuthStore.setState({ fetchStatus: async () => {} })
  useHahaOpenAIOAuthStore.setState({ fetchStatus: async () => {} })
  useHahaGrokOAuthStore.setState({ fetchStatus: async () => {} })
  teamPlansApi.get = async () => ({ plan: clone(plan) })
  teamPlansApi.save = async (expected, edits) => {
    if (expected.revision !== plan.revision) throw new ApiError(409, { message: 'Fixture revision conflict' })
    plan = { ...plan, ...clone(edits), revision: plan.revision + 1 }
    return { plan: clone(plan) }
  }
  teamPlansApi.act = async (expected, action, _requestId, feedback) => {
    if (expected.revision !== plan.revision) throw new ApiError(409, { message: 'Fixture revision conflict' })
    plan = { ...plan, revision: plan.revision + 1, feedback, state: action === 'approve' ? 'running' : action === 'cancel' ? 'cancelled' : action === 'retry' ? 'review_pending' : 'draft' }
    return { plan: clone(plan) }
  }
  return {
    reset: () => { plan = createTeamPlanGalleryFixture(); useTeamPlanStore.setState({ bySession: {} }); void useTeamPlanStore.getState().refresh(TEAM_PLAN_GALLERY_SESSION) },
    conflict: () => { plan = { ...plan, revision: plan.revision + 1 }; void useTeamPlanStore.getState().refresh(TEAM_PLAN_GALLERY_SESSION) },
    interrupt: () => { plan = { ...plan, revision: plan.revision + 1, state: 'interrupted' }; void useTeamPlanStore.getState().refresh(TEAM_PLAN_GALLERY_SESSION) },
    dispose: () => {
      Object.assign(teamPlansApi, oldApi)
      useChatStore.setState({ stopGeneration: oldStop })
      useProviderStore.setState(providerState)
      useHahaOAuthStore.setState({ fetchStatus: oldClaudeFetch })
      useHahaOpenAIOAuthStore.setState({ fetchStatus: oldOpenAIFetch })
      useHahaGrokOAuthStore.setState({ fetchStatus: oldGrokFetch })
    },
  }
}
