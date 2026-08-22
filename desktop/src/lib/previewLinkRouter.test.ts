import { describe, expect, it } from 'vitest'
import { classifyPreviewLink } from './previewLinkRouter'

describe('classifyPreviewLink', () => {
  it('classifies loopback urls as browser-localhost', () => {
    expect(classifyPreviewLink('http://localhost:5173/').kind).toBe('browser-localhost')
    expect(classifyPreviewLink('http://127.0.0.1:8080/x').kind).toBe('browser-localhost')
  })
  it('classifies html file paths as browser-file', () => {
    expect(classifyPreviewLink('file:///Users/x/index.html').kind).toBe('browser-file')
    expect(classifyPreviewLink('/Users/x/page.htm').kind).toBe('browser-file')
    expect(classifyPreviewLink('./out/index.html').kind).toBe('browser-file')
  })
  it('classifies relative previewable docs as file-preview', () => {
    expect(classifyPreviewLink('docs/report.md').kind).toBe('file-preview')
    expect(classifyPreviewLink('src/app.ts').kind).toBe('file-preview')
  })
  it('sends source files to the code view even when the path is absolute', () => {
    // The code view is the only surface that can reveal a line; a browser
    // surface would just dump the source as plain text.
    expect(classifyPreviewLink('/Users/x/app.ts').kind).toBe('file-preview')
  })
  it('routes office and archive files to their system application instead of the code preview', () => {
    expect(classifyPreviewLink('reports/brief.docx')).toMatchObject({ kind: 'system-file', path: 'reports/brief.docx' })
    expect(classifyPreviewLink('reports/budget.xlsx').kind).toBe('system-file')
    expect(classifyPreviewLink('reports/launch.pptx').kind).toBe('system-file')
    expect(classifyPreviewLink('exports/archive.zip').kind).toBe('system-file')
  })
  it('reads the line suffix the system prompt asks the model to write', () => {
    expect(classifyPreviewLink('src/app.ts:42')).toMatchObject({ kind: 'file-preview', path: 'src/app.ts', line: 42 })
    expect(classifyPreviewLink('src/app.ts:42:8')).toMatchObject({ path: 'src/app.ts', line: 42, column: 8 })
    expect(classifyPreviewLink('src/app.ts#L42')).toMatchObject({ path: 'src/app.ts', line: 42 })
  })
  it('routes Windows drive paths instead of reading the drive as a URL scheme', () => {
    // `new URL('C:\\src\\app.ts')` succeeds with protocol 'c:', so before #1146
    // every path link on Windows classified as `ignored`.
    expect(classifyPreviewLink('C:\\src\\app.ts')).toMatchObject({ kind: 'file-preview', path: 'C:\\src\\app.ts' })
    expect(classifyPreviewLink('C:\\src\\app.ts:42')).toMatchObject({ path: 'C:\\src\\app.ts', line: 42 })
  })
  it('routes the extensions the old private list was missing', () => {
    expect(classifyPreviewLink('.github/workflows/release-desktop.yml:386')).toMatchObject({
      kind: 'file-preview',
      line: 386,
    })
    expect(classifyPreviewLink('scripts/windows-installer-smoke.ps1:14').kind).toBe('file-preview')
  })
  it('still ignores prose that only looks like a path', () => {
    expect(classifyPreviewLink('console.log').kind).toBe('ignored')
    expect(classifyPreviewLink('example.com').kind).toBe('ignored')
  })
  it('classifies remote http(s) as remote', () => {
    expect(classifyPreviewLink('https://example.com').kind).toBe('remote')
  })
  it('ignores anchors and empty', () => {
    expect(classifyPreviewLink('#section').kind).toBe('ignored')
    expect(classifyPreviewLink('').kind).toBe('ignored')
  })
  it('exposes a normalized path for file kinds', () => {
    expect(classifyPreviewLink('file:///Users/x/index.html').path).toBe('/Users/x/index.html')
    expect(classifyPreviewLink('docs/report.md').path).toBe('docs/report.md')
  })
})
