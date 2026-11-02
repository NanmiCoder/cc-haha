import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentDesktopProcessError, runAgentDesktopProcess, type AgentDesktopProcessRequest } from './agentDesktopProcess.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function request(code: string): Promise<AgentDesktopProcessRequest> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-desktop-process-'))
  roots.push(root)
  return { binaryPath: process.execPath, args: ['-e', code], cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: 5_000, maxOutputBytes: 1024 }
}

test('native process output limits terminate the child and preserve uncertain execution', async () => {
  const args = await request("process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)")
  try {
    await runAgentDesktopProcess(args)
    throw new Error('expected output limit')
  } catch (error) {
    expect(error).toBeInstanceOf(AgentDesktopProcessError)
    expect(error).toMatchObject({ reason: 'output_limit', dispatched: true })
  }
})

test('spawn errors identify a command that never started', async () => {
  const args = await request('')
  await expect(runAgentDesktopProcess({ ...args, binaryPath: path.join(args.cwd, 'missing-native-executable') })).rejects.toMatchObject({ reason: 'spawn_failed', dispatched: false })
})

test('an already cancelled native process request never spawns', async () => {
  const args = await request("throw new Error('must not execute')")
  const controller = new AbortController()
  controller.abort()
  await expect(runAgentDesktopProcess({ ...args, signal: controller.signal })).rejects.toMatchObject({ reason: 'aborted', dispatched: false })
})

test.skipIf(process.platform === 'win32')('cancellation waits for cooperative input release and process exit', async () => {
  const args = await request(`
    const fs = require('node:fs')
    fs.writeFileSync('pid', String(process.pid))
    process.on('SIGTERM', () => {
      fs.writeFileSync('terminating', '')
      setTimeout(() => { fs.writeFileSync('released', 'yes'); process.exit(0) }, 1800)
    })
    fs.writeFileSync('ready', '')
    setInterval(() => {}, 1000)
  `)
  const controller = new AbortController()
  const outcome = runAgentDesktopProcess({ ...args, signal: controller.signal }).catch(error => error)
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(path.join(args.cwd, 'ready')).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const pid = Number(await readFile(path.join(args.cwd, 'pid'), 'utf8'))
    controller.abort()
    expect(await outcome).toMatchObject({ reason: 'aborted', dispatched: true })
    expect(await readFile(path.join(args.cwd, 'released'), 'utf8')).toBe('yes')
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    controller.abort()
    await outcome
  }
})
