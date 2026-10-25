// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveBundledAgentSdkExecutable } from './officialAgentSdkRuntime'

describe('official Agent SDK sidecar runtime', () => {
  it('leaves source launches to the SDK official dependency resolver', () => {
    expect(resolveBundledAgentSdkExecutable({ moduleUrl: 'file:///workspace/claude-sidecar.ts' })).toBeUndefined()
  })

  it.each([
    ['darwin', 'file:///$bunfs/root/claude-sidecar.ts', 'claude'],
    ['win32', 'file:///B:/~BUN/root/claude-sidecar.ts', 'claude.exe'],
  ] as const)('resolves the packaged executable after relocating the %s app', async (platform, moduleUrl, binaryName) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cc-haha-sdk-中文 install-'))
    try {
      const execPath = path.join(directory, 'claude-sidecar')
      const runtimeDirectory = path.join(directory, 'official-agent-sdk')
      await mkdir(runtimeDirectory)
      const executable = path.join(runtimeDirectory, binaryName)
      await writeFile(executable, 'native runtime fixture')
      expect(resolveBundledAgentSdkExecutable({ execPath, moduleUrl, platform })).toBe(executable)
      await rm(executable)
      expect(() => resolveBundledAgentSdkExecutable({ execPath, moduleUrl, platform })).toThrow('bundled official Agent SDK runtime is missing')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
