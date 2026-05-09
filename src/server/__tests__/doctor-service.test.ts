import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleDoctorApi } from '../api/doctor.js'
import { handleApiRequest } from '../router.js'
import { DoctorService } from '../services/doctorService.js'

let tmpDir: string
let homeDir: string
let configDir: string
let projectRoot: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-service-test-'))
  homeDir = path.join(tmpDir, 'home')
  configDir = path.join(homeDir, '.claude')
  projectRoot = path.join(tmpDir, 'workspace', 'demo-project')
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir

  await fs.mkdir(path.join(configDir, 'projects', 'demo-project'), { recursive: true })
  await fs.mkdir(path.join(configDir, 'skills', 'alpha-skill'), { recursive: true })
  await fs.mkdir(path.join(configDir, 'cc-haha'), { recursive: true })
  await fs.mkdir(path.join(projectRoot, '.claude', 'skills', 'beta-skill'), { recursive: true })

  await fs.writeFile(path.join(configDir, 'settings.json'), '{"defaultMode":', 'utf-8')
  await fs.writeFile(path.join(projectRoot, '.claude', 'settings.json'), '{"model":', 'utf-8')
  await fs.writeFile(
    path.join(configDir, 'projects', 'demo-project', 'session-1.jsonl'),
    '{"type":"message"}\n{bad json}\n',
    'utf-8',
  )
  await fs.writeFile(
    path.join(configDir, 'cc-haha', 'providers.json'),
    JSON.stringify({ activeId: null, providers: [{ id: 'provider-1' }] }),
    'utf-8',
  )
  await fs.writeFile(
    path.join(configDir, 'skills', 'alpha-skill', 'SKILL.md'),
    '# Alpha\n',
    'utf-8',
  )
  await fs.writeFile(
    path.join(projectRoot, '.claude', 'skills', 'beta-skill', 'SKILL.md'),
    '# Beta\n',
    'utf-8',
  )
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

describe('DoctorService', () => {
  test('report redacts filesystem paths and lists protected skipped items', async () => {
    const service = new DoctorService({ configDir, homeDir, projectRoot })

    const report = await service.getReport()
    const serialized = JSON.stringify(report)

    expect(serialized).not.toContain(tmpDir)
    expect(serialized).not.toContain(projectRoot)

    const userSettings = report.items.find((item) => item.path === '~/.claude/settings.json')
    expect(userSettings).toBeDefined()
    expect(userSettings?.protected).toBe(true)
    expect(userSettings?.status).toBe('invalid_json')

    const projectSettings = report.items.find(
      (item) => item.path === '<project>/.claude/settings.json',
    )
    expect(projectSettings).toBeDefined()
    expect(projectSettings?.protected).toBe(true)
    expect(projectSettings?.status).toBe('invalid_json')

    const sessionJsonl = report.items.find(
      (item) => item.path === '~/.claude/projects/demo-project/session-1.jsonl',
    )
    expect(sessionJsonl).toBeDefined()
    expect(sessionJsonl?.protected).toBe(true)
    expect(sessionJsonl?.status).toBe('invalid_jsonl')
    expect(sessionJsonl?.lineCount).toBe(2)
    expect(sessionJsonl?.invalidLineCount).toBe(1)

    expect(report.protectedSkips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '~/.claude/settings.json', reason: 'protected' }),
        expect.objectContaining({ path: '<project>/.claude/settings.json', reason: 'protected' }),
        expect.objectContaining({
          path: '~/.claude/projects/demo-project/session-1.jsonl',
          reason: 'protected',
        }),
      ]),
    )
  })

  test('safe repair skips protected malformed files without modifying them', async () => {
    const service = new DoctorService({ configDir, homeDir, projectRoot })
    const userSettingsPath = path.join(configDir, 'settings.json')
    const projectSettingsPath = path.join(projectRoot, '.claude', 'settings.json')
    const beforeUser = await fs.readFile(userSettingsPath, 'utf-8')
    const beforeProject = await fs.readFile(projectSettingsPath, 'utf-8')

    const result = await service.repair()

    expect(result.mutated).toBe(false)
    expect(result.operations).toEqual([])
    expect(result.skips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '~/.claude/settings.json', reason: 'protected' }),
        expect.objectContaining({ path: '<project>/.claude/settings.json', reason: 'protected' }),
      ]),
    )

    expect(await fs.readFile(userSettingsPath, 'utf-8')).toBe(beforeUser)
    expect(await fs.readFile(projectSettingsPath, 'utf-8')).toBe(beforeProject)
  })
})

describe('doctor API', () => {
  test('returns a report and dry-run repair result', async () => {
    const reportReq = makeRequest(
      'GET',
      `/api/doctor/report?cwd=${encodeURIComponent(projectRoot)}`,
    )
    const reportRes = await handleDoctorApi(reportReq.req, reportReq.url, reportReq.segments)
    expect(reportRes.status).toBe(200)
    const reportBody = await reportRes.json() as {
      report: { summary: { protectedCount: number } }
    }
    expect(reportBody.report.summary.protectedCount).toBeGreaterThan(0)

    const repairReq = makeRequest('POST', '/api/doctor/repair', { cwd: projectRoot })
    const repairRes = await handleDoctorApi(repairReq.req, repairReq.url, repairReq.segments)
    expect(repairRes.status).toBe(200)
    const repairBody = await repairRes.json() as { result: { mutated: boolean } }
    expect(repairBody.result.mutated).toBe(false)
  })

  test('routes doctor requests through the main API router', async () => {
    const url = new URL(
      `/api/doctor/report?cwd=${encodeURIComponent(projectRoot)}`,
      'http://localhost:3456',
    )
    const res = await handleApiRequest(new Request(url.toString(), { method: 'GET' }), url)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      report: { items: Array<{ path: string; status: string }> }
    }
    expect(body.report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '~/.claude/settings.json',
          status: 'invalid_json',
        }),
      ]),
    )
  })
})
