import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { sessionsApi, type WorkspaceTreeResult } from '@/api/sessions'
import { extractAssistantOutputTargets } from '@/lib/assistantOutputTargets'
import { resetDiskListingCacheForTests, useDiskConfirmedTargets } from './useDiskConfirmedTargets'

let getWorkspaceTree: MockInstance<typeof sessionsApi.getWorkspaceTree>

function listing(path: string, files: string[]): WorkspaceTreeResult {
  return {
    state: 'ok',
    path,
    entries: files.map((name) => ({ name, path: path ? `${path}/${name}` : name, isDirectory: false })),
  } as WorkspaceTreeResult
}

function onDisk(files: Record<string, string[]>) {
  getWorkspaceTree.mockImplementation(async (_sessionId, dir = '') => listing(dir, files[dir] ?? []))
}

// No changed file corroborates anything, so every reading is left for the disk.
const cards = (content: string) => extractAssistantOutputTargets(content, {
  workDir: '/w',
  changedFiles: [],
  includeUnconfirmedNames: true,
})
const named = (targets: { title: string; href: string }[]) => targets.map((target) => [target.title, target.href])

beforeEach(() => {
  resetDiskListingCacheForTests()
  getWorkspaceTree = vi.spyOn(sessionsApi, 'getWorkspaceTree')
})

afterEach(() => {
  getWorkspaceTree.mockRestore()
})

describe('useDiskConfirmedTargets', () => {
  it('renames a card to the longest reading that exists on disk', async () => {
    onDisk({ '': ['报告v2.docx', 'v2.docx.bak'] })
    const targets = cards('已生成报告v2.docx')

    const { result } = renderHook(() => useDiskConfirmedTargets('s1', targets))

    expect(named(result.current)).toEqual([['v2.docx', 'v2.docx']])
    await waitFor(() => expect(named(result.current)).toEqual([['报告v2.docx', '报告v2.docx']]))
    expect(getWorkspaceTree).toHaveBeenCalledTimes(1)
    expect(getWorkspaceTree).toHaveBeenCalledWith('s1', '')
  })

  it('recovers names glued together and names with spaces and full-width brackets', async () => {
    onDisk({ '': ['测试文档1.docx', '测试文档2.docx', '毕业设计（论文）任务书 张三.docx'] })
    const targets = cards('已找到测试文档1.docx和测试文档2.docx。任务书是 毕业设计（论文）任务书 张三.docx')

    const { result } = renderHook(() => useDiskConfirmedTargets('s1', targets))

    await waitFor(() => expect(named(result.current)).toEqual([
      ['测试文档1.docx', '测试文档1.docx'],
      ['测试文档2.docx', '测试文档2.docx'],
      ['毕业设计（论文）任务书 张三.docx', '毕业设计（论文）任务书 张三.docx'],
    ]))
  })

  it('prefers the longer name when a shorter one exists too', async () => {
    // `1.docx` also sits in the folder, but the prose spelled out more of the name.
    onDisk({ '': ['1.docx', '测试文档1.docx'] })
    const targets = cards('已找到测试文档1.docx')

    const { result } = renderHook(() => useDiskConfirmedTargets('s1', targets))

    await waitFor(() => expect(named(result.current)).toEqual([['测试文档1.docx', '测试文档1.docx']]))
  })

  it('matches a name the file system stored decomposed (NFD)', async () => {
    onDisk({ '': ['résumé报告v2.docx'.normalize('NFD')] })
    const targets = cards('见 résumé报告v2.docx')

    const { result } = renderHook(() => useDiskConfirmedTargets('s1', targets))

    await waitFor(() => expect(result.current[0]?.title).toBe('résumé报告v2.docx'))
  })

  it('keeps the scan reading when nothing exists or the listing fails', async () => {
    onDisk({ '': ['other.docx'] })
    const { result } = renderHook(() => useDiskConfirmedTargets('s1', cards('已生成报告v2.docx')))
    await waitFor(() => expect(getWorkspaceTree).toHaveBeenCalled())
    expect(named(result.current)).toEqual([['v2.docx', 'v2.docx']])

    getWorkspaceTree.mockRejectedValue(new Error('403'))
    const failed = renderHook(() => useDiskConfirmedTargets('s2', cards('已生成报告v3.docx')))
    await waitFor(() => expect(getWorkspaceTree).toHaveBeenCalledWith('s2', ''))
    expect(named(failed.result.current)).toEqual([['v3.docx', 'v3.docx']])
  })

  it('collapses two mentions that settle on the same file', async () => {
    onDisk({ '': ['报告v2.docx'] })
    const targets = cards('已生成报告v2.docx，即 `报告v2.docx`')

    const { result } = renderHook(() => useDiskConfirmedTargets('s1', targets))

    await waitFor(() => expect(named(result.current)).toEqual([['报告v2.docx', '报告v2.docx']]))
  })

  it('shows a CJK-and-extension name only once the disk confirms it', async () => {
    onDisk({ '': ['开题报告.docx'] })
    const targets = cards('已生成 开题报告.docx。只支持后缀为.docx的文件')

    const { result } = renderHook(() => useDiskConfirmedTargets('s1', targets))

    expect(result.current).toEqual([])
    await waitFor(() => expect(named(result.current)).toEqual([['开题报告.docx', '开题报告.docx']]))
  })

  it('never shows an unconfirmed name when the listing fails', async () => {
    getWorkspaceTree.mockRejectedValue(new Error('403'))
    const { result } = renderHook(() => useDiskConfirmedTargets('s1', cards('已生成 开题报告.docx')))

    await waitFor(() => expect(getWorkspaceTree).toHaveBeenCalled())
    expect(result.current).toEqual([])
  })

  it('lists a folder once for every message that names files in it', async () => {
    onDisk({ '': ['报告v2.docx', '报告v3.docx'] })
    const first = renderHook(() => useDiskConfirmedTargets('s1', cards('已生成报告v2.docx')))
    const second = renderHook(() => useDiskConfirmedTargets('s1', cards('已生成报告v3.docx')))

    await waitFor(() => expect(second.result.current[0]?.title).toBe('报告v3.docx'))
    expect(first.result.current[0]?.title).toBe('报告v2.docx')
    expect(getWorkspaceTree).toHaveBeenCalledTimes(1)
  })

  it('asks the disk nothing when every name is already bounded', () => {
    const targets = cards('见 `报告v2.docx` 和 out/a.docx')

    renderHook(() => useDiskConfirmedTargets('s1', targets))

    expect(getWorkspaceTree).not.toHaveBeenCalled()
  })
})
