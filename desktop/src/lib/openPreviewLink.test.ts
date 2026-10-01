import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openPath = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
// The server's verdict on a document the string check cannot place. Refusing
// (the 403 a path outside the workspace gets) is the default.
const getWorkspaceFile = vi.hoisted(() => vi.fn())

vi.mock('../api/sessions', () => ({
  sessionsApi: { getWorkspaceFile },
}))

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
    getState: () => ({
      statusBySession: {
        s1: { workDir: '/work' },
        // The server reports the canonical workdir; the chat writes the symlinked form.
        s3: { workDir: '/private/tmp/app' },
      },
    }),
  },
}))

import { openPreviewLink } from './openPreviewLink'
import { workspaceOpen } from './workspace/openTarget'

beforeEach(() => {
  getWorkspaceFile.mockReset().mockRejectedValue(new Error('403 Path is outside workspace'))
})

afterEach(() => {
  openPath.mockReset().mockResolvedValue(undefined)
  vi.mocked(workspaceOpen.file).mockClear()
})

describe('openPreviewLink for a document the workspace can draw', () => {
  it('previews a workspace-relative document, which the server resolves against the workdir', () => {
    expect(openPreviewLink('out/thesis.pdf', 's1')).toBe(true)

    expect(workspaceOpen.file).toHaveBeenCalledWith('s1', 'out/thesis.pdf', {})
    expect(openPath).not.toHaveBeenCalled()
  })

  it('previews a Word document the same way as a PDF', () => {
    expect(openPreviewLink('out/thesis.docx', 's1')).toBe(true)

    expect(workspaceOpen.file).toHaveBeenCalledWith('s1', 'out/thesis.docx', {})
    expect(openPath).not.toHaveBeenCalled()
  })

  it.each(['out/budget.xlsx', 'out/legacy.xls'])('previews an Excel workbook (%s) the same way', (path) => {
    expect(openPreviewLink(path, 's1')).toBe(true)

    expect(workspaceOpen.file).toHaveBeenCalledWith('s1', path, {})
    expect(openPath).not.toHaveBeenCalled()
  })

  it('keeps a Word document outside the session directory with the system application, as a PDF', async () => {
    expect(openPreviewLink('/Users/x/Documents/thesis.docx', 's1')).toBe(true)

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/Users/x/Documents/thesis.docx'))
    expect(workspaceOpen.file).not.toHaveBeenCalled()
  })

  it('previews an absolute path that sits inside the session directory', () => {
    openPreviewLink('/work/out/thesis.pdf', 's1')

    expect(workspaceOpen.file).toHaveBeenCalledWith('s1', '/work/out/thesis.pdf', {})
    expect(openPath).not.toHaveBeenCalled()
  })

  it.each([
    ['an absolute path outside the session directory', '/Users/x/Documents/thesis.pdf'],
    ['a home-relative path, which the server cannot resolve against the workdir', '~/Documents/thesis.pdf'],
    ['a path on another drive', 'D:\\papers\\thesis.pdf'],
  ])('keeps %s with the system application, since the preview would open onto a 403', async (_label, href) => {
    expect(openPreviewLink(href, 's1')).toBe(true)

    await waitFor(() => expect(openPath).toHaveBeenCalledTimes(1))
    expect(workspaceOpen.file).not.toHaveBeenCalled()
  })

  it.each([
    ['a relative path that climbs out of the session directory', '../shared/spec.pdf', '/work/../shared/spec.pdf'],
    ['one that climbs out from further down', 'out/../../shared/table.xlsx', '/work/out/../../shared/table.xlsx'],
  ])('keeps %s with the system application, as it does the same path written out', async (_label, href, opened) => {
    // The server resolves it against the workdir and refuses what lands outside.
    expect(openPreviewLink(href, 's1')).toBe(true)

    await waitFor(() => expect(openPath).toHaveBeenCalledWith(opened))
    expect(workspaceOpen.file).not.toHaveBeenCalled()
  })

  it('still previews a relative document that only steps out of a folder and back in', () => {
    openPreviewLink('out/../out/thesis.pdf', 's1')

    expect(workspaceOpen.file).toHaveBeenCalledWith('s1', 'out/../out/thesis.pdf', {})
    expect(openPath).not.toHaveBeenCalled()
  })

  it('keeps an absolute document with the system application while the workdir is still unknown and the server refuses it', async () => {
    // Session s2 has no workspace status yet, so the string check cannot place the
    // path; the server's refusal is what sends it to the system app.
    openPreviewLink('/Users/x/Documents/thesis.pdf', 's2')

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/Users/x/Documents/thesis.pdf'))
    expect(getWorkspaceFile).toHaveBeenCalledWith('s2', '/Users/x/Documents/thesis.pdf')
    expect(workspaceOpen.file).not.toHaveBeenCalled()
  })

  it('previews an absolute document the server accepts even though the workdir has not loaded yet', async () => {
    getWorkspaceFile.mockResolvedValue({ state: 'ok', path: '/work/out/thesis.pdf' })

    openPreviewLink('/work/out/thesis.pdf', 's2')

    await waitFor(() => expect(workspaceOpen.file).toHaveBeenCalledWith('s2', '/work/out/thesis.pdf', {}))
    expect(openPath).not.toHaveBeenCalled()
  })

  it('previews a document written through a symlink of the canonical workdir (/tmp vs /private/tmp)', async () => {
    // Regression: the output card for `/tmp/app/report.pdf` opened the system app,
    // because the session's canonical workdir is `/private/tmp/app` and the string
    // comparison called the document outside the workspace.
    getWorkspaceFile.mockResolvedValue({ state: 'ok', path: '/tmp/app/report.pdf' })

    expect(openPreviewLink('/tmp/app/report.pdf', 's3')).toBe(true)

    await waitFor(() => expect(workspaceOpen.file).toHaveBeenCalledWith('s3', '/tmp/app/report.pdf', {}))
    expect(getWorkspaceFile).toHaveBeenCalledWith('s3', '/tmp/app/report.pdf')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('does not ask the server when the path is plainly inside the workdir', () => {
    openPreviewLink('/work/out/thesis.pdf', 's1')

    expect(getWorkspaceFile).not.toHaveBeenCalled()
  })

  it('still previews a relative document while the workdir is unknown', () => {
    openPreviewLink('out/thesis.pdf', 's2')

    expect(workspaceOpen.file).toHaveBeenCalledWith('s2', 'out/thesis.pdf', {})
  })

  it('applies only to documents: source files outside the workdir open in the code view as before', () => {
    openPreviewLink('/Users/x/notes/app.ts', 's1')

    expect(workspaceOpen.file).toHaveBeenCalledWith('s1', '/Users/x/notes/app.ts', {})
    expect(openPath).not.toHaveBeenCalled()
  })

  it('leaves formats without a viewer with the system application, inside the workdir too', async () => {
    openPreviewLink('out/launch.pptx', 's1')

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/work/out/launch.pptx'))
    expect(workspaceOpen.file).not.toHaveBeenCalled()
  })
})

describe('openPreviewLink', () => {
  it('resolves an Office artifact against the session directory and opens it with the system app', async () => {
    expect(openPreviewLink('outputs/brief.pptx', 's1')).toBe(true)

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/work/outputs/brief.pptx'))
  })

  it('opens a CJK-named markdown in the workspace instead of ignoring the click', () => {
    // The output card for `README-拍摄大纲.md` rendered but its click returned
    // false: the path parser was ASCII-only and the router answered `ignored`.
    expect(openPreviewLink('README-拍摄大纲.md', 's1')).toBe(true)
    expect(workspaceOpen.file).toHaveBeenCalledWith('s1', 'README-拍摄大纲.md', {})
  })
})
