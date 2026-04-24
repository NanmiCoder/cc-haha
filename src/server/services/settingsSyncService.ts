import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

type SyncOptions = {
  fallbackDirName?: string
  topLevel?: boolean
  ccHaha?: boolean
}

function resolveConfigDir(fallbackDirName = '.claude'): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), fallbackDirName)
}

function resolveTargets(options?: SyncOptions): string[] {
  const configDir = resolveConfigDir(options?.fallbackDirName)
  const topLevel = options?.topLevel ?? true
  const ccHaha = options?.ccHaha ?? true
  const targets: string[] = []

  if (topLevel) targets.push(path.join(configDir, 'settings.json'))
  if (ccHaha) targets.push(path.join(configDir, 'cc-haha', 'settings.json'))

  return targets
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

async function writeJsonFile(
  filePath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpFile = `${filePath}.tmp.${Date.now()}`

  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    await fs.rename(tmpFile, filePath)
  } catch (error) {
    await fs.unlink(tmpFile).catch(() => {})
    throw error
  }
}

export async function patchSettingsEnv(
  envPatch: Record<string, string>,
  options?: SyncOptions,
): Promise<void> {
  const targets = resolveTargets(options)

  await Promise.all(
    targets.map(async (target) => {
      const settings = await readJsonFile(target)
      const currentEnv = (settings.env as Record<string, string>) || {}

      settings.env = {
        ...currentEnv,
        ...envPatch,
      }

      await writeJsonFile(target, settings)
    }),
  )
}
