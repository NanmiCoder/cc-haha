import { describe, expect, it } from 'vitest'
import { setBaseUrl } from '../api/client'
import { attachmentImageSource, isInlineImagePath, isManagedGeneratedImagePath, localImageFileUrl } from './attachmentImages'

describe('attachment image sources', () => {
  it('recognizes managed image results in a relocated data directory', () => {
    expect(isManagedGeneratedImagePath('D:\\Haha Data\\cc-haha\\generated-images\\session\\image.png')).toBe(true)
    expect(isManagedGeneratedImagePath('/Volumes/Data/haha/cc-haha/generated-images/session/image.png')).toBe(true)
    expect(isManagedGeneratedImagePath('/project/generated-images/image.png')).toBe(false)
  })

  it('recognizes the extensions the server inlines as images', () => {
    expect(isInlineImagePath('/Users/nanmi/Desktop/a.png')).toBe(true)
    expect(isInlineImagePath('/Users/nanmi/Desktop/a.JPG')).toBe(true)
    expect(isInlineImagePath('a.jpeg')).toBe(true)
    expect(isInlineImagePath('a.gif')).toBe(true)
    expect(isInlineImagePath('a.webp')).toBe(true)
    expect(isInlineImagePath('a.svg')).toBe(false)
    expect(isInlineImagePath('a.pdf')).toBe(false)
    expect(isInlineImagePath('png')).toBe(false)
    expect(isInlineImagePath(undefined)).toBe(false)
  })

  it('prefers an already inlined preview over a server round trip', () => {
    expect(
      attachmentImageSource({ previewUrl: 'data:image/png;base64,PREVIEW', data: 'data:image/png;base64,DATA' }),
    ).toBe('data:image/png;base64,PREVIEW')
    expect(attachmentImageSource({ data: 'data:image/png;base64,DATA' })).toBe('data:image/png;base64,DATA')
  })

  it('serves a path-only desktop image through the local server', () => {
    setBaseUrl('http://127.0.0.1:4321')

    expect(attachmentImageSource({ path: '/Users/nanmi/Desktop/6代码仓库.png' })).toBe(
      `http://127.0.0.1:4321/api/filesystem/file?path=${encodeURIComponent('/Users/nanmi/Desktop/6代码仓库.png')}`,
    )
    expect(attachmentImageSource({ path: 'C:\\Users\\Nanmi\\Desktop\\shot.png' })).toBe(
      localImageFileUrl('C:\\Users\\Nanmi\\Desktop\\shot.png'),
    )

    setBaseUrl('http://127.0.0.1:3456')
  })

  it('has no source for paths the endpoint cannot resolve or serve', () => {
    // Relative paths would resolve against the server cwd rather than the workspace.
    expect(attachmentImageSource({ path: 'docs/diagram.png' })).toBeUndefined()
    expect(attachmentImageSource({ path: '/Users/nanmi/Desktop/notes.md' })).toBeUndefined()
    expect(attachmentImageSource({ path: '/Users/nanmi/Pictures', isDirectory: true })).toBeUndefined()
    expect(attachmentImageSource({})).toBeUndefined()
  })
})
