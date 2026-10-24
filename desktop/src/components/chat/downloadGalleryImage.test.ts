import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadGalleryImage } from '@/components/chat/downloadGalleryImage'
import { fetchServerImageBlobUrl } from '@/lib/authedImage'

vi.mock('@/lib/authedImage', () => ({ fetchServerImageBlobUrl: vi.fn() }))

describe('downloadGalleryImage', () => {
  const downloads: Array<{ href: string; name: string }> = []
  beforeEach(() => {
    vi.useFakeTimers()
    downloads.length = 0
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, name: this.download })
    })
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:download-original'),
      revokeObjectURL: vi.fn(),
    }))
    vi.mocked(fetchServerImageBlobUrl).mockResolvedValue('blob:download-server')
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('downloads the chosen inline pixels and releases only its own object URL', async () => {
    await downloadGalleryImage({ src: 'blob:row-thumbnail', name: 'Screenshot', inline: { mediaType: 'image/png', data: 'AAAA' } })
    expect(downloads).toEqual([{ href: 'blob:download-original', name: 'Screenshot.png' }])
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.runOnlyPendingTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download-original')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:row-thumbnail')
  })

  it('uses the authenticated image fetch for server files and their original filename', async () => {
    const src = 'http://127.0.0.1:3456/api/filesystem/image?path=chart.webp'
    await downloadGalleryImage({ src, name: 'Chart', path: 'C:\\Pictures\\chart.webp' })
    expect(fetchServerImageBlobUrl).toHaveBeenCalledWith(src)
    expect(downloads).toEqual([{ href: 'blob:download-server', name: 'chart.webp' }])
    vi.runOnlyPendingTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download-server')
  })

  it.each([
    [{ src: 'blob:row-thumbnail', name: 'Screenshot', path: '/tmp/screen.png', inline: { mediaType: 'image/jpeg' as const, data: 'AAAA' } }, 'screen.jpg'],
    [{ src: 'data:image/webp;base64,AAAA', name: 'photo.png' }, 'photo.webp'],
  ])('uses the actual pixel format when it differs from the original filename', async (image, name) => {
    // Read can return compressed JPEG pixels for an original PNG path.
    await downloadGalleryImage(image)
    expect(downloads[0]?.name).toBe(name)
  })

  it.each(['图片 1/1', '图片 1\\1'])('preserves display names containing filename separators: %s', async (name) => {
    await downloadGalleryImage({ src: 'data:image/png;base64,AAAA', name })
    expect(downloads[0]?.name).toBe('图片 1-1.png')
  })

  it('preserves an existing matching JPEG extension', async () => {
    await downloadGalleryImage({ src: 'data:image/jpeg;base64,AAAA', name: 'Photo.JPEG' })
    expect(downloads[0]?.name).toBe('Photo.JPEG')
  })

  it('keeps existing inline URLs alive and propagates failed downloads without a broken link', async () => {
    await downloadGalleryImage({ src: 'data:image/jpeg;base64,AAAA', name: 'Photo' })
    expect(downloads).toEqual([{ href: 'data:image/jpeg;base64,AAAA', name: 'Photo.jpg' }])
    vi.mocked(fetchServerImageBlobUrl).mockRejectedValueOnce(new Error('Image unavailable'))
    await expect(downloadGalleryImage({ src: 'http://127.0.0.1:3456/missing.png', name: 'missing.png' })).rejects.toThrow('Image unavailable')
    expect(downloads).toHaveLength(1)
    vi.runOnlyPendingTimers()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })
})
