const DINGTALK_API = 'https://api.dingtalk.com'
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema'
const CARD_API_MAX_QPS = 20
const QPS_BACKOFF_DURATION_MS = 2_000
const DEFAULT_IM_CARD_REQUEST_TIMEOUT_MS = 15_000

const AICardStatus = {
  INPUTING: '2',
  FINISHED: '3',
} as const
type AICardFlowStatus = (typeof AICardStatus)[keyof typeof AICardStatus]

export type DingTalkAiCardTarget =
  | { type: 'user'; userId: string }
  | { type: 'group'; openConversationId: string }

export type DingTalkAiCardInstance = {
  cardInstanceId: string
  accessToken: string
  tokenExpireTime: number
  inputingStarted: boolean
}

export type DingTalkCreateCardOptions = {
  cardTemplateId?: string
  outTrackId?: string
  cardParamMap?: Record<string, unknown>
  callbackRouteKey?: string
}

type TokenProvider = () => Promise<string>

export class DingTalkAiCardService {
  constructor(
    private readonly getAccessToken: TokenProvider,
    private readonly robotCode: string,
  ) {}

  async createForTarget(
    target: DingTalkAiCardTarget,
    options: DingTalkCreateCardOptions = {},
  ): Promise<DingTalkAiCardInstance | null> {
    try {
      const token = await this.getAccessToken()
      const cardInstanceId = options.outTrackId ?? `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const createBody: Record<string, unknown> = {
        cardTemplateId: options.cardTemplateId || AI_CARD_TEMPLATE_ID,
        outTrackId: cardInstanceId,
        cardData: {
          cardParamMap: {
            config: JSON.stringify({ autoLayout: true }),
            ...options.cardParamMap,
          },
        },
        callbackType: 'STREAM',
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
      }
      if (options.callbackRouteKey) createBody.callbackRouteKey = options.callbackRouteKey
      await postJson('/v1.0/card/instances', token, createBody)

      await postJson('/v1.0/card/instances/deliver', token, buildDeliverBody(cardInstanceId, target, this.robotCode))

      return {
        cardInstanceId,
        accessToken: token,
        tokenExpireTime: Date.now() + 2 * 60 * 60 * 1000,
        inputingStarted: false,
      }
    } catch (err) {
      console.warn('[DingTalk][AICard] create failed:', err instanceof Error ? err.message : err)
      return null
    }
  }

  async stream(card: DingTalkAiCardInstance, content: string, finished = false): Promise<void> {
    await this.ensureValidToken(card)

    if (!card.inputingStarted) {
      await this.updateStatus(card, AICardStatus.INPUTING, content)
      card.inputingStarted = true
    }

    await withCardRateLimit(() =>
      putJson('/v1.0/card/streaming', card.accessToken, {
        outTrackId: card.cardInstanceId,
        guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        key: 'msgContent',
        content: ensureTableBlankLines(content),
        isFull: true,
        isFinalize: finished,
        isError: false,
      }),
    )
  }

  async finish(card: DingTalkAiCardInstance, content: string): Promise<void> {
    await this.stream(card, content, true)
    try {
      await this.updateStatus(card, AICardStatus.FINISHED, ensureTableBlankLines(content))
    } catch (err) {
      console.warn('[DingTalk][AICard] finish status failed:', err instanceof Error ? err.message : err)
    }
  }

  private async updateStatus(
    card: DingTalkAiCardInstance,
    flowStatus: AICardFlowStatus,
    content: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      outTrackId: card.cardInstanceId,
      cardData: {
        cardParamMap: {
          flowStatus,
          msgContent: ensureTableBlankLines(content),
          staticMsgContent: '',
          sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
          config: JSON.stringify({ autoLayout: true }),
        },
      },
    }
    if (flowStatus === AICardStatus.FINISHED) {
      body.cardUpdateOptions = { updateCardDataByKey: true }
    }

    await withCardRateLimit(() =>
      putJson('/v1.0/card/instances', card.accessToken, body),
    )
  }

  private async ensureValidToken(card: DingTalkAiCardInstance): Promise<void> {
    if (Date.now() <= card.tokenExpireTime - 5 * 60 * 1000) return
    card.accessToken = await this.getAccessToken()
    card.tokenExpireTime = Date.now() + 2 * 60 * 60 * 1000
  }
}

export function buildDeliverBody(
  cardInstanceId: string,
  target: DingTalkAiCardTarget,
  robotCode: string,
): Record<string, unknown> {
  const base = { outTrackId: cardInstanceId, userIdType: 1 }
  if (target.type === 'group') {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
      imGroupOpenDeliverModel: {
        robotCode,
      },
    }
  }

  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
    imRobotOpenDeliverModel: {
      spaceType: 'IM_ROBOT',
      robotCode,
      extension: {
        dynamicSummary: 'true',
      },
    },
  }
}

async function postJson(path: string, token: string, body: Record<string, unknown>): Promise<void> {
  await requestJson('POST', path, token, body)
}

async function putJson(path: string, token: string, body: Record<string, unknown>): Promise<void> {
  await requestJson('PUT', path, token, body)
}

async function requestJson(
  method: 'POST' | 'PUT',
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const controller = new AbortController()
  const timeoutMs = getImCardRequestTimeoutMs()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${DINGTALK_API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = new Error(`${method} ${path} failed: ${res.status} ${text}`)
      ;(err as any).status = res.status
      ;(err as any).body = text
      throw err
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`${method} ${path} timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function getImCardRequestTimeoutMs(): number {
  const raw = process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS
  const parsed = raw ? Number(raw) : DEFAULT_IM_CARD_REQUEST_TIMEOUT_MS
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_IM_CARD_REQUEST_TIMEOUT_MS
}

async function withCardRateLimit(fn: () => Promise<void>): Promise<void> {
  await cardRateLimiter.waitForToken()
  try {
    await fn()
  } catch (err) {
    if (!isQpsLimitError(err)) throw err
    cardRateLimiter.triggerBackoff()
    await cardRateLimiter.waitForToken()
    await fn()
  }
}

function isQpsLimitError(err: unknown): boolean {
  return (err as any)?.status === 403 && String((err as any)?.body ?? '').includes('QpsLimit')
}

const cardRateLimiter = {
  tokens: CARD_API_MAX_QPS,
  lastRefillTime: Date.now(),
  backoffUntil: 0,
  queueTail: Promise.resolve() as Promise<unknown>,

  refill(): void {
    const now = Date.now()
    const elapsedSeconds = (now - this.lastRefillTime) / 1000
    if (elapsedSeconds <= 0) return
    this.tokens = Math.min(CARD_API_MAX_QPS, this.tokens + elapsedSeconds * CARD_API_MAX_QPS)
    this.lastRefillTime = now
  },

  async waitForToken(): Promise<void> {
    const prev = this.queueTail
    let release!: () => void
    this.queueTail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await prev.catch(() => {})
      const now = Date.now()
      if (now < this.backoffUntil) await sleep(this.backoffUntil - now)
      this.refill()
      if (this.tokens < 1) {
        await sleep(Math.ceil(((1 - this.tokens) / CARD_API_MAX_QPS) * 1000))
        this.refill()
      }
      this.tokens -= 1
    } finally {
      release()
    }
  },

  triggerBackoff(): void {
    const backoffEnd = Date.now() + QPS_BACKOFF_DURATION_MS
    this.backoffUntil = backoffEnd
    this.tokens = 0
    this.lastRefillTime = backoffEnd
  },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureTableBlankLines(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  const tableDividerRegex = /^\s*\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)+\|?\s*$/
  const tableRowRegex = /^\s*\|?.*\|.*\|?\s*$/

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i] ?? ''
    const nextLine = lines[i + 1] ?? ''
    if (
      tableRowRegex.test(currentLine) &&
      nextLine.includes('|') &&
      tableDividerRegex.test(nextLine) &&
      i > 0 &&
      lines[i - 1]?.trim() !== '' &&
      !tableRowRegex.test(lines[i - 1] ?? '')
    ) {
      result.push('')
    }
    result.push(currentLine)
  }
  return result.join('\n')
}
