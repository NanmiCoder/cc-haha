import { describe, expect, it } from 'vitest'
import { isHtmlFilePath, shouldOfferStaticHtmlPreview } from './htmlPreviewPolicy'

describe('isHtmlFilePath', () => {
  it('matches html/htm/xhtml regardless of separators and suffixes', () => {
    expect(isHtmlFilePath('index.html')).toBe(true)
    expect(isHtmlFilePath('page.htm')).toBe(true)
    expect(isHtmlFilePath('a/b.xhtml')).toBe(true)
    expect(isHtmlFilePath('C:\\proj\\page.html')).toBe(true)
    expect(isHtmlFilePath('app.html?v=2#top')).toBe(true)
  })

  it('rejects non-html paths', () => {
    expect(isHtmlFilePath('style.css')).toBe(false)
    expect(isHtmlFilePath('readme.md')).toBe(false)
  })
})

describe('shouldOfferStaticHtmlPreview', () => {
  it('is false for non-html files', () => {
    expect(shouldOfferStaticHtmlPreview('app.js')).toBe(false)
    expect(shouldOfferStaticHtmlPreview('styles/site.css')).toBe(false)
  })

  it('offers static preview for non-index html pages', () => {
    expect(shouldOfferStaticHtmlPreview('todo.html')).toBe(true)
    expect(shouldOfferStaticHtmlPreview('pages/about.html')).toBe(true)
  })

  it('offers static preview for a hand-authored single-page index.html (no project manifest)', () => {
    // The real-world regression: a "make me a todo page" output written into a
    // subfolder must still get a browser preview — it is NOT a build template.
    expect(shouldOfferStaticHtmlPreview('todo-app/index.html')).toBe(true)
    expect(
      shouldOfferStaticHtmlPreview('todo-app/index.html', {
        siblingFiles: ['todo-app/index.html', 'todo-app/style.css', 'todo-app/app.js'],
      }),
    ).toBe(true)
  })

  it('defaults a bare index.html to static preview when no change-set context is given', () => {
    expect(shouldOfferStaticHtmlPreview('index.html')).toBe(true)
  })

  it('routes a framework-template index.html (manifest in the same change-set) to source view', () => {
    expect(
      shouldOfferStaticHtmlPreview('index.html', {
        siblingFiles: ['index.html', 'package.json', 'vite.config.ts', 'src/main.tsx'],
      }),
    ).toBe(false)
    expect(
      shouldOfferStaticHtmlPreview('my-app/index.html', {
        siblingFiles: ['my-app/package.json', 'my-app/index.html', 'my-app/src/main.tsx'],
      }),
    ).toBe(false)
  })

  it('only treats a manifest as a signal when it sits at or above the index.html dir', () => {
    // A package.json in an unrelated sibling folder must not suppress the preview.
    expect(
      shouldOfferStaticHtmlPreview('site/index.html', {
        siblingFiles: ['api/package.json', 'site/index.html', 'site/app.js'],
      }),
    ).toBe(true)
  })

  it('always offers static preview for build-output and generated exports', () => {
    expect(shouldOfferStaticHtmlPreview('dist/index.html')).toBe(true)
    expect(shouldOfferStaticHtmlPreview('out/index.html')).toBe(true)
    expect(shouldOfferStaticHtmlPreview('build/index.html')).toBe(true)
    expect(shouldOfferStaticHtmlPreview('report_files/index.html')).toBe(true)
    // Even with a manifest present, a built artifact dir stays statically previewable.
    expect(
      shouldOfferStaticHtmlPreview('dist/index.html', { siblingFiles: ['package.json', 'dist/index.html'] }),
    ).toBe(true)
  })

  it('normalizes windows separators and url suffixes', () => {
    expect(shouldOfferStaticHtmlPreview('todo-app\\index.html')).toBe(true)
    expect(shouldOfferStaticHtmlPreview('page.html?v=1#frag')).toBe(true)
  })
})
