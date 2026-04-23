/**
 * 飞书 CardKit API 薄封装
 *
 * 这是生产路径的核心：openclaw-lark 的 CardKit 主路径等价实现。
 *
 * 五步流程：
 *   1. createCardEntity()    —— 创建卡片实体，返回 card_id
 *   2. sendCardAsMessage()   —— 通过 IM 消息把卡片挂到聊天窗，返回 message_id
 *   3. streamCardContent()   —— 循环调用，按 element_id 增量追加文本
 *   4. setCardStreamingMode() —— 关闭流式模式（收尾前必须做）
 *   5. updateCardKitCard()   —— 全量替换卡片为最终态
 *
 * 关键约束：
 * - 每次 3/4/5 类调用必须携带**单调递增**的 sequence，否则飞书拒绝
 * - streamCardContent 传的是**完整累计文本**，不是 delta
 * - 必须关闭 streaming_mode 后卡片才能被用户交互
 *
 * 参考实现: openclaw-lark/src/card/cardkit.ts
 */

import type * as Lark from '@larksuiteoapi/node-sdk'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 流式 markdown 元素的固定 element_id。卡片 JSON 里用这个 id 标记要被
 *  `cardElement.content()` 更新的那一个 markdown 元素。 */
export const STREAMING_ELEMENT_ID = 'streaming_content'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * SDK 返回的通用响应结构。
 * SDK 的 TypeScript 类型不完整，运行时实际返回 { code, msg, data }。
 * 我们统一当成 CardKitResponse 处理以免到处 `as any`。
 */
type CardKitResponse = {
  code?: number
  msg?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

/** 非零 code 时抛出的结构化错误。字段与 Lark SDK 的标准错误对齐，
 *  可被 card-errors.ts 的 parseCardApiError 识别。 */
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

// ---------------------------------------------------------------------------
// Response check
// ---------------------------------------------------------------------------

/**
 * 检查 CardKit 响应的 body-level code。非 0 → 抛 CardKitApiError。
 *
 * Fail-fast 策略: 让 streaming-card 用 try/catch 配合 card-errors 统一
 * 判断是速率限制还是真错误。
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
 * 创建一张 CardKit 卡片实体，返回 card_id。
 *
 * 此时卡片还没挂到任何聊天窗。需要再调 sendCardAsMessage 才能显示。
 *
 * @param client  Lark SDK client
 * @param card    Schema 2.0 格式的卡片 JSON
 * @returns       飞书分配的 card_id（失败时抛错）
 */
export async function createCardEntity(
  client: LarkClient,
  card: Record<string, unknown>,
): Promise<string> {
  // SDK 返回类型不完整，cast 到运行时实际结构
  const resp = (await client.cardkit.v1.card.create({
    data: {
      type: 'card_json',
      data: JSON.stringify(card),
    },
  })) as unknown as CardKitResponse

  assertCardKitOk({
    resp,
    api: 'card.create',
    context: `cardLen=${JSON.stringify(card).length}`,
  })

  // 兼容不同 SDK 包装层：data.card_id 优先，回退顶层 card_id
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
 * 把 CardKit 卡片通过 IM 消息挂到聊天窗。
 *
 * content 格式: `{"type":"card","data":{"card_id":"xxx"}}`
 * msg_type 固定为 `interactive`。
 *
 * @param client            Lark SDK client
 * @param chatId            目标 chat_id
 * @param cardId            CardKit card_id（由 createCardEntity 产生）
 * @param replyToMessageId  可选。如果提供，走 im.message.reply；否则 im.message.create
 * @returns                 飞书分配的 message_id
 */
export async function sendCardAsMessage(
  client: LarkClient,
  chatId: string,
  cardId: string,
  replyToMessageId?: string,
): Promise<string> {
  const content = JSON.stringify({
    type: 'card',
    data: { card_id: cardId },
  })

  if (replyToMessageId) {
    const resp = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { content, msg_type: 'interactive' },
    })
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

  const resp = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content,
    },
  })
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
 * 流式更新指定 element 的内容。飞书自动对比旧内容做 diff，在客户端
 * 渲染打字机效果。
 *
 * **重要**: `content` 必须传**完整累计文本**，不是 delta。
 * sequence 必须**单调递增**，否则飞书拒绝。
 *
 * @param client     Lark SDK client
 * @param cardId     CardKit card_id
 * @param elementId  要更新的元素 id（通常是 STREAMING_ELEMENT_ID）
 * @param content    完整累计文本
 * @param sequence   单调递增序列号
 */
export async function streamCardContent(
  client: LarkClient,
  cardId: string,
  elementId: string,
  content: string,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.cardElement.content({
    data: { content, sequence },
    path: { card_id: cardId, element_id: elementId },
  })) as unknown as CardKitResponse

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
 * 开/关卡片的流式模式。收尾前必须调用 `streamingMode: false`，
 * 否则卡片会保持"只读"状态，用户点按钮没反应。
 */
export async function setCardStreamingMode(
  client: LarkClient,
  cardId: string,
  streamingMode: boolean,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.card.settings({
    data: {
      settings: JSON.stringify({ streaming_mode: streamingMode }),
      sequence,
    },
    path: { card_id: cardId },
  })) as unknown as CardKitResponse

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
 * 全量替换卡片为新的 JSON。用于流式结束后把卡片切换成最终态
 * （加 header template、footer、完成样式等）。
 */
export async function updateCardKitCard(
  client: LarkClient,
  cardId: string,
  card: Record<string, unknown>,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.card.update({
    data: {
      card: { type: 'card_json', data: JSON.stringify(card) },
      sequence,
    },
    path: { card_id: cardId },
  })) as unknown as CardKitResponse

  assertCardKitOk({
    resp,
    api: 'card.update',
    context: `seq=${sequence} cardId=${cardId}`,
  })
}
