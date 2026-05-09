import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export type SessionEntry = {
  sessionId: string
  workDir: string
  updatedAt: number
}

type StoreData = Record<string, SessionEntry>

function getDefaultPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapter-sessions.json')
}

export class SessionStore {
  private data: StoreData
  private filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? getDefaultPath()
    this.data = this.load()
  }

  get(chatId: string): SessionEntry | null {
    this.refresh()
    return this.data[chatId] ?? null
  }

  set(chatId: string, sessionId: string, workDir: string): void {
    this.refresh()
    this.data[chatId] = { sessionId, workDir, updatedAt: Date.now() }
    this.save()
  }

  delete(chatId: string): void {
    this.refresh()
    delete this.data[chatId]
    this.save()
  }

  deleteBySessionId(sessionId: string): string[] {
    this.refresh()
    const removed: string[] = []
    for (const [chatId, entry] of Object.entries(this.data)) {
      if (entry.sessionId !== sessionId) continue
      delete this.data[chatId]
      removed.push(chatId)
    }
    if (removed.length > 0) {
      this.save()
    }
    return removed
  }

  listAll(): Array<{ chatId: string } & SessionEntry> {
    this.refresh()
    return Object.entries(this.data).map(([chatId, entry]) => ({ chatId, ...entry }))
  }

  private refresh(): void {
    this.data = this.load()
  }

  private load(): StoreData {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n')
    fs.renameSync(tmp, this.filePath)
  }
}
