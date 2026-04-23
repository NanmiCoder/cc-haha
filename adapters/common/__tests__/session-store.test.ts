import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionStore } from '../session-store.js'

describe('SessionStore', () => {
  let tmpDir: string
  let store: SessionStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'))
    store = new SessionStore(path.join(tmpDir, 'sessions.json'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null for unknown chatId', () => {
    expect(store.get('unknown')).toBeNull()
  })

  it('stores and retrieves a session', () => {
    store.set('chat-1', 'uuid-aaa', '/path/to/project')
    const entry = store.get('chat-1')
    expect(entry).not.toBeNull()
    expect(entry!.sessionId).toBe('uuid-aaa')
    expect(entry!.workDir).toBe('/path/to/project')
  })

  it('overwrites existing entry on set', () => {
    store.set('chat-1', 'uuid-aaa', '/old')
    store.set('chat-1', 'uuid-bbb', '/new')
    expect(store.get('chat-1')!.sessionId).toBe('uuid-bbb')
  })

  it('deletes an entry', () => {
    store.set('chat-1', 'uuid-aaa', '/path')
    store.delete('chat-1')
    expect(store.get('chat-1')).toBeNull()
  })

  it('persists to disk and reloads', () => {
    store.set('chat-1', 'uuid-aaa', '/path')

    const store2 = new SessionStore(path.join(tmpDir, 'sessions.json'))
    expect(store2.get('chat-1')!.sessionId).toBe('uuid-aaa')
  })

  it('handles missing file gracefully', () => {
    const store2 = new SessionStore(path.join(tmpDir, 'nonexistent.json'))
    expect(store2.get('anything')).toBeNull()
  })

  it('lists all entries', () => {
    store.set('chat-1', 'uuid-1', '/a')
    store.set('chat-2', 'uuid-2', '/b')
    const all = store.listAll()
    expect(all).toHaveLength(2)
  })
})
