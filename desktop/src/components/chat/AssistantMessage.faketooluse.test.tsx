import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// AssistantMessage transitively pulls in stores that need lightweight mocks
// in jsdom. We only stub what's strictly necessary for the fake-tool-use
// path; everything else (markdown, link routing, output cards) is left at
// real implementation so the assertions exercise the real DOM.

const openBrowser = vi.hoisted(() => vi.fn())
vi.mock('../../stores/browserPanelStore', () => ({
  useBrowserPanelStore: { getState: () => ({ open: openBrowser }) },
}))

vi.mock('../../lib/desktopRuntime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

// No active workdir; output-target cards stay quiet.
const openPreviewFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../stores/workspacePanelStore', () => {
  const state = { statusBySession: {} as Record<string, { workDir?: string } | undefined>, openPreview: openPreviewFn }
  const useWorkspacePanelStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useWorkspacePanelStore }
})

const ensureTargets = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const openTargetFn = vi.hoisted(() => vi.fn())
vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: {
    getState: () => ({ ensureTargets, targets: [], openTarget: openTargetFn }),
  },
}))

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockResolvedValue(undefined) }))

// providerStore selector — we want activeId='provider-a' so detections get
// attributed to a provider in the compat counter.
vi.mock('../../stores/providerStore', () => {
  const state = { activeId: 'provider-a' }
  const useProviderStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useProviderStore }
})

// providerCompatStore — minimal real-ish mock so we can spy on
// recordFakeToolUse calls.
const recordFakeToolUse = vi.hoisted(() => vi.fn())
vi.mock('../../stores/providerCompatStore', () => ({
  useProviderCompatStore: {
    getState: () => ({ recordFakeToolUse }),
  },
}))

// Real i18n + real settingsStore for accurate translation assertions.

import { AssistantMessage } from './AssistantMessage'

beforeEach(() => {
  recordFakeToolUse.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('AssistantMessage fake tool_use detection', () => {
  it('renders a notice card and strips the XML when the model emits a fake tool_use', () => {
    const content = [
      'Sure, let me check.',
      '<tool_use id="tooluse_xyz" name="Bash">{"command":"ls -la /tmp"}</tool_use>',
      'Done.',
    ].join('\n')

    render(<AssistantMessage sessionId="s1" content={content} />)

    expect(screen.getByTestId('fake-tool-use-notice')).toBeInTheDocument()
    // Body text mentions the attempted tool name (here: Bash).
    expect(screen.getByTestId('fake-tool-use-notice').textContent).toMatch(/Bash/)

    // The XML garbage is gone — neither the tag nor the JSON payload should
    // appear anywhere in the rendered DOM.
    const html = document.body.innerHTML
    expect(html).not.toContain('tooluse_xyz')
    expect(html).not.toContain('ls -la /tmp')
    expect(html).not.toContain('<tool_use')
  })

  it('records one compat event per fake block with the attributed provider id', () => {
    const content = [
      '<tool_use id="t1" name="Bash">{"command":"ls"}</tool_use>',
      '<tool_use id="t2" name="Edit">{"path":"foo.ts"}</tool_use>',
    ].join('\n')

    render(<AssistantMessage sessionId="s1" content={content} />)

    expect(recordFakeToolUse).toHaveBeenCalledTimes(2)
    expect(recordFakeToolUse).toHaveBeenCalledWith('provider-a', 'Bash')
    expect(recordFakeToolUse).toHaveBeenCalledWith('provider-a', 'Edit')
  })

  it('does NOT record events while the message is still streaming (avoids double-counting)', () => {
    const content = '<tool_use id="t1" name="Bash">{"command":"ls"}</tool_use>'

    render(<AssistantMessage sessionId="s1" content={content} isStreaming />)

    expect(recordFakeToolUse).not.toHaveBeenCalled()
    // The notice still renders mid-stream so the user sees something is wrong
    // without waiting for the whole turn.
    expect(screen.getByTestId('fake-tool-use-notice')).toBeInTheDocument()
  })

  it('renders a "+N more" hint when the model retried multiple times in one turn', () => {
    const content = [
      'First try:',
      '<tool_use id="t1" name="Bash">{"command":"ls"}</tool_use>',
      'Apologies, retrying:',
      '<tool_use id="t2" name="Bash">{"command":"ls -la"}</tool_use>',
    ].join('\n')

    render(<AssistantMessage sessionId="s1" content={content} />)

    const more = screen.getByTestId('fake-tool-use-notice-more')
    expect(more.textContent).toMatch(/\+1/)
  })

  it('leaves clean text alone (no false positive on regular markdown)', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'I will run `npm test` and report back.'}
      />,
    )
    expect(screen.queryByTestId('fake-tool-use-notice')).not.toBeInTheDocument()
    expect(recordFakeToolUse).not.toHaveBeenCalled()
  })

  it('does NOT trigger on `<tool_use>` examples that live inside a fenced code block (legitimate docs)', () => {
    const content = [
      'Some providers emit:',
      '```xml',
      '<tool_use name="Bash" id="t1">{"command":"ls"}</tool_use>',
      '```',
    ].join('\n')

    render(<AssistantMessage sessionId="s1" content={content} />)
    expect(screen.queryByTestId('fake-tool-use-notice')).not.toBeInTheDocument()
    expect(recordFakeToolUse).not.toHaveBeenCalled()
  })
})
