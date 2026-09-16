import { describe, expect, it } from 'vitest'
import { normalizeBrowserAddress } from './browserAddress'

describe('workspace address input', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['example.test/index.html', 'https://example.test/index.html'],
    ['localhost:3000/a', 'http://localhost:3000/a'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['[::1]:3000', 'http://[::1]:3000'],
    ['https://example.test/q?x=1', 'https://example.test/q?x=1'],
    ['index.html', 'index.html'],
    ['./app/index.html', './app/index.html'],
    ['/tmp/index.html', '/tmp/index.html'],
    ['hello world', 'https://www.google.com/search?q=hello%20world'],
    ['中文 搜索', 'https://www.google.com/search?q=%E4%B8%AD%E6%96%87%20%E6%90%9C%E7%B4%A2'],
    ['javascript:alert(1)', ''],
    ['', ''],
  ])('resolves %s as %s', (input, expected) => {
    expect(normalizeBrowserAddress(input)).toBe(expected)
  })
})
