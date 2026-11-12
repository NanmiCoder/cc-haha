import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The view is the shared layout and has its own suite; here it only lays the
 * slots out flat, so each test reads what the market page put into them.
 */
vi.mock('./SkillDetailView', () => ({
  SkillDetailView: (props: {
    meta: Array<{ label: string; value: React.ReactNode }>
    actions?: React.ReactNode
    banner?: React.ReactNode
    metaLine?: React.ReactNode
    chips?: React.ReactNode
    summary?: string
    stats?: Array<{ label: string; value: string }>
    extraTabs?: Array<{ key: string; label: string; badge?: React.ReactNode; content: React.ReactNode }>
    activeTab?: string
    onTabChange?: (tab: string) => void
    overviewLead?: React.ReactNode
    docHeader?: React.ReactNode
    sideCards?: React.ReactNode
    actionsPlacement?: string
    onBack: () => void
    backLabel: string
  }) => (
    <div data-testid="detail-view" data-active-tab={props.activeTab} data-actions={props.actionsPlacement}>
      {props.meta.map((item) => (
        <span key={item.label}>
          {item.label}={item.value}
        </span>
      ))}
      <div data-testid="slot-summary">{props.summary}</div>
      <div data-testid="slot-meta-line">{props.metaLine}</div>
      <div data-testid="slot-chips">{props.chips}</div>
      <div data-testid="slot-stats">
        {props.stats?.map((stat) => <span key={stat.label}>{`${stat.label}=${stat.value}`}</span>)}
      </div>
      <div data-testid="slot-tabs">
        {props.extraTabs?.map((tab) => (
          <button key={tab.key} type="button" data-testid={`slot-tab-${tab.key}`} onClick={() => props.onTabChange?.(tab.key)}>
            {tab.label}
            {tab.badge}
          </button>
        ))}
      </div>
      <div data-testid="slot-tab-content">
        {props.extraTabs?.find((tab) => tab.key === props.activeTab)?.content}
      </div>
      <div data-testid="slot-overview-lead">{props.overviewLead}</div>
      <div data-testid="slot-doc-header">{props.docHeader}</div>
      <div data-testid="slot-side">{props.sideCards}</div>
      {props.actions}
      {props.banner}
      <button type="button" data-testid="detail-back" onClick={props.onBack}>{props.backLabel}</button>
    </div>
  ),
}))

import { useMarketStore } from '../../stores/marketStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { MarketSkillDetail } from './MarketSkillDetail'

const backToList = vi.fn()
const refreshDetail = vi.fn()

function setStore(partial: Record<string, unknown>) {
  useMarketStore.setState({
    selectedId: 'skill-1',
    detail: null,
    isDetailLoading: false,
    detailError: null,
    installingIds: new Set<string>(),
    installError: null,
    categories: [{ key: 'agent', name: 'Agent boost', nameEn: 'Agent boost', count: 30 }],
    backToList,
    refreshDetail,
    fetchFileContent: vi.fn(),
    ...partial,
  } as never)
}

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'skill-1',
    name: 'Weather',
    author: { displayName: 'Ada', handle: 'ada' },
    stats: { downloads: 12_500 },
    files: [],
    source: 'clawhub',
    slug: 'weather',
    summary: 'Forecasts',
    tags: [],
    description: '# Weather',
    totalSize: 0,
    securityStatus: 'benign',
    installState: 'installable',
    ...overrides,
  }
}

const SELF_IMPROVING = {
  securityStatus: 'flagged',
  securityNote: 'Hook is opt-in; reviewed by the curator.',
  securityReports: [
    { vendor: 'VirusTotal', status: 'clean', statusText: 'clean', reportUrl: 'https://www.virustotal.com/x' },
    { vendor: 'LLM review', status: 'suspicious', statusText: 'suspicious', summary: 'Reads transcripts.', reportUrl: 'javascript:alert(1)' },
  ],
  description: '```bash\nmkdir -p .learnings\n```\nCopy the hook to ~/.openclaw/hooks.',
  descriptionFrontmatter: {
    description: 'Captures learnings. Use when: (1) A command fails unexpectedly, (2) User corrects Claude',
  },
  files: [
    { path: 'SKILL.md', size: 21_000, language: 'markdown', tooBig: false },
    { path: 'scripts/extract-skill.sh', size: 400, language: 'bash', tooBig: false },
    { path: 'hooks/openclaw/handler.js', size: 300, language: 'javascript', tooBig: false },
  ],
  stats: { downloads: 482_069, installs: 18_500, stars: 4_012 },
  license: 'MIT-0',
  updatedAt: Date.UTC(2026, 7, 6),
  pageUrl: 'https://clawhub.ai/pskoett/self-improving-agent',
}

describe('MarketSkillDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
  })

  it('shows a labeled skeleton group while loading', () => {
    // The placeholder used to be a bare `animate-pulse` div, invisible to a
    // screen reader; SkeletonGroup carries role=status and aria-busy.
    setStore({ isDetailLoading: true })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status.className).toContain('animate-pulse')
  })

  it('offers a retry when the detail fails to load', () => {
    setStore({ detailError: 'network down' })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    expect(screen.getByText(/network down/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(refreshDetail).toHaveBeenCalledWith('skill-1')
  })

  it('formats large download counts compactly', () => {
    setStore({ detail: makeDetail() })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)
    expect(screen.getByTestId('detail-view')).toHaveTextContent('12.5k')
  })

  it('requests install for the selected skill, pinned to the owner it was opened with', () => {
    const onRequestInstall = vi.fn()
    setStore({ detail: makeDetail(), selectedOwner: 'ada' })
    render(<MarketSkillDetail onRequestInstall={onRequestInstall} onRequestUninstall={vi.fn()} />)

    fireEvent.click(screen.getByTestId('market-install-button'))
    expect(onRequestInstall).toHaveBeenCalledWith('skill-1', 'ada')
  })

  it('requests an unpinned install when the detail has no owner', () => {
    const onRequestInstall = vi.fn()
    setStore({ detail: makeDetail({ source: 'skillhub' }), selectedOwner: null })
    render(<MarketSkillDetail onRequestInstall={onRequestInstall} onRequestUninstall={vi.fn()} />)

    fireEvent.click(screen.getByTestId('market-install-button'))
    expect(onRequestInstall).toHaveBeenCalledWith('skill-1', undefined)
  })

  it('offers uninstall instead once installed', () => {
    const onRequestUninstall = vi.fn()
    setStore({ detail: makeDetail({ installState: 'installed' }) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={onRequestUninstall} />)

    expect(screen.queryByTestId('market-install-button')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('market-uninstall-button'))
    expect(onRequestUninstall).toHaveBeenCalledWith('skill-1')
  })

  it('disables the action and shows a spinner while installing', () => {
    setStore({ detail: makeDetail(), installingIds: new Set(['skill-1']) })
    const { container } = render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    expect(screen.getByTestId('market-install-button')).toBeDisabled()
    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument()
  })

  it('goes back to the list', () => {
    setStore({ detail: makeDetail() })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    fireEvent.click(screen.getByTestId('detail-back'))
    expect(backToList).toHaveBeenCalled()
  })
})

describe('MarketSkillDetail catalog redesign', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
  })

  it('fills the hero: meta line, chips with the resolved category, and the stats strip', () => {
    setStore({
      detail: makeDetail({ ...SELF_IMPROVING, featured: true, curated: true, category: 'agent', tags: ['自我改进'] }),
    })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    // Separators are their own nodes, spaced by the flex gap.
    expect(screen.getByTestId('slot-meta-line')).toHaveTextContent(/^by Ada·ClawHub·MIT-0·Updated 2026-08-06$/)
    const chips = screen.getByTestId('slot-chips')
    expect(within(chips).getByTestId('security-badge-flagged')).toBeInTheDocument()
    expect(within(chips).getByTestId('market-detail-featured')).toHaveTextContent('Featured')
    expect(chips).toHaveTextContent('Agent boost')
    // Curated tags are not shown (older catalogs carried them untranslated).
    expect(chips).not.toHaveTextContent('自我改进')
    expect(screen.getByTestId('slot-stats')).toHaveTextContent('Downloads=482.1k')
    expect(screen.getByTestId('slot-stats')).toHaveTextContent('Installs=18.5k')
    expect(screen.getByTestId('slot-stats')).toHaveTextContent('Stars=4.0k')
    expect(screen.getByTestId('slot-stats')).toHaveTextContent('Files=3')
    expect(screen.getByTestId('detail-view')).toHaveAttribute('data-actions', 'hero')
  })

  it('reads the English summary of a curated skill', () => {
    const curated = { curated: true, summary: '把失败与纠正记录到本地', summaryEn: 'Log failures and corrections' }
    setStore({ detail: makeDetail(curated) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)
    expect(screen.getByTestId('slot-summary')).toHaveTextContent('Log failures and corrections')
  })

  it('marks the security tab of a flagged skill and lists every scanner with safe links only', () => {
    setStore({ detail: makeDetail(SELF_IMPROVING) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    const securityTab = screen.getByTestId('slot-tab-security')
    expect(within(securityTab).getByTestId('market-detail-flagged-dot')).toHaveTextContent('Flagged by the security scan')

    fireEvent.click(securityTab)
    const panel = screen.getByTestId('slot-tab-content')
    expect(within(panel).getAllByTestId('market-security-report')).toHaveLength(2)
    expect(within(panel).getByText('Reads transcripts.')).toBeInTheDocument()
    // The `javascript:` report URL from upstream must not become a link.
    const links = within(panel).getAllByRole('link', { name: /View report/ })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://www.virustotal.com/x')
    expect(within(panel).getByTestId('market-security-note')).toHaveTextContent('Hook is opt-in')
  })

  it('puts no warning dot on a skill that scanned clean', () => {
    setStore({ detail: makeDetail() })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    expect(screen.queryByTestId('market-detail-flagged-dot')).not.toBeInTheDocument()
  })

  it('leads the overview with the capability panel, whose report link opens the security tab', () => {
    setStore({ detail: makeDetail(SELF_IMPROVING) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    const lead = screen.getByTestId('slot-overview-lead')
    expect(within(lead).getByText('Before installing: what this skill does')).toBeInTheDocument()
    expect(within(lead).getByTestId('market-capability-shell')).toHaveTextContent('scripts/extract-skill.sh')
    expect(within(lead).getByTestId('market-capability-hooks')).toBeInTheDocument()

    expect(screen.getByTestId('detail-view')).toHaveAttribute('data-active-tab', 'overview')
    fireEvent.click(within(lead).getByTestId('market-capability-view-report'))
    expect(screen.getByTestId('detail-view')).toHaveAttribute('data-active-tab', 'security')
  })

  it('renders no capability panel when no rule fires', () => {
    setStore({ detail: makeDetail({ description: '# Writing guide\nBe concise.' }) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    expect(screen.queryByTestId('market-capability-panel')).not.toBeInTheDocument()
  })

  it('lists when the skill triggers in the side rail', () => {
    setStore({ detail: makeDetail(SELF_IMPROVING) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    const side = screen.getByTestId('slot-side')
    expect(within(side).getByText('When it triggers')).toBeInTheDocument()
    expect(within(side).getByText('A command fails unexpectedly')).toBeInTheDocument()
    expect(within(side).getByText('User corrects Claude')).toBeInTheDocument()
  })

  it('shows the SKILL.md size and reading time above the document', () => {
    setStore({ detail: makeDetail(SELF_IMPROVING) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    expect(screen.getByTestId('slot-doc-header')).toHaveTextContent('SKILL.md')
    expect(screen.getByTestId('slot-doc-header')).toHaveTextContent('min read')
  })

  it('adds a changelog tab only when upstream sent a release note', () => {
    setStore({ detail: makeDetail() })
    const { unmount } = render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)
    expect(screen.queryByTestId('slot-tab-changelog')).not.toBeInTheDocument()
    unmount()

    setStore({
      detail: makeDetail({
        version: '4.0.2',
        changelog: { version: '4.0.2', text: 'Opt-in hook', publishedAt: Date.UTC(2026, 7, 6) },
        pageUrl: 'https://clawhub.ai/x',
      }),
    })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)
    fireEvent.click(screen.getByTestId('slot-tab-changelog'))

    const panel = within(screen.getByTestId('slot-tab-content')).getByTestId('market-changelog-panel')
    expect(panel).toHaveTextContent('v4.0.2')
    expect(panel).toHaveTextContent('2026-08-06')
    expect(panel).toHaveTextContent('Opt-in hook')
    expect(within(panel).getByRole('link', { name: /Source page/ })).toHaveAttribute('href', 'https://clawhub.ai/x')
  })

  it('links the registry page beside the install action', () => {
    setStore({ detail: makeDetail(SELF_IMPROVING) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    expect(screen.getByTestId('market-source-page-link')).toHaveAttribute(
      'href',
      'https://clawhub.ai/pskoett/self-improving-agent',
    )
  })
})
