#!/usr/bin/env bun
/**
 * Builds the phone app as the desktop's H5: the Expo web export, under the
 * base path the desktop server hosts it at (`/m`, see `app.config.ts` and
 * `src/server/staticH5.ts`).
 *
 *   bun scripts/export-h5.ts [outDir]     # default: ../desktop/dist/m
 *
 * `desktop/package.json` runs this at the end of `bun run build`, after Vite
 * has emptied `dist`, so every desktop build carries it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { H5_BASE_PATH } from '../app.config'

const mobileRoot = resolve(import.meta.dir, '..')
/** The desktop probes this file before leaving its own phone shell for the phone app. */
export const H5_MARKER_FILE = 'h5.json'
export const H5_MARKER_APP = 'cc-haha-mobile'

export function h5ExportEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...source,
    EXPO_PUBLIC_CC_HAHA_H5: '1',
    CI: '1',
    EXPO_OFFLINE: '1',
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_DOTENV: '1',
  }
}

/** The export must load its bundles from under the base path, or the server hands back the desktop app. */
export function verifyH5Export(outDir: string) {
  const index = join(outDir, 'index.html')
  if (!existsSync(index)) throw new Error(`H5 export has no index.html in ${outDir}`)
  const html = readFileSync(index, 'utf8')
  if (!html.includes(`src="${H5_BASE_PATH}/_expo/static/js/web/`))
    throw new Error(`H5 export does not load its scripts from ${H5_BASE_PATH}/_expo; is experiments.baseUrl set?`)
}

export async function exportH5(outDir: string) {
  const cli = join(mobileRoot, 'node_modules', 'expo', 'bin', 'cli')
  if (!existsSync(cli))
    throw new Error('The phone H5 needs the mobile dependencies: run `bun install --frozen-lockfile` in mobile/ first.')
  // Expo runs on Node, as the desktop build already does for tsc and Vite.
  const child = Bun.spawn(['node', cli, 'export', '--platform', 'web', '--output-dir', outDir], {
    cwd: mobileRoot,
    env: h5ExportEnvironment(),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`expo export exited with code ${code}`)
  verifyH5Export(outDir)
  const { version } = JSON.parse(readFileSync(join(mobileRoot, 'package.json'), 'utf8')) as { version: string }
  writeFileSync(join(outDir, H5_MARKER_FILE), `${JSON.stringify({ app: H5_MARKER_APP, version })}\n`)
}

if (import.meta.main) {
  const outDir = resolve(process.argv[2] ?? join(mobileRoot, '..', 'desktop', 'dist', H5_BASE_PATH.slice(1)))
  await exportH5(outDir)
  console.log(`[export-h5] phone H5 written to ${outDir}`)
}
