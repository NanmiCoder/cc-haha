import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useState, useEffect, useRef, useCallback } from 'react'
import './styles.css'

// ---------- Tiny Web Chat ----------
// A self-contained single-page web chat that talks to the Bun server
// via HTTP (sessions, messages) and WebSocket (real-time stream).
// No desktop/src or src/ imports — avoids the entire CLI dependency graph.
// ----------

const API = window.location.origin

// ---- helpers ----
async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(API + path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error((err as { message?: string }).message ?? `${res.status}`)
  }
  return res.json()
}

// ---- types ----
type SessionInfo = { id: string; title: string; modifiedAt: string }
type ChatMessage = {
  id: string
  type: string
  content?: string
  text?: string
  toolName?: string
  toolUseId?: string
  input?: unknown
  timestamp: number
  model?: string
}

type ServerMsg =
  | { type: 'connected'; sessionId: string }
  | { type: 'content_delta'; text: string }
  | { type: 'content_start'; blockType: string }
  | { type: 'thinking'; text: string }
  | { type: 'assistant_text'; content: string; timestamp: number; model?: string }
  | { type: 'tool_use_complete'; toolName: string; toolUseId: string; input: unknown }
  | { type: 'status'; state: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'message_complete' }
  | { type: 'pong' }

// ---- App ----
function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const msgId = useRef(0)

  const nextId = () => `ui-${++msgId.current}-${Date.now()}`

  // ---- sessions ----
  const loadSessions = useCallback(async () => {
    try {
      const data = await apiGet<{ sessions: SessionInfo[] }>('/api/sessions')
      setSessions(data.sessions)
    } catch {
      // server may not be running yet
    }
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions])

  // ---- WebSocket ----
  const connectWS = useCallback((sessionId: string) => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    const proto = API.startsWith('https') ? 'wss' : 'ws'
    const url = `${proto}://${new URL(API).host}/ws/${sessionId}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => setBusy(false)
    ws.onmessage = (e) => {
      const msg: ServerMsg = JSON.parse(e.data)
      switch (msg.type) {
        case 'connected':
          setMessages([])
          setStreaming('')
          break
        case 'content_delta':
          setStreaming((prev) => prev + msg.text)
          break
        case 'assistant_text':
          setMessages((prev) => [...prev, {
            id: nextId(),
            type: 'assistant_text',
            content: msg.content,
            timestamp: msg.timestamp,
            model: msg.model,
          }])
          setStreaming('')
          break
        case 'thinking':
          setMessages((prev) => [...prev, {
            id: nextId(),
            type: 'thinking',
            content: msg.text,
            timestamp: Date.now(),
          }])
          break
        case 'tool_use_complete':
          setMessages((prev) => [...prev, {
            id: nextId(),
            type: 'tool_use',
            toolName: msg.toolName,
            toolUseId: msg.toolUseId,
            input: msg.input,
            timestamp: Date.now(),
          }])
          break
        case 'message_complete':
          setBusy(false)
          setStreaming('')
          break
        case 'error':
          setError(msg.message)
          setBusy(false)
          break
      }
    }
    ws.onerror = () => setError('WebSocket connection lost')
    ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null }
  }, [nextId])

  // ---- actions ----
  const createSession = async () => {
    try {
      const data = await apiPost<{ sessionId: string }>('/api/sessions', {})
      setActiveId(data.sessionId)
      connectWS(data.sessionId)
      setMessages([])
      setStreaming('')
      setError(null)
      await loadSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    }
  }

  const selectSession = (id: string) => {
    setActiveId(id)
    connectWS(id)
    setMessages([])
    setStreaming('')
    setError(null)
  }

  const sendMessage = async (content: string) => {
    if (!activeId || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    setBusy(true)
    setStreaming('')
    setError(null)
    setMessages((prev) => [...prev, {
      id: nextId(),
      type: 'user',
      content,
      timestamp: Date.now(),
    }])
    wsRef.current.send(JSON.stringify({ type: 'user_message', content }))
  }

  const stopGeneration = () => {
    if (!activeId) return
    wsRef.current?.send(JSON.stringify({ type: 'stop_generation' }))
    setBusy(false)
  }

  const activeTitle = sessions.find((s) => s.id === activeId)?.title ?? 'Untitled'

  // ---- render ----
  return (
    <div className="h-screen flex flex-col bg-[#1e1e2e] text-[#cdd6f4] font-sans">
      {/* header */}
      <header className="h-10 shrink-0 flex items-center border-b border-[#313244] px-3 bg-[#181825]">
        <button
          className="mr-2 rounded p-1 hover:bg-[#313244] text-[#a6adc8]"
          onClick={() => setActiveId(null)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        </button>
        <span className="text-sm font-medium truncate flex-1">{activeId ? activeTitle : 'Claude Code Web'}</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* sidebar */}
        {!activeId && (
          <aside className="w-64 shrink-0 border-r border-[#313244] flex flex-col bg-[#181825]">
            <div className="p-3">
              <button
                className="w-full rounded bg-[#89b4fa] px-3 py-2 text-sm font-medium text-[#1e1e2e] hover:bg-[#74c7ec]"
                onClick={createSession}
              >
                New Session
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  className="w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-[#313244] text-[#cdd6f4]"
                  onClick={() => selectSession(s.id)}
                >
                  {s.title || 'Untitled'}
                </button>
              ))}
            </div>
          </aside>
        )}

        {activeId && (
          <button
            className="shrink-0 border-r border-[#313244] px-2 text-xs text-[#a6adc8] hover:bg-[#313244] bg-[#181825]"
            onClick={() => setActiveId(null)}
            title="Back to sessions"
          >
            &laquo;
          </button>
        )}

        {/* chat */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {activeId ? (
              <>
                {messages.map((m) => (
                  <div key={m.id} className={`mb-2 ${m.type === 'user' ? 'text-right' : ''}`}>
                    {m.type === 'user' && (
                      <div className="inline-block rounded-xl bg-[#89b4fa] text-[#1e1e2e] px-3 py-1.5 text-sm max-w-[80%] text-left">
                        {m.content}
                      </div>
                    )}
                    {m.type === 'assistant_text' && m.content && (
                      <div className="inline-block rounded-xl bg-[#313244] px-3 py-1.5 text-sm max-w-[80%] whitespace-pre-wrap">
                        {m.content}
                      </div>
                    )}
                    {m.type === 'thinking' && m.content && (
                      <div className="text-xs text-[#a6adc8] italic px-1">🤔 {m.content}</div>
                    )}
                    {m.type === 'tool_use' && (
                      <div className="text-xs text-[#f9e2af] bg-[#1e1e2e] rounded px-2 py-1 inline-block">
                        🔧 {m.toolName}
                      </div>
                    )}
                  </div>
                ))}
                {streaming && (
                  <div className="inline-block rounded-xl bg-[#313244] px-3 py-1.5 text-sm max-w-[80%] whitespace-pre-wrap">
                    {streaming}
                    <span className="animate-pulse ml-0.5">|</span>
                  </div>
                )}
                {busy && !streaming && (
                  <div className="text-xs text-[#a6adc8] animate-pulse">Thinking...</div>
                )}
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-[#6c7086] text-sm">
                Select a session or create a new one
              </div>
            )}
          </div>

          {/* input */}
          {activeId && (
            <ChatInputBar onSend={sendMessage} onStop={stopGeneration} busy={busy} />
          )}
        </main>
      </div>

      {/* error toast */}
      {error && (
        <div className="fixed bottom-4 right-4 bg-[#f38ba8] text-[#1e1e2e] px-4 py-2 rounded-lg text-sm shadow-lg z-50">
          {error}
          <button className="ml-2 font-bold" onClick={() => setError(null)}>×</button>
        </div>
      )}
    </div>
  )
}

// ---- ChatInputBar ----
function ChatInputBar({ onSend, onStop, busy }: {
  onSend: (text: string) => void
  onStop: () => void
  busy: boolean
}) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    onSend(trimmed)
    setText('')
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="border-t border-[#313244] p-3 bg-[#181825]">
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          className="flex-1 resize-none rounded-lg bg-[#313244] border border-[#45475a] px-3 py-2 text-sm text-[#cdd6f4] placeholder-[#6c7086] focus:outline-none focus:border-[#89b4fa]"
          rows={1}
          placeholder="Type a message..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          disabled={busy}
        />
        {busy ? (
          <button
            className="rounded-lg bg-[#f38ba8] px-4 py-2 text-sm font-medium text-[#1e1e2e] hover:bg-[#eba0ac]"
            onClick={onStop}
          >
            Stop
          </button>
        ) : (
          <button
            className="rounded-lg bg-[#89b4fa] px-4 py-2 text-sm font-medium text-[#1e1e2e] hover:bg-[#74c7ec] disabled:opacity-50"
            onClick={handleSend}
            disabled={!text.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}

// ---- bootstrap ----
createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
