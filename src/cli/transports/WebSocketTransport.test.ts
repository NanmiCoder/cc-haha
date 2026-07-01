/**
 * Regression test for the PERMANENT_CLOSE_CODES set in WebSocketTransport.
 *
 * The fix under test: adding 1008 (Policy Violation) so that a stale CLI
 * subprocess does NOT infinitely retry at 1 Hz against the session-ingress
 * server. Before this fix, the WS handshake succeeded (triggering `open`
 * which resets the backoff counter), then the server immediately
 * `close(1008, 'Invalid SDK token')`. Because 1008 was not in
 * PERMANENT_CLOSE_CODES, the transport treated it as transient, re-opened
 * with reset attempts=0, and looped at ~1/sec until the 10-minute budget
 * ran out — causing a "Rejected SDK connection" storm visible in
 * diagnostics exports.
 *
 * This test file does NOT fully unit-test WebSocketTransport (that would
 * require a WS server mock); it only freezes the exported constant shape
 * so future edits can't accidentally re-introduce the storm.
 */
import { describe, expect, it } from 'bun:test'

// We test the constant by importing the module and checking its exported
// transport behavior indirectly: the constant isn't exported, but we can
// import the module and inspect the class's static fields or test via
// integration. Since PERMANENT_CLOSE_CODES is module-private, we verify
// via a lightweight integration: instantiate the class with a fake URL,
// then invoke the close handler and check the state transition.
//
// But since the class constructor immediately tries to open a WebSocket
// connection (which fails without a server), we instead do a source-level
// assertion: read the source file and confirm the constant includes 1008.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE_PATH = join(import.meta.dir, 'WebSocketTransport.ts')
const source = readFileSync(SOURCE_PATH, 'utf-8')

describe('WebSocketTransport PERMANENT_CLOSE_CODES', () => {
  it('includes 1008 (policy violation) to prevent post-handshake reject storms', () => {
    // The set literal must contain 1008 as a numeric entry.
    expect(source).toMatch(/PERMANENT_CLOSE_CODES\s*=\s*new\s+Set\(\[[\s\S]*?1008[\s\S]*?\]\)/)
  })

  it('includes all previously-specified permanent codes (regression guard)', () => {
    expect(source).toMatch(/1002/)
    expect(source).toMatch(/4001/)
    expect(source).toMatch(/4003/)
  })

  it('does NOT include 1000 or 1001 (normal/going-away closures should not be permanent)', () => {
    // Extract only the Set literal to avoid false positives from comments
    const setMatch = source.match(/PERMANENT_CLOSE_CODES\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/)
    expect(setMatch).not.toBeNull()
    const setBody = setMatch![1]
    // These codes should never appear as literal numbers in the Set
    expect(setBody).not.toMatch(/\b1000\b/)
    expect(setBody).not.toMatch(/\b1001\b/)
  })
})
