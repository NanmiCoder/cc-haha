import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../pr/test-environment'
import type { LiveContext } from '../agent-flow/live'
import type { SessionSocket } from '../agent-flow/execute'

/** The real Enter/Exit tools, CLI, server persistence and desktop WS protocol. */
export async function runWorktreeSession(ctx: LiveContext, readResults: () => Array<{ content?: unknown; is_error?: boolean }>) {
  const repo = join(realpathSync(ctx.workRoot), 'worktree-session')
  mkdirSync(repo, { recursive: true })
  const env = createSandboxedTestEnvironment(join(ctx.configDir, 'git-fixture'), {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(ctx.configDir, 'empty-gitconfig'),
  })
  function git(args: string[]) {
    const result = Bun.spawnSync(['git', '-C', repo, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  git(['init', '-b', 'main'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  const create = async (workDir = repo) => {
    const response = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workDir }),
    })
    if (!response.ok) throw new Error(`Create worktree session: ${response.status}`)
    return (await response.json() as { sessionId: string }).sessionId
  }
  const sessionId = await create()
  const otherId = await create()
  const subdirectory = join(repo, 'package')
  mkdirSync(subdirectory)
  const failedId = await create(subdirectory)
  const cwd = async (id = sessionId) => {
    const response = await fetch(`${ctx.baseUrl}/api/sessions/${id}/git-info`)
    if (!response.ok) throw new Error(`Git info: ${response.status}`)
    return await response.json() as { workDir: string; worktree: { enabled: boolean; path: string } | null }
  }
  const runTool = async (socket: SessionSocket, tool: string, input: Record<string, unknown>) => {
    const start = socket.messages.length
    socket.send({ type: 'user_message', content: `MOCK_TEAM_OWNER ${JSON.stringify({ tool, input })}` })
    let cursor = start
    while (true) {
      const message = await socket.waitFor(message => ['permission_request', 'message_complete', 'error'].includes(message.type), ctx.stepTimeoutMs, `${tool} completion`, cursor)
      cursor = socket.messages.indexOf(message) + 1
      if (message.type === 'error') throw new Error(JSON.stringify(message))
      if (message.type === 'message_complete') return socket.messages.slice(start)
      socket.send({ type: 'permission_response', requestId: message.requestId, allowed: true })
    }
  }
  const worktree = join(repo, '.claude', 'worktrees', 'sync')
  let socket = await ctx.openSocket(failedId)
  try {
    ctx.pinRuntime(socket)
    const blocked = join(repo, '.claude', 'worktrees', 'blocked')
    mkdirSync(join(blocked, '..'), { recursive: true })
    writeFileSync(blocked, 'block creation with a disposable file')
    const failureStart = readResults().length
    await runTool(socket, 'EnterWorktree', { name: 'blocked' })
    if (!readResults().slice(failureStart).some(result => result.is_error)) throw new Error('Blocked worktree did not fail creation')
    const failureCommandStart = readResults().length
    await runTool(socket, process.platform === 'win32' ? 'PowerShell' : 'Bash', { command: process.platform === 'win32' ? '(Get-Location).Path' : 'pwd' })
    if ((await cwd(failedId)).workDir !== subdirectory || (await cwd(failedId)).worktree?.enabled ||
      !readResults().slice(failureCommandStart).some(result => !result.is_error && JSON.stringify(result.content).includes(subdirectory.replaceAll('\\', '\\\\')))) {
      throw new Error('Failed EnterWorktree changed the CLI/session directory from its starting subdirectory')
    }
    socket.close()
    socket = await ctx.openSocket(sessionId)
    ctx.pinRuntime(socket)

    const entered = await runTool(socket, 'EnterWorktree', { name: 'sync' })
    const notification = entered.findIndex(message => message.type === 'system_notification' && message.subtype === 'init' && (message.data as { cwd?: string })?.cwd === worktree)
    const completed = entered.findIndex(message => message.type === 'message_complete')
    if (notification < 0 || notification >= completed) throw new Error('EnterWorktree did not publish its cwd within its own turn')
    if ((await cwd()).workDir !== worktree || !(await cwd()).worktree?.enabled) throw new Error('Git/UI directory disagrees with EnterWorktree')

    const summary = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}/summary`).then(response => response.json()) as { workDir: string }
    if (summary.workDir !== worktree) throw new Error('The worktree directory was not persisted')
    const restartStart = socket.messages.length
    socket.send({ type: 'set_runtime_config', providerId: ctx.target.providerId, modelId: ctx.target.modelId, effortLevel: 'high' })
    await socket.waitFor(message => message.type === 'runtime_config_applied' && message.effortLevel === 'high', ctx.stepTimeoutMs, 'restart in worktree', restartStart)
    const commandStart = readResults().length
    await runTool(socket, process.platform === 'win32' ? 'PowerShell' : 'Bash', { command: process.platform === 'win32' ? '(Get-Location).Path' : 'pwd' })
    if (!readResults().slice(commandStart).some(result => !result.is_error && JSON.stringify(result.content).includes(worktree.replaceAll('\\', '\\\\')))) {
      throw new Error('The real command did not execute in the entered worktree after resume')
    }
    socket.close()
    socket = await ctx.openSocket(sessionId)
    await socket.waitFor(message => message.type === 'system_notification' && (message.data as { cwd?: string })?.cwd === worktree, ctx.stepTimeoutMs, 'reconnect cwd')
    if ((await cwd(otherId)).workDir !== repo) throw new Error('EnterWorktree changed a different session')

    const exited = await runTool(socket, 'ExitWorktree', { action: 'keep' })
    if (!exited.some(message => message.type === 'system_notification' && (message.data as { cwd?: string })?.cwd === repo)) throw new Error('ExitWorktree did not publish the original cwd')
    if ((await cwd()).workDir !== repo || (await cwd()).worktree?.enabled) throw new Error('Git/UI did not return to the original checkout')
    writeFileSync(join(ctx.artifactDir, 'worktree-session.json'), JSON.stringify({ sessionId, otherId, repo, worktree, failedCreation: 'unchanged', sameTurnNotification: 'passed', persistedWorkDir: 'passed', resumeCommandCwd: 'passed', reconnect: 'passed', otherSession: 'unchanged', exit: 'passed' }, null, 2))
  } finally {
    socket.close()
  }
}
