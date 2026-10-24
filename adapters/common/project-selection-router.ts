import type { AdapterHttpClient, RecentProject } from './http-client.js'
import { t } from './i18n.js'

export type ProjectSelectionRoute = {
  kind: 'new' | 'picker_reply'
  query?: string
}

export type ProjectSelectionOutcome =
  | { kind: 'created'; project?: RecentProject }
  | { kind: 'creation_failed' }
  | { kind: 'ambiguous'; projects: RecentProject[] }
  | { kind: 'not_found'; query: string }
  | { kind: 'error'; message: string }

type ProjectSelectionControllerDeps = {
  httpClient: Pick<AdapterHttpClient, 'listRecentProjects' | 'matchProject'>
  defaultWorkDir: string
  prepareNewSession: (chatId: string) => void | Promise<void>
  createSession: (chatId: string, workDir: string) => Promise<boolean>
}

const NON_PROJECT_COMMANDS = new Set([
  '/help',
  '帮助',
  '/status',
  '状态',
  '/clear',
  '清空',
  '/stop',
  '停止',
  '/projects',
  '项目列表',
])

export class ProjectSelectionRouter {
  private readonly pendingChats = new Set<string>()

  markPickerShown(chatId: string): void {
    this.pendingChats.add(chatId)
  }

  clear(chatId: string): void {
    this.pendingChats.delete(chatId)
  }

  route(chatId: string, text: string): ProjectSelectionRoute | null {
    const trimmed = text.trim()

    // Explicit commands must win while a picker is pending; otherwise
    // `/new express` is forwarded verbatim as the project query.
    if (trimmed === '/new' || trimmed === '新会话' || trimmed.startsWith('/new ')) {
      const query = trimmed.startsWith('/new ') ? trimmed.slice(5).trim() : ''
      return { kind: 'new', query: query || undefined }
    }

    if (this.pendingChats.has(chatId) && trimmed && !NON_PROJECT_COMMANDS.has(trimmed)) {
      return { kind: 'picker_reply', query: trimmed }
    }

    return null
  }
}

export class ProjectSelectionController {
  private readonly router = new ProjectSelectionRouter()

  constructor(private readonly deps: ProjectSelectionControllerDeps) {}

  async listProjects(chatId: string): Promise<RecentProject[]> {
    const projects = await this.deps.httpClient.listRecentProjects()
    if (projects.length > 0) this.router.markPickerShown(chatId)
    return projects
  }

  clear(chatId: string): void {
    this.router.clear(chatId)
  }

  async handleInput(chatId: string, text: string): Promise<ProjectSelectionOutcome | null> {
    const route = this.router.route(chatId, text)
    if (!route) return null

    await this.deps.prepareNewSession(chatId)
    this.router.clear(chatId)

    if (!route.query) {
      const created = await this.deps.createSession(chatId, this.deps.defaultWorkDir)
      return created ? { kind: 'created' } : { kind: 'creation_failed' }
    }

    try {
      const { project, ambiguous } = await this.deps.httpClient.matchProject(route.query)
      if (project) {
        const created = await this.deps.createSession(chatId, project.realPath)
        return created ? { kind: 'created', project } : { kind: 'creation_failed' }
      }
      if (ambiguous) return { kind: 'ambiguous', projects: ambiguous }
      return { kind: 'not_found', query: route.query }
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}

export function formatAmbiguousProjectSelection(projects: RecentProject[]): string {
  const choices = projects
    .map((project, index) => `${index + 1}. **${project.projectName}** — ${project.realPath}`)
    .join('\n')
  return t('project.multiple', { choices })
}

export function formatProjectSelectionOutcome(outcome: ProjectSelectionOutcome): string | null {
  switch (outcome.kind) {
    case 'created':
      return outcome.project
        ? t('project.created', {
          name: outcome.project.projectName,
          branch: outcome.project.branch ? ` (${outcome.project.branch})` : '',
        })
        : t('project.createdPlain')
    case 'creation_failed':
      return null
    case 'ambiguous':
      return formatAmbiguousProjectSelection(outcome.projects)
    case 'not_found':
      return t('project.notFound', { query: outcome.query })
    case 'error':
      return `❌ ${outcome.message}`
  }
}
