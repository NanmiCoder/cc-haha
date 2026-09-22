import { sessionCollaborationApi } from '@/api/sessionCollaboration'
import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { filesystemApi } from '@/api/filesystem'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from '@/components/chat/ComposerReferenceMenu'

vi.mock('@/api/sessionCollaboration', () => ({ sessionCollaborationApi: { list: vi.fn() } }))
vi.mock('@/api/filesystem', () => ({ filesystemApi: { browse: vi.fn(), search: vi.fn() } }))
const directory = { name: 'src', path: '/work/src', isDirectory: true }
const file = { name: 'app.ts', path: '/work/app.ts', isDirectory: false }
const references: ComposerReferenceCandidate[] = [
  { kind: 'plugin', id: 'hyperframes', name: 'hyperframes', displayName: 'HyperFrames', description: 'Video creation', source: 'plugin', modelText: 'Use HyperFrames', icon: '/connectors/hyperframes.svg' },
  { kind: 'skill', id: 'design', name: 'design', displayName: 'Design', description: 'Create interfaces', source: 'user', path: '/skills/design/SKILL.md', modelText: 'Use design' },
]
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(sessionCollaborationApi.list).mockResolvedValue({ sessions: [] })
  vi.mocked(filesystemApi.browse).mockResolvedValue({ currentPath: '/work', parentPath: '/', entries: [directory, file] })
  vi.mocked(filesystemApi.search).mockResolvedValue({ currentPath: '/work', parentPath: '/', entries: [file] })
})

it('previews capabilities without tabs or filesystem reads and inserts structured references', () => {
  const ref = createRef<ComposerReferenceMenuHandle>()
  const onSelect = vi.fn()
  render(<ComposerReferenceMenu ref={ref} id="references" cwd="/work" references={references} onSelect={onSelect} />)
  expect(screen.getAllByRole('option').map(row => row.textContent)).toEqual(['DesignCreate interfacesPersonal', 'HyperFramesVideo creationPlugin'])
  expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  expect(filesystemApi.browse).not.toHaveBeenCalled()
  expect(filesystemApi.search).not.toHaveBeenCalled()
  expect(screen.getByRole('option', { name: 'HyperFrames' })).toHaveAccessibleDescription('Video creation')
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true })) })
  expect(onSelect).not.toHaveBeenCalled()
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Tab' })) })
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'skill', path: '/skills/design/SKILL.md', modelText: 'Use design' }))
})

it('limits empty previews to three per capability and gives embedded category browsers full access', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ ...references[1]!, id: String(index), displayName: `Design ${index}` }))
  const action = { key: 'manage', label: 'Manage', onSelect: vi.fn() }
  const view = render(<ComposerReferenceMenu id="large" cwd="/work" references={many} actions={[action]} onSelect={vi.fn()} />)
  expect(screen.getAllByRole('option')).toHaveLength(3)
  expect(screen.queryByRole('option', { name: 'Manage' })).not.toBeInTheDocument()
  view.rerender(<ComposerReferenceMenu embedded browseReferences id="large" cwd="/work" references={many} actions={[action]} onSelect={vi.fn()} />)
  expect(screen.getAllByRole('option')).toHaveLength(13)
  fireEvent.click(screen.getByRole('option', { name: 'Manage' }))
  expect(action.onSelect).toHaveBeenCalledOnce()
  expect(filesystemApi.browse).not.toHaveBeenCalled()
})

it('ranks file, capability and action results together with a total limit of eight', async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ ...references[1]!, id: String(index), displayName: `helper ${index}`, description: 'app helper' }))
  const action = { key: 'app', label: 'app', onSelect: vi.fn() }
  render(<ComposerReferenceMenu id="ranked" cwd="/work" filter="app" references={many} actions={[action]} onSelect={vi.fn()} />)
  await screen.findByRole('option', { name: 'app.ts' })
  expect(screen.getAllByRole('option')).toHaveLength(8)
  expect(screen.getAllByRole('option')[0]).toHaveAccessibleName('app')
  expect(screen.queryByRole('group', { name: 'Skills' })).not.toBeInTheDocument()
})

it('keeps directory selection separate from ArrowRight and pointer navigation', async () => {
  vi.mocked(filesystemApi.search).mockResolvedValue({ currentPath: '/work', parentPath: '/', entries: [directory] })
  const ref = createRef<ComposerReferenceMenuHandle>()
  const onSelect = vi.fn()
  const onNavigate = vi.fn()
  render(<ComposerReferenceMenu ref={ref} id="files" cwd="/work" filter="src" references={[]} onSelect={onSelect} onNavigate={onNavigate} />)
  const option = await screen.findByRole('option', { name: 'src' })
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' })) })
  expect(onNavigate).toHaveBeenLastCalledWith('src/')
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.click(option.querySelector('[data-navigate-directory]')!)
  expect(onNavigate).toHaveBeenCalledTimes(2)
  fireEvent.click(option)
  expect(onSelect).toHaveBeenCalledWith({ label: 'src/', path: '/work/src', isDirectory: true })
})

it('browses directory queries without filtering out their children', async () => {
  const onSelect = vi.fn()
  render(<ComposerReferenceMenu id="path" cwd="/work" filter="src/" references={references} onSelect={onSelect} />)
  await screen.findByRole('option', { name: 'app.ts' })
  expect(filesystemApi.browse).toHaveBeenCalledWith('/work/src', { includeFiles: true, signal: expect.any(AbortSignal) })
  expect(screen.queryByRole('option', { name: 'Design' })).not.toBeInTheDocument()
})

it('discards late query and workspace results and never selects stale files', async () => {
  let oldResolve!: (value: Awaited<ReturnType<typeof filesystemApi.search>>) => void
  vi.mocked(filesystemApi.search).mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve }))
  const onSelect = vi.fn()
  const ref = createRef<ComposerReferenceMenuHandle>()
  const view = render(<ComposerReferenceMenu ref={ref} id="search" cwd="/old" filter="old" references={[]} onSelect={onSelect} />)
  await waitFor(() => expect(filesystemApi.search).toHaveBeenCalled())
  view.rerender(<ComposerReferenceMenu ref={ref} id="search" cwd="/work" filter="app" references={[]} onSelect={onSelect} />)
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })) })
  expect(onSelect).not.toHaveBeenCalled()
  await screen.findByRole('option', { name: 'app.ts' })
  await act(async () => { oldResolve({ currentPath: '/old', parentPath: '/', entries: [{ name: 'old.ts', path: '/old/old.ts', isDirectory: false }] }) })
  expect(screen.queryByRole('option', { name: 'old.ts' })).not.toBeInTheDocument()
  view.rerender(<ComposerReferenceMenu ref={ref} id="search" cwd="/work" references={references} onSelect={onSelect} />)
  expect(screen.queryByRole('option', { name: 'app.ts' })).not.toBeInTheDocument()
})

it('keeps plugin results usable after search failure without exposing raw errors or remote icons', async () => {
  vi.mocked(filesystemApi.search).mockRejectedValue(new Error('secret-server-error'))
  const onSelect = vi.fn()
  render(<ComposerReferenceMenu id="failure" cwd="/work" filter="hyper" references={[{ ...references[0]!, icon: 'https://untrusted.test/tracker.svg' }]} referencesError="secret-reference-error" onSelect={onSelect} />)
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
  expect(document.body.textContent).not.toContain('secret-')
  expect(document.querySelector('img')).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'HyperFrames' }))
  expect(onSelect).toHaveBeenCalled()
})

it('preserves explicitly highlighted results when asynchronous files change their ranking', async () => {
  let resolveFiles!: (value: Awaited<ReturnType<typeof filesystemApi.search>>) => void
  vi.mocked(filesystemApi.search).mockImplementationOnce(() => new Promise(resolve => { resolveFiles = resolve }))
  const ref = createRef<ComposerReferenceMenuHandle>()
  const onSelect = vi.fn()
  render(<ComposerReferenceMenu ref={ref} id="pending" cwd="/work" filter="hyper" references={references} onSelect={onSelect} />)
  fireEvent.mouseEnter(screen.getByRole('option', { name: 'HyperFrames' }))
  await waitFor(() => expect(filesystemApi.search).toHaveBeenCalled())
  await act(async () => { resolveFiles({ currentPath: '/work', parentPath: '/', entries: [{ ...file, name: 'hyper', path: '/work/hyper' }] }) })
  expect(screen.getAllByRole('option')[0]).toHaveAccessibleName('hyper')
  expect(screen.getByRole('option', { name: 'HyperFrames' })).toHaveAttribute('aria-selected', 'true')
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })) })
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plugin', id: 'hyperframes' }))
})

it('keeps explicit capability category searches out of the filesystem', () => {
  render(<ComposerReferenceMenu embedded browseReferences id="category" cwd="/work" filter="design" references={references} onSelect={vi.fn()} />)
  expect(screen.getByRole('option', { name: 'Design' })).toBeInTheDocument()
  expect(filesystemApi.search).not.toHaveBeenCalled()
  expect(filesystemApi.browse).not.toHaveBeenCalled()
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
})

it.each(['src/', 'src\\'])('keeps every child accessible while browsing %s', async filter => {
  vi.mocked(filesystemApi.browse).mockResolvedValue({ currentPath: '/work/src', parentPath: '/work', entries: Array.from({ length: 15 }, (_, index) => ({ name: `file-${index}.ts`, path: `/work/src/file-${index}.ts`, isDirectory: false })) })
  render(<ComposerReferenceMenu id="directory" cwd="/work" filter={filter} references={[]} onSelect={vi.fn()} />)
  await screen.findByRole('option', { name: 'file-14.ts' })
  expect(screen.getAllByRole('option')).toHaveLength(15)
  expect(filesystemApi.browse).toHaveBeenCalledWith('/work/src', { includeFiles: true, signal: expect.any(AbortSignal) })
  expect(filesystemApi.search).not.toHaveBeenCalled()
})

it('resolves plugin icons against the packaged asset base', () => {
  vi.stubEnv('BASE_URL', './')
  try {
    render(<ComposerReferenceMenu id="brand" cwd="/work" references={references} onSelect={vi.fn()} />)
    expect(screen.getByRole('option', { name: 'HyperFrames' }).querySelector('img')).toHaveAttribute('src', './connectors/hyperframes.svg')
  } finally { vi.unstubAllEnvs() }
})

it('searches previous sessions and selects a structured reference without treating it as a file', async () => {
  vi.mocked(sessionCollaborationApi.list).mockResolvedValue({ sessions: [{ sessionId: 'past-session', title: 'Auth review', cwd: '/work/api', status: 'idle', updatedAt: '2026-09-20T00:00:00Z' }] })
  const onSelect = vi.fn()
  render(<ComposerReferenceMenu id="sessions" cwd="/work" filter="Auth" references={[]} onSelect={onSelect} />)
  fireEvent.click(await screen.findByRole('option', { name: 'Auth review' }))
  expect(sessionCollaborationApi.list).toHaveBeenCalledWith('Auth', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session', id: 'past-session', label: 'Auth review', path: '' }))
})


it('ranks exact session titles and IDs above server content matches before limiting results', async () => {
  const candidate = (sessionId: string, title: string) => ({ sessionId, title, cwd: '/work/api', status: 'idle', updatedAt: '2026-09-20T00:00:00Z' })
  vi.mocked(sessionCollaborationApi.list).mockResolvedValue({ sessions: [
    ...Array.from({ length: 8 }, (_, i) => candidate(`notes-${i}`, `alpha notes ${i}`)),
    candidate('exact-title', 'alpha'), candidate('alpha', 'By ID'), candidate('content-only', 'Unrelated title'),
  ] })
  const view = render(<ComposerReferenceMenu id="rank" cwd="/work" filter="alpha" references={[]} onSelect={vi.fn()} />)
  await screen.findByRole('option', { name: 'alpha' })
  expect(screen.getAllByRole('option').slice(0, 2).map(row => row.textContent)).toEqual([expect.stringContaining('alpha'), expect.stringContaining('By ID')])
  vi.mocked(sessionCollaborationApi.list).mockResolvedValue({ sessions: [candidate('content-only', 'Unrelated title')] })
  view.rerender(<ComposerReferenceMenu id="rank" cwd="/work" filter="body text" references={[]} onSelect={vi.fn()} />)
  expect(await screen.findByRole('option', { name: 'Unrelated title' })).toBeInTheDocument()
})

it('distinguishes sessions with the same title and project and selects their stable IDs', async () => {
  vi.mocked(sessionCollaborationApi.list).mockResolvedValue({ sessions: ['aaaa1111-session', 'bbbb2222-session'].map(sessionId => ({ sessionId, title: 'Review', cwd: '/work/api', status: 'idle', updatedAt: '2026-09-20T00:00:00Z' })) })
  const onSelect = vi.fn()
  render(<ComposerReferenceMenu id="duplicates" cwd="/work" filter="Review" references={[]} onSelect={onSelect} />)
  await waitFor(() => expect(screen.getAllByRole('option', { name: 'Review' })).toHaveLength(2))
  const options = screen.getAllByRole('option', { name: 'Review' })
  expect(options[0]).toHaveAccessibleDescription(expect.stringContaining('aaaa1111'))
  expect(options[1]).toHaveAccessibleDescription(expect.stringContaining('bbbb2222'))
  fireEvent.click(options[1]!)
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'bbbb2222-session' }))
})

it('shows a pending session search instead of an early empty state, then a sanitized error', async () => {
  let reject!: (reason: Error) => void
  vi.mocked(sessionCollaborationApi.list).mockImplementation(() => new Promise((_, rejectPromise) => { reject = rejectPromise }))
  render(<ComposerReferenceMenu id="loading-sessions" cwd="/work" references={[]} onSelect={vi.fn()} />)
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true')
  expect(screen.getByRole('status')).toBeInTheDocument()
  await waitFor(() => expect(sessionCollaborationApi.list).toHaveBeenCalled())
  await act(async () => { reject(new Error('secret backend data')) })
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(document.body.textContent).not.toContain('secret backend data')
})

it('discards stale session results and keeps colliding ID prefixes distinguishable with keyboard selection', async () => {
  let oldResolve!: (value: Awaited<ReturnType<typeof sessionCollaborationApi.list>>) => void
  vi.mocked(sessionCollaborationApi.list).mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve }))
  const ref = createRef<ComposerReferenceMenuHandle>()
  const onSelect = vi.fn()
  const view = render(<ComposerReferenceMenu ref={ref} id="switch-query" cwd="/work" filter="old" references={[]} onSelect={onSelect} />)
  await waitFor(() => expect(sessionCollaborationApi.list).toHaveBeenCalledWith('old', expect.objectContaining({ signal: expect.any(AbortSignal) })))
  const sessions = ['same1234-A', 'same1234-B'].map(sessionId => ({ sessionId, title: 'Review', cwd: '/work/api', status: 'idle', updatedAt: '' }))
  vi.mocked(sessionCollaborationApi.list).mockResolvedValue({ sessions })
  view.rerender(<ComposerReferenceMenu ref={ref} id="switch-query" cwd="/work" filter="Review" references={[]} onSelect={onSelect} />)
  await waitFor(() => expect(screen.getAllByRole('option', { name: 'Review' })).toHaveLength(2))
  await act(async () => { oldResolve({ sessions: [{ ...sessions[0]!, title: 'Old result' }] }) })
  expect(screen.queryByRole('option', { name: 'Old result' })).not.toBeInTheDocument()
  expect(screen.getAllByRole('option')[0]).toHaveAccessibleDescription(expect.stringContaining('same1234-A'))
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })); })
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })); })
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'same1234-B' }))
})

it('debounces keyword requests and aborts superseded and unmounted requests', async () => {
  vi.useFakeTimers()
  vi.mocked(filesystemApi.search).mockImplementation(() => new Promise(() => {}))
  vi.mocked(sessionCollaborationApi.list).mockImplementation(() => new Promise(() => {}))
  try {
    const view = render(<ComposerReferenceMenu id="cancel" cwd="/work" filter="修" references={[]} onSelect={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    view.rerender(<ComposerReferenceMenu id="cancel" cwd="/work" filter="修复" references={[]} onSelect={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(149) })
    expect(filesystemApi.search).not.toHaveBeenCalled()
    expect(sessionCollaborationApi.list).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(filesystemApi.search).toHaveBeenCalledTimes(1)
    expect(sessionCollaborationApi.list).toHaveBeenCalledTimes(1)
    const fileSignal = vi.mocked(filesystemApi.search).mock.calls[0]![2]!.signal!
    const sessionSignal = vi.mocked(sessionCollaborationApi.list).mock.calls[0]![1]!.signal!
    expect(fileSignal.aborted).toBe(false)
    expect(sessionSignal.aborted).toBe(false)
    view.rerender(<ComposerReferenceMenu id="cancel" cwd="/work" filter="修复中" references={[]} onSelect={vi.fn()} />)
    expect(fileSignal.aborted).toBe(true)
    expect(sessionSignal.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    const nextFileSignal = vi.mocked(filesystemApi.search).mock.calls[1]![2]!.signal!
    const nextSessionSignal = vi.mocked(sessionCollaborationApi.list).mock.calls[1]![1]!.signal!
    view.unmount()
    expect(nextFileSignal.aborted).toBe(true)
    expect(nextSessionSignal.aborted).toBe(true)
  } finally { vi.useRealTimers() }
})

it('browses directories immediately and cancels their request on workspace change', () => {
  vi.mocked(filesystemApi.browse).mockImplementation(() => new Promise(() => {}))
  const view = render(<ComposerReferenceMenu id="browse-cancel" cwd="/work" filter="src/" references={[]} onSelect={vi.fn()} />)
  expect(filesystemApi.browse).toHaveBeenCalledTimes(1)
  const signal = vi.mocked(filesystemApi.browse).mock.calls[0]![1]!.signal!
  view.rerender(<ComposerReferenceMenu id="browse-cancel" cwd="/other" filter="src/" references={[]} onSelect={vi.fn()} />)
  expect(signal.aborted).toBe(true)
  expect(filesystemApi.browse).toHaveBeenCalledTimes(2)
})
