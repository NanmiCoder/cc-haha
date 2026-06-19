import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { openBrowser } = vi.hoisted(() => ({ openBrowser: vi.fn() }))
vi.mock('../../stores/browserPanelStore', () => ({
  useBrowserPanelStore: { getState: () => ({ open: openBrowser }) },
}))
vi.mock('../../lib/desktopRuntime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

// Mock openTargetStore for the open-with menu (used by the cards)
const ensureTargets = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const openTargetFn = vi.hoisted(() => vi.fn())
vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: {
    getState: () => ({ ensureTargets, targets: [], openTarget: openTargetFn }),
  },
}))

// Mock workspacePanelStore — usable both as a hook selector and via getState().
// workDir is undefined (no active workspace) so relative paths resolve as-is.
const openPreviewFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../stores/workspacePanelStore', () => {
  const state = { statusBySession: {} as Record<string, { workDir?: string } | undefined>, openPreview: openPreviewFn }
  const useWorkspacePanelStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useWorkspacePanelStore }
})

// Mock tauri shell (used by openSystem inside the card's open-with)
const shellOpen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellOpen }))

// Mock i18n — return the key as the label so we can assert on keys
vi.mock('../../i18n', () => ({
  useTranslation: () => (k: string, v?: Record<string, string>) => (v?.target ? `${k}:${v.target}` : k),
}))

// Mock settingsStore (safety net for transitive i18n usage)
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign((sel: (s: { locale: string }) => unknown) => sel({ locale: 'en' }), {
    getState: () => ({ locale: 'en' }),
    subscribe: () => () => {},
  }),
}))

import { AssistantMessage } from './AssistantMessage'

afterEach(() => {
  openBrowser.mockReset()
  ensureTargets.mockReset().mockResolvedValue(undefined)
  openTargetFn.mockReset()
  openPreviewFn.mockReset().mockResolvedValue(undefined)
})

describe('AssistantMessage link routing', () => {
  it('opens a localhost link in the in-app browser on left-click', () => {
    render(<AssistantMessage sessionId="s1" content={'打开 [预览](http://localhost:5173/)'} />)
    // The clickable element is the rendered markdown anchor (the card title is a span).
    fireEvent.click(screen.getByRole('link', { name: '预览' }))
    expect(openBrowser).toHaveBeenCalledWith('s1', 'http://localhost:5173/')
  })
})

describe('AssistantMessage output-target cards', () => {
  it('renders a card for a localhost URL after streaming ends', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'本地服务运行在 http://localhost:5173/ 上'}
        isStreaming={false}
      />,
    )
    expect(screen.getAllByText('http://localhost:5173/').length).toBeGreaterThan(0)
    expect(screen.getByText('assistantOutputs.kind.localhost')).toBeInTheDocument()
  })

  it('does NOT render a localhost card for URLs shown inside a log code block', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={[
          '日志前 50 行：',
          '```log',
          '[08:29:36][INFO] 代理服务已启动: 127.0.0.1:15721',
          '[08:29:36][INFO] Claude Live 配置已接管，代理地址: http://127.0.0.1:15721',
          '```',
        ].join('\n')}
        isStreaming={false}
      />,
    )

    expect(screen.queryByText('assistantOutputs.kind.localhost')).toBeNull()
  })

  it('renders a card for a markdown link with its Markdown badge', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'见 [说明文档](docs/readme.md)'}
        isStreaming={false}
      />,
    )
    // Link text appears in both the bubble anchor and the card title; the badge is unique.
    expect(screen.getByRole('link', { name: '说明文档' })).toBeInTheDocument()
    expect(screen.getByText('assistantOutputs.kind.markdown')).toBeInTheDocument()
  })

  it('renders a relative image inline (an <img>) but NOT as an image card', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'渲染结果见 outputs/foo/preview_frame.png'}
        isStreaming={false}
      />,
    )
    // Image renders inline through InlineImageGallery (workDir is undefined in this
    // test's mock, so the relative path resolves as-is and is served via /preview-fs).
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(
      'http://127.0.0.1:4321/preview-fs/s1/outputs/foo/preview_frame.png',
    )
    // ...and is NOT duplicated as an output-target card.
    expect(screen.queryByText('assistantOutputs.kind.image')).toBeNull()
  })

  it('renders a relative video inline (a <video>) but NOT as a card', () => {
    const { container } = render(
      <AssistantMessage
        sessionId="s1"
        content={'生成的视频见 outputs/demo.mp4'}
        isStreaming={false}
      />,
    )
    // Video renders inline through InlineVideoGallery (workDir is undefined in this
    // test's mock, so the relative path resolves as-is and is served via /preview-fs).
    const video = container.querySelector('video') as HTMLVideoElement
    expect(video).not.toBeNull()
    expect(video.getAttribute('src')).toBe('http://127.0.0.1:4321/preview-fs/s1/outputs/demo.mp4')
    // ...and is NOT duplicated as an output-target card (no extra open/copy controls).
    expect(screen.queryByText('assistantOutputs.kind.image')).toBeNull()
  })

  it('still renders md/html/localhost cards when those references are present', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={[
          '本地服务 http://localhost:5173/',
          '见 [说明](docs/readme.md)',
          '页面 [首页](out/index.html)',
        ].join('\n')}
        isStreaming={false}
      />,
    )
    expect(screen.getByText('assistantOutputs.kind.localhost')).toBeInTheDocument()
    expect(screen.getByText('assistantOutputs.kind.markdown')).toBeInTheDocument()
    expect(screen.getByText('assistantOutputs.kind.html')).toBeInTheDocument()
  })

  it('does NOT render cards while streaming', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'本地服务运行在 http://localhost:5173/ 上'}
        isStreaming={true}
      />,
    )
    expect(screen.queryByText('assistantOutputs.kind.localhost')).toBeNull()
  })

  it('does NOT render cards when there are no previewable references', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'装一下 `npm install` 然后看 [anchor](#section)'}
        isStreaming={false}
      />,
    )
    expect(screen.queryByText('assistantOutputs.kind.localhost')).toBeNull()
    expect(screen.queryByText('Markdown')).toBeNull()
  })

  it('does NOT render cards when sessionId is absent', () => {
    render(
      <AssistantMessage
        content={'本地服务运行在 http://localhost:5173/ 上'}
        isStreaming={false}
      />,
    )
    expect(screen.queryByText('assistantOutputs.kind.localhost')).toBeNull()
  })
})
