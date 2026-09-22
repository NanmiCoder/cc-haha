import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTerminalOutput, retainTerminalOutput, subscribeTerminalOutput, TERMINAL_REPLAY_MAX_BYTES } from './terminalOutputReplay'

afterEach(() => clearTerminalOutput())
const bytes = (text: string) => new TextEncoder().encode(text)

describe('connection-owned terminal output replay', () => {
  it('acknowledges stored bytes once, never acknowleding their replay again', () => {
    const ack = vi.fn()
    retainTerminalOutput('host', 'connection', 1, bytes('prompt$ '), ack)
    const rendered: string[] = []
    const stop = subscribeTerminalOutput('host', 'connection', 1, (data, parsed) => { rendered.push(new TextDecoder().decode(data)); parsed() })
    expect(rendered).toEqual(['prompt$ '])
    expect(ack).toHaveBeenCalledTimes(1)
    stop()
    subscribeTerminalOutput('host', 'connection', 1, (_data, parsed) => parsed())
    expect(ack).toHaveBeenCalledTimes(1)
  })

  it('keeps parsing backpressure when mounted and releases pending bytes on unmount', () => {
    const ack = vi.fn()
    let parsed!: () => void
    const stop = subscribeTerminalOutput('h', 'c', 1, (_data, done) => { parsed = done })
    retainTerminalOutput('h', 'c', 1, bytes('one'), ack)
    expect(ack).not.toHaveBeenCalled()
    stop()
    parsed()
    expect(ack).toHaveBeenCalledTimes(1)
  })

  it('bounds replay bytes and clears state across disconnect and new generations', () => {
    retainTerminalOutput('h', 'c', 1, new Uint8Array(TERMINAL_REPLAY_MAX_BYTES + 100), () => {})
    retainTerminalOutput('h', 'c', 1, bytes('latest$ '), () => {})
    let replay: Uint8Array = new Uint8Array()
    subscribeTerminalOutput('h', 'c', 1, data => { replay = data })
    expect(replay.byteLength).toBe(TERMINAL_REPLAY_MAX_BYTES)
    expect(new TextDecoder().decode(replay.slice(-8))).toBe('latest$ ')
    const next = vi.fn()
    subscribeTerminalOutput('h', 'c', 2, next)
    expect(next).not.toHaveBeenCalled()
    clearTerminalOutput('h')
    subscribeTerminalOutput('h', 'c', 2, next)
    expect(next).not.toHaveBeenCalled()
  })
})
