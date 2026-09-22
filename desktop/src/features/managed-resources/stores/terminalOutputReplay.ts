type WriteOutput = (bytes: Uint8Array, parsed: () => void) => void

type OutputSession = {
  connectionId: string
  generation: number
  chunks: Uint8Array[]
  size: number
  writer: WriteOutput | null
  pending: Set<() => void>
}

// Memory only, bounded per live connection. Never put terminal contents in a
// persisted Zustand store, localStorage, conversation history or diagnostics.
export const TERMINAL_REPLAY_MAX_BYTES = 1024 * 1024
const sessions = new Map<string, OutputSession>()

function release(session: OutputSession) {
  session.writer = null
  for (const parsed of [...session.pending]) parsed()
}

export function clearTerminalOutput(hostId?: string): void {
  if (hostId === undefined) {
    for (const session of sessions.values()) release(session)
    sessions.clear()
  } else {
    const session = sessions.get(hostId)
    if (session) release(session)
    sessions.delete(hostId)
  }
}

function resolve(hostId: string, connectionId: string, generation: number): OutputSession {
  let session = sessions.get(hostId)
  if (!session || session.connectionId !== connectionId || session.generation !== generation) {
    if (session) release(session)
    session = { connectionId, generation, chunks: [], size: 0, writer: null, pending: new Set() }
    sessions.set(hostId, session)
  }
  return session
}

/** Called by the store subscription established BEFORE SSH starts. */
export function retainTerminalOutput(hostId: string, connectionId: string, generation: number, bytes: Uint8Array, acknowledge: () => void): void {
  const session = resolve(hostId, connectionId, generation)
  const copy = bytes.slice()
  session.chunks.push(copy)
  session.size += copy.length
  while (session.size > TERMINAL_REPLAY_MAX_BYTES && session.chunks.length > 0) {
    const first = session.chunks[0]!
    const drop = Math.min(first.length, session.size - TERMINAL_REPLAY_MAX_BYTES)
    session.size -= drop
    if (drop === first.length) session.chunks.shift()
    else session.chunks[0] = first.slice(drop)
  }
  let acknowledged = false
  const parsed = () => {
    if (acknowledged) return
    acknowledged = true
    session.pending.delete(parsed)
    acknowledge()
  }
  if (!session.writer) {
    // No mounted terminal: bounded replay storage has accepted these bytes.
    // Do not leave the remote PTY permanently paused waiting for a hidden UI.
    parsed()
    return
  }
  session.pending.add(parsed)
  try { session.writer(copy, parsed) } catch { parsed() }
}

/** Replay then subscribe synchronously: there is no snapshot/subscription gap. */
export function subscribeTerminalOutput(hostId: string, connectionId: string, generation: number, writer: WriteOutput): () => void {
  const session = resolve(hostId, connectionId, generation)
  release(session)
  session.writer = writer
  const snapshot = new Uint8Array(session.size)
  let offset = 0
  for (const chunk of session.chunks) { snapshot.set(chunk, offset); offset += chunk.length }
  if (snapshot.length > 0) writer(snapshot, () => {}) // Already ACKed; never ACK replay twice.
  return () => {
    if (session.writer === writer) release(session)
  }
}
