import { describe, expect, it, vi } from 'vitest'
import { buildOpenWithItems, describeFileType, isPreviewableChangedFile, type OpenWithContext, type OpenWithDeps } from './openWithItems'
import type { OpenTarget } from '../stores/openTargetStore'

// ──────────────────────────────────────────────────────────────────────────────
// describeFileType tests
// ──────────────────────────────────────────────────────────────────────────────
describe('describeFileType', () => {
  it('markdown → markdown icon, document categoryKey, uppercased ext', () => {
    expect(describeFileType('a.md')).toEqual({
      icon: 'markdown',
      categoryKey: 'openWith.fileType.document',
      ext: 'MD',
    })
  })

  it.each([
    ['report.pdf', 'picture_as_pdf', 'openWith.fileType.document', 'PDF'],
    ['brief.docx', 'docs', 'openWith.fileType.document', 'DOCX'],
    ['budget.xlsx', 'table_chart', 'openWith.fileType.spreadsheet', 'XLSX'],
    ['launch.pptx', 'slideshow', 'openWith.fileType.presentation', 'PPTX'],
    ['sources.zip', 'folder_zip', 'openWith.fileType.archive', 'ZIP'],
    ['voice.m4a', 'audio_file', 'openWith.fileType.audio', 'M4A'],
    ['demo.mov', 'video_file', 'openWith.fileType.video', 'MOV'],
  ])('classifies %s', (path, icon, categoryKey, ext) => {
    expect(describeFileType(path)).toEqual({ icon, categoryKey, ext })
  })

  it('HTML (uppercase path) → web icon, web categoryKey', () => {
    expect(describeFileType('x.HTML')).toEqual({
      icon: 'html',
      categoryKey: 'openWith.fileType.web',
      ext: 'HTML',
    })
  })

  it('png → image icon, image categoryKey', () => {
    expect(describeFileType('y.png')).toEqual({
      icon: 'image',
      categoryKey: 'openWith.fileType.image',
      ext: 'PNG',
    })
  })

  it('tsx → code icon, code categoryKey', () => {
    expect(describeFileType('z.tsx')).toEqual({
      icon: 'code',
      categoryKey: 'openWith.fileType.code',
      ext: 'TSX',
    })
  })

  it('unknown extension → generic file icon, file categoryKey', () => {
    expect(describeFileType('w.bin')).toEqual({
      icon: 'insert_drive_file',
      categoryKey: 'openWith.fileType.file',
      ext: 'BIN',
    })
  })

  it('extensionless files do not expose the entire filename as an extension', () => {
    expect(describeFileType('Makefile').ext).toBe('')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// isPreviewableChangedFile tests — only md/html/image get the open-with affordance
// ──────────────────────────────────────────────────────────────────────────────
describe('isPreviewableChangedFile', () => {
  it.each([
    'a.md', 'a.markdown', 'x.html', 'x.htm', 'X.HTML',
    'y.png', 'y.JPG', 'z.jpeg', 'g.gif', 'w.webp', 'v.svg',
    'docs/sub/readme.md',
  ])('previewable: %s → true', (p) => {
    expect(isPreviewableChangedFile(p)).toBe(true)
  })

  it.each([
    'main.ts', 'main.tsx', 'data.json', 'style.css', 'notes.txt',
    'lib.rs', 'Makefile', 'archive.zip', 'no-ext', 'a.mdx',
  ])('non-previewable: %s → false', (p) => {
    expect(isPreviewableChangedFile(p)).toBe(false)
  })
})

describe('isPreviewableChangedFile for a document the workspace can draw', () => {
  it('ranks a listed document with the other rendered previews, from the same set the gate uses', () => {
    expect(isPreviewableChangedFile('out/thesis.pdf')).toBe(true)
    expect(isPreviewableChangedFile('OUT/THESIS.PDF')).toBe(true)
  })

  it.each(['out/budget.xlsx', 'out/macros.xlsm', 'out/legacy.xls', 'out/thesis.docx'])('ranks %s with them too', (path) => {
    expect(isPreviewableChangedFile(path)).toBe(true)
  })

  it('leaves an unlisted office file with the generic rows', () => {
    expect(isPreviewableChangedFile('deck.pptx')).toBe(false)
  })
})

function makeT() {
  return (key: string, vars?: Record<string, string>) =>
    vars?.target != null ? `${key}:${vars.target}` : key
}

function makeDeps(overrides?: Partial<OpenWithDeps>): OpenWithDeps {
  return {
    openInAppBrowser: vi.fn(),
    openSystem: vi.fn(),
    openWorkspacePreview: vi.fn(),
    openTarget: vi.fn(),
    t: makeT(),
    ...overrides,
  }
}

const ideTarget: OpenTarget = { id: 'code', kind: 'ide', label: 'VS Code', icon: 'vscode', platform: 'darwin' }
const fmTarget: OpenTarget = { id: 'finder', kind: 'file_manager', label: 'Finder', icon: 'finder', platform: 'darwin' }
const appTarget: OpenTarget = { id: 'application:pages', kind: 'application', label: 'Pages', icon: 'application', platform: 'darwin', isDefault: true }
const systemTarget: OpenTarget = { id: 'system-default', kind: 'system_default', label: 'System default', icon: 'system', platform: 'darwin' }

describe('buildOpenWithItems – url context', () => {
  it('returns exactly [in-app, system] for a url context', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'url', url: 'https://example.com' }
    const items = buildOpenWithItems(ctx, [], deps)
    expect(items.map((i) => i.id)).toEqual(['in-app', 'system'])
  })

  it('in-app calls openInAppBrowser with url', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'url', url: 'https://example.com' }
    const items = buildOpenWithItems(ctx, [], deps)
    items[0]!.onSelect()
    expect(deps.openInAppBrowser).toHaveBeenCalledWith('https://example.com')
    expect(deps.openSystem).not.toHaveBeenCalled()
  })

  it('system calls openSystem with url', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'url', url: 'https://example.com' }
    const items = buildOpenWithItems(ctx, [], deps)
    items[1]!.onSelect()
    expect(deps.openSystem).toHaveBeenCalledWith('https://example.com')
    expect(deps.openInAppBrowser).not.toHaveBeenCalled()
  })
})

describe('buildOpenWithItems – file context with targets', () => {
  it('keeps system-default opening available immediately after workspace preview', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/a.md', relPath: 'a.md', previewable: true }
    const items = buildOpenWithItems(ctx, [ideTarget, fmTarget], deps)
    expect(items.map((i) => i.id)).toEqual(['preview', 'system', 'ide:code', 'fm:finder'])
  })

  it('preview calls openWorkspacePreview with relPath', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/a.md', relPath: 'a.md', previewable: true }
    const items = buildOpenWithItems(ctx, [ideTarget, fmTarget], deps)
    const preview = items.find((i) => i.id === 'preview')!
    preview.onSelect()
    expect(deps.openWorkspacePreview).toHaveBeenCalledWith('a.md')
  })

  it('ide:code calls openTarget with correct args', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/a.md', relPath: 'a.md', previewable: true }
    const items = buildOpenWithItems(ctx, [ideTarget, fmTarget], deps)
    const ideItem = items.find((i) => i.id === 'ide:code')!
    ideItem.onSelect()
    expect(deps.openTarget).toHaveBeenCalledWith('code', '/w/a.md')
  })

  it('system-default calls the safe system opener when no backend system target is loaded', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/a.md', relPath: 'a.md', previewable: true }
    const items = buildOpenWithItems(ctx, [ideTarget, fmTarget], deps)
    const system = items.find((i) => i.id === 'system')!
    system.onSelect()
    expect(deps.openSystem).toHaveBeenCalledWith('/w/a.md')
  })

  it('names the default application on the system-default row instead of listing it twice', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/brief.docx', previewable: false }

    const items = buildOpenWithItems(ctx, [appTarget, systemTarget, ideTarget, fmTarget], deps)
    const system = items.find((item) => item.id === 'system')!

    expect(system.label).toBe('openWith.openInDefaultTarget:Pages')
    // Its icon comes from the application, so the row reads as that application.
    expect(system.target).toBe(appTarget)
    // ...and the application does not also appear as a row of its own.
    expect(items.some((item) => item.id === 'app:application:pages')).toBe(false)
  })

  it('still launches the named default row through the guarded system-default target', () => {
    // The label is cosmetic. Routing it through the application target instead
    // would skip the check that refuses to hand an executable to the shell.
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/brief.docx', previewable: false }

    const items = buildOpenWithItems(ctx, [appTarget, systemTarget, ideTarget, fmTarget], deps)
    items.find((item) => item.id === 'system')!.onSelect()

    expect(deps.openTarget).toHaveBeenCalledWith('system-default', '/w/brief.docx')
  })

  it('keeps the generic system-default row when no application is marked default', () => {
    // Windows and Linux never report one, so that path has to stay untouched.
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/brief.docx', previewable: false }
    const nonDefaultApp: OpenTarget = { ...appTarget, isDefault: false }

    const items = buildOpenWithItems(ctx, [nonDefaultApp, systemTarget, fmTarget], deps)

    expect(items.map((item) => item.id)).toEqual(['system', 'app:application:pages', 'fm:finder'])
    expect(items[0]!.label).toBe('openWith.systemDefault')
  })

  it('offers no editor for a file an editor cannot meaningfully open', () => {
    const deps = makeDeps()
    const editors = [ideTarget, { ...ideTarget, id: 'sublime', label: 'Sublime Text' }]

    const binary = buildOpenWithItems(
      { kind: 'file', absolutePath: '/w/brief.docx', previewable: false },
      [systemTarget, ...editors, fmTarget],
      deps,
    )
    expect(binary.some((item) => item.id.startsWith('ide:'))).toBe(false)

    const source = buildOpenWithItems(
      { kind: 'file', absolutePath: '/w/app.py', relPath: 'app.py', previewable: true },
      [systemTarget, ...editors, fmTarget],
      deps,
    )
    expect(source.filter((item) => item.id.startsWith('ide:')).length).toBeGreaterThan(0)
  })

  it('puts the configured editor first, and otherwise the first detected one', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/app.py', relPath: 'app.py', previewable: true }
    const sublime: OpenTarget = { ...ideTarget, id: 'sublime', label: 'Sublime Text' }

    const byDefault = buildOpenWithItems(ctx, [systemTarget, ideTarget, sublime, fmTarget], deps)
    expect(byDefault.filter((item) => item.id.startsWith('ide:'))[0]!.id).toBe('ide:code')

    const configured = buildOpenWithItems(
      ctx,
      [systemTarget, ideTarget, sublime, fmTarget],
      { ...deps, preferredEditorTargetId: 'sublime' },
    )
    expect(configured.filter((item) => item.id.startsWith('ide:'))[0]!.id).toBe('ide:sublime')
    // ...and no editor is listed twice once the rest fill in behind it.
    const ids = configured.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives the editors only the room the associated applications leave', () => {
    // macOS fills this group with LaunchServices results, so one editor is all
    // that fits. Windows and Linux have no such list, and there the other
    // installed editors would otherwise be dropped for nothing.
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/app.py', relPath: 'app.py', previewable: true }
    const editors: OpenTarget[] = ['code', 'sublime', 'goland', 'pycharm']
      .map((id) => ({ ...ideTarget, id, label: id }))
    const apps: OpenTarget[] = ['a', 'b', 'c', 'd']
      .map((id) => ({ ...appTarget, id: `application:${id}`, label: id, isDefault: false }))

    const crowded = buildOpenWithItems(ctx, [appTarget, systemTarget, ...apps, ...editors, fmTarget], deps)
    const crowdedGroup = crowded.filter((item) => item.id === 'system' || /^(ide|app):/.test(item.id))
    expect(crowdedGroup).toHaveLength(6)
    expect(crowdedGroup.filter((item) => item.id.startsWith('ide:'))).toHaveLength(1)

    const roomy = buildOpenWithItems(ctx, [systemTarget, ...editors, fmTarget], deps)
    expect(roomy.filter((item) => item.id.startsWith('ide:')).map((item) => item.id))
      .toEqual(['ide:code', 'ide:sublime', 'ide:goland', 'ide:pycharm'])
  })

  it('names the file manager after the platform, not after the server label', () => {
    // The server label is a bare identifier with no locale behind it, so
    // interpolating it produced a localized "Show in Explorer" on Windows — an English name
    // inside a Chinese sentence, and not the name Windows uses.
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/app.py', relPath: 'app.py', previewable: true }
    const revealLabel = (platform: OpenTarget['platform'], id: string, label: string) => {
      const fm: OpenTarget = { id, kind: 'file_manager', label, icon: 'folder', platform }
      return buildOpenWithItems(ctx, [fm], deps).find((item) => item.id === `fm:${id}`)!.label
    }

    expect(revealLabel('darwin', 'finder', 'Finder')).toBe('openWith.revealIn.darwin')
    expect(revealLabel('win32', 'explorer', 'Explorer')).toBe('openWith.revealIn.win32')
    expect(revealLabel('linux', 'file-manager', 'File Manager')).toBe('openWith.revealIn.linux')
    expect(revealLabel('freebsd', 'file-manager', 'File Manager')).toBe('openWith.revealIn.default')
  })

  it('builds the whole Windows menu, where no application is ever discovered', () => {
    // `discoverNativeApplications` returns nothing off macOS, so Windows and Linux
    // never get a named default row — that path has to keep working untouched.
    const deps = makeDeps({ copyPath: vi.fn(), copyFileContent: vi.fn() })
    const windowsTargets: OpenTarget[] = [
      { id: 'system-default', kind: 'system_default', label: 'System default', icon: 'system', platform: 'win32' },
      { id: 'vscode', kind: 'ide', label: 'VS Code', icon: 'vscode', platform: 'win32' },
      { id: 'pycharm', kind: 'ide', label: 'PyCharm', icon: 'pycharm', platform: 'win32' },
      { id: 'explorer', kind: 'file_manager', label: 'Explorer', icon: 'folder', platform: 'win32' },
    ]

    // Real Windows paths, backslashes and all — that is what the server hands back,
    // and the file-type gate has to read the extension off them.
    const source = buildOpenWithItems(
      { kind: 'file', absolutePath: 'C:\\w\\app.py', relPath: 'app.py', previewable: true },
      windowsTargets,
      deps,
    )
    expect(source.map((item) => item.id)).toEqual([
      'preview', 'system', 'ide:vscode', 'ide:pycharm', 'copy-path', 'copy-content', 'fm:explorer',
    ])
    expect(source.find((item) => item.id === 'system')!.label).toBe('openWith.systemDefault')

    // ...and the editor gate is platform-independent, so a Windows PDF drops it too.
    for (const absolutePath of ['C:\\w\\report.pdf', '\\\\server\\share\\brief.docx']) {
      const binary = buildOpenWithItems({ kind: 'file', absolutePath, previewable: false }, windowsTargets, deps)
      expect(binary.some((item) => item.id.startsWith('ide:'))).toBe(false)
      expect(binary.find((item) => item.id === 'system')!.label).toBe('openWith.systemDefault')
    }
  })

  it('rules a line between the open, copy and reveal groups', () => {
    const deps = makeDeps({ copyPath: vi.fn(), copyFileContent: vi.fn() })
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/app.py', relPath: 'app.py', previewable: true }

    const items = buildOpenWithItems(ctx, [systemTarget, ideTarget, fmTarget], deps)

    expect(items.filter((item) => item.separatorBefore).map((item) => item.id))
      .toEqual(['system', 'copy-path', 'fm:finder'])
    // Never above the first row — there is nothing to separate it from.
    expect(items[0]!.separatorBefore).toBeUndefined()
  })

  it('ide item carries the target object', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/a.md', relPath: 'a.md', previewable: true }
    const items = buildOpenWithItems(ctx, [ideTarget, fmTarget], deps)
    const ideItem = items.find((i) => i.id === 'ide:code')!
    expect(ideItem.target).toBe(ideTarget)
  })
})

describe('buildOpenWithItems – file context with inAppBrowserUrl (no previewable)', () => {
  it('returns only the browser preview item for no targets + inAppBrowserUrl', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = {
      kind: 'file',
      absolutePath: '/w/page.html',
      inAppBrowserUrl: 'http://127.0.0.1:4321/preview-fs/s1/page.html',
    }
    const items = buildOpenWithItems(ctx, [], deps)
    expect(items.map((i) => i.id)).toEqual(['in-app', 'system'])
  })

  it('in-app calls openInAppBrowser with inAppBrowserUrl', () => {
    const deps = makeDeps()
    const inAppBrowserUrl = 'http://127.0.0.1:4321/preview-fs/s1/page.html'
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/page.html', inAppBrowserUrl }
    const items = buildOpenWithItems(ctx, [], deps)
    items.find((i) => i.id === 'in-app')!.onSelect()
    expect(deps.openInAppBrowser).toHaveBeenCalledWith(inAppBrowserUrl)
  })
})
