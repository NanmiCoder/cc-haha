import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { filesystemApi } from '@/api/filesystem'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from './ComposerReferenceMenu'

vi.mock('@/api/filesystem', () => ({ filesystemApi: { browse: vi.fn(), search: vi.fn() } }))
const directory = { name: 'src', path: '/work/src', isDirectory: true }
const file = { name: 'app.ts', path: '/work/app.ts', isDirectory: false }
const references: ComposerReferenceCandidate[] = [
  { kind: 'plugin', id: 'hyperframes', name: 'hyperframes', displayName: 'HyperFrames', description: 'Video creation', source: 'plugin', modelText: 'Use HyperFrames', icon: '/connectors/hyperframes.svg' },
  { kind: 'skill', id: 'design', name: 'design', displayName: 'Design', description: 'Create interfaces', source: 'user', path: '/skills/design/SKILL.md', modelText: 'Use design' },
]
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(filesystemApi.browse).mockResolvedValue({ currentPath: '/work', parentPath: '/', entries: [directory, file] })
  vi.mocked(filesystemApi.search).mockResolvedValue({ currentPath: '/work', parentPath: '/', entries: [file] })
})

it('unifies plugin, skill and file groups with structured selection and active option ids', async () => {
  const ref = createRef<ComposerReferenceMenuHandle>()
  const onSelect = vi.fn()
  const onActiveChange = vi.fn()
  render(<ComposerReferenceMenu ref={ref} id="references" cwd="/work" references={references} onSelect={onSelect} onActiveChange={onActiveChange} />)
  await screen.findByRole('option', { name: 'app.ts' })
  expect(screen.getAllByRole('option').map(row => row.textContent)).toEqual(['HyperFramesVideo creationPlugin', 'DesignCreate interfacesPersonal', 'src', 'app.ts'])
  expect(onActiveChange).toHaveBeenLastCalledWith('references-option-0')
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })) })
  expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'plugin', id: 'hyperframes', modelText: 'Use HyperFrames', path: '', isDirectory: false }))
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })) })
  expect(screen.getByRole('option', { name: 'Design' })).toHaveAttribute('aria-selected', 'true')
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Tab' })) })
  expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'skill', id: 'design', path: '/skills/design/SKILL.md' }))
  fireEvent.click(screen.getByRole('option', { name: 'app.ts' }))
  expect(onSelect).toHaveBeenLastCalledWith({ label: 'app.ts', path: '/work/app.ts', isDirectory: false })
  expect(screen.getByRole('option', { name: 'HyperFrames' })).toHaveAccessibleDescription('Video creation')
})

it('keeps directory selection separate from ArrowRight and pointer navigation and ignores IME Enter', async () => {
  const ref = createRef<ComposerReferenceMenuHandle>()
  const onSelect = vi.fn()
  const onNavigate = vi.fn()
  render(<ComposerReferenceMenu ref={ref} id="files" cwd="/work" references={[]} onSelect={onSelect} onNavigate={onNavigate} />)
  const option = await screen.findByRole('option', { name: 'src' })
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true })) })
  expect(onSelect).not.toHaveBeenCalled()
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' })) })
  expect(onNavigate).toHaveBeenLastCalledWith('src/')
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.click(option.querySelector('[data-navigate-directory]')!)
  expect(onNavigate).toHaveBeenCalledTimes(2)
  fireEvent.click(option)
  expect(onSelect).toHaveBeenCalledWith({ label: 'src/', path: '/work/src', isDirectory: true })
})

it('discards late query and workspace results and never selects stale files while loading', async () => {
  let oldResolve!: (value: Awaited<ReturnType<typeof filesystemApi.search>>) => void
  vi.mocked(filesystemApi.search).mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve }))
  const onSelect = vi.fn()
  const ref = createRef<ComposerReferenceMenuHandle>()
  const view = render(<ComposerReferenceMenu ref={ref} id="search" cwd="/old" filter="old" references={[]} onSelect={onSelect} />)
  view.rerender(<ComposerReferenceMenu ref={ref} id="search" cwd="/work" filter="new" references={[]} onSelect={onSelect} />)
  act(() => { ref.current!.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })) })
  expect(onSelect).not.toHaveBeenCalled()
  await screen.findByRole('option', { name: 'app.ts' })
  await act(async () => { oldResolve({ currentPath: '/old', parentPath: '/', entries: [{ name: 'old.ts', path: '/old/old.ts', isDirectory: false }] }) })
  expect(screen.queryByRole('option', { name: 'old.ts' })).not.toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'app.ts' })).toBeInTheDocument()
})

it('keeps plugin matches usable when file loading fails without exposing raw errors or remote icons', async () => {
  vi.mocked(filesystemApi.browse).mockRejectedValue(new Error('secret-server-error'))
  const onSelect = vi.fn()
  render(<ComposerReferenceMenu id="failure" cwd="/work" references={[{ ...references[0]!, icon: 'https://untrusted.test/tracker.svg' }]} referencesError="secret-reference-error" onSelect={onSelect} />)
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
  expect(document.body.textContent).not.toContain('secret-')
  expect(document.querySelector('img')).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'HyperFrames' }))
  expect(onSelect).toHaveBeenCalled()
})

it('uses the shared fallback vocabulary and labels where each reference came from', async () => {
  const { container } = render(<ComposerReferenceMenu id="shared" cwd="/work" references={references} onSelect={vi.fn()} />)
  await screen.findByRole('option', { name: 'app.ts' })
  // The skill row must use the same outline box the slash menu uses; the
  // decorative sparkle it used to render made the two menus disagree.
  expect(container.querySelector('.lucide-box')).toBeInTheDocument()
  expect(container.querySelector('.lucide-sparkles')).toBeNull()
  expect(screen.getByRole('option', { name: 'HyperFrames' })).toHaveTextContent('Plugin')
  expect(screen.getByRole('option', { name: 'Design' })).toHaveTextContent('Personal')
  expect(screen.getByRole('option', { name: 'src' })).not.toHaveTextContent('Personal')
})

it('resolves brand icons against the packaged asset base instead of the document root', async () => {
  vi.stubEnv('BASE_URL', './')
  try {
    render(<ComposerReferenceMenu id="brand" cwd="/work" references={references} onSelect={vi.fn()} />)
    const option = await screen.findByRole('option', { name: 'HyperFrames' })
    expect(option.querySelector('img')).toHaveAttribute('src', './connectors/hyperframes.svg')
  } finally { vi.unstubAllEnvs() }
})

it('browses explicit path filters and reports no active descendant for empty results', async () => {
  vi.mocked(filesystemApi.browse).mockResolvedValue({ currentPath: '/work/src', parentPath: '/work', entries: [] })
  const onActiveChange = vi.fn()
  render(<ComposerReferenceMenu id="path" cwd="/work" filter="src/" references={references} onSelect={vi.fn()} onActiveChange={onActiveChange} />)
  await waitFor(() => expect(filesystemApi.browse).toHaveBeenCalledWith('/work/src', { includeFiles: true }))
  expect(screen.queryAllByRole('option')).toHaveLength(0)
  expect(onActiveChange).toHaveBeenLastCalledWith(undefined)
})
