import { describe, it, expect, vi } from 'vitest'

// Mock isLoopbackHostname so previewLinkRouter classifies localhost properly
vi.mock('./desktopRuntime', () => ({
  isLoopbackHostname: (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '::1',
}))

import { openWithContextForHref, openWithContextForWorkspaceFile } from './openWithContextForHref'
import { localFileUrl, previewFsUrl } from './handlePreviewLink'

const BASE = 'http://127.0.0.1:4321'
const SESSION = 's1'

describe('openWithContextForHref', () => {
  it('localhost href → {kind:"url", url}', () => {
    const result = openWithContextForHref('http://localhost:5173/', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result).toEqual({ kind: 'url', url: 'http://localhost:5173/' })
  })

  it('remote href → {kind:"url", url}', () => {
    const result = openWithContextForHref('https://example.com/page', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result).toEqual({ kind: 'url', url: 'https://example.com/page' })
  })

  it('relative previewable path with workDir → absolutePath resolved', () => {
    const result = openWithContextForHref('docs/a.md', { sessionId: SESSION, serverBaseUrl: BASE, workDir: '/w' })
    expect(result).toEqual({ kind: 'file', absolutePath: '/w/docs/a.md', relPath: 'docs/a.md', previewable: true })
  })

  it('absolute path in browser-file → inAppBrowserUrl via localFileUrl ($HOME-sandboxed route)', () => {
    const result = openWithContextForHref('/x/p.html', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result).toEqual({
      kind: 'file',
      absolutePath: '/x/p.html',
      inAppBrowserUrl: localFileUrl(BASE, '/x/p.html'),
    })
  })

  it('#anchor href → null (ignored)', () => {
    const result = openWithContextForHref('#anchor', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result).toBeNull()
  })

  it('empty href → null', () => {
    const result = openWithContextForHref('', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result).toBeNull()
  })

  it('relative path with trailing slash on workDir → correct absolutePath', () => {
    const result = openWithContextForHref('src/index.ts', { sessionId: SESSION, serverBaseUrl: BASE, workDir: '/proj/' })
    expect(result).toEqual({ kind: 'file', absolutePath: '/proj/src/index.ts', relPath: 'src/index.ts', previewable: true })
  })

  it('tilde html path → absolutePath passed through, not joined onto workDir', () => {
    const result = openWithContextForHref('~/reports/a.html', { sessionId: SESSION, serverBaseUrl: BASE, workDir: '/w' })
    expect(result).toEqual({
      kind: 'file',
      absolutePath: '~/reports/a.html',
      inAppBrowserUrl: previewFsUrl(BASE, SESSION, '~/reports/a.html'),
    })
  })

  it('Windows backslash tilde html path → absolutePath passed through', () => {
    const result = openWithContextForHref('~\\reports\\a.html', { sessionId: SESSION, serverBaseUrl: BASE, workDir: 'C:/w' })
    expect(result).toMatchObject({ kind: 'file', absolutePath: '~\\reports\\a.html' })
  })

  it('tilde markdown path → absolutePath passed through in file-preview context', () => {
    const result = openWithContextForHref('~/notes/a.md', { sessionId: SESSION, serverBaseUrl: BASE, workDir: '/w' })
    expect(result).toEqual({ kind: 'file', absolutePath: '~/notes/a.md', relPath: '~/notes/a.md', previewable: true })
  })
})

describe('openWithContextForWorkspaceFile', () => {
  it('.md rel path → { kind:"file", absolutePath, relPath, previewable:true } with no inAppBrowserUrl', () => {
    const result = openWithContextForWorkspaceFile('README.md', '/w/proj/README.md', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result).toEqual({ kind: 'file', absolutePath: '/w/proj/README.md', relPath: 'README.md', previewable: true })
  })

  it('hand-authored single-page index.html (no manifest in change-set) → static preview offered', () => {
    const result = openWithContextForWorkspaceFile('todo-app/index.html', '/w/proj/todo-app/index.html', {
      sessionId: SESSION,
      serverBaseUrl: BASE,
      siblingFiles: ['todo-app/index.html', 'todo-app/style.css', 'todo-app/app.js'],
    })
    expect(result).toEqual({
      kind: 'file',
      absolutePath: '/w/proj/todo-app/index.html',
      relPath: 'todo-app/index.html',
      previewable: true,
      inAppBrowserUrl: previewFsUrl(BASE, SESSION, 'todo-app/index.html'),
    })
  })

  it('framework-template index.html (manifest in change-set) → no inAppBrowserUrl (needs dev server)', () => {
    const result = openWithContextForWorkspaceFile('index.html', '/w/proj/index.html', {
      sessionId: SESSION,
      serverBaseUrl: BASE,
      siblingFiles: ['index.html', 'package.json', 'vite.config.ts', 'src/main.tsx'],
    })
    expect(result).toEqual({
      kind: 'file',
      absolutePath: '/w/proj/index.html',
      relPath: 'index.html',
      previewable: true,
    })
  })

  it('generated *_files index.html rel path → has inAppBrowserUrl equal to previewFsUrl', () => {
    const result = openWithContextForWorkspaceFile('66estmutl_files/index.html', '/w/proj/66estmutl_files/index.html', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result).toEqual({
      kind: 'file',
      absolutePath: '/w/proj/66estmutl_files/index.html',
      relPath: '66estmutl_files/index.html',
      previewable: true,
      inAppBrowserUrl: previewFsUrl(BASE, SESSION, '66estmutl_files/index.html'),
    })
  })

  it('built dist index.html rel path → has inAppBrowserUrl equal to previewFsUrl', () => {
    const result = openWithContextForWorkspaceFile('todo-app/dist/index.html', '/w/proj/todo-app/dist/index.html', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result).toEqual({
      kind: 'file',
      absolutePath: '/w/proj/todo-app/dist/index.html',
      relPath: 'todo-app/dist/index.html',
      previewable: true,
      inAppBrowserUrl: previewFsUrl(BASE, SESSION, 'todo-app/dist/index.html'),
    })
  })

  it('.htm extension → also has inAppBrowserUrl', () => {
    const result = openWithContextForWorkspaceFile('page.htm', '/w/proj/page.htm', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result.kind).toBe('file')
    if (result.kind === 'file') {
      expect(result.inAppBrowserUrl).toBeDefined()
      expect(result.inAppBrowserUrl).toBe(previewFsUrl(BASE, SESSION, 'page.htm'))
    }
  })

  it('.ts rel path → no inAppBrowserUrl', () => {
    const result = openWithContextForWorkspaceFile('src/app.ts', '/w/proj/src/app.ts', { sessionId: SESSION, serverBaseUrl: BASE })
    expect(result.kind).toBe('file')
    if (result.kind === 'file') {
      expect(result.inAppBrowserUrl).toBeUndefined()
      expect(result.previewable).toBe(true)
    }
  })

  it('outside-workspace html (absolute displayPath) → inAppBrowserUrl via localFileUrl, not preview-fs', () => {
    // A changed file that could not be relativized arrives with an absolute relPath;
    // it lives outside the workdir, so it must be served by the /local-file route.
    const result = openWithContextForWorkspaceFile('D:/workspace/demo/todo.html', 'D:\\workspace\\demo\\todo.html', {
      sessionId: SESSION,
      serverBaseUrl: BASE,
    })
    expect(result).toEqual({
      kind: 'file',
      absolutePath: 'D:\\workspace\\demo\\todo.html',
      relPath: 'D:/workspace/demo/todo.html',
      previewable: true,
      inAppBrowserUrl: localFileUrl(BASE, 'D:\\workspace\\demo\\todo.html'),
    })
  })

  it('outside-workspace POSIX html absolute path → inAppBrowserUrl via localFileUrl', () => {
    const result = openWithContextForWorkspaceFile('/elsewhere/site/todo.html', '/elsewhere/site/todo.html', {
      sessionId: SESSION,
      serverBaseUrl: BASE,
    })
    expect(result.kind).toBe('file')
    if (result.kind === 'file') {
      expect(result.inAppBrowserUrl).toBe(localFileUrl(BASE, '/elsewhere/site/todo.html'))
    }
  })
})
