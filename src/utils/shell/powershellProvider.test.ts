import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createPowerShellProvider } from './powershellProvider.js'

test('preserves a caller-supplied command when automatic error handling is disabled', async () => {
  const provider = createPowerShellProvider('pwsh')
  const command = "using namespace System.Collections.Generic\nparam($marker = '中文')\nWrite-Output $marker"
  const { commandString } = await provider.buildExecCommand(command, {
    id: 'caller-supplied',
    useSandbox: false,
    failOnPowerShellError: false,
  })

  expect(commandString.startsWith(`${command}\n; $_ec = `)).toBe(true)
  expect(provider.getSpawnArgs(commandString)).toEqual(['-NoProfile', '-NonInteractive', '-Command', commandString])
})

test.skipIf(process.platform !== 'win32')('native model commands preserve Unicode and stop on PowerShell errors', async () => {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const provider = createPowerShellProvider(executable)

  async function run(command: string, failOnPowerShellError = true) {
    const { commandString, cwdFilePath } = await provider.buildExecCommand(command, {
      id: randomUUID(),
      useSandbox: false,
      failOnPowerShellError,
    })
    try {
      return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        execFile(executable, provider.getSpawnArgs(commandString), {
          windowsHide: true,
          timeout: 10_000,
          encoding: 'utf8',
        }, (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') reject(error)
          else resolve({ code: error?.code ?? 0, stdout, stderr })
        })
      })
    } finally {
      await unlink(cwdFilePath).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  const text = "中文 🙂 It's It’s"
  const utf8 = await run('using namespace System.Collections.Generic\nparam($marker = "fixture")\nWrite-Output "' + text + '"')
  expect(utf8.code).toBe(0)
  expect(utf8.stdout.trim()).toBe(text)

  const failure = await run("Write-Error 'fixture error'; Write-Output 'continued'")
  expect(failure.code).toBe(1)
  expect(failure.stderr).toContain('fixture error')
  expect(failure.stdout.trim()).toBe('')
  expect((await run("Write-Error 'fixture error' -ErrorAction Continue; Write-Output 'continued'")).stdout.trim()).toBe('continued')
  expect((await run("Write-Error 'fixture error'; Write-Output 'continued'", false)).code).toBe(0)
  expect((await run('cmd.exe /d /c exit 7')).code).toBe(7)
})
