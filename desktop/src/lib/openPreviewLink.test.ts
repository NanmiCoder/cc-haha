import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openPath = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('./desktopHost', () => ({
  getDesktopHost: () => ({
    shell: {
      open: vi.fn().mockResolvedValue(undefined),
      openPath,
    },
  }),
}))

vi.mock('./desktopRuntime', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

vi.mock('./workspace/openTarget', () => ({
  workspaceOpen: { file: vi.fn(), browser: vi.fn(), review: vi.fn(), terminal: vi.fn() },
  openWorkspaceTarget: vi.fn(),
}))

vi.mock('../stores/workspaceContentStore', () => ({
  useWorkspaceContentStore: {
    getState: () => ({ statusBySession: { s1: { workDir: '/work' } } }),
  },
}))

import { openPreviewLink } from './openPreviewLink'
import { workspaceOpen } from './workspace/openTarget'

afterEach(() => {
  openPath.mockReset().mockResolvedValue(undefined)
})

describe('openPreviewLink', () => {
  it('resolves an Office artifact against the session directory and opens it with the system app', async () => {
    expect(openPreviewLink('outputs/brief.docx', 's1')).toBe(true)

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/work/outputs/brief.docx'))
  })

  it('opens a CJK-named markdown in the workspace instead of ignoring the click', () => {
    // The output card for `README-拍摄大纲.md` rendered but its click returned
    // false: the path parser was ASCII-only and the router answered `ignored`.
    expect(openPreviewLink('README-拍摄大纲.md', 's1')).toBe(true)
    expect(workspaceOpen.file).toHaveBeenCalledWith('s1', 'README-拍摄大纲.md', {})
  })
})
