import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { lazy } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ApiError } from '@/api/client'
import { sessionsApi } from '@/api/sessions'
import { resetDocumentBlobCacheForTests } from '@/lib/workspace/documentBlobCache'
import { openLocalFileWithSystem } from '@/lib/systemFileOpen'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspaceContentStore, workspaceFileKey } from '@/stores/workspaceContentStore'
import { useWorkspaceChatContextStore, formatWorkspaceReferencePrompt } from '@/stores/workspaceChatContextStore'
import { DocumentSurface, type DocumentSurfaceProps } from './DocumentSurface'
import type { DocumentViewerProps, DocumentViewers } from './documentViewers'

vi.mock('@/lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn(),
  reportOpenFailure: vi.fn(),
}))
vi.mock('@/lib/diagnosticsCapture', () => ({
  reportReactError: vi.fn(),
}))

type Pending = { resolve: (blob: Blob) => void; reject: (error: unknown) => void; signal: AbortSignal | undefined }

let pending: Pending[]
let getWorkspaceRaw: MockInstance<typeof sessionsApi.getWorkspaceRaw>
let viewerProps: DocumentViewerProps[]

/** A stand-in for a real engine: records what it was handed and draws a marker. */
const FakeViewer = lazy(async () => ({
  default: (props: DocumentViewerProps) => {
    viewerProps.push(props)
    return (
      <div data-testid="viewer" data-version={props.version} data-refreshing={String(props.refreshing)}>
        <button type="button" onClick={() => props.onZoomChange(2)}>set zoom</button>
        <button type="button" onClick={() => props.onZoomChange(undefined)}>reset zoom</button>
        <button type="button" onClick={() => props.onSheetChange?.('Second')}>pick sheet</button>
      </div>
    )
  },
}))

const viewers: DocumentViewers = { pdf: FakeViewer }

const baseProps: DocumentSurfaceProps = {
  sessionId: 's1',
  path: 'out/thesis.pdf',
  absolutePath: '/work/out/thesis.pdf',
  previewType: 'pdf',
  version: 'v1',
  initialView: undefined,
  viewers,
}

function renderSurface(overrides: Partial<DocumentSurfaceProps> = {}) {
  return render(<DocumentSurface {...baseProps} {...overrides} />)
}

async function deliver(index: number, blob = new Blob(['bytes'])) {
  await act(async () => { pending[index]!.resolve(blob) })
  await screen.findByTestId('viewer')
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useWorkspaceContentStore.setState({ fileViewByKey: {} })
  resetDocumentBlobCacheForTests()
  useWorkspaceChatContextStore.setState({ referencesBySession: {} })
  pending = []
  viewerProps = []
  vi.mocked(openLocalFileWithSystem).mockReset().mockResolvedValue(undefined)
  getWorkspaceRaw = vi.spyOn(sessionsApi, 'getWorkspaceRaw').mockImplementation(
    (_session, _path, signal) => new Promise<Blob>((resolve, reject) => {
      pending.push({ resolve, reject, signal })
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
  )
})

afterEach(() => {
  getWorkspaceRaw.mockRestore()
  resetDocumentBlobCacheForTests()
})

describe('DocumentSurface', () => {
  it('shows a loading state until the bytes arrive, then hands them to the viewer', async () => {
    renderSurface()

    expect(screen.getByRole('status')).toHaveTextContent('Loading document...')
    expect(screen.queryByTestId('viewer')).not.toBeInTheDocument()

    const blob = new Blob(['%PDF'])
    await deliver(0, blob)

    expect(screen.queryByText('Loading document...')).not.toBeInTheDocument()
    expect(viewerProps.at(-1)).toMatchObject({
      path: 'out/thesis.pdf',
      absolutePath: '/work/out/thesis.pdf',
      blob,
      version: 'v1',
      refreshing: false,
    })
  })

  it('requests the file by its workspace path, once', async () => {
    renderSurface()
    await deliver(0)

    expect(getWorkspaceRaw).toHaveBeenCalledTimes(1)
    expect(getWorkspaceRaw).toHaveBeenCalledWith('s1', 'out/thesis.pdf', expect.any(AbortSignal))
  })

  it('waits for the file metadata before fetching anything', () => {
    renderSurface({ version: undefined })

    expect(getWorkspaceRaw).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Loading document...')
  })

  describe('a format with no viewer yet', () => {
    it('says so and offers the system app, without downloading the file', () => {
      renderSurface({ previewType: 'docx', path: 'thesis.docx', absolutePath: '/work/thesis.docx' })

      expect(screen.getByRole('status')).toHaveTextContent("This file type can't be previewed here.")
      expect(getWorkspaceRaw).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))
      expect(openLocalFileWithSystem).toHaveBeenCalledWith('/work/thesis.docx')
    })

    it('offers no system action for a path that is not absolute', () => {
      renderSurface({ previewType: 'docx', absolutePath: 'thesis.docx' })

      expect(screen.queryByRole('button', { name: 'Open in system app' })).not.toBeInTheDocument()
    })
  })

  describe('when the bytes cannot be fetched', () => {
    it.each([
      [403, "This file is outside the workspace and can't be previewed here."],
      [404, 'File not found.'],
      [413, 'File is too large to preview.'],
      [500, 'This document could not be displayed.'],
    ])('explains a %i in words', async (status, message) => {
      renderSurface()
      await act(async () => { pending[0]!.reject(new ApiError(status, { message: 'server said no' })) })

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
    })

    it('offers the system app as the way out', async () => {
      renderSurface()
      await act(async () => { pending[0]!.reject(new ApiError(413, {})) })

      fireEvent.click(await screen.findByRole('button', { name: 'Open in system app' }))

      expect(openLocalFileWithSystem).toHaveBeenCalledWith('/work/out/thesis.pdf')
    })

    it('offers a retry where trying again could help, and it works', async () => {
      renderSurface()
      await act(async () => { pending[0]!.reject(new ApiError(500, {})) })

      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(pending).toHaveLength(2))
      await deliver(1)

      expect(screen.getByTestId('viewer')).toBeInTheDocument()
    })

    it.each([403, 413, 415])('offers no retry for a %i, which will not change its mind', async (status) => {
      renderSurface()
      await act(async () => { pending[0]!.reject(new ApiError(status, {})) })

      await screen.findByRole('alert')
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    })
  })

  describe('when the file changes underneath a reader', () => {
    it('keeps the previous render on screen while the new version loads, and says so', async () => {
      const { rerender } = renderSurface()
      await deliver(0)

      rerender(<DocumentSurface {...baseProps} version="v2" />)

      const viewer = await screen.findByTestId('viewer')
      expect(viewer).toHaveAttribute('data-version', 'v1')
      expect(viewer).toHaveAttribute('data-refreshing', 'true')
      expect(screen.getByRole('status')).toHaveTextContent('Updating preview...')

      await act(async () => { pending[1]!.resolve(new Blob(['newer'])) })

      await waitFor(() => expect(screen.getByTestId('viewer')).toHaveAttribute('data-version', 'v2'))
      expect(screen.getByTestId('viewer')).toHaveAttribute('data-refreshing', 'false')
      expect(screen.queryByText('Updating preview...')).not.toBeInTheDocument()
    })

    it('keeps the last good render and reports the failure when a refresh fails', async () => {
      const { rerender } = renderSurface()
      await deliver(0)

      rerender(<DocumentSurface {...baseProps} version="v2" />)
      await act(async () => { pending[1]!.reject(new Error('unzip failed: incomplete file')) })

      // The agent was mid-write. The reader's page must survive it.
      expect(screen.getByTestId('viewer')).toHaveAttribute('data-version', 'v1')
      expect(await screen.findByRole('status')).toHaveTextContent('unzip failed: incomplete file')
    })

    it('words a refresh the server refused, instead of quoting its response body', async () => {
      const { rerender } = renderSurface()
      await deliver(0)

      rerender(<DocumentSurface {...baseProps} version="v2" />)
      // What `apiGetBlob` throws: the response body as text, which for the workspace is JSON.
      await act(async () => {
        pending[1]!.reject(new ApiError(404, '{"error":"NOT_FOUND","message":"File not found: out/thesis.pdf"}'))
      })

      const banner = await screen.findByRole('status')
      expect(banner).toHaveTextContent('Showing the last loaded version — refresh failed: File not found.')
      expect(banner).not.toHaveTextContent('NOT_FOUND')
    })
  })

  describe('when the viewer itself cannot be loaded', () => {
    // `lazy` throws on a failed chunk fetch: an old page against a newer server, a bad link.
    const brokenViewers = (): DocumentViewers => ({
      pdf: lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module'))),
    })
    let consoleError: MockInstance<typeof console.error>

    beforeEach(() => {
      // React reports a caught render error to the console as well.
      consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleError.mockRestore()
    })

    it('says so in the panel, and offers the system app, instead of taking the window down', async () => {
      renderSurface({ viewers: brokenViewers() })
      await act(async () => { pending[0]!.resolve(new Blob(['bytes'])) })

      expect(await screen.findByRole('alert')).toHaveTextContent("The document viewer can't start in this environment.")
      expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
    })

    it('offers to load the page again, the one thing that makes a browser fetch the chunk anew', async () => {
      // A module whose fetch failed is remembered as failed for the life of the page, network
      // back or not, so trying again in place cannot work; a newer bundle, after a server
      // update, arrives the same way.
      const reloadPage = vi.fn()
      renderSurface({ viewers: brokenViewers(), reloadPage })
      await act(async () => { pending[0]!.resolve(new Blob(['bytes'])) })

      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

      expect(reloadPage).toHaveBeenCalledTimes(1)
    })

    it('gives the next version of the file its own chance, since a viewer that broke on one may draw the next', async () => {
      const CrashesOnFirst = lazy(async () => ({
        default: (props: DocumentViewerProps) => {
          if (props.version === 'v1') throw new Error('cannot draw this one')
          return <div data-testid="viewer" data-version={props.version} />
        },
      }))
      const { rerender } = renderSurface({ viewers: { pdf: CrashesOnFirst } })
      await act(async () => { pending[0]!.resolve(new Blob(['bytes'])) })
      expect(await screen.findByRole('alert')).toBeInTheDocument()

      // The agent rewrote the file: the version that broke the viewer is replaced.
      rerender(<DocumentSurface {...baseProps} viewers={{ pdf: CrashesOnFirst }} version="v2" />)
      await act(async () => { pending[1]!.resolve(new Blob(['newer'])) })

      expect(await screen.findByTestId('viewer')).toHaveAttribute('data-version', 'v2')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('zoom', () => {
    const zoomOf = () => useWorkspaceContentStore.getState().fileViewByKey[workspaceFileKey('s1', 'out/thesis.pdf')]?.zoom

    it('hands the viewer the zoom the reader chose last time', async () => {
      useWorkspaceContentStore.getState().setFileZoom('s1', 'out/thesis.pdf', 1.5)
      renderSurface()
      await deliver(0)

      expect(viewerProps.at(-1)?.zoom).toBe(1.5)
    })

    it('records a zoom the viewer reports, and a reset to the default', async () => {
      renderSurface()
      await deliver(0)

      fireEvent.click(screen.getByRole('button', { name: 'set zoom' }))
      expect(zoomOf()).toBe(2)
      await waitFor(() => expect(viewerProps.at(-1)?.zoom).toBe(2))

      fireEvent.click(screen.getByRole('button', { name: 'reset zoom' }))
      expect(zoomOf()).toBeUndefined()
    })

    it('does not mix up two files open in the same session', async () => {
      useWorkspaceContentStore.getState().setFileZoom('s1', 'out/other.pdf', 3)
      renderSurface()
      await deliver(0)

      expect(viewerProps.at(-1)?.zoom).toBeUndefined()
    })
  })

  describe('worksheet', () => {
    const sheetOf = () => useWorkspaceContentStore.getState().fileViewByKey[workspaceFileKey('s1', 'out/thesis.pdf')]?.sheet

    it('hands the viewer the worksheet the reader was on last time', async () => {
      useWorkspaceContentStore.getState().setFileSheet('s1', 'out/thesis.pdf', 'Second')
      renderSurface()
      await deliver(0)

      expect(viewerProps.at(-1)?.sheet).toBe('Second')
    })

    it('records a worksheet the viewer reports, and hands it back', async () => {
      renderSurface()
      await deliver(0)
      expect(viewerProps.at(-1)?.sheet).toBeUndefined()

      fireEvent.click(screen.getByRole('button', { name: 'pick sheet' }))

      expect(sheetOf()).toBe('Second')
      await waitFor(() => expect(viewerProps.at(-1)?.sheet).toBe('Second'))
    })

    it('does not mix up two files open in the same session', async () => {
      useWorkspaceContentStore.getState().setFileSheet('s1', 'out/other.xlsx', 'Elsewhere')
      renderSurface()
      await deliver(0)

      expect(viewerProps.at(-1)?.sheet).toBeUndefined()
    })
  })

  it('passes the scroll position the tab was last left at through to the viewer', async () => {
    const initialView = { scrollTop: 320, scrollLeft: 0 }
    renderSurface({ initialView })
    await deliver(0)

    expect(viewerProps.at(-1)?.initialView).toBe(initialView)
  })

  it('does not offer a stale copy for a different file after the path changes', async () => {
    const { rerender } = renderSurface()
    await deliver(0, new Blob(['first']))

    rerender(<DocumentSurface {...baseProps} path="out/second.pdf" absolutePath="/work/out/second.pdf" />)

    // A new path is a new document: it loads, it does not borrow the previous bytes.
    await waitFor(() => expect(getWorkspaceRaw).toHaveBeenCalledWith('s1', 'out/second.pdf', expect.any(AbortSignal)))
    expect(screen.queryByTestId('viewer')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading document...')
  })
})


describe('document comments', () => {
  it('adds the original file, document location, quote and note to the owning chat', async () => {
    renderSurface()
    await deliver(0)
    act(() => viewerProps.at(-1)!.onAnnotate?.({ text: 'Quarterly revenue', location: 'Page 2' }))
    expect(screen.getByRole('button', { name: 'Add comment' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Correct this total' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    const refs = useWorkspaceChatContextStore.getState().referencesBySession.s1!
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ path: 'out/thesis.pdf', absolutePath: '/work/out/thesis.pdf', quote: 'Quarterly revenue', note: 'Page 2\nCorrect this total' })
    expect(refs[0]!.lineStart).toBeUndefined()
    expect(formatWorkspaceReferencePrompt(refs)).toContain('Page 2\nCorrect this total')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useWorkspaceChatContextStore.getState().referencesBySession.other).toBeUndefined()
  })

  it('cancels without adding a reference and discards comments after document refresh', async () => {
    const view = renderSurface()
    await deliver(0)
    act(() => viewerProps.at(-1)!.onAnnotate?.({ text: 'Old text', location: 'Page 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useWorkspaceChatContextStore.getState().referencesBySession.s1).toBeUndefined()
    act(() => viewerProps.at(-1)!.onAnnotate?.({ text: 'Old text', location: 'Page 1' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Stale note' } })
    view.rerender(<DocumentSurface {...baseProps} version="v2" />)
    await deliver(1, new Blob(['new bytes']))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useWorkspaceChatContextStore.getState().referencesBySession.s1).toBeUndefined()
  })
})


it('keeps same-note comments on different selections independently removable', async () => {
  renderSurface()
  await deliver(0)
  for (const text of ['First paragraph', 'Second paragraph']) {
    act(() => viewerProps.at(-1)!.onAnnotate?.({ text, location: 'Page 1' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Rewrite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
  }
  const store = useWorkspaceChatContextStore.getState()
  const refs = store.referencesBySession.s1!
  expect(refs).toHaveLength(2)
  expect(refs[0]!.id).not.toBe(refs[1]!.id)
  act(() => store.removeReference('s1', refs[0]!.id))
  expect(useWorkspaceChatContextStore.getState().referencesBySession.s1).toEqual([refs[1]])
})
