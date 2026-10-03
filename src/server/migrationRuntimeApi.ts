import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isLocalAccessAuthorized } from './localAccessAuth.js'
import { isLoopbackHost } from './h5AccessPolicy.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { stripBOM } from '../utils/jsonRead.js'
import { getGlobalClaudeFile } from '../utils/env.js'
import { sessionService } from './services/sessionService.js'

export type MigrationPreview = { activeTasks: number; externalProcesses: number }
export type MigrationRuntimeControl = {
  preview(): Promise<MigrationPreview>
  quiesce(): Promise<void>
  activate(): Promise<void>
  recover?(): Promise<void>
}

export function isMigrationRuntimePath(pathname: string): boolean {
  return pathname.startsWith('/api/runtime/migration/')
}

export async function handleMigrationRuntimeRequest(
  request: Request,
  clientAddress: string | null,
  control: MigrationRuntimeControl,
): Promise<Response> {
  if (!clientAddress || !isLoopbackHost(clientAddress) || request.headers.has('Origin') ||
    ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'via'].some(header => request.headers.has(header)) ||
    !isLocalAccessAuthorized(request)) {
    return Response.json({ error: 'Local desktop credential required' }, { status: 403 })
  }
  const pathname = new URL(request.url).pathname
  try {
    if (request.method === 'GET' && pathname.endsWith('/preview')) return Response.json(await control.preview())
    if (request.method === 'POST' && pathname.endsWith('/quiesce')) {
      await control.quiesce()
      return Response.json({ quiesced: true })
    }
    if (request.method === 'POST' && pathname.endsWith('/recover') && control.recover) {
      await control.recover()
      return Response.json({ quiesced: true })
    }
    if (request.method === 'GET' && pathname.endsWith('/validate')) {
      const root = getClaudeConfigHomeDir()
      if (!(await stat(root)).isDirectory()) throw new Error('Data directory is unavailable')
      for (const configFile of [join(root, 'settings.json'), join(root, 'cc-haha', 'settings.json'), getGlobalClaudeFile()]) {
        try {
          const config = JSON.parse(stripBOM(await readFile(configFile, 'utf8')))
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid migrated configuration')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      let representativeSession: string | undefined
      try {
        const projects = join(root, 'projects')
        for (const project of await readdir(projects, { withFileTypes: true })) {
          if (!project.isDirectory()) continue
          const directory = join(projects, project.name)
          for (const file of await readdir(directory, { withFileTypes: true })) {
            if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
            if (!representativeSession && /^[a-f0-9-]{36}\.jsonl$/i.test(file.name)) representativeSession = file.name.slice(0, -6)
            const transcript = await open(join(directory, file.name), 'r')
            try { await transcript.read(Buffer.alloc(1), 0, 1, 0) } finally { await transcript.close() }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (representativeSession) await sessionService.getSessionHistoryPage(representativeSession, { limit: 1, projectContext: false })
      return Response.json({ valid: true })
    }
    if (request.method === 'POST' && pathname.endsWith('/activate')) {
      await control.activate()
      return Response.json({ activated: true })
    }
    return Response.json({ error: 'Unknown migration control' }, { status: 404 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Migration runtime control failed', code: 'MIGRATION_RUNTIME_UNSAFE' }, { status: 409 })
  }
}
