import { describe, expect, it } from 'bun:test'
import { HTTP_CONNECTION_IDLE_TIMEOUT_SECONDS } from '../index.js'

describe('server connection lifetime', () => {
  it('lets HTTP clients own pooled connection lifetime', () => {
    expect(HTTP_CONNECTION_IDLE_TIMEOUT_SECONDS).toBe(0)
  })
})
