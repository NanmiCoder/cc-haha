import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceStatusResult } from '../../api/sessions'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { openLocalFileWithSystem } from '../../lib/systemFileOpen'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { AssistantMessage } from './AssistantMessage'

const BASE = 'http://127.0.0.1:4321'
const apiGetBlob = vi.hoisted(() => vi.fn())

vi.mock('../../api/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  apiGetBlob,
  getBaseUrl: () => 'http://127.0.0.1:4321',
}))

vi.mock('../../lib/desktopRuntime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))
vi.mock('../../lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn().mockResolvedValue(undefined),
  reportOpenFailure: vi.fn(),
}))

const filesystem = (path: string) => `${BASE}/api/filesystem/file?path=${encodeURIComponent(path)}`

function withWorkDir(workDir: string | undefined) {
  const status: WorkspaceStatusResult | undefined = workDir
    ? { state: 'ok', workDir, repoName: null, branch: null, isGitRepo: false, changedFiles: [] }
    : undefined
  useWorkspaceContentStore.setState({ statusBySession: status ? { s1: status } : {} })
}

/** The pictures the prose itself carries, not the gallery under it. */
function proseImages(container: HTMLElement): HTMLImageElement[] {
  return Array.from(container.querySelectorAll<HTMLImageElement>('.markdown-prose img'))
}

function renderMessage(content: string, props: { isStreaming?: boolean } = {}) {
  return render(<AssistantMessage sessionId="s1" content={content} isStreaming={props.isStreaming ?? false} />)
}

beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null)
  apiGetBlob.mockReset().mockRejectedValue(new Error('404'))
  useSettingsStore.setState({ locale: 'en' })
  withWorkDir('/repo')
  vi.mocked(openLocalFileWithSystem).mockReset().mockResolvedValue(undefined)
  Reflect.deleteProperty(window, 'desktopHost')
})

afterEach(() => {
  act(() => withWorkDir(undefined))
  Reflect.deleteProperty(window, 'desktopHost')
  vi.restoreAllMocks()
})

describe('AssistantMessage · Markdown pictures on disk', () => {
  it('resets an outside-workspace image failure when the session changes even though its URL stays the same', async () => {
    const content = '![missing](/tmp/missing.png)'
    const { container, rerender } = render(<AssistantMessage sessionId="s1" content={content} />)
    fireEvent.error(proseImages(container)[0]!)
    await screen.findByRole('alert')
    act(() => useWorkspaceContentStore.setState({
      statusBySession: { s2: { state: 'ok', workDir: '/repo', repoName: null, branch: null, isGitRepo: false, changedFiles: [] } },
    }))
    rerender(<AssistantMessage sessionId="s2" content={content} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(proseImages(container)[0]).toHaveAttribute('src', filesystem('/tmp/missing.png'))
    expect(proseImages(container)[0]).toBeVisible()
  })

  it('does not apply a late image from the previous session to the new one', async () => {
    let finish!: (blob: Blob) => void
    apiGetBlob.mockReturnValueOnce(new Promise<Blob>((resolve) => { finish = resolve }))
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:old-session'), configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
    const content = '![missing](/tmp/missing.png)'
    const { container, rerender } = render(<AssistantMessage sessionId="s1" content={content} />)
    fireEvent.error(proseImages(container)[0]!)
    rerender(<AssistantMessage sessionId="s2" content={content} />)
    act(() => finish(new Blob(['png'], { type: 'image/png' })))
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-session'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(proseImages(container)[0]).not.toHaveAttribute('src', 'blob:old-session')
  })
  it('serves a picture in the workdir from the session sandbox', () => {
    const { container } = renderMessage('![chart](/repo/output/chart.png)')

    expect(proseImages(container).map((image) => image.getAttribute('src'))).toEqual([
      `${BASE}/preview-fs/s1//repo/output/chart.png`,
    ])
  })

  it('shows a picture outside the workdir, which used to be a broken image', () => {
    const { container } = renderMessage('![chart](/Users/me/Pictures/chart.png)')

    expect(proseImages(container).map((image) => image.getAttribute('src'))).toEqual([
      filesystem('/Users/me/Pictures/chart.png'),
    ])
  })

  it.each([
    ['a file:// URL with a drive letter', '![chart](file:///C:/Users/me/chart.png)', 'C:/Users/me/chart.png'],
    ['a Windows path', '![chart](C:\\Users\\me\\chart.png)', 'C:/Users/me/chart.png'],
    ['a home-relative path', '![chart](~/Pictures/chart.png)', '~/Pictures/chart.png'],
    ['the QA-003 home-relative path to /tmp', '![chart](~/../../tmp/qa/sample.png)', '~/../../tmp/qa/sample.png'],
    ['an encoded home-relative path', '![chart](~/%2e%2e/%2e%2e/tmp/My%20Pics/sample.png)', '~/../../tmp/My Pics/sample.png'],
    ['a file:// URL', '![chart](file:///Users/me/chart.png)', '/Users/me/chart.png'],
  ])('shows a picture written as %s', (_label, markdown, path) => {
    const { container } = renderMessage(markdown)

    expect(proseImages(container).map((image) => image.getAttribute('src'))).toEqual([filesystem(path)])
  })

  it('routes a picture again once the workdir arrives, which is fetched after the reply first renders', () => {
    withWorkDir(undefined)
    const { container } = renderMessage('![chart](/Users/me/Pictures/chart.png)')
    // Without a workdir every absolute path is tried on the session route.
    expect(proseImages(container).map((image) => image.getAttribute('src'))).toEqual([
      `${BASE}/preview-fs/s1//Users/me/Pictures/chart.png`,
    ])

    act(() => withWorkDir('/repo'))

    expect(proseImages(container).map((image) => image.getAttribute('src'))).toEqual([
      filesystem('/Users/me/Pictures/chart.png'),
    ])
  })

  it('does not ask the filesystem route for what is not a picture', () => {
    const { container } = renderMessage('![notes](/Users/me/notes.txt)')

    expect(proseImages(container)).toHaveLength(0)
  })

  it('still refuses a remote picture', () => {
    const { container } = renderMessage('![track](https://attacker.example/track.png)')

    expect(proseImages(container)).toHaveLength(0)
  })

  it('shows none while the reply is still being written', () => {
    const { container } = renderMessage('![chart](/Users/me/Pictures/chart.png)', { isStreaming: true })

    expect(proseImages(container)).toHaveLength(0)
  })
})

describe('AssistantMessage · looking closer at a picture', () => {
  const TWO = '![first](/Users/me/one.png)\n\n![second](/repo/two.png)'

  it('opens the picture clicked in a viewer, and says which of how many', () => {
    const { container } = renderMessage(TWO)

    fireEvent.click(proseImages(container)[1]!)

    const dialog = screen.getByRole('dialog', { name: 'second' })
    expect(within(dialog).getByText('2 / 2')).toBeInTheDocument()
    expect(dialog.querySelector('img')).toHaveAttribute('src', `${BASE}/preview-fs/s1//repo/two.png`)
  })

  it('opens the QA-003 home-relative picture in the viewer', () => {
    const { container } = renderMessage('![tilde](~/../../tmp/qa/sample.png)')

    fireEvent.click(proseImages(container)[0]!)

    expect(screen.getByRole('dialog', { name: 'tilde' }).querySelector('img'))
      .toHaveAttribute('src', filesystem('~/../../tmp/qa/sample.png'))
  })

  it('moves between the pictures of the reply', () => {
    const { container } = renderMessage(TWO)
    fireEvent.click(proseImages(container)[0]!)

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))

    expect(screen.getByRole('dialog', { name: 'second' })).toBeInTheDocument()
  })

  it('closes', () => {
    const { container } = renderMessage(TWO)
    fireEvent.click(proseImages(container)[0]!)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names a picture that has no description after its file', () => {
    const { container } = renderMessage('![](/Users/me/Pictures/chart.png)')

    fireEvent.click(proseImages(container)[0]!)

    expect(screen.getByRole('dialog', { name: 'chart.png' })).toBeInTheDocument()
  })

  it('leaves a picture inside a link to the link', () => {
    const { container } = renderMessage('[![badge](/Users/me/badge.png)](https://example.com)')

    fireEvent.click(proseImages(container)[0]!)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  describe('opening the original', () => {
    const desktop = () => {
      window.desktopHost = {
        ...browserHost,
        kind: 'electron',
        isDesktop: true,
        capabilities: { ...browserHost.capabilities, shell: true },
      }
    }
    const open = () => screen.queryByRole('button', { name: 'Open in system app' })

    it.each([
      ['outside the workdir', '![c](/Users/me/Pictures/c.png)', '/Users/me/Pictures/c.png'],
      ['inside the workdir', '![c](/repo/out/c.png)', '/repo/out/c.png'],
      ['relative to the workdir', '![c](out/c.png)', '/repo/out/c.png'],
      ['under the home directory', '![c](~/Pictures/c.png)', '~/Pictures/c.png'],
      ['on a Windows drive', '![c](file:///C:/Users/me/c.png)', 'C:/Users/me/c.png'],
    ])('hands the file to the system for a picture %s', (_label, markdown, path) => {
      desktop()
      const { container } = renderMessage(markdown)
      fireEvent.click(proseImages(container)[0]!)

      fireEvent.click(open()!)

      expect(openLocalFileWithSystem).toHaveBeenCalledWith(path)
    })

    it('places a picture relative to the workdir once the workdir arrives', () => {
      desktop()
      withWorkDir(undefined)
      const { container } = renderMessage('![c](out/c.png)')
      act(() => withWorkDir('/repo'))
      fireEvent.click(proseImages(container)[0]!)

      fireEvent.click(open()!)

      expect(openLocalFileWithSystem).toHaveBeenCalledWith('/repo/out/c.png')
    })

    it.each([
      ['a launcher', '![c](run.terminal)'],
      ['a document', '![c](/repo/notes.txt)'],
    ])('does not offer it for %s written as a picture', (_label, markdown) => {
      desktop()
      const { container } = renderMessage(markdown)
      // A picture that will not load can still be clicked; the viewer just has no
      // original to hand to the system, which would open a launcher as one.
      fireEvent.click(proseImages(container)[0]!)

      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(open()).not.toBeInTheDocument()
      expect(openLocalFileWithSystem).not.toHaveBeenCalled()
    })

    it('does not offer it in a browser', () => {
      const { container } = renderMessage('![c](/Users/me/Pictures/c.png)')
      fireEvent.click(proseImages(container)[0]!)

      expect(open()).not.toBeInTheDocument()
    })

    it('does not offer it for a picture that is not a file', () => {
      desktop()
      const { container } = renderMessage('![inline](data:image/png;base64,AAAA)')
      fireEvent.click(proseImages(container)[0]!)

      expect(open()).not.toBeInTheDocument()
    })
  })
})
