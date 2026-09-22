import { expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { filesystemApi } from '@/api/filesystem'
vi.mock('@/api/client', () => ({ api: { get: vi.fn() } }))

it('forwards cancellation for keyword searches and directory browsing', () => {
  const signal = new AbortController().signal
  filesystemApi.search('修复', '/work', { signal })
  filesystemApi.browse('/work/src', { includeFiles: true, signal })
  expect(api.get).toHaveBeenCalledWith('/api/filesystem/browse?search=%E4%BF%AE%E5%A4%8D&maxResults=200&includeFiles=true&path=%2Fwork', { signal })
  expect(api.get).toHaveBeenCalledWith('/api/filesystem/browse?path=%2Fwork%2Fsrc&includeFiles=true', { includeFiles: true, signal })
})
