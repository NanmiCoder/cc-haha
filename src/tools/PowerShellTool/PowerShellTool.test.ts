import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import * as Shell from '../../utils/Shell.js'
import * as detection from '../../utils/shell/powershellDetection.js'
import { PowerShellTool } from './PowerShellTool.js'

const command = "Write-Output 'fixture'"
const context = (userModified = false): ToolUseContext => ({
  abortController: new AbortController(),
  agentId: asAgentId('powershell-fixture'),
  setAppState() {},
  userModified,
}) as ToolUseContext

let restoreSandbox: () => void

beforeEach(() => {
  const enabled = spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false)
  const settings = spyOn(SandboxManager, 'isSandboxEnabledInSettings').mockReturnValue(false)
  restoreSandbox = () => {
    enabled.mockRestore()
    settings.mockRestore()
  }
})

afterEach(() => restoreSandbox())

test('PowerShell reports a missing runtime as a tool error without executing', async () => {
  const path = spyOn(detection, 'getCachedPowerShellPath').mockResolvedValue(null)
  const execute = spyOn(Shell, 'exec').mockRejectedValue(new Error('unexpected spawn'))
  try {
    await expect(PowerShellTool.call({ command }, context())).rejects.toThrow(
      'PowerShell is not available on this system.',
    )
    expect(execute).not.toHaveBeenCalled()
  } finally {
    execute.mockRestore()
    path.mockRestore()
  }
})

test('PowerShell forwards model-only error handling and reports a rejected spawn', async () => {
  const path = spyOn(detection, 'getCachedPowerShellPath').mockResolvedValue('powershell.exe')
  const execute = spyOn(Shell, 'exec').mockRejectedValue(new Error('fixture executable denied'))
  const modelMessage = createAssistantMessage({ content: 'Run PowerShell.' })
  try {
    for (const [userModified, parentMessage, failOnPowerShellError] of [
      [false, modelMessage, true],
      [true, modelMessage, false],
      [false, undefined, false],
    ] as const) {
      const toolContext = context(userModified)
      await expect(
        PowerShellTool.call({ command }, toolContext, undefined, parentMessage),
      ).rejects.toThrow('Failed to execute PowerShell command: fixture executable denied')
      expect(execute).toHaveBeenLastCalledWith(
        command, toolContext.abortController.signal, 'powershell',
        expect.objectContaining({ failOnPowerShellError }),
      )
    }
    expect(execute).toHaveBeenCalledTimes(3)
  } finally {
    execute.mockRestore()
    path.mockRestore()
  }
})

test('PowerShell 5.1 prompt explains native invocation, BOMs, and command errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-powershell-prompt-'))
  const previous = process.env[detection.POWERSHELL_PATH_OVERRIDE_ENV]
  try {
    const executable = join(directory, 'powershell.exe')
    await writeFile(executable, '')
    process.env[detection.POWERSHELL_PATH_OVERRIDE_ENV] = executable
    detection.resetPowerShellCache()

    const prompt = await PowerShellTool.prompt()
    expect(prompt).toContain('Use this tool directly for native Windows PowerShell commands')
    expect(prompt).toContain('PowerShell edition: Windows PowerShell 5.1 (powershell.exe)')
    expect(prompt).toContain('reads scripts without a BOM as ANSI')
    expect(prompt).toContain('`-Encoding UTF8` to `Out-File` or `Set-Content`')
    expect(prompt).toContain('PowerShell cmdlet errors stop model-issued commands by default')
    expect(prompt).toContain('Check $LASTEXITCODE for native executables')
  } finally {
    if (previous === undefined) delete process.env[detection.POWERSHELL_PATH_OVERRIDE_ENV]
    else process.env[detection.POWERSHELL_PATH_OVERRIDE_ENV] = previous
    detection.resetPowerShellCache()
    await rm(directory, { recursive: true, force: true })
  }
})
