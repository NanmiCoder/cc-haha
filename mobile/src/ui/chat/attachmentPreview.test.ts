import { expect, test } from 'bun:test'
import { attachmentImageSelection, attachmentImageUri } from './attachmentPreview'

test('previews local selections and replayed Base64 without treating computer paths as phone files', () => {
  expect(attachmentImageUri({ type: 'image', uri: 'file:///cache/photo.jpg', data: 'AA==' })).toBe('file:///cache/photo.jpg')
  expect(attachmentImageUri({ type: 'image', data: 'AA==', mimeType: 'image/png' })).toBe('data:image/png;base64,AA==')
  expect(attachmentImageUri({ type: 'image', data: 'data:image/png;base64,AA==' })).toBe('data:image/png;base64,AA==')
  expect(attachmentImageUri({ type: 'image', path: '/computer/photo.png' })).toBeUndefined()
  expect(attachmentImageUri({ type: 'file', data: 'AA==', mimeType: 'image/png' })).toBeUndefined()
})

test('mixed files, missing previews and duplicate images preserve the tapped attachment identity', () => {
  const images = [
    { type: 'image' as const, name: 'Mon', uri: 'file:///same.jpg' },
    { type: 'file' as const, name: 'Files.pdf' },
    { type: 'image' as const, name: 'Old image', path: '/computer/missing.png' },
    { type: 'image' as const, name: 'Tue', uri: 'file:///same.jpg' },
  ]
  const selection = attachmentImageSelection(images, 3)
  expect(selection?.initialIndex).toBe(1)
  expect(selection?.images.map((image) => image.name)).toEqual(['Mon', 'Tue'])
  expect(selection?.images.map((image) => image.id)).toEqual(['attachment-0', 'attachment-3'])
  expect(attachmentImageSelection(images, 1)).toBeNull()
  expect(attachmentImageSelection(images, 2)).toBeNull()
  expect(attachmentImageSelection([], 0)).toBeNull()
})
