import { describe, expect, it, vi } from 'vitest'
import {
  handlePreviewLink,
  isAbsoluteLocalPath,
  localFileUrl,
  previewFsUrl,
  type PreviewLinkDeps,
} from './handlePreviewLink'

function makeDeps(overrides?: Partial<PreviewLinkDeps>): PreviewLinkDeps {
  return {
    sessionId: 's1',
    serverBaseUrl: 'http://127.0.0.1:8787',
    openBrowser: vi.fn(),
    openFilePreview: vi.fn(),
    openExternal: vi.fn(),
    ...overrides,
  }
}

describe('handlePreviewLink', () => {
  it('routes loopback urls to openBrowser with the url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('http://localhost:5173/', deps)
    expect(handled).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith('s1', 'http://localhost:5173/')
    expect(deps.openFilePreview).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('routes absolute html file paths to openBrowser with the local-file url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('/Users/x/index.html', deps)
    expect(handled).toBe(true)
    // Absolute paths may live outside the session workspace, so they go through
    // the $HOME-sandboxed /local-file route, NOT /preview-fs.
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/local-file/Users/x/index.html',
    )
    expect(deps.openFilePreview).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('routes file:// urls to openBrowser with the local-file url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('file:///Users/x/page.html', deps)
    expect(handled).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/local-file/Users/x/page.html',
    )
  })

  it('routes a built relative .html file to openBrowser with the preview-fs (workspace) url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('out/index.html', deps)
    expect(handled).toBe(true)
    // Relative → stays workspace-scoped via /preview-fs.
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/preview-fs/s1/out/index.html',
    )
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('routes generated *_files index.html to openBrowser with the preview-fs url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('66estmutl_files/index.html', deps)
    expect(handled).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/preview-fs/s1/66estmutl_files/index.html',
    )
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('routes a hand-authored single-page index.html to the static browser preview', () => {
    // Without change-set context a bare index.html is assumed to be a standalone
    // static page (the common "make me a todo page" output), so it renders in the
    // in-app browser rather than dropping the user into the source view.
    const deps = makeDeps()
    const handled = handlePreviewLink('todo-app/index.html', deps)
    expect(handled).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/preview-fs/s1/todo-app/index.html',
    )
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('routes relative previewable docs to openFilePreview with the relative path', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('docs/report.md', deps)
    expect(handled).toBe(true)
    expect(deps.openFilePreview).toHaveBeenCalledWith('s1', 'docs/report.md')
    expect(deps.openBrowser).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('routes remote http(s) to openExternal with the url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('https://example.com/', deps)
    expect(handled).toBe(true)
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.com/')
    expect(deps.openBrowser).not.toHaveBeenCalled()
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('returns false for ignored links and calls no deps', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('#x', deps)
    expect(handled).toBe(false)
    expect(deps.openBrowser).not.toHaveBeenCalled()
    expect(deps.openFilePreview).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })
})

describe('isAbsoluteLocalPath', () => {
  it('treats POSIX leading-slash paths as absolute', () => {
    expect(isAbsoluteLocalPath('/Users/x/page.html')).toBe(true)
  })
  it('treats Windows drive paths as absolute (both slash styles)', () => {
    expect(isAbsoluteLocalPath('C:\\Users\\x\\page.html')).toBe(true)
    expect(isAbsoluteLocalPath('C:/Users/x/page.html')).toBe(true)
  })
  it('treats relative paths as not absolute', () => {
    expect(isAbsoluteLocalPath('out/index.html')).toBe(false)
    expect(isAbsoluteLocalPath('./page.html')).toBe(false)
  })
})

describe('localFileUrl', () => {
  it('appends a POSIX absolute path after /local-file, preserving slashes', () => {
    expect(localFileUrl('http://127.0.0.1:8787', '/Users/x/page.html')).toBe(
      'http://127.0.0.1:8787/local-file/Users/x/page.html',
    )
  })
  it('encodes spaces/unicode per segment but keeps separators', () => {
    expect(localFileUrl('http://127.0.0.1:8787', '/Users/x/with space/p.html')).toBe(
      'http://127.0.0.1:8787/local-file/Users/x/with%20space/p.html',
    )
  })
  it('normalizes Windows backslashes and keeps a leading slash', () => {
    expect(localFileUrl('http://127.0.0.1:8787', 'C:\\proj\\page.html')).toBe(
      'http://127.0.0.1:8787/local-file/C%3A/proj/page.html',
    )
  })
  it('trims a trailing slash on the base', () => {
    expect(localFileUrl('http://127.0.0.1:8787/', '/a/b.html')).toBe(
      'http://127.0.0.1:8787/local-file/a/b.html',
    )
  })
})

describe('previewFsUrl (unchanged, regression guard)', () => {
  it('still builds a workspace-scoped preview-fs url for relative paths', () => {
    expect(previewFsUrl('http://127.0.0.1:8787', 's1', 'out/index.html')).toBe(
      'http://127.0.0.1:8787/preview-fs/s1/out/index.html',
    )
  })
})
