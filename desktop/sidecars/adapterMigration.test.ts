// @vitest-environment node

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

it('the real adapter launcher confirms inactivity when migration races credential gating', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haha-adapter-inactive-'))
  const data = path.join(root, 'data')
  await mkdir(data)
  const repo = path.resolve(import.meta.dirname, '../..')
  const child = spawn('bun', [path.join(repo, 'desktop/sidecars/claude-sidecar.ts'), 'adapters', '--app-root', repo, '--feishu', '--telegram', '--wechat', '--dingtalk', '--whatsapp', '--wecom', '--qq', '--slack'], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      CLAUDE_CONFIG_DIR: data,
      CC_HAHA_MIGRATION_CONTROL: '1',
      CC_HAHA_LOCAL_ACCESS_TOKEN: 'isolated-migration-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdin.on('error', () => {})
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  try {
    child.stdin.write(JSON.stringify({ type: 'migration_quiesce', requestId: 'early', token: 'isolated-migration-token' }) + '\n')
    expect(await closed, stderr).toBe(0)
    expect(stdout.trim()).toBe('{"type":"migration_adapter_inactive"}')
    expect(stderr.match(/requested but/g)).toHaveLength(8)
    expect(await readdir(data)).toEqual([])
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await closed.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
