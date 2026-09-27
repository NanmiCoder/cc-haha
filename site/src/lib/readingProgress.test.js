import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readingProgress, copyCode } from './readingProgress.js'

test('reading progress respects sticky header and clamps before/after the article', () => {
  const page = { height: 1800, viewportHeight: 900, headerHeight: 100 }
  assert.equal(readingProgress({ ...page, top: 300 }), 0)
  assert.equal(readingProgress({ ...page, top: -400 }), 50)
  assert.equal(readingProgress({ ...page, top: -1000 }), 100)
})
test('short articles are complete when their top reaches the reading area', () => {
  const page = { height: 300, viewportHeight: 900, headerHeight: 100 }
  assert.equal(readingProgress({ ...page, top: 200 }), 0)
  assert.equal(readingProgress({ ...page, top: 100 }), 100)
})
test('code copying preserves exact whitespace and reports unavailable/denied clipboard', async () => {
  let copied
  const code = '  const value = 1\n\n'
  assert.equal(await copyCode(code, { writeText: async text => { copied = text } }), true)
  assert.equal(copied, code)
  assert.equal(await copyCode(code, undefined), false)
  assert.equal(await copyCode(code, { writeText: async () => { throw new Error('denied') } }), false)
})
