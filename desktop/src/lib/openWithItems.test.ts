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

  it('offers path-specific native applications before system default for a binary document', () => {
    const deps = makeDeps()
    const ctx: OpenWithContext = { kind: 'file', absolutePath: '/w/brief.docx', previewable: false }

    const items = buildOpenWithItems(ctx, [appTarget, systemTarget, ideTarget, fmTarget], deps)

    expect(items.map((item) => item.id)).toEqual([
      'app:application:pages',
      'system',
      'ide:code',
      'fm:finder',
    ])
    items[0]!.onSelect()
    expect(deps.openTarget).toHaveBeenCalledWith('application:pages', '/w/brief.docx')
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
