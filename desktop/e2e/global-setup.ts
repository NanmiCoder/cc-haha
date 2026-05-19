import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default async function globalSetup() {
  const desktopDir = path.resolve(here, '..')
  console.log('[e2e] building web target...')
  execSync('bun run build:web', { cwd: desktopDir, stdio: 'inherit' })
}
