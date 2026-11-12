import { useTabStore } from '@/stores/tabStore'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openPreviewLink = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../lib/openPreviewLink', () => ({ openPreviewLink }))

import { UserMessage, type UserMessageEditAction } from './UserMessage'
import { withAgentTeamRequest } from '../../lib/agentTeamRequest'
import { useCapabilityCatalogStore } from '../../stores/capabilityCatalogStore'
import { useSettingsStore } from '../../stores/settingsStore'

function makeEditAction(overrides: Partial<UserMessageEditAction> = {}): UserMessageEditAction {
  return {
    label: 'Edit and resend',
    editing: false,
    submitting: false,
    disabled: false,
    getDraft: () => ({ text: 'A prompt', attachments: [], sessionReferences: [] }),
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }
}

function bubbleOf(container: HTMLElement): HTMLElement {
  const bubble = container.querySelector<HTMLElement>('[data-message-body="user"]')
  if (!bubble) throw new Error('user message bubble not found')
  return bubble
}

describe('UserMessage', () => {
  it('keeps a teammate Markdown file reference parsed through the click callback', () => {
    render(<UserMessage sessionId="s1" content="[open](docs/literal%2520name.md:7)" teammateFrom="reviewer" />)
    fireEvent.click(screen.getByRole('link', { name: 'open' }))
    expect(openPreviewLink).toHaveBeenCalledWith({ path: 'docs/literal%20name.md', line: 7 }, 's1')
  })

  afterEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    openPreviewLink.mockClear().mockReturnValue(true)
  })

  it('places edit beside copy and fork in the existing hover and keyboard-focus action row', () => {
    useSettingsStore.setState({ locale: 'en' })
    const editAction = makeEditAction()
    const { container } = render(<UserMessage content="A prompt" branchAction={{ label: 'Fork', onBranch: vi.fn() }} editAction={editAction} />)
    const button = screen.getByRole('button', { name: 'Edit and resend' })
    const actions = button.closest('[data-message-actions]')
    expect(actions).toBeTruthy()
    expect(actions?.className).toContain('opacity-0')
    expect(actions?.className).toContain('group-hover:opacity-100')
    expect(actions?.className).toContain('group-focus-within:opacity-100')
    // Hung under the bubble with no layout height, so revealing it never shifts
    // the transcript. It must stay in flow inside the hover shell (see
    // MessageActionBar.overlay.test.tsx for why, #1616).
    expect(actions?.getAttribute('data-placement')).toBe('overlay')
    expect(actions?.className).toContain('h-0')
    expect(actions?.className).not.toMatch(/(^|\s)(absolute|fixed)(\s|$)/)
    expect(actions?.parentElement?.getAttribute('data-message-shell')).toBe('user')
    expect(container.querySelectorAll('[data-message-actions]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Fork' }).closest('[data-message-actions]')).toBe(actions)
    expect(button.textContent).toBe('')
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(editAction.onStart).toHaveBeenCalledOnce()
  })

  it('replaces the bubble with the inline editor while editing, seeded from the saved draft', () => {
    useSettingsStore.setState({ locale: 'en' })
    const editAction = makeEditAction({
      editing: true,
      getDraft: () => ({ text: 'Draft kept by the list', attachments: [], sessionReferences: [] }),
    })
    const { container } = render(<UserMessage content="Original prompt" editAction={editAction} />)

    expect(container.querySelector('[data-message-body="user"]')).toBeNull()
    expect(container.querySelector('[data-message-actions]')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Edited message' }).textContent).toBe('Draft kept by the list')
  })

  it('offers edit on an attachment-only prompt, which has no text to copy', () => {
    useSettingsStore.setState({ locale: 'en' })
    render(
      <UserMessage
        content=""
        attachments={[{ type: 'image', name: 'shot.png', data: 'data:image/png;base64,AAAA' }]}
        editAction={makeEditAction()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Edit and resend' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull()
  })

  it('never offers edit on a teammate message', () => {
    useSettingsStore.setState({ locale: 'en' })
    render(<UserMessage content="Do the review" teammateFrom="reviewer" editAction={makeEditAction()} />)

    expect(screen.queryByRole('button', { name: 'Edit and resend' })).toBeNull()
  })

  it('keeps long URLs inside the message bubble', () => {
    const longUrl = `https://cn.bing.com/search?q=${'encoded'.repeat(60)}`

    const { container } = render(<UserMessage content={longUrl} />)

    const shell = container.querySelector('[data-message-shell="user"]')
    const bubble = bubbleOf(container)

    expect(shell?.className).toContain('min-w-0')
    expect(bubble.className).toContain('min-w-0')
    expect(bubble.className).toContain('max-w-full')
    expect(bubble.className).toContain('whitespace-pre-wrap')
    expect(bubble.style.overflowWrap).toBe('anywhere')
    expect(bubble.style.wordBreak).toBe('break-word')
    // The long text now lives in the anchor, so it has to wrap there too.
    expect(screen.getByRole('link', { name: longUrl }).className).toContain('[overflow-wrap:anywhere]')
  })

})

// #1145. The prompt bubble rendered raw text, so a URL the user typed (or pasted
// back from an earlier reply) could never be clicked — the only clickable copy
// lived in the assistant's output card.
describe('UserMessage bare-URL linkify', () => {
  afterEach(() => {
    openPreviewLink.mockClear().mockReturnValue(true)
  })

  it('turns a bare URL into a link and leaves the prose as text', () => {
    const { container } = render(
      <UserMessage sessionId="s1" content={'把 http://localhost:3000 的样式改一下'} />,
    )

    const link = screen.getByRole('link', { name: 'http://localhost:3000' })
    expect(link.getAttribute('href')).toBe('http://localhost:3000')
    expect(bubbleOf(container).textContent).toBe('把 http://localhost:3000 的样式改一下')
  })

  it('stops the href at CJK punctuation', () => {
    render(<UserMessage sessionId="s1" content={'看看 http://localhost:5173，是不是白屏'} />)

    const link = screen.getByRole('link', { name: 'http://localhost:5173' })
    expect(link.getAttribute('href')).toBe('http://localhost:5173')
  })

  it('routes the click through the shared preview-link handler', () => {
    render(<UserMessage sessionId="s1" content={'打开 http://localhost:3000'} />)

    fireEvent.click(screen.getByRole('link', { name: 'http://localhost:3000' }))
    expect(openPreviewLink).toHaveBeenCalledWith('http://localhost:3000', 's1')
  })

  it('falls back to the anchor default when there is no session', () => {
    render(<UserMessage content={'打开 http://localhost:3000'} />)

    const link = screen.getByRole('link', { name: 'http://localhost:3000' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')

    fireEvent.click(link)
    expect(openPreviewLink).not.toHaveBeenCalled()
  })

  // Prompts are literal text: linkifying must not smuggle in markdown parsing.
  it('does not render markdown syntax in the prompt', () => {
    const content = 'change **bold** and `code`, also # heading and [x](y)'
    const { container } = render(<UserMessage sessionId="s1" content={content} />)

    const bubble = bubbleOf(container)
    expect(bubble.textContent).toBe(content)
    expect(bubble.querySelector('strong')).toBeNull()
    expect(bubble.querySelector('code')).toBeNull()
    expect(bubble.querySelector('h1')).toBeNull()
    expect(bubble.querySelectorAll('a')).toHaveLength(0)
  })

  it('preserves line breaks around a linkified URL', () => {
    const content = 'Line one\nopen http://localhost:3000\nLine three'
    const { container } = render(<UserMessage sessionId="s1" content={content} />)

    expect(bubbleOf(container).textContent).toBe(content)
    expect(screen.getByRole('link', { name: 'http://localhost:3000' })).toBeTruthy()
  })

  it('renders no link when the prompt has no URL', () => {
    const { container } = render(<UserMessage sessionId="s1" content={'Tweak the styles'} />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('attributes a teammate turn and left-aligns it away from the user bubble', () => {
    const { container } = render(
      <UserMessage content="Review the auth diff." teammateFrom="team-lead" />,
    )

    const shell = container.querySelector('[data-message-shell="teammate"]')
    expect(shell).toBeTruthy()
    expect(shell?.getAttribute('data-teammate-from')).toBe('team-lead')
    // Attribution is the point: an unlabelled bubble reads as the operator.
    expect(shell?.textContent).toContain('team-lead')
    expect(shell?.textContent).toContain('teammate message')

    // A teammate turn must not reuse the user's right-aligned bubble, and must
    // not offer branching — the operator did not author it.
    expect(container.querySelector('[data-message-shell="user"]')).toBeNull()
    expect(container.querySelector('[data-message-body="user"]')).toBeNull()
    expect(container.querySelector('[data-message-body="teammate"]')).toBeTruthy()
    expect(container.firstElementChild?.className).toContain('justify-start')
  })

  it('renders teammate communication as markdown inside a quiet neutral card', () => {
    const { container } = render(
      <UserMessage
        content={'**Critical** findings:\n\n- Review `src/auth.ts`\n- Keep replay protection\n\n[Open report](http://localhost:3000/report)'}
        teammateFrom="security-reviewer"
        sessionId="s1"
      />,
    )

    const body = container.querySelector<HTMLElement>('[data-message-body="teammate"]')
    expect(body?.querySelector('strong')?.textContent).toBe('Critical')
    expect(body?.querySelector('code')?.textContent).toBe('src/auth.ts')
    expect(body?.querySelectorAll('li')).toHaveLength(2)
    fireEvent.click(screen.getByRole('link', { name: 'Open report' }))
    expect(openPreviewLink).toHaveBeenCalledWith('http://localhost:3000/report', 's1')

    // The old full-height brand border dominated long reports. A complete
    // neutral outline keeps the card edge legible without repeating identity.
    expect(body?.className).not.toContain('border-l-2')
    expect(body?.className).toContain('border-[var(--color-border)]')
  })

  it('uses the teammate character supplied by the Agent Teams identity map', () => {
    render(
      <UserMessage
        content="Review the auth diff."
        teammateFrom="team-lead"
        teammateAvatarSrc="/agent-teams/team-lead.png"
        teammateAvatarKey="team-lead"
        teammateAccent="var(--color-brand)"
      />,
    )

    const avatar = screen.getByTestId('teammate-message-avatar')
    expect(avatar.getAttribute('data-avatar-key')).toBe('team-lead')
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('/agent-teams/team-lead.png')
    expect(avatar.querySelector('span')?.style.background).toBe('var(--color-brand)')
  })

  it('keeps an ordinary prompt in the right-aligned user bubble', () => {
    const { container } = render(<UserMessage content="Review the auth diff." />)

    expect(container.querySelector('[data-message-shell="teammate"]')).toBeNull()
    expect(bubbleOf(container).textContent).toBe('Review the auth diff.')
    expect(container.firstElementChild?.className).toContain('justify-end')
  })
})

it('opens the exact referenced conversation from a source chip', () => {
  const open = vi.spyOn(useTabStore.getState(), 'openTab')
  render(<UserMessage content="Use @Review" sessionReferences={[{ sessionId: 'prior' }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open session prior' }))
  expect(open).toHaveBeenCalledWith('prior', 'prior')
  open.mockRestore()
})

it('labels a collaboration delivery with its source session above a normal user bubble', () => {
  const open = vi.spyOn(useTabStore.getState(), 'openTab')
  const { container } = render(
    <UserMessage content="Read-only finding: #1335 does not reproduce" collaboration={{ sourceSessionId: 'root-1', messageId: 'm-1' }} />,
  )

  const label = screen.getByRole('button', { name: 'Sent by root-1 from another session' })
  fireEvent.click(label)
  expect(open).toHaveBeenCalledWith('root-1', 'root-1')
  // Codex parity: the payload stays an ordinary right-aligned user bubble, not a panel row.
  expect(container.firstElementChild?.className).toContain('justify-end')
  expect(bubbleOf(container).textContent).toBe('Read-only finding: #1335 does not reproduce')
  open.mockRestore()
})

describe('UserMessage capability pills', () => {
  const SKILL = 'Use the Skill tool with skill: "frontend-design" for this request.'
  const TEAM_MODEL_CONTENT = withAgentTeamRequest(`${SKILL} build a landing page`)

  afterEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useCapabilityCatalogStore.setState({ entries: {} })
  })

  function pills(container: HTMLElement) {
    return [...bubbleOf(container).querySelectorAll('[data-user-message-pill]')]
      .map((pill) => `${pill.getAttribute('data-user-message-pill')}:${pill.textContent}`)
  }

  it('shows the Agent Team switch as a read-only chip above the bubble', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { container } = render(<UserMessage content="@frontend-design build a landing page" modelContent={TEAM_MODEL_CONTENT} />)
    const chip = screen.getByTestId('agent-team-chip')
    expect(chip.textContent).toBe('Agent Teams')
    expect(bubbleOf(container).contains(chip)).toBe(false)
    expect(screen.queryByRole('button', { name: 'Remove Agent Teams' })).toBeNull()
  })

  it('renders a live pill and its reloaded copy the same way', () => {
    // Live: the bubble text is the composer projection, the model text the sentence.
    const live = render(<UserMessage content="@Frontend Design build a landing page" modelContent={TEAM_MODEL_CONTENT} />)
    // Reload: history keeps the sentence in the text (no team block, no modelContent).
    const reloaded = render(<UserMessage content={`${SKILL} build a landing page`} />)
    for (const { container } of [live, reloaded]) {
      expect(pills(container)).toEqual(['skill:@frontend-design'])
      expect(bubbleOf(container).textContent).toBe('@frontend-design build a landing page')
      expect(bubbleOf(container).textContent).not.toContain('Use the Skill tool')
    }
    expect(reloaded.container.querySelector('[data-testid="agent-team-chip"]')).toBeNull()
  })

  it('names a pill the way the composer showed it, brand icon included', () => {
    const PLUGIN = 'Use the enabled plugin "amap@official" for this request. Available skill identities: []. '
      + 'MCP server identities: ["plugin:amap:maps"]. Invoke skills using the Skill tool and use only tools currently '
      + 'available from these servers. If unavailable or authentication is required, report that; do not install or authenticate automatically.'
    useCapabilityCatalogStore.getState().remember([
      { kind: 'plugin', id: 'amap@official', name: 'amap', displayName: 'Amap', description: '', source: 'amap@official', icon: '/connectors/amap.svg', modelText: PLUGIN },
      { kind: 'skill', id: 'frontend-design', name: 'frontend-design', displayName: 'Frontend Design', description: '', source: 'skills', modelText: SKILL },
    ])
    // Live (composer projection + model text) and reloaded (sentence only) agree.
    const live = render(<UserMessage content="@Frontend Design use @Amap to find a route" modelContent={`${SKILL} use ${PLUGIN} to find a route`} />)
    const reloaded = render(<UserMessage content={`${SKILL} use ${PLUGIN} to find a route`} />)
    for (const { container } of [live, reloaded]) {
      expect(pills(container)).toEqual(['skill:@Frontend Design', 'plugin:@Amap'])
      const brand = bubbleOf(container).querySelector('[data-user-message-pill="plugin"] img')
      expect(brand?.getAttribute('src')).toMatch(/connectors\/amap\.svg$/)
    }
  })

  it('marks a leading slash command inside the bubble', () => {
    const { container } = render(<UserMessage content="/commit only commit docs" />)
    expect(pills(container)).toEqual(['command:/commit'])
    expect(bubbleOf(container).textContent).toBe('/commit only commit docs')
  })

  it('leaves a plain prompt as plain text', () => {
    const { container } = render(<UserMessage content="Analyze the latest release commits" />)
    expect(pills(container)).toEqual([])
    expect(screen.queryByTestId('agent-team-chip')).toBeNull()
  })
})
