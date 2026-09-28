import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

if (process.platform !== 'win32') { console.log('SKIPPED: Windows network UI fixture'); process.exit(0) }
const desktop = path.resolve(import.meta.dir, '..')
const source = path.join(import.meta.dir, 'fixtures', 'network-manager-ui')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-network-ui-'))
const output = path.resolve(process.argv[2] ?? path.join(desktop, '..', 'runtime', 'network-manager-ui-smoke'))
let code = 1
try {
  await build({ configFile: false, root: source, base: './', plugins: [react(), tailwindcss()], resolve: { alias: { '@': path.join(desktop, 'src') } }, build: { outDir: path.join(sandbox, 'ui'), target: 'es2021', chunkSizeWarningLimit: 3000 } })
  for (const name of ['main', 'preload']) {
    const result = await Bun.build({ entrypoints: [path.join(source, `${name}.ts`)], target: 'node', format: 'cjs', naming: `${name}.cjs`, outdir: sandbox, external: ['electron'] })
    if (!result.success) throw new Error(`Failed to bundle ${name}: ${result.logs.join('\n')}`)
  }
  for (const name of ['roaming', 'local', 'temp']) await fs.mkdir(path.join(sandbox, name), { recursive: true })
  const env = { ...process.env, NETWORK_SMOKE_SANDBOX: sandbox, NETWORK_SMOKE_OUTPUT: output, NODE_PATH: path.join(desktop, 'node_modules'), HOME: sandbox, USERPROFILE: sandbox, APPDATA: path.join(sandbox, 'roaming'), LOCALAPPDATA: path.join(sandbox, 'local'), TEMP: path.join(sandbox, 'temp'), TMP: path.join(sandbox, 'temp'), CLAUDE_CONFIG_DIR: path.join(sandbox, 'config') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn([path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), path.join(sandbox, 'main.cjs')], { cwd: desktop, env, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => { Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' }) }, 150_000)
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(output, 'process.log'), stdout + stderr)
  console.log(stdout.trim())
  if (exitCode) console.error(stderr.slice(-4000))
  code = exitCode
} finally {
  if (path.dirname(sandbox) !== os.tmpdir() || !path.basename(sandbox).startsWith('cc-haha-network-ui-')) throw new Error('Unexpected sandbox path')
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
process.exit(code)
