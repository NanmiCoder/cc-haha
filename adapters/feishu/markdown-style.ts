/**
 * Feishu 卡片 Markdown 样式优化
 *
 * 背景:
 * - 飞书卡片的 `tag: 'markdown'` 元素对 H1~H3 标题有已知渲染异常（字面量显示）。
 *   必须降级为 H4/H5 才能正常渲染。
 * - Schema 2.0 CardKit 支持完整的 markdown 但需要手动加 `<br>` 间距避免标题/表格/
 *   代码块贴得太紧。
 * - 卡片有表格数量上限（FEISHU_CARD_TABLE_LIMIT=3），超出会触发 230099/11310。
 * - 图片必须是飞书上传过的 `img_xxx` key，其它 URL 会触发 CardKit 错误 200570。
 *
 * 实现参考: openclaw-lark/src/card/markdown-style.ts + card-error.ts
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 飞书卡片表格数量上限 —— 超出 3 张触发 230099/11310（openclaw 2026-03 实测） */
export const FEISHU_CARD_TABLE_LIMIT = 3

// ---------------------------------------------------------------------------
// Public: optimizeMarkdownForFeishu
// ---------------------------------------------------------------------------

/**
 * 对将要放入 `tag: 'markdown'` 元素的 markdown 做安全预处理。
 *
 * - 标题降级: 若原文包含 H1~H3，则 H2~H6 → H5，H1 → H4
 * - 代码块内容受保护，不会被降级
 * - Schema 2.0: 连续标题/表格/代码块前后加 `<br>` 间距
 * - 连续 3+ 空行压缩为 2
 * - 删除非 `img_*` 的 markdown 图片引用（防止 CardKit 200570）
 * - 任何内部错误都 fallback 到原文，不阻塞消息发送
 *
 * @param text 原始 markdown
 * @param cardVersion 卡片 schema 版本。默认 2 (Schema 2.0 CardKit)，
 *   1 对应老 Schema 1.0 fallback 路径（已不推荐）。
 */
export function optimizeMarkdownForFeishu(text: string, cardVersion = 2): string {
  try {
    let r = _optimizeMarkdownForFeishu(text, cardVersion)
    r = stripInvalidImageKeys(r)
    return r
  } catch {
    return text
  }
}

function _optimizeMarkdownForFeishu(text: string, cardVersion: number): string {
  // ── 1. 提取代码块，用占位符保护，处理后再还原 ─────────────────────
  // 代码块内的 `#` / `|` 不能被标题降级或表格匹配误伤
  const MARK = '___CB_'
  const codeBlocks: string[] = []
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`
  })

  // ── 2. 标题降级 ────────────────────────────────────────────────────
  // 只有当原文档（不是保护后的 r）包含 H1~H3 时才执行降级
  // 顺序: 先 H2~H6 → H5，再 H1 → H4
  // 若先 H1→H4，`####` 会被后面的 `#{2,6}` 再次匹配成 H5
  const hasH1toH3 = /^#{1,3} /m.test(text)
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1') // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, '#### $1') // H1 → H4
  }

  // ── 3. Schema 2.0 段落间距 ────────────────────────────────────────
  if (cardVersion >= 2) {
    // 3a. 连续标题之间加 <br>
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2')

    // 3b. 非表格行直接跟表格行 → 先补空行（保证后续规则生效）
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2')

    // 3c. 表格前: 在空行之前插入 <br>（即 `\n\n|` → `\n<br>\n\n|`）
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1')

    // 3d. 表格后: 在表格块末尾追加 <br>（跳过后接分隔线/标题/加粗/文末）
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
      const after = r.slice(offset + m.length).replace(/^\n+/, '')
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m
      return m + '\n<br>\n'
    })

    // 3e. 表格前是普通文本: 只保留 <br>，去掉多余空行
    //     "text\n\n<br>\n\n|" → "text\n<br>\n|"
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3')

    // 3f. 表格前是加粗行: <br> 紧贴加粗行，空行保留在后面
    //     "**bold**\n\n<br>\n\n|" → "**bold**\n<br>\n\n|"
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3')

    // 3g. 表格后是普通文本: 去掉多余空行
    //     "| row |\n\n<br>\ntext" → "| row |\n<br>\ntext"
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3')
  }

  // ── 4. 压缩多余空行（3 个以上连续换行 → 2 个）────────────────────
  // 必须在还原代码块之前做，否则代码块内部的连续换行会被误伤
  r = r.replace(/\n{3,}/g, '\n\n')

  // ── 5. 还原代码块 ─────────────────────────────────────────────────
  // Schema 2.0 时前后加 <br>，让代码块与周围段落拉开距离
  codeBlocks.forEach((block, i) => {
    const replacement = cardVersion >= 2 ? `\n<br>\n${block}\n<br>\n` : block
    r = r.replace(`${MARK}${i}___`, replacement)
  })

  return r
}

// ---------------------------------------------------------------------------
// stripInvalidImageKeys
// ---------------------------------------------------------------------------

/** 匹配完整的 markdown 图片语法: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

/**
 * 删除 value 不是飞书 image key (`img_xxx`) 的 markdown 图片引用。
 * 防止 CardKit 错误 200570（unknown image key）。
 *
 * HTTP URL 和本地路径也会被删除 —— 上游（ImageResolver）负责把它们转成
 * `img_xxx`，此函数是 safety net。
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch
    return ''
  })
}

// ---------------------------------------------------------------------------
// Table limiting: sanitizeTextForCard
// ---------------------------------------------------------------------------

export type MarkdownTableMatch = {
  index: number
  length: number
  raw: string
}

/**
 * 扫描正文里会被飞书卡片**实际渲染**的 markdown 表格位置。
 *
 * 代码块内的示例表格不会被飞书解析成卡片表格元素，因此要先排除。
 * 这份结果供 `sanitizeTextForCard` 判断是否需要降级多余的表格。
 */
export function findMarkdownTablesOutsideCodeBlocks(text: string): MarkdownTableMatch[] {
  // 先扫描代码块区间
  const codeBlockRanges: Array<{ start: number; end: number }> = []
  const codeBlockRegex = /```[\s\S]*?```/g
  let cbMatch = codeBlockRegex.exec(text)
  while (cbMatch != null) {
    codeBlockRanges.push({
      start: cbMatch.index,
      end: cbMatch.index + cbMatch[0].length,
    })
    cbMatch = codeBlockRegex.exec(text)
  }
  const isInsideCodeBlock = (idx: number): boolean =>
    codeBlockRanges.some((range) => idx >= range.start && idx < range.end)

  // 扫描表格（header | sep | body...）
  const tableRegex = /\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g
  const matches: MarkdownTableMatch[] = []
  let tableMatch = tableRegex.exec(text)
  while (tableMatch != null) {
    if (!isInsideCodeBlock(tableMatch.index)) {
      matches.push({
        index: tableMatch.index,
        length: tableMatch[0].length,
        raw: tableMatch[0],
      })
    }
    tableMatch = tableRegex.exec(text)
  }
  return matches
}

/**
 * 对正文里超出 `tableLimit` 张的 markdown 表格降级为代码块，防止触发
 * 230099/11310。前 `tableLimit` 张保持原样（卡片正常渲染），其余用
 * 反引号包裹（飞书会当成 code block 而不是表格）。
 */
export function sanitizeTextForCard(
  text: string,
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): string {
  const matches = findMarkdownTablesOutsideCodeBlocks(text)
  if (matches.length <= tableLimit) return text
  return wrapTablesBeyondLimit(text, matches, Math.max(tableLimit, 0))
}

function wrapTablesBeyondLimit(
  text: string,
  matches: readonly MarkdownTableMatch[],
  keepCount: number,
): string {
  if (matches.length <= keepCount) return text
  // 从后往前替换，避免前面的替换导致后面的 offset 错乱
  let result = text
  for (let i = matches.length - 1; i >= keepCount; i--) {
    const { index, length, raw } = matches[i]!
    const replacement = '```\n' + raw + '\n```'
    result = result.slice(0, index) + replacement + result.slice(index + length)
  }
  return result
}
