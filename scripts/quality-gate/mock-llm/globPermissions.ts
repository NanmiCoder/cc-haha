import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LiveContext } from '../agent-flow/live'

type ToolResult = { content?: unknown; is_error?: boolean }

/** Check the permission boundary through the real CLI, using disposable files. */
export async function runGlobPermissions(
  ctx: LiveContext,
  readResults: () => ToolResult[],
) {
  const outside = mkdtempSync(join(dirname(ctx.workRoot), 'glob-outside-'))
  const outsideFile = 'glob-outside-private-sentinel.env'
  const inside = join(ctx.workRoot, 'glob-recovery')
  const insideFile = 'glob-inside-public-sentinel.txt'
  mkdirSync(inside, { recursive: true })
  writeFileSync(join(outside, outsideFile), 'disposable outside fixture')
  writeFileSync(join(inside, insideFile), 'disposable inside fixture')
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    socket.send({ type: 'set_permission_mode', mode: 'default' })
    for (const path of [undefined, ctx.workRoot]) {
      const start = socket.messages.length
      const resultStart = readResults().length
      socket.send({
        type: 'user_message',
        content: `MOCK_TEAM_OWNER ${JSON.stringify({
          tool: 'Glob', input: { pattern: join(outside, '**', '*.env'), ...(path ? { path } : {}) },
        })}`,
      })
      const permission = await socket.waitFor(message =>
        ['permission_request', 'message_complete', 'error'].includes(message.type),
      ctx.stepTimeoutMs, 'absolute Glob outside workspace', start)
      if (permission.type !== 'permission_request') {
        throw new Error(`Absolute Glob escaped its workspace without approval: ${JSON.stringify(permission)}`)
      }
      socket.send({ type: 'permission_response', requestId: permission.requestId, allowed: false })
      await socket.waitFor(message => message.type === 'message_complete',
        ctx.stepTimeoutMs, 'denied Glob result reaches model', start)
      const results = readResults().slice(resultStart)
      if (!results.some(result => result.is_error) || JSON.stringify(results).includes(outsideFile)) {
        throw new Error('Denied Glob must reach the model as an error without enumerating the outside filename')
      }
    }

    const start = socket.messages.length
    const resultStart = readResults().length
    socket.send({
      type: 'user_message',
      content: `MOCK_TEAM_OWNER ${JSON.stringify({ tool: 'Glob', input: { pattern: 'glob-recovery/*.txt' } })}`,
    })
    const completed = await socket.waitFor(message =>
      ['permission_request', 'message_complete', 'error'].includes(message.type),
    ctx.stepTimeoutMs, 'in-workspace Glob recovers after denial', start)
    if (completed.type !== 'message_complete' || !readResults().slice(resultStart).some(result =>
      !result.is_error && JSON.stringify(result.content).includes(insideFile))) {
      throw new Error(`In-workspace Glob did not recover after denial: ${JSON.stringify(completed)}`)
    }
    writeFileSync(join(ctx.artifactDir, 'glob-permissions.json'), JSON.stringify({
      outsideWithoutPath: 'requested and denied',
      outsideWithWorkspacePath: 'requested and denied',
      outsideFilenameDisclosed: false,
      nextWorkspaceGlob: 'succeeded',
    }, null, 2))
  } finally {
    socket.close()
    rmSync(outside, { recursive: true, force: true })
    rmSync(inside, { recursive: true, force: true })
  }
}
