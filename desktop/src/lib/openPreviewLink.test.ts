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

vi.mock('../stores/browserPanelStore', () => ({
  useBrowserPanelStore: { getState: () => ({ open: vi.fn() }) },
}))

vi.mock('../stores/workspacePanelStore', () => ({
  useWorkspacePanelStore: {
    getState: () => ({
      statusBySession: { s1: { workDir: '/work' } },
      openPreview: vi.fn(),
    }),
  },
}))

import { openPreviewLink } from './openPreviewLink'

afterEach(() => {
  openPath.mockReset().mockResolvedValue(undefined)
})

describe('openPreviewLink', () => {
  it('resolves an Office artifact against the session directory and opens it with the system app', async () => {
    expect(openPreviewLink('outputs/brief.docx', 's1')).toBe(true)

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/work/outputs/brief.docx'))
  })
})
