import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

export type WechatMediaPreference = { enabled: boolean; voiceId?: string }
export interface WechatMediaPreferences {
  get(chatId: string): WechatMediaPreference
  set(chatId: string, value: WechatMediaPreference): void
}

/** Separate adapter-owned preferences. Never modifies shared settings or credentials.
 * Scope must identify the binding, so a newly bound account cannot inherit opt-in. */
export class WechatMediaPreferenceStore implements WechatMediaPreferences {
  constructor(private readonly filePath: string, private readonly scope: string) {
    if (!scope) throw new Error('Media preference binding scope is required')
  }

  private read(): Record<string, any> {
    try {
      const stat = fs.statSync(this.filePath)
      if (stat.size > 1024 * 1024) throw new Error('语音偏好文件过大')
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('语音偏好格式无效')
      if (data.version !== undefined && data.version !== 0 && data.version !== 1) throw new Error('语音偏好版本不受支持')
      return data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: {} }
      throw error
    }
  }

  get(chatId: string): WechatMediaPreference {
    const data = this.read()
    const entry = data.bindings?.[this.scope]?.[chatId]
    // v0 used a boolean; normalize forward without changing another account.
    if (typeof entry === 'boolean') return { enabled: entry }
    return { enabled: entry?.enabled === true,
      ...(typeof entry?.voiceId === 'string' && entry.voiceId.length <= 2048 ? { voiceId: entry.voiceId } : {}) }
  }

  set(chatId: string, value: WechatMediaPreference): void {
    const data = this.read()
    if (data.version === 0) {
      try { fs.copyFileSync(this.filePath, `${this.filePath}.v0.bak`, fs.constants.COPYFILE_EXCL) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const bindings = data.bindings && typeof data.bindings === 'object' && !Array.isArray(data.bindings) ? data.bindings : {}
    const entries = bindings[this.scope] && typeof bindings[this.scope] === 'object' ? bindings[this.scope] : {}
    const old = entries[chatId]
    const updated = { ...data, version: 1, bindings: { ...bindings, [this.scope]: { ...entries,
      [chatId]: { ...(old && typeof old === 'object' ? old : {}), enabled: value.enabled, voiceId: value.voiceId },
    } } }
    const encoded = JSON.stringify(updated, null, 2)
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('语音偏好文件过大')
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try { fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.filePath) }
    finally { try { fs.unlinkSync(temporary) } catch {} }
  }
}
