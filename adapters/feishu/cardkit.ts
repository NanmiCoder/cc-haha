/**
 * Thin wrapper over the Feishu CardKit API
 *
 * This is the core of the production path: equivalent to openclaw-lark's main CardKit path.
 *
 * Five-step flow:
 *   1. createCardEntity()    —— create the card entity, returns card_id
 *   2. sendCardAsMessage()   —— attach the card to the chat via an IM message, returns message_id
 *   3. streamCardContent()   —— called in a loop, appends text incrementally by element_id
 *   4. setCardStreamingMode() —— turn off streaming mode (required before finishing)
 *   5. updateCardKitCard()   —— replace the whole card with its final state
 *
 * Key constraints:
 * - Every step 3/4/5 call must carry a **monotonically increasing** sequence, or Feishu rejects it
 * - streamCardContent takes the **full accumulated text**, not a delta
 * - streaming_mode must be turned off before users can interact with the card
 *
 * Reference implementation: openclaw-lark/src/card/cardkit.ts
 */

import type * as Lark from '@larksuiteoapi/node-sdk'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed element_id of the streaming markdown element. The card JSON uses this id to mark
 *  the one markdown element updated by `cardElement.content()`. */
export const STREAMING_ELEMENT_ID = 'streaming_content'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Generic response shape returned by the SDK.
 * The SDK's TypeScript types are incomplete; at runtime it returns { code, msg, data }.
 * We treat it uniformly as CardKitResponse to avoid `as any` everywhere.
 */
type CardKitResponse = {
  code?: number
  msg?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

/** Structured error thrown on a non-zero code. Fields align with the Lark SDK's standard error,
 *  so card-errors.ts parseCardApiError can recognize it. */
export class CardKitApiError extends Error {
  readonly code: number
  readonly msg: string

  constructor(params: { api: string; code: number; msg: string; context: string }) {
    const { api, code, msg, context } = params
    super(`cardkit ${api} FAILED: code=${code}, msg=${msg}, ${context}`)
    this.name = 'CardKitApiError'
    this.code = code
    this.msg = msg
  }
}

type LarkClient = Lark.Client

const DEFAULT_IM_CARD_REQUEST_TIMEOUT_MS = 15_000

function getImCardRequestTimeoutMs(): number {
  const raw = process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS
  const parsed = raw ? Number(raw) : DEFAULT_IM_CARD_REQUEST_TIMEOUT_MS
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_IM_CARD_REQUEST_TIMEOUT_MS
}

export async function withImCardRequestTimeout<T>(
  api: string,
  request: () => Promise<T>,
): Promise<T> {
  const timeoutMs = getImCardRequestTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      Promise.resolve().then(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${api} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Response check
// ---------------------------------------------------------------------------

/**
 * Check the body-level code of a CardKit response. Non-zero → throw CardKitApiError.
 *
 * Fail-fast strategy: streaming-card uses try/catch with card-errors to decide
 * uniformly whether it is a rate limit or a real error.
 */
function assertCardKitOk(params: {
  resp: CardKitResponse
  api: string
  context: string
}): void {
  const { resp, api, context } = params
  const code = resp.code
  if (code !== undefined && code !== 0) {
    throw new CardKitApiError({
      api,
      code,
      msg: typeof resp.msg === 'string' ? resp.msg : '',
      context,
    })
  }
}

// ---------------------------------------------------------------------------
// Step 1 — createCardEntity
// ---------------------------------------------------------------------------

/**
 * Create a CardKit card entity and return its card_id.
 *
 * The card is not attached to any chat yet; call sendCardAsMessage to display it.
 *
 * @param client  Lark SDK client
 * @param card    Card JSON in Schema 2.0 format
 * @returns       card_id assigned by Feishu (throws on failure)
 */
export async function createCardEntity(
  client: LarkClient,
  card: Record<string, unknown>,
): Promise<string> {
  // SDK return type is incomplete; cast to the actual runtime shape
  const resp = (await withImCardRequestTimeout('card.create', () =>
    client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(card),
      },
    }),
  )) as unknown as CardKitResponse

  assertCardKitOk({
    resp,
    api: 'card.create',
    context: `cardLen=${JSON.stringify(card).length}`,
  })

  // Handle different SDK wrapper layers: prefer data.card_id, fall back to top-level card_id
  const cardId =
    (resp.data?.card_id as string | undefined) ??
    (resp.card_id as string | undefined)

  if (!cardId) {
    throw new CardKitApiError({
      api: 'card.create',
      code: resp.code ?? -1,
      msg: 'response missing card_id',
      context: `resp=${JSON.stringify(resp).slice(0, 200)}`,
    })
  }
  return cardId
}

// ---------------------------------------------------------------------------
// Step 2 — sendCardAsMessage
// ---------------------------------------------------------------------------

/**
 * Attach a CardKit card to a chat via an IM message.
 *
 * content format: `{"type":"card","data":{"card_id":"xxx"}}`
 * msg_type is always `interactive`.
 *
 * @param client            Lark SDK client
 * @param chatId            target chat_id
 * @param cardId            CardKit card_id (produced by createCardEntity)
 * @param replyToMessageId  optional. If provided, uses im.message.reply; otherwise im.message.create
 * @returns                 message_id assigned by Feishu
 */
export async function sendCardAsMessage(
  client: LarkClient,
  chatId: string,
  cardId: string,
  replyToMessageId?: string,
  uuid?: string,
): Promise<string> {
  const content = JSON.stringify({
    type: 'card',
    data: { card_id: cardId },
  })

  if (replyToMessageId) {
    const resp = await withImCardRequestTimeout('im.message.reply', () =>
      client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'interactive', uuid },
      }),
    )
    const messageId = resp.data?.message_id
    if (!messageId) {
      throw new CardKitApiError({
        api: 'im.message.reply',
        code: -1,
        msg: 'response missing message_id',
        context: `cardId=${cardId}`,
      })
    }
    return messageId
  }

  const resp = await withImCardRequestTimeout('im.message.create', () =>
    client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content,
        uuid,
      },
    }),
  )
  const messageId = resp.data?.message_id
  if (!messageId) {
    throw new CardKitApiError({
      api: 'im.message.create',
      code: -1,
      msg: 'response missing message_id',
      context: `chatId=${chatId} cardId=${cardId}`,
    })
  }
  return messageId
}

// ---------------------------------------------------------------------------
// Step 3 — streamCardContent
// ---------------------------------------------------------------------------

/**
 * Stream-update the content of the given element. Feishu diffs against the old content
 * and renders a typewriter effect on the client.
 *
 * **Important**: `content` must be the **full accumulated text**, not a delta.
 * sequence must be **monotonically increasing**, or Feishu rejects it.
 *
 * @param client     Lark SDK client
 * @param cardId     CardKit card_id
 * @param elementId  id of the element to update (usually STREAMING_ELEMENT_ID)
 * @param content    full accumulated text
 * @param sequence   monotonically increasing sequence number
 */
export async function streamCardContent(
  client: LarkClient,
  cardId: string,
  elementId: string,
  content: string,
  sequence: number,
): Promise<void> {
  const resp = (await withImCardRequestTimeout('cardElement.content', () =>
    client.cardkit.v1.cardElement.content({
      data: { content, sequence },
      path: { card_id: cardId, element_id: elementId },
    }),
  )) as unknown as CardKitResponse

  assertCardKitOk({
    resp,
    api: 'cardElement.content',
    context: `seq=${sequence} len=${content.length}`,
  })
}

// ---------------------------------------------------------------------------
// Step 4 — setCardStreamingMode
// ---------------------------------------------------------------------------

/**
 * Turn the card's streaming mode on/off. Must call with `streamingMode: false` before finishing,
 * otherwise the card stays "read-only" and buttons do nothing.
 */
export async function setCardStreamingMode(
  client: LarkClient,
  cardId: string,
  streamingMode: boolean,
  sequence: number,
): Promise<void> {
  const resp = (await withImCardRequestTimeout('card.settings', () =>
    client.cardkit.v1.card.settings({
      data: {
        settings: JSON.stringify({ streaming_mode: streamingMode }),
        sequence,
      },
      path: { card_id: cardId },
    }),
  )) as unknown as CardKitResponse

  assertCardKitOk({
    resp,
    api: 'card.settings',
    context: `seq=${sequence} streaming_mode=${streamingMode}`,
  })
}

// ---------------------------------------------------------------------------
// Step 5 — updateCardKitCard
// ---------------------------------------------------------------------------

/**
 * Replace the whole card with new JSON. Used after streaming ends to switch the card to its final state
 * (header template, footer, completed style, etc.).
 */
export async function updateCardKitCard(
  client: LarkClient,
  cardId: string,
  card: Record<string, unknown>,
  sequence: number,
): Promise<void> {
  const resp = (await withImCardRequestTimeout('card.update', () =>
    client.cardkit.v1.card.update({
      data: {
        card: { type: 'card_json', data: JSON.stringify(card) },
        sequence,
      },
      path: { card_id: cardId },
    }),
  )) as unknown as CardKitResponse

  assertCardKitOk({
    resp,
    api: 'card.update',
    context: `seq=${sequence} cardId=${cardId}`,
  })
}
