import '@testing-library/jest-dom/vitest'
import css from './AgentTeamsPlanCard.css?raw'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { teamPlansApi } from '@/api/teamPlans'
import { useTeamPlanStore } from '@/stores/teamPlanStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionRuntimeStore } from '@/stores/sessionRuntimeStore'
import { useProviderStore } from '@/stores/providerStore'
import { AgentTeamsPlanCard } from './AgentTeamsPlanCard'
import type { TeamPlanRecord } from '../../../../src/shared/teamPlan'

/**
 * Regression anchor for #1523: AI-written plan text (a long identifier, path or
 * URL with no break opportunity) pushed the review dialog's scroller wider than
 * itself and showed a horizontal scrollbar.
 *
 * jsdom has no layout, so this cannot measure `scrollWidth`. It locks the
 * cheapest structural fact instead: every field that renders model-written
 * text must sit under an element that opts into `overflow-wrap`/`word-break`
 * (inline style, a Tailwind utility, or a rule in AgentTeamsPlanCard.css).
 * Limitation: it proves the guard is declared, not that the browser honours it
 * (e.g. an ancestor with `white-space: pre` would still defeat it). The real
 * measurement lives in the browser replay script named in the issue report
 * (scrollWidth > clientWidth on the Modal's `overflow-y-auto` scroller).
 */

vi.mock('@/api/teamPlans', () => ({ teamPlansApi: { get: vi.fn(), save: vi.fn(), act: vi.fn() } }))
vi.mock('@/components/controls/ModelSelector', () => ({
  ModelSelector: (props: { ariaLabel: string }) => <button aria-label={props.ariaLabel} />,
}))

const LONG = 'SupercalifragilisticexpialidociousAuthenticationSessionRefreshTokenRotationHandlerImplementation'.repeat(3)

function fixture(): TeamPlanRecord {
  return {
    schemaVersion: 1, planId: 'plan', sessionId: 'session', teamName: 'Test team', incarnationId: 'incarnation', revision: 1,
    state: 'review_pending', workDir: '/tmp/fixture', createdAt: 1, updatedAt: 1,
    leaderRuntime: { providerId: 'claude-official', modelId: 'leader' },
    agentCatalog: { engineer: { systemPrompt: 'Engineer', source: 'built-in' } },
    members: [
      { id: 'build', name: 'Builder', agentType: 'engineer', prompt: `PROMPT ${LONG}`, reason: `REASON ${LONG}`, runtime: { providerId: 'fast', modelId: 'small' }, suggestedRuntime: { providerId: 'fast', modelId: 'small' } },
    ],
    tasks: [{ id: 'task', subject: `SUBJECT ${LONG}`, description: `DESCRIPTION ${LONG}`, ownerId: 'build', dependencies: [] }],
  }
}

const GUARD_CLASS = /(^|\s)(break-words|break-all|\[overflow-wrap:(anywhere|break-word)\]|\[word-break:(break-all|break-word)\])(\s|$)/

function cssRuleGuards(className: string): boolean {
  // A `.class { ... overflow-wrap|word-break ... }` rule in the feature stylesheet.
  const rules = css.split('}').map(rule => rule.trim()).filter(Boolean)
  return rules.some(rule => {
    const [selector = '', body = ''] = rule.split('{')
    const classesInSelector: string[] = selector.match(/\.[\w-]+/g) ?? []
    return classesInSelector.includes(`.${className}`) && /(overflow-wrap|word-break)\s*:\s*(anywhere|break-word|break-all)/.test(body)
  })
}

function hasWrapGuard(element: Element, stopAt: Element): boolean {
  for (let node: Element | null = element; node && node !== stopAt.parentElement; node = node.parentElement) {
    const style = (node as HTMLElement).style
    if (/^(anywhere|break-word)$/.test(style.overflowWrap) || /^(break-all|break-word)$/.test(style.wordBreak)) return true
    if (GUARD_CLASS.test(node.getAttribute('class') ?? '')) return true
    if (Array.from(node.classList).some(cssRuleGuards)) return true
  }
  return false
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useTeamPlanStore.setState({ bySession: {} })
  useProviderStore.setState({ providers: [] })
  useSessionRuntimeStore.setState({ selections: {} })
  vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: fixture() })
})

describe('AgentTeamsPlanCard long unbroken text (#1523)', () => {
  it('detects a missing guard (helper sanity, so the assertions below cannot pass vacuously)', () => {
    const wrapper = document.createElement('div')
    const plain = document.createElement('p')
    plain.className = 'text-sm whitespace-pre-wrap'
    wrapper.appendChild(plain)
    expect(hasWrapGuard(plain, wrapper)).toBe(false)
    plain.className = 'text-sm [overflow-wrap:anywhere]'
    expect(hasWrapGuard(plain, wrapper)).toBe(true)
  })

  it.each([
    ['member brief (prompt)', /^PROMPT /],
    ['member reason', /^REASON /],
    ['task subject', /^SUBJECT /],
    ['task description', /^DESCRIPTION /],
  ])('wraps model-written %s that has no break opportunity', async (_label, text) => {
    render(<AgentTeamsPlanCard sessionId="session" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review configuration' }))
    const dialog = screen.getByRole('dialog')
    const field = screen.getByText(text, { selector: 'p' })
    expect(hasWrapGuard(field, dialog)).toBe(true)
  })
})
