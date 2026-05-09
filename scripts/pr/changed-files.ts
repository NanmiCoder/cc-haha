async function output(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited

  if (code !== 0) {
    throw new Error(stderr || stdout || `Command failed: ${cmd.join(' ')}`)
  }

  return stdout.trim()
}

async function outputOrEmpty(cmd: string[]) {
  try {
    return await output(cmd)
  } catch {
    return ''
  }
}

function splitFiles(output: string) {
  return output.split(/\r?\n/).filter(Boolean)
}

function unique(files: string[]) {
  return [...new Set(files.filter(Boolean))]
}

export async function localChangedFiles() {
  const staged = await outputOrEmpty(['git', 'diff', '--name-only', '--cached'])
  const unstaged = await outputOrEmpty(['git', 'diff', '--name-only'])
  const untracked = await outputOrEmpty(['git', 'ls-files', '--others', '--exclude-standard'])

  return unique([
    ...splitFiles(staged),
    ...splitFiles(unstaged),
    ...splitFiles(untracked),
  ])
}

export async function changedFilesForLocalPrCheck(explicitFiles: string[] = []) {
  if (explicitFiles.length > 0) {
    return unique(explicitFiles)
  }

  const localFiles = await localChangedFiles()
  const explicitBase = process.env.PR_BASE_REF?.trim()
  const branch = await outputOrEmpty(['git', 'branch', '--show-current'])

  if (!explicitBase && !branch && localFiles.length > 0) {
    return localFiles
  }

  const base = explicitBase || 'origin/main'
  try {
    const diff = await output(['git', 'diff', '--name-only', `${base}...HEAD`])
    return unique([...splitFiles(diff), ...localFiles])
  } catch {
    try {
      const diff = await output(['git', 'diff', '--name-only', 'main...HEAD'])
      return unique([...splitFiles(diff), ...localFiles])
    } catch {
      return localFiles
    }
  }
}
