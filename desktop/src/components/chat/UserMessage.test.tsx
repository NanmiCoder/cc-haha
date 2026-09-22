import { useTabStore } from '@/stores/tabStore'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openPreviewLink = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../lib/openPreviewLink', () => ({ openPreviewLink }))

import { UserMessage } from './UserMessage'
import { useSettingsStore } from '../../stores/settingsStore'

function bubbleOf(container: HTMLElement): HTMLElement {
  const bubble = container.querySelector<HTMLElement>('[data-message-body="user"]')
  if (!bubble) throw new Error('user message bubble not found')
  return bubble
}

describe('UserMessage', () => {
  afterEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    openPreviewLink.mockClear().mockReturnValue(true)
  })

  it('places rollback beside copy and fork in the existing hover and keyboard-focus action row', () => {
    useSettingsStore.setState({ locale: 'en' })
    const rollback = vi.fn()
    const { container } = render(<UserMessage content="A prompt" branchAction={{ label: 'Fork', onBranch: vi.fn() }} rewindAction={{ label: 'Roll back conversation', onRewind: rollback }} />)
    const button = screen.getByRole('button', { name: 'Roll back conversation' })
    const actions = button.closest('[data-message-actions]')
    expect(actions).toBeTruthy()
    expect(actions?.className).toContain('opacity-0')
    expect(actions?.className).toContain('group-hover:opacity-100')
    expect(actions?.className).toContain('group-focus-within:opacity-100')
    expect(container.querySelectorAll('[data-message-actions]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Fork' }).closest('[data-message-actions]')).toBe(actions)
    expect(button.textContent).toBe('')
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(rollback).toHaveBeenCalledOnce()
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

  // The copy label was a hardcoded "Copy prompt" literal, so it stayed English
  // under every locale. English is also what `chat.copyPrompt` resolves to, so
  // only a non-English locale can tell the wiring from the old literal.
  it('translates the copy action label instead of hardcoding English', () => {
    useSettingsStore.setState({ locale: 'zh' })

    render(<UserMessage content="把这条复制走" />)

    expect(screen.getByRole('button', { name: '复制提示词' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull()
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
    const content = '改一下 **bold** 和 `code`，还有 # 标题 与 [x](y)'
    const { container } = render(<UserMessage sessionId="s1" content={content} />)

    const bubble = bubbleOf(container)
    expect(bubble.textContent).toBe(content)
    expect(bubble.querySelector('strong')).toBeNull()
    expect(bubble.querySelector('code')).toBeNull()
    expect(bubble.querySelector('h1')).toBeNull()
    expect(bubble.querySelectorAll('a')).toHaveLength(0)
  })

  it('preserves line breaks around a linkified URL', () => {
    const content = '第一行\n打开 http://localhost:3000\n第三行'
    const { container } = render(<UserMessage sessionId="s1" content={content} />)

    expect(bubbleOf(container).textContent).toBe(content)
    expect(screen.getByRole('link', { name: 'http://localhost:3000' })).toBeTruthy()
  })

  it('renders no link when the prompt has no URL', () => {
    const { container } = render(<UserMessage sessionId="s1" content={'把样式改一下'} />)
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
    <UserMessage content="只读发现：#1335 未复现" collaboration={{ sourceSessionId: 'root-1', messageId: 'm-1' }} />,
  )

  const label = screen.getByRole('button', { name: 'Sent by root-1 from another session' })
  fireEvent.click(label)
  expect(open).toHaveBeenCalledWith('root-1', 'root-1')
  // Codex parity: the payload stays an ordinary right-aligned user bubble, not a panel row.
  expect(container.firstElementChild?.className).toContain('justify-end')
  expect(bubbleOf(container).textContent).toBe('只读发现：#1335 未复现')
  open.mockRestore()
})
