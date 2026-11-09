import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from './memoryStore'

const { memoryApiMock } = vi.hoisted(() => ({
  memoryApiMock: {
    listProjects: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    saveFile: vi.fn(),
  },
}))

vi.mock('../api/memory', () => ({
  memoryApi: memoryApiMock,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const project = (id: string, isCurrent = false) => ({
  id,
  label: `/workspace/${id}`,
  memoryDir: `/tmp/.claude/projects/${id}/memory`,
  exists: true,
  fileCount: 1,
  isCurrent,
})

const file = (path: string) => ({
  path,
  name: path.split('/').at(-1) ?? path,
  title: path,
  bytes: 12,
  updatedAt: '2026-07-24T00:00:00.000Z',
  isIndex: path === 'MEMORY.md',
})

beforeEach(() => {
  vi.clearAllMocks()
  useMemoryStore.setState({
    projects: [],
    files: [],
    selectedProjectId: null,
    selectedFile: null,
    draftContent: '',
    isLoadingProjects: false,
    isLoadingFiles: false,
    isLoadingFile: false,
    isSaving: false,
    error: null,
    lastSavedAt: null,
  })
})

describe('memoryStore request ownership', () => {
  it('keeps the newest cwd project response when requests finish out of order', async () => {
    const first = deferred<{ projects: ReturnType<typeof project>[] }>()
    const second = deferred<{ projects: ReturnType<typeof project>[] }>()
    memoryApiMock.listProjects.mockImplementation((cwd?: string) =>
      cwd === '/workspace/first' ? first.promise : second.promise,
    )

    const firstRequest = useMemoryStore.getState().fetchProjects('/workspace/first')
    const secondRequest = useMemoryStore.getState().fetchProjects('/workspace/second')

    second.resolve({ projects: [project('second', true)] })
    await secondRequest
    first.resolve({ projects: [project('first', true)] })
    await firstRequest

    expect(useMemoryStore.getState()).toMatchObject({
      projects: [project('second', true)],
      selectedProjectId: 'second',
      isLoadingProjects: false,
      error: null,
    })
  })

  it('does not let an old project file response replace the current project files', async () => {
    const first = deferred<{ files: ReturnType<typeof file>[] }>()
    const second = deferred<{ files: ReturnType<typeof file>[] }>()
    memoryApiMock.listFiles.mockImplementation((projectId: string) =>
      projectId === 'first' ? first.promise : second.promise,
    )
    useMemoryStore.setState({
      projects: [project('first'), project('second')],
      selectedProjectId: 'first',
    })

    const firstRequest = useMemoryStore.getState().fetchFiles('first')
    useMemoryStore.getState().selectProject('second')
    const secondRequest = useMemoryStore.getState().fetchFiles('second')

    second.resolve({ files: [file('second.md')] })
    await secondRequest
    first.resolve({ files: [file('first.md')] })
    await firstRequest

    expect(useMemoryStore.getState()).toMatchObject({
      selectedProjectId: 'second',
      files: [file('second.md')],
      isLoadingFiles: false,
      error: null,
    })
  })

  it('keeps the newest file open response when reads finish out of order', async () => {
    const first = deferred<{ file: ReturnType<typeof file> & { content: string } }>()
    const second = deferred<{ file: ReturnType<typeof file> & { content: string } }>()
    memoryApiMock.readFile.mockImplementation((_projectId: string, path: string) =>
      path === 'first.md' ? first.promise : second.promise,
    )
    useMemoryStore.setState({
      projects: [project('demo')],
      selectedProjectId: 'demo',
      files: [file('first.md'), file('second.md')],
    })

    const firstRequest = useMemoryStore.getState().openFile('demo', 'first.md')
    const secondRequest = useMemoryStore.getState().openFile('demo', 'second.md')

    second.resolve({ file: { ...file('second.md'), content: '# Second' } })
    await secondRequest
    first.resolve({ file: { ...file('first.md'), content: '# First' } })
    await firstRequest

    expect(useMemoryStore.getState()).toMatchObject({
      selectedFile: { path: 'second.md', content: '# Second' },
      draftContent: '# Second',
      isLoadingFile: false,
      error: null,
    })
  })

  it('advances the saved revision without discarding edits made while saving', async () => {
    const firstSave = deferred<{
      ok: true
      file: { path: string; updatedAt: string; bytes: number }
    }>()
    const secondSave = deferred<{
      ok: true
      file: { path: string; updatedAt: string; bytes: number }
    }>()
    memoryApiMock.saveFile.mockReturnValueOnce(firstSave.promise)
    memoryApiMock.listFiles.mockResolvedValue({ files: [file('MEMORY.md')] })
    useMemoryStore.setState({
      projects: [project('demo')],
      selectedProjectId: 'demo',
      selectedFile: {
        ...file('MEMORY.md'),
        content: '# Original',
      },
      draftContent: '# First edit',
    })

    const firstRequest = useMemoryStore.getState().saveFile()
    useMemoryStore.getState().updateDraft('# First edit\n\nContinued typing')
    firstSave.resolve({
      ok: true,
      file: {
        path: 'MEMORY.md',
        updatedAt: '2026-07-24T00:01:00.000Z',
        bytes: 12,
      },
    })

    await expect(firstRequest).resolves.toBe(true)
    expect(useMemoryStore.getState()).toMatchObject({
      selectedFile: {
        path: 'MEMORY.md',
        content: '# First edit',
        updatedAt: '2026-07-24T00:01:00.000Z',
        bytes: 12,
      },
      draftContent: '# First edit\n\nContinued typing',
      isSaving: false,
      lastSavedAt: '2026-07-24T00:01:00.000Z',
    })

    memoryApiMock.saveFile.mockReturnValueOnce(secondSave.promise)
    const secondRequest = useMemoryStore.getState().saveFile()
    expect(memoryApiMock.saveFile).toHaveBeenLastCalledWith({
      projectId: 'demo',
      path: 'MEMORY.md',
      content: '# First edit\n\nContinued typing',
      expectedUpdatedAt: '2026-07-24T00:01:00.000Z',
      expectedBytes: 12,
    })
    secondSave.resolve({
      ok: true,
      file: {
        path: 'MEMORY.md',
        updatedAt: '2026-07-24T00:02:00.000Z',
        bytes: 30,
      },
    })

    await expect(secondRequest).resolves.toBe(true)
    expect(useMemoryStore.getState()).toMatchObject({
      selectedFile: {
        path: 'MEMORY.md',
        content: '# First edit\n\nContinued typing',
        updatedAt: '2026-07-24T00:02:00.000Z',
        bytes: 30,
      },
      draftContent: '# First edit\n\nContinued typing',
      isSaving: false,
      lastSavedAt: '2026-07-24T00:02:00.000Z',
    })
  })

  it('serializes saves, sends the loaded revision, and does not cross project context', async () => {
    const save = deferred<{
      ok: true
      file: { path: string; updatedAt: string; bytes: number }
    }>()
    memoryApiMock.saveFile.mockReturnValue(save.promise)
    useMemoryStore.setState({
      projects: [project('first'), project('second')],
      selectedProjectId: 'first',
      selectedFile: {
        ...file('MEMORY.md'),
        content: '# Original',
      },
      draftContent: '# Edited',
    })

    const firstSave = useMemoryStore.getState().saveFile()
    const duplicateSave = useMemoryStore.getState().saveFile()

    expect(memoryApiMock.saveFile).toHaveBeenCalledTimes(1)
    expect(memoryApiMock.saveFile).toHaveBeenCalledWith({
      projectId: 'first',
      path: 'MEMORY.md',
      content: '# Edited',
      expectedUpdatedAt: '2026-07-24T00:00:00.000Z',
      expectedBytes: 12,
    })
    await expect(duplicateSave).resolves.toBe(false)

    useMemoryStore.getState().selectProject('second')
    save.resolve({
      ok: true,
      file: {
        path: 'MEMORY.md',
        updatedAt: '2026-07-24T00:01:00.000Z',
        bytes: 8,
      },
    })

    await expect(firstSave).resolves.toBe(false)
    expect(useMemoryStore.getState()).toMatchObject({
      selectedProjectId: 'second',
      selectedFile: null,
      draftContent: '',
      isSaving: false,
      lastSavedAt: null,
    })
  })
})

describe('memoryStore refresh', () => {
  const opened = (content: string, updatedAt: string, bytes: number) => ({
    file: { path: 'MEMORY.md', content, updatedAt, bytes },
  })

  beforeEach(() => {
    // clearAllMocks keeps queued one-shot values; a test must not inherit them.
    memoryApiMock.readFile.mockReset()
    memoryApiMock.listFiles.mockReset()
  })

  it('re-reads the open file when the list is refreshed after it changed on disk', async () => {
    useMemoryStore.setState({ projects: [project('demo')], selectedProjectId: 'demo' })
    memoryApiMock.readFile.mockResolvedValueOnce(opened('# Before\n', '2026-07-24T00:00:00.000Z', 9))
    await useMemoryStore.getState().openFile('demo', 'MEMORY.md')

    // A session rewrote the file: the list reports the new revision and a read
    // returns the new body.
    memoryApiMock.listFiles.mockResolvedValueOnce({
      files: [{ ...file('MEMORY.md'), bytes: 31, updatedAt: '2026-07-24T00:05:00.000Z' }],
    })
    memoryApiMock.readFile.mockResolvedValueOnce(
      opened('# After\n\n- Written by a session\n', '2026-07-24T00:05:00.000Z', 31),
    )

    await useMemoryStore.getState().fetchFiles('demo', { reloadSelectedFile: true })

    expect(memoryApiMock.readFile).toHaveBeenLastCalledWith('demo', 'MEMORY.md')
    expect(useMemoryStore.getState()).toMatchObject({
      selectedFile: {
        path: 'MEMORY.md',
        content: '# After\n\n- Written by a session\n',
        updatedAt: '2026-07-24T00:05:00.000Z',
        bytes: 31,
      },
      draftContent: '# After\n\n- Written by a session\n',
      isLoadingFiles: false,
      isLoadingFile: false,
    })
  })

  it('keeps the loaded body when the list is reloaded without asking for it', async () => {
    useMemoryStore.setState({ projects: [project('demo')], selectedProjectId: 'demo' })
    memoryApiMock.readFile.mockResolvedValueOnce(opened('# Before\n', '2026-07-24T00:00:00.000Z', 9))
    await useMemoryStore.getState().openFile('demo', 'MEMORY.md')
    memoryApiMock.listFiles.mockResolvedValueOnce({ files: [file('MEMORY.md')] })

    await useMemoryStore.getState().fetchFiles('demo')

    expect(memoryApiMock.readFile).toHaveBeenCalledTimes(1)
    expect(useMemoryStore.getState().selectedFile?.content).toBe('# Before\n')
  })
})
