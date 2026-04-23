export type CommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<CommandResult>

type PythonCandidate = {
  command: string
  prefixArgs: string[]
  locator: {
    command: string
    args: string[]
  } | null
}

export type PythonRuntimeResolution = {
  installed: boolean
  version: string | null
  path: string | null
  command: string | null
  prefixArgs: string[]
  source: 'system' | 'venv' | null
}

function getPythonCandidates(platform: NodeJS.Platform): PythonCandidate[] {
  if (platform === 'win32') {
    return [
      {
        command: 'python3',
        prefixArgs: [],
        locator: { command: 'where', args: ['python3'] },
      },
      {
        command: 'python',
        prefixArgs: [],
        locator: { command: 'where', args: ['python'] },
      },
      {
        command: 'py',
        prefixArgs: ['-3'],
        locator: { command: 'where', args: ['py'] },
      },
      {
        command: 'py',
        prefixArgs: [],
        locator: { command: 'where', args: ['py'] },
      },
    ]
  }

  return [
    {
      command: 'python3',
      prefixArgs: [],
      locator: { command: 'which', args: ['python3'] },
    },
  ]
}

function extractPythonVersion(output: string): string | null {
  const match = output.match(/Python\s+([0-9][^\s]*)/i)
  return match?.[1] ?? null
}

function firstOutputLine(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(Boolean)
  return line ?? null
}

async function locateCandidatePath(
  candidate: PythonCandidate,
  runCommand: CommandRunner,
): Promise<string | null> {
  if (!candidate.locator) return null
  const locateResult = await runCommand(candidate.locator.command, candidate.locator.args)
  if (!locateResult.ok) return null
  return firstOutputLine(locateResult.stdout)
}

export async function detectPythonRuntime(
  platform: NodeJS.Platform,
  runCommand: CommandRunner,
  venvPythonPath?: string,
): Promise<PythonRuntimeResolution> {
  for (const candidate of getPythonCandidates(platform)) {
    const versionResult = await runCommand(candidate.command, [...candidate.prefixArgs, '--version'])
    if (!versionResult.ok) continue

    return {
      installed: true,
      version: extractPythonVersion(`${versionResult.stdout}\n${versionResult.stderr}`),
      path: await locateCandidatePath(candidate, runCommand),
      command: candidate.command,
      prefixArgs: candidate.prefixArgs,
      source: 'system',
    }
  }

  if (venvPythonPath) {
    const venvResult = await runCommand(venvPythonPath, ['--version'])
    if (venvResult.ok) {
      return {
        installed: true,
        version: extractPythonVersion(`${venvResult.stdout}\n${venvResult.stderr}`),
        path: venvPythonPath,
        command: venvPythonPath,
        prefixArgs: [],
        source: 'venv',
      }
    }
  }

  return {
    installed: false,
    version: null,
    path: null,
    command: null,
    prefixArgs: [],
    source: null,
  }
}

