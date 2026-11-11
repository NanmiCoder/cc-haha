/**
 * Magpie (https://usemagpie.ai) runs a local gateway that serves every model
 * its user set up — API keys, subscriptions, local models, routing groups —
 * under one Anthropic-compatible endpoint. Its guide for apps
 * (docs/integrating.md, "Talk to the gateway") is the contract followed here:
 *
 * - the port is `port` in its settings.json (default 3425); read it, never write it;
 * - `GET /api/hello` answers `{"name":"magpie"}`;
 * - the key names the calling app: `magpie-<app>` is counted as that app, and
 *   keeps the gateway from treating our `claude-cli` requests as Claude Code's
 *   (which would redirect `claude-*` ids to the models it set for Claude Code);
 * - `GET /v1/models` lists the models with their windows and reply limits.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  MODEL_CONTEXT_WINDOW_MAX,
  MODEL_CONTEXT_WINDOW_MIN,
  MODEL_MAX_OUTPUT_TOKENS_MAX,
  MODEL_MAX_OUTPUT_TOKENS_MIN,
} from '../../utils/model/modelContextWindows.js'
import { getNetworkProxyFetchOptions, loadNetworkSettings } from './networkSettings.js'

export const MAGPIE_PRESET_ID = 'magpie'
export const MAGPIE_CLIENT_KEY = 'magpie-cc-haha'
export const MAGPIE_DEFAULT_PORT = 3425

const PROBE_TIMEOUT_MS = 1_200
const CATALOG_TIMEOUT_MS = 3_000
const CATALOG_TTL_MS = 30_000

export type MagpieStatus = {
  /** Magpie's settings folder exists on this computer. */
  installed: boolean
  running: boolean
  baseUrl: string
  version?: string
}

export type MagpieModel = {
  id: string
  /** The id to run: Claude models of a 1M window get `[1m]`, as Magpie does for Claude Code. */
  runtimeId: string
  displayName: string
  provider: string
  /** The provider's name as the user sees it in Magpie, when the catalog says. */
  providerName?: string
  isGroup: boolean
  contextWindow?: number
  maxOutputTokens?: number
  reasoningEfforts: string[]
  images?: boolean
}

type MagpieEnv = Pick<NodeJS.ProcessEnv, 'HOME' | 'USERPROFILE' | 'XDG_CONFIG_HOME'>

export function resolveMagpieConfigDir(env: MagpieEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg) return join(xdg, 'magpie')
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  return join(home, '.config', 'magpie')
}

export function readMagpiePort(env: MagpieEnv = process.env): number {
  try {
    const settings: unknown = JSON.parse(readFileSync(join(resolveMagpieConfigDir(env), 'settings.json'), 'utf8'))
    const port = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).port : undefined
    // Magpie itself treats 0 as "the default" and only accepts 1024–65535.
    if (typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535) return port
  } catch {
    // No settings yet, or a file mid-write: the default port is where it listens.
  }
  return MAGPIE_DEFAULT_PORT
}

export function magpieBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function isMagpieProvider(provider: { presetId?: string } | null | undefined): boolean {
  return provider?.presetId === MAGPIE_PRESET_ID
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

async function loopbackFetch(url: string, init: RequestInit): Promise<Response> {
  // Loopback is never proxied; the options say so explicitly for runtimes
  // that would otherwise pick a proxy up from the environment.
  const proxyOptions = getNetworkProxyFetchOptions(await loadNetworkSettings(), url)
  return fetch(url, { ...init, ...proxyOptions })
}

export async function probeMagpie(options: { env?: MagpieEnv; fetchImpl?: FetchLike } = {}): Promise<MagpieStatus> {
  const env = options.env ?? process.env
  const baseUrl = magpieBaseUrl(readMagpiePort(env))
  const installed = existsSync(resolveMagpieConfigDir(env))
  try {
    const response = await (options.fetchImpl ?? loopbackFetch)(`${baseUrl}/api/hello`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return { installed, running: false, baseUrl }
    const hello = await response.json() as { name?: unknown; version?: unknown }
    if (hello?.name !== 'magpie') return { installed, running: false, baseUrl }
    return {
      installed: true,
      running: true,
      baseUrl,
      ...(typeof hello.version === 'string' && { version: hello.version }),
    }
  } catch {
    return { installed, running: false, baseUrl }
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function reasoningEffortsOf(record: Record<string, unknown>): string[] {
  const flat = Array.isArray(record.reasoning_levels)
    ? record.reasoning_levels.filter((level): level is string => typeof level === 'string' && !!level.trim())
    : []
  if (flat.length) return flat
  if (!Array.isArray(record.supported_reasoning_levels)) return []
  return record.supported_reasoning_levels.flatMap((level) => {
    const effort = level && typeof level === 'object' ? (level as Record<string, unknown>).effort : undefined
    return typeof effort === 'string' && effort.trim() ? [effort] : []
  })
}

function modalitiesOf(record: Record<string, unknown>): { input?: string[]; output?: string[] } {
  const modalities = record.modalities
  if (!modalities || typeof modalities !== 'object') return {}
  const pick = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
  const { input, output } = modalities as Record<string, unknown>
  return { input: pick(input), output: pick(output) }
}

export function magpieRuntimeModelId(id: string, contextWindow: number | undefined): string {
  // The 1M beta header only goes out for an id marked [1m]; without it an
  // Anthropic upstream holds a 1M Claude model to 200K.
  return /claude/i.test(id) && (contextWindow ?? 0) >= 1_000_000 ? `${id}[1m]` : id
}

/** `GET /v1/models` as cc-haha uses it: chat models only, limits kept when known. */
export function parseMagpieModels(body: unknown): MagpieModel[] {
  const data = body && typeof body === 'object' ? (body as Record<string, unknown>).data : undefined
  if (!Array.isArray(data)) return []
  const models: MagpieModel[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || models.some((model) => model.id === id)) continue
    // Video and image generators are listed too; a conversation can't run on them.
    const { input, output } = modalitiesOf(record)
    if (typeof record.kind === 'string' && record.kind !== 'chat') continue
    if (output && output.length > 0 && !output.includes('text')) continue
    const contextWindow = positiveInt(record.context_window) ?? positiveInt(record.context_length) ?? positiveInt(record.max_input_tokens)
    const maxOutputTokens = positiveInt(record.max_output_tokens)
    const displayName = typeof record.display_name === 'string' && record.display_name.trim()
      ? record.display_name.trim()
      : id
    // `magpie_label` is "<model> · <provider name>".
    const label = typeof record.magpie_label === 'string' ? record.magpie_label : ''
    const providerName = label.includes(' · ') ? label.slice(label.lastIndexOf(' · ') + 3).trim() : ''
    models.push({
      id,
      runtimeId: magpieRuntimeModelId(id, contextWindow),
      displayName,
      provider: typeof record.owned_by === 'string' ? record.owned_by : '',
      ...(providerName && { providerName }),
      isGroup: id.startsWith('group/'),
      ...(contextWindow !== undefined && { contextWindow }),
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      reasoningEfforts: reasoningEffortsOf(record),
      ...(input && { images: input.includes('image') }),
    })
  }
  return models
}

/**
 * The per-model maps the runtime reads (CLAUDE_CODE_MODEL_CONTEXT_WINDOWS and
 * CLAUDE_CODE_MODEL_MAX_OUTPUT_TOKENS), for every model Magpie serves: a
 * conversation can switch to any of them, and a model missing from the maps
 * falls back to 200K and a 32K reply.
 */
export function magpieModelLimits(models: readonly MagpieModel[]): {
  modelContextWindows: Record<string, number>
  modelMaxOutputTokens: Record<string, number>
} {
  const modelContextWindows: Record<string, number> = {}
  const modelMaxOutputTokens: Record<string, number> = {}
  for (const model of models) {
    const window = model.contextWindow
    if (window !== undefined && window >= MODEL_CONTEXT_WINDOW_MIN && window <= MODEL_CONTEXT_WINDOW_MAX) {
      modelContextWindows[model.id] = window
    }
    const output = model.maxOutputTokens
    if (output !== undefined && output >= MODEL_MAX_OUTPUT_TOKENS_MIN && output <= MODEL_MAX_OUTPUT_TOKENS_MAX) {
      modelMaxOutputTokens[model.id] = output
    }
  }
  return { modelContextWindows, modelMaxOutputTokens }
}

let cachedCatalog: { baseUrl: string; at: number; models: MagpieModel[] } | null = null

export function clearMagpieCatalogCache(): void {
  cachedCatalog = null
}

/** The last catalog fetched, without asking the gateway (empty before the first fetch). */
export function getCachedMagpieModels(): readonly MagpieModel[] {
  return cachedCatalog?.models ?? []
}

/** The catalog, refetched at most every 30s; null when the gateway did not answer. */
export async function fetchMagpieModels(
  baseUrl: string,
  options: { fetchImpl?: FetchLike; force?: boolean; now?: number } = {},
): Promise<MagpieModel[] | null> {
  const now = options.now ?? Date.now()
  if (!options.force && cachedCatalog?.baseUrl === baseUrl && now - cachedCatalog.at < CATALOG_TTL_MS) {
    return cachedCatalog.models
  }
  try {
    const response = await (options.fetchImpl ?? loopbackFetch)(`${baseUrl}/v1/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${MAGPIE_CLIENT_KEY}`,
        'User-Agent': 'cc-haha',
      },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const models = parseMagpieModels(await response.json())
    cachedCatalog = { baseUrl, at: now, models }
    return models
  } catch {
    return null
  }
}

export type OpenMagpieResult = { ok: boolean; unsupported?: boolean }

type Spawner = (command: string[]) => Promise<number>

async function spawnAndWait(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  return child.exited
}

/** Opens the Magpie app. Only macOS has one launcher for it, so elsewhere the UI explains instead. */
export async function openMagpieApp(
  options: { platform?: NodeJS.Platform; spawn?: Spawner } = {},
): Promise<OpenMagpieResult> {
  if ((options.platform ?? process.platform) !== 'darwin') return { ok: false, unsupported: true }
  try {
    const code = await (options.spawn ?? spawnAndWait)(['open', '-a', 'magpie'])
    return { ok: code === 0 }
  } catch {
    return { ok: false }
  }
}
