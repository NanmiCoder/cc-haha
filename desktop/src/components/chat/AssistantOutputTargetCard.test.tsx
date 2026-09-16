import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { openBrowser } = vi.hoisted(() => ({ openBrowser: vi.fn() }))
// The unified open entry point replaced the per-store `open` / `openPreview`
// pair: every caller now names a target and the controller decides the tab.
vi.mock('../../lib/workspace/openTarget', () => ({
  workspaceOpen: {
    file: (...args: unknown[]) => openPreviewFn(...args),
    browser: (...args: unknown[]) => openBrowser(...args),
    review: (...args: unknown[]) => openPreviewFn(...args),
    terminal: vi.fn(),
  },
  openWorkspaceTarget: vi.fn(),
}))

vi.mock('../../lib/desktopRuntime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

const ensureTargets = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const openTargetFn = vi.hoisted(() => vi.fn())
vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: {
    getState: () => ({ ensureTargets, targets: [], openTarget: openTargetFn }),
  },
}))

const openPreviewFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const shellOpen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellOpen }))

// Mock i18n — return the key (plus interpolation) so we can assert on keys
vi.mock('../../i18n', () => ({
  useTranslation: () => (k: string, v?: Record<string, string>) => (v?.target ? `${k}:${v.target}` : k),
}))

import { AssistantOutputTargetCard } from './AssistantOutputTargetCard'
import type { AssistantOutputTarget } from '../../lib/assistantOutputTargets'

const markdownTarget: AssistantOutputTarget = {
  id: 'markdown:docs/readme.md',
  kind: 'markdown',
  title: 'readme.md',
  subtitle: 'docs/readme.md',
  href: 'docs/readme.md',
  normalizedPath: 'docs/readme.md',
  confidence: 'high',
  source: 'markdown-link',
}

const localhostTarget: AssistantOutputTarget = {
  id: 'localhost-url:http://localhost:5173/',
  kind: 'localhost-url',
  title: 'http://localhost:5173/',
  href: 'http://localhost:5173/',
  confidence: 'high',
  source: 'plain-url',
}

const documentTarget: AssistantOutputTarget = {
  id: 'file:outputs/brief.docx',
  kind: 'file',
  title: 'brief.docx',
  subtitle: 'outputs/brief.docx',
  href: 'outputs/brief.docx',
  normalizedPath: 'outputs/brief.docx',
  confidence: 'high',
  source: 'changed-file',
}

afterEach(() => {
  openBrowser.mockReset()
  ensureTargets.mockReset().mockResolvedValue(undefined)
  openTargetFn.mockReset()
  openPreviewFn.mockReset().mockResolvedValue(undefined)
  shellOpen.mockReset().mockResolvedValue(undefined)
})

describe('AssistantOutputTargetCard', () => {
  it('renders a markdown target title + Markdown badge', () => {
    render(<AssistantOutputTargetCard target={markdownTarget} sessionId="s1" />)
    expect(screen.getByText('readme.md')).toBeInTheDocument()
    expect(screen.getByText('assistantOutputs.kind.markdown')).toBeInTheDocument()
    expect(screen.getByText('docs/readme.md')).toBeInTheDocument()
  })

  it('renders a localhost target title + Localhost badge (URL not duplicated)', () => {
    render(<AssistantOutputTargetCard target={localhostTarget} sessionId="s1" />)
    // subtitle equals the title for localhost, so the URL renders exactly once.
    expect(screen.getAllByText('http://localhost:5173/')).toHaveLength(1)
    expect(screen.getByText('assistantOutputs.kind.localhost')).toBeInTheDocument()
  })

  it('renders an Office artifact with its concrete document type', () => {
    render(<AssistantOutputTargetCard target={documentTarget} sessionId="s1" />)
    expect(screen.getByText('brief.docx')).toBeInTheDocument()
    expect(screen.getByText('openWith.fileType.document')).toBeInTheDocument()
    expect(screen.getByText('outputs/brief.docx')).toBeInTheDocument()
  })

  it('routes Open to workspace preview for a markdown target', () => {
    render(<AssistantOutputTargetCard target={markdownTarget} sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('assistantOutputs.open'))
    // The trailing args are openPreview's optional `origin` and `reveal` (#1146);
    // a card has no line number to reveal, hence undefined.
    expect(openPreviewFn).toHaveBeenCalledWith('s1', 'docs/readme.md', {})
  })

  it('routes Open to the in-app browser for a localhost target', () => {
    render(<AssistantOutputTargetCard target={localhostTarget} sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('assistantOutputs.open'))
    expect(openBrowser).toHaveBeenCalledWith('s1', 'http://localhost:5173/')
  })

  // The trailing icon button is a discoverability affordance, not the hit area:
  // clicking the file name / path anywhere on the row must open the target.
  it('opens the workspace preview when the row body is clicked', () => {
    render(<AssistantOutputTargetCard target={markdownTarget} sessionId="s1" />)
    fireEvent.click(screen.getByText('readme.md'))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', 'docs/readme.md', {})
  })

  it('opens the in-app browser when a localhost row body is clicked', () => {
    render(<AssistantOutputTargetCard target={localhostTarget} sessionId="s1" />)
    // The badge sits inside the row body too — clicking it is not a dead zone.
    fireEvent.click(screen.getByText('assistantOutputs.kind.localhost'))
    expect(openBrowser).toHaveBeenCalledWith('s1', 'http://localhost:5173/')
  })

  it('exposes the row body as a pointer-cursor button, since button cursors default to the arrow', () => {
    render(<AssistantOutputTargetCard target={markdownTarget} sessionId="s1" />)
    const row = screen.getByLabelText('assistantOutputs.openAria')
    expect(row.tagName).toBe('BUTTON')
    expect(row).toHaveClass('cursor-pointer')
  })

  // The open-with control sits next to the row's own hit area; a full-row click
  // handler that swallows it would open the file instead of the menu.
  it('opens the open-with menu without opening the target when its trigger is clicked', async () => {
    render(<AssistantOutputTargetCard target={localhostTarget} sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('openWith.title'))
    expect(await screen.findByText('openWith.systemBrowser')).toBeInTheDocument()
    expect(openBrowser).not.toHaveBeenCalled()
    expect(openPreviewFn).not.toHaveBeenCalled()
  })

  it('does not render a copy button for output target cards', () => {
    render(<AssistantOutputTargetCard target={markdownTarget} sessionId="s1" />)
    expect(screen.queryByLabelText('assistantOutputs.copy')).not.toBeInTheDocument()
  })

  it('opens the open-with menu with URL items for a localhost target', async () => {
    render(<AssistantOutputTargetCard target={localhostTarget} sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('openWith.title'))
    expect(await screen.findByText('openWith.inAppBrowser')).toBeInTheDocument()
    expect(screen.getByText('openWith.systemBrowser')).toBeInTheDocument()
  })

  it('re-clicking the same open-with trigger TOGGLES the menu closed', async () => {
    render(<AssistantOutputTargetCard target={localhostTarget} sessionId="s1" />)
    const trigger = screen.getByLabelText('openWith.title')

    // 1st click → opens
    fireEvent.click(trigger)
    expect(await screen.findByText('openWith.inAppBrowser')).toBeInTheDocument()

    // 2nd click on the SAME trigger → closes (toggle)
    fireEvent.click(trigger)
    expect(screen.queryByText('openWith.inAppBrowser')).not.toBeInTheDocument()
  })
})
