import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { CuCallToolResult } from '../../vendor/computer-use-mcp/toolCalls.js'
import { AgentDesktopProcessError, type AgentDesktopProcessResult } from './agentDesktopProcess.js'

export type AgentDesktopEnvelope = {
  ok: boolean
  command: string
  data?: Record<string, unknown>
  error?: Record<string, unknown>
  [key: string]: unknown
}

export type AgentDesktopCursorConfiguration = {
  configured: boolean | null
  warning?: { code: string; message: string }
}

const cursorFeedbackPrefix = 'CC_HAHA_CURSOR_FEEDBACK '

export function cursorFeedback(stderr: string, configuration: AgentDesktopCursorConfiguration) {
  let attempted = false
  let rendered: boolean | null = null
  let warning = configuration.warning
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith(cursorFeedbackPrefix)) continue
    let event: unknown
    try { event = JSON.parse(line.slice(cursorFeedbackPrefix.length)) } catch { continue }
    if (!record(event) || typeof event.acknowledged !== 'boolean') continue
    attempted = true
    if (event.acknowledged) rendered = true
    if (record(event.warning) && typeof event.warning.code === 'string' && typeof event.warning.message === 'string') {
      if (rendered !== true) rendered = false
      warning ??= { code: event.warning.code, message: event.warning.message }
    }
  }
  return { configured: configuration.configured, attempted, rendered, ...(warning ? { warning } : {}) }
}

export function parseAgentDesktopEnvelope(stdout: string): AgentDesktopEnvelope {
  const value: unknown = JSON.parse(stdout)
  if (!record(value) || typeof value.ok !== 'boolean' || typeof value.command !== 'string') {
    throw new Error('agent-desktop returned an invalid JSON envelope')
  }
  return value as AgentDesktopEnvelope
}

export function parseAgentDesktopProcessEnvelope(result: AgentDesktopProcessResult, command = 'desktop'): AgentDesktopEnvelope {
  if (result.exitCode === 2 && !result.stdout.trim()) {
    return {
      ok: false,
      command,
      error: {
        code: 'INVALID_ARGS',
        message: result.stderr.trim().slice(0, 8192) || 'agent-desktop rejected the CLI arguments',
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      },
    }
  }
  try {
    return parseAgentDesktopEnvelope(result.stdout)
  } catch {
    throw new AgentDesktopProcessError(
      `agent-desktop exited with code ${String(result.exitCode)} without a valid JSON response; execution result is unknown. ${result.stderr.trim().slice(0, 2048) || 'Inspect live state before retrying.'}`,
      'invalid_response',
      true,
    )
  }
}

export async function agentDesktopToolResult(
  result: AgentDesktopProcessResult,
  artifactRoot: string,
  help: boolean,
  command?: string,
  cursor?: AgentDesktopCursorConfiguration,
): Promise<CuCallToolResult> {
  if (help && result.exitCode === 0) return { content: [{ type: 'text', text: result.stdout }] }
  const envelope = parseAgentDesktopProcessEnvelope(result, command)
  if (cursor) {
    envelope.cursor_overlay = {
      ...cursorFeedback(result.stderr, cursor),
      ...(result.stderrTruncated ? { diagnostics_truncated: true } : {}),
    }
  }
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
  let imageBytes = 0
  const extract = async (entry: AgentDesktopEnvelope) => {
    const data = entry.data
    if (!entry.ok || !data) return
    if (entry.command === 'screenshot' || (entry.command === 'clipboard-get' && data.type === 'image' && data.found !== false)) {
      const format = typeof data.format === 'string' ? data.format : 'png'
      const mimeType = format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
      let bytes: Buffer
      if (typeof data.data === 'string') {
        if (data.data.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data)) throw new Error('Native screenshot exceeds the image limit or has invalid base64')
        bytes = Buffer.from(data.data, 'base64')
      } else if (typeof data.path === 'string') {
        const filename = data.path
        if (!within(artifactRoot, filename)) throw new Error('Native image output escaped the host artifact directory')
        const info = await lstat(filename)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Native image output is not a bounded regular file')
        if (!within(await realpath(artifactRoot), await realpath(filename))) throw new Error('Native image output escaped the host artifact directory')
        bytes = await readFile(filename)
        await rm(filename, { force: true })
      } else {
        throw new Error('Native screenshot returned no image')
      }
      imageBytes += bytes.length
      if (bytes.length > 16 * 1024 * 1024 || imageBytes > 32 * 1024 * 1024) throw new Error('Native image output exceeds the image limit')
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType })
      delete data.data
      delete data.path
      data.image_delivered = true
      data.mime_type = mimeType
    }
    if (entry.command === 'batch' && Array.isArray(data.results)) {
      for (const nested of data.results) {
        if (record(nested) && typeof nested.ok === 'boolean' && typeof nested.command === 'string') await extract(nested as AgentDesktopEnvelope)
      }
    }
  }
  await extract(envelope)
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }, ...images],
    ...(!envelope.ok || result.exitCode !== 0 ? { isError: true } : {}),
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function within(root: string, filename: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filename))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
