import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractDingTalkText, type DingTalkRobotMessage } from '../../dingtalk/helpers.js'
import { extractInboundPayload } from '../../feishu/extract-payload.js'
import { AdapterHttpClient, type RecentProject } from '../http-client.js'
import {
  formatProjectSelectionOutcome,
  ProjectSelectionController,
  ProjectSelectionRouter,
} from '../project-selection-router.js'

const ORIGINAL_FETCH = globalThis.fetch
const ADAPTERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

type TransportFixture = {
  name: string
  extractText: (command: string) => string
}

const TRANSPORTS: TransportFixture[] = [
  {
    name: 'DingTalk',
    extractText: (command) => extractDingTalkText({
      msgtype: 'text',
      conversationType: '1',
      senderStaffId: 'ding-user',
      text: { content: command },
    } satisfies DingTalkRobotMessage),
  },
  {
    name: 'Feishu',
    extractText: (command) => extractInboundPayload(
      JSON.stringify({ text: command }),
      'text',
    ).text,
  },
]

function recentProject(projectName: string, realPath: string): RecentProject {
  return {
    projectPath: realPath,
    realPath,
    projectName,
    isGit: false,
    repoName: null,
    branch: null,
    modifiedAt: '2026-08-10T00:00:00.000Z',
    sessionCount: 1,
  }
}

function createProjectController(
  client: AdapterHttpClient,
  defaultWorkDir: string,
): ProjectSelectionController {
  return new ProjectSelectionController({
    httpClient: client,
    defaultWorkDir,
    prepareNewSession: () => {},
    createSession: async (_chatId, workDir) => {
      await client.createSession(workDir)
      return true
    },
  })
}

describe('IM project selection flow', () => {
  it('keeps both adapter entrypoints wired to the tested controller', () => {
    for (const platform of ['dingtalk', 'feishu']) {
      const source = fs.readFileSync(path.join(ADAPTERS_DIR, platform, 'index.ts'), 'utf8')
      expect(source).toContain('projectSelectionController.listProjects(chatId)')
      expect(source).toContain('projectSelectionController.handleInput(chatId,')
    }
  })

  it('keeps bare picker replies while explicit commands retain priority', () => {
    const router = new ProjectSelectionRouter()
    router.markPickerShown('chat-1')

    expect(router.route('chat-1', '/new express')).toEqual({ kind: 'new', query: 'express' })
    expect(router.route('chat-1', '1')).toEqual({ kind: 'picker_reply', query: '1' })
    expect(router.route('chat-1', '/projects')).toBeNull()
    expect(router.route('chat-1', '/help')).toBeNull()

    router.clear('chat-1')
    expect(router.route('chat-1', '1')).toBeNull()
  })

  it('drives picker state through listing and clears it after the selected project is created', async () => {
    const events: string[] = []
    const project = recentProject('express', '/allowed/express')
    const controller = new ProjectSelectionController({
      httpClient: {
        listRecentProjects: async () => {
          events.push('list')
          return [project]
        },
        matchProject: async (query) => {
          events.push(`match:${query}`)
          return { project }
        },
      },
      defaultWorkDir: '/allowed/default',
      prepareNewSession: (chatId) => {
        events.push(`prepare:${chatId}`)
      },
      createSession: async (chatId, workDir) => {
        events.push(`create:${chatId}:${workDir}`)
        return true
      },
    })

    expect(await controller.listProjects('chat-1')).toEqual([project])
    expect(await controller.handleInput('chat-1', '1')).toEqual({ kind: 'created', project })
    expect(events).toEqual([
      'list',
      'prepare:chat-1',
      'match:1',
      'create:chat-1:/allowed/express',
    ])
    expect(await controller.handleInput('chat-1', '1')).toBeNull()
  })

  it('keeps default, failed, and errored session outcomes explicit', async () => {
    const createdWorkDirs: string[] = []
    const controller = new ProjectSelectionController({
      httpClient: {
        listRecentProjects: async () => [],
        matchProject: async () => {
          throw new Error('project lookup failed')
        },
      },
      defaultWorkDir: '/allowed/default',
      prepareNewSession: () => {},
      createSession: async (_chatId, workDir) => {
        createdWorkDirs.push(workDir)
        return true
      },
    })

    expect(await controller.handleInput('chat-1', 'ordinary message')).toBeNull()
    expect(await controller.listProjects('chat-1')).toEqual([])
    expect(await controller.handleInput('chat-1', '1')).toBeNull()

    const created = await controller.handleInput('chat-1', '/new')
    expect(created).toEqual({ kind: 'created' })
    expect(formatProjectSelectionOutcome(created!)).toBe('✅ New session created. You can start chatting now.')
    expect(createdWorkDirs).toEqual(['/allowed/default'])

    const errored = await controller.handleInput('chat-1', '/new express')
    expect(errored).toEqual({ kind: 'error', message: 'project lookup failed' })
    expect(formatProjectSelectionOutcome(errored!)).toBe('❌ project lookup failed')

    const failingController = new ProjectSelectionController({
      httpClient: {
        listRecentProjects: async () => [],
        matchProject: async () => ({ project: recentProject('express', '/allowed/express') }),
      },
      defaultWorkDir: '/allowed/default',
      prepareNewSession: () => {},
      createSession: async () => false,
    })
    const failed = await failingController.handleInput('chat-2', '/new express')
    expect(failed).toEqual({ kind: 'creation_failed' })
    expect(formatProjectSelectionOutcome(failed!)).toBeNull()
  })

  it('routes DingTalk and Feishu /new name and index commands to the same canonical cwd after /projects', async () => {
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'im-project-flow-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'im-project-outside-'))
    const expressDir = path.join(allowedRoot, 'express')
    const taskBoardDir = path.join(allowedRoot, 'task-board')
    const expressApiDir = path.join(allowedRoot, 'express-api')
    const expressWebDir = path.join(allowedRoot, 'express-web')
    fs.mkdirSync(expressDir)
    fs.mkdirSync(taskBoardDir)
    fs.mkdirSync(expressApiDir)
    fs.mkdirSync(expressWebDir)
    const canonicalExpressDir = fs.realpathSync(expressDir)
    const canonicalTaskBoardDir = fs.realpathSync(taskBoardDir)
    const canonicalExpressApiDir = fs.realpathSync(expressApiDir)
    const canonicalExpressWebDir = fs.realpathSync(expressWebDir)
    const canonicalOutsideRoot = fs.realpathSync(outsideRoot)

    const projects = [
      recentProject('outside', canonicalOutsideRoot),
      recentProject('express', canonicalExpressDir),
      recentProject('task-board', canonicalTaskBoardDir),
      recentProject('express-api', canonicalExpressApiDir),
      recentProject('express-web', canonicalExpressWebDir),
    ]
    const createdWorkDirs: string[] = []

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/sessions/recent-projects')) {
        return Response.json({ projects })
      }
      if (url.endsWith('/api/sessions') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { workDir: string }
        createdWorkDirs.push(body.workDir)
        return Response.json({ sessionId: `session-${createdWorkDirs.length}` }, { status: 201 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch

    try {
      const client = new AdapterHttpClient('ws://127.0.0.1:3456', {
        allowedProjectRoots: [allowedRoot],
      })

      for (const transport of TRANSPORTS) {
        for (const command of [
          '/new express',
          '/new 1',
          '  /new   ExPrEsS  ',
        ] as const) {
          const chatId = `${transport.name}:${command}`
          const controller = createProjectController(client, canonicalExpressDir)
          const listed = await controller.listProjects(chatId)
          expect(listed.map((project) => project.projectName)).toEqual([
            'express',
            'task-board',
            'express-api',
            'express-web',
          ])

          const outcome = await controller.handleInput(chatId, transport.extractText(command))
          expect(outcome).toMatchObject({
            kind: 'created',
            project: {
              projectName: 'express',
              realPath: canonicalExpressDir,
            },
          })
          expect(formatProjectSelectionOutcome(outcome!)).toContain('**express**')
        }
      }

      expect(createdWorkDirs).toEqual(Array(6).fill(canonicalExpressDir))

      for (const transport of TRANSPORTS) {
        const chatId = `${transport.name}:ambiguous`
        const controller = createProjectController(client, canonicalExpressDir)
        const listed = await controller.listProjects(chatId)
        expect(listed).toHaveLength(4)

        const outcome = await controller.handleInput(chatId, transport.extractText('/new express-'))
        expect(outcome?.kind).toBe('ambiguous')
        if (outcome?.kind !== 'ambiguous') throw new Error('Expected ambiguous project outcome')
        expect(outcome.projects.map((project) => project.projectName)).toEqual([
          'express-api',
          'express-web',
        ])
        const prompt = formatProjectSelectionOutcome(outcome) ?? ''
        expect(prompt).toContain('/new <more complete name or path>')
        expect(prompt).toContain(`**express-api** — ${canonicalExpressApiDir}`)
        expect(prompt).toContain(`**express-web** — ${canonicalExpressWebDir}`)
      }

      for (const transport of TRANSPORTS) {
        for (const query of ['outside', canonicalOutsideRoot]) {
          const chatId = `${transport.name}:outside:${query}`
          const controller = createProjectController(client, canonicalExpressDir)
          const listed = await controller.listProjects(chatId)
          expect(listed.some((project) => project.projectName === 'outside')).toBe(false)

          const outcome = await controller.handleInput(
            chatId,
            transport.extractText(`/new ${query}`),
          )
          expect(outcome).toEqual({ kind: 'not_found', query })
          expect(formatProjectSelectionOutcome(outcome!)).toContain(`No project matching "${query}"`)
        }
      }

      expect(createdWorkDirs).toEqual(Array(6).fill(canonicalExpressDir))
    } finally {
      fs.rmSync(allowedRoot, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('prompts instead of choosing arbitrarily when exact project names are duplicated', async () => {
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'im-project-duplicates-'))
    const firstDir = path.join(allowedRoot, 'team-a', 'express')
    const secondDir = path.join(allowedRoot, 'team-b', 'express')
    fs.mkdirSync(firstDir, { recursive: true })
    fs.mkdirSync(secondDir, { recursive: true })
    const canonicalFirstDir = fs.realpathSync(firstDir)
    const canonicalSecondDir = fs.realpathSync(secondDir)
    const projects = [
      recentProject('express', canonicalFirstDir),
      recentProject('express', canonicalSecondDir),
    ]
    let createRequests = 0

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/sessions/recent-projects')) {
        return Response.json({ projects })
      }
      if (url.endsWith('/api/sessions') && init?.method === 'POST') {
        createRequests += 1
        return Response.json({ sessionId: 'unexpected-session' }, { status: 201 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch

    try {
      const client = new AdapterHttpClient('ws://127.0.0.1:3456', {
        allowedProjectRoots: [allowedRoot],
      })

      for (const transport of TRANSPORTS) {
        const chatId = `${transport.name}:duplicate-express`
        const controller = createProjectController(client, canonicalFirstDir)
        await controller.listProjects(chatId)

        const outcome = await controller.handleInput(
          chatId,
          transport.extractText('/new express'),
        )
        expect(outcome?.kind).toBe('ambiguous')
        if (outcome?.kind !== 'ambiguous') throw new Error('Expected ambiguous project outcome')
        expect(outcome.projects.map((project) => project.realPath)).toEqual([
          canonicalFirstDir,
          canonicalSecondDir,
        ])
        const prompt = formatProjectSelectionOutcome(outcome) ?? ''
        expect(prompt).toContain(canonicalFirstDir)
        expect(prompt).toContain(canonicalSecondDir)
      }

      expect(createRequests).toBe(0)
    } finally {
      fs.rmSync(allowedRoot, { recursive: true, force: true })
    }
  })
})
