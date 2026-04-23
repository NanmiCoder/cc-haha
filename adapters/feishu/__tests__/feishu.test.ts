/**
 * 飞书 Adapter 翻译逻辑测试
 *
 * 不启动真实 Bot，只测试事件解析和消息翻译逻辑。
 */

import { describe, it, expect } from 'bun:test'
import * as path from 'node:path'

// ---------- helpers extracted from feishu/index.ts for testability ----------

function extractText(content: string, msgType: string): string | null {
  try {
    const parsed = JSON.parse(content)
    if (msgType === 'text') {
      return parsed.text ?? null
    }
    if (msgType === 'post') {
      const zhContent = parsed.zh_cn?.content ?? parsed.en_us?.content ?? []
      return zhContent
        .flat()
        .filter((n: any) => n.tag === 'text' || n.tag === 'md')
        .map((n: any) => n.text ?? n.content ?? '')
        .join('')
        .trim() || null
    }
    return null
  } catch {
    return null
  }
}

function isBotMentioned(
  mentions: Array<{ id?: { open_id?: string } }> | undefined,
  botOpenId: string,
): boolean {
  if (!mentions || !botOpenId) return false
  return mentions.some((m) => m.id?.open_id === botOpenId)
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').trim()
}

type RecentProject = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

function prettyPath(realPath: string, maxLen = 64): string {
  const home = process.env.HOME
  let p = realPath
  if (home) {
    if (p === home) return '~'
    if (p.startsWith(`${home}/`)) p = `~${p.slice(home.length)}`
  }
  if (p.length <= maxLen) return p
  const tailLen = Math.floor(maxLen * 0.65)
  const headLen = maxLen - tailLen - 1
  return `${p.slice(0, headLen)}…${p.slice(-tailLen)}`
}

function buildProjectPickerCard(projects: RecentProject[]): Record<string, unknown> {
  const items = projects.slice(0, 10)
  const total = projects.length
  const subtitleText =
    total > items.length
      ? `共 ${total} 个最近项目，显示前 ${items.length}`
      : `共 ${total} 个最近项目`

  const rows = items.map((p, i) => {
    const branch = p.branch ? `  ·  *${p.branch}*` : ''
    return {
      tag: 'column_set',
      flex_mode: 'stretch',
      horizontal_spacing: '8px',
      margin: i === 0 ? '0px 0 0 0' : '10px 0 0 0',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          elements: [
            {
              tag: 'markdown',
              content: `**${p.projectName}**${branch}`,
            },
            {
              tag: 'markdown',
              content: prettyPath(p.realPath, 56),
              text_size: 'notation',
              margin: '2px 0 0 0',
            },
          ],
        },
        {
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '选择' },
              type: i === 0 ? 'primary' : 'default',
              size: 'small',
              value: {
                action: 'pick_project',
                realPath: p.realPath,
                projectName: p.projectName,
              },
            },
          ],
        },
      ],
    }
  })

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: { tag: 'plain_text', content: '📁 选择项目' },
      subtitle: { tag: 'plain_text', content: subtitleText },
      template: 'blue',
    },
    body: {
      elements: [
        ...rows,
        { tag: 'hr', margin: '14px 0 0 0' },
        {
          tag: 'markdown',
          content: '💡 点击右侧 **选择** 按钮，或发送 `/new <项目名>`',
          text_size: 'notation',
          margin: '6px 0 0 0',
        },
      ],
    },
  }
}

// ---------- permission card helpers (mirrored from feishu/index.ts) ----------

type ToolCallSummary = {
  icon: string
  label: string
  target?: string
  filePath?: string
}

function summarizeToolCall(toolName: string, input: unknown): ToolCallSummary {
  const rec: Record<string, unknown> =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const str = (key: string): string | undefined =>
    typeof rec[key] === 'string' ? (rec[key] as string) : undefined

  switch (toolName) {
    case 'Write': {
      const fp = str('file_path')
      return { icon: '✏️', label: '写入文件', target: fp, filePath: fp }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const fp = str('file_path') ?? str('notebook_path')
      return { icon: '✏️', label: '修改文件', target: fp, filePath: fp }
    }
    case 'Read': {
      const fp = str('file_path')
      return { icon: '📖', label: '读取文件', target: fp, filePath: fp }
    }
    case 'Bash':
    case 'BashOutput': {
      return { icon: '🖥️', label: '执行命令', target: str('command') }
    }
    case 'Grep': {
      const pattern = str('pattern')
      return {
        icon: '🔍',
        label: '搜索内容',
        target: pattern ? `pattern: ${pattern}` : undefined,
        filePath: str('path'),
      }
    }
    case 'Glob': {
      const pattern = str('pattern')
      return {
        icon: '📁',
        label: '查找文件',
        target: pattern ? `pattern: ${pattern}` : undefined,
        filePath: str('path'),
      }
    }
    case 'WebFetch':
      return { icon: '🌐', label: '访问网页', target: str('url') }
    case 'WebSearch':
      return { icon: '🌐', label: '搜索网页', target: str('query') }
    default:
      return { icon: '🔧', label: toolName }
  }
}

function isOutsideWorkDir(filePath: string, workDir: string): boolean {
  const abs = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workDir, filePath)
  const normWork = path.normalize(workDir).replace(/\/+$/, '')
  return abs !== normWork && !abs.startsWith(normWork + path.sep)
}

function truncateTarget(s: string, maxLen = 160): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + '…'
}

function buildPermissionCard(
  toolName: string,
  input: unknown,
  requestId: string,
  workDir?: string,
): Record<string, unknown> {
  const summary = summarizeToolCall(toolName, input)
  const crossDir = Boolean(
    workDir && summary.filePath && isOutsideWorkDir(summary.filePath, workDir),
  )

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: `${summary.icon} **${summary.label}**  \`${toolName}\``,
    },
  ]

  if (summary.target) {
    const shown = summary.filePath
      ? prettyPath(summary.target, 80)
      : truncateTarget(summary.target, 160)
    elements.push({
      tag: 'markdown',
      content: '```\n' + shown + '\n```',
      margin: '4px 0 0 0',
    })
  }

  if (crossDir) {
    elements.push({
      tag: 'markdown',
      content: '⚠️ **该操作位于当前项目目录之外**',
      margin: '8px 0 0 0',
      text_size: 'notation',
    })
  }

  elements.push({ tag: 'hr', margin: '12px 0 0 0' })

  elements.push({
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: '8px',
    margin: '8px 0 0 0',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            size: 'medium',
            value: { action: 'permit', requestId, allowed: true },
          },
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '♾️ 永久允许' },
            type: 'default',
            size: 'medium',
            value: { action: 'permit', requestId, allowed: true, rule: 'always' },
          },
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            size: 'medium',
            value: { action: 'permit', requestId, allowed: false },
          },
        ],
      },
    ],
  })

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
      update_multi: true,
    },
    header: {
      title: { tag: 'plain_text', content: '🔐 需要权限确认' },
      subtitle: {
        tag: 'plain_text',
        content: crossDir ? '⚠️ 跨目录操作' : toolName,
      },
      template: crossDir ? 'red' : 'orange',
      padding: '12px 12px 12px 12px',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
    },
    body: { elements },
  }
}

// ---------- tests ----------

describe('Feishu: event parsing', () => {
  describe('extractText', () => {
    it('extracts text from text message', () => {
      const content = JSON.stringify({ text: 'hello world' })
      expect(extractText(content, 'text')).toBe('hello world')
    })

    it('extracts text from post message (zh_cn)', () => {
      const content = JSON.stringify({
        zh_cn: {
          content: [[
            { tag: 'text', text: 'Hello ' },
            { tag: 'text', text: 'World' },
          ]],
        },
      })
      expect(extractText(content, 'post')).toBe('Hello World')
    })

    it('extracts text from post message with md tag', () => {
      const content = JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'md', text: '**bold** text' }]],
        },
      })
      expect(extractText(content, 'post')).toBe('**bold** text')
    })

    it('returns null for unsupported message types', () => {
      expect(extractText('{}', 'image')).toBeNull()
      expect(extractText('{}', 'audio')).toBeNull()
    })

    it('returns null for malformed content', () => {
      expect(extractText('not-json', 'text')).toBeNull()
    })

    it('returns null for empty text', () => {
      const content = JSON.stringify({ text: '' })
      // empty string is falsy, so ?? null returns ''
      expect(extractText(content, 'text')).toBe('')
    })
  })

  describe('isBotMentioned', () => {
    const botId = 'ou_bot_123'

    it('returns true when bot is mentioned', () => {
      const mentions = [
        { id: { open_id: 'ou_user_1' } },
        { id: { open_id: 'ou_bot_123' } },
      ]
      expect(isBotMentioned(mentions, botId)).toBe(true)
    })

    it('returns false when bot is not mentioned', () => {
      const mentions = [
        { id: { open_id: 'ou_user_1' } },
        { id: { open_id: 'ou_user_2' } },
      ]
      expect(isBotMentioned(mentions, botId)).toBe(false)
    })

    it('returns false for undefined mentions', () => {
      expect(isBotMentioned(undefined, botId)).toBe(false)
    })

    it('returns false for empty mentions', () => {
      expect(isBotMentioned([], botId)).toBe(false)
    })
  })

  describe('stripMentions', () => {
    it('removes @_user_N patterns', () => {
      expect(stripMentions('@_user_1 hello world')).toBe('hello world')
    })

    it('removes multiple mentions', () => {
      expect(stripMentions('@_user_1 @_user_2 test')).toBe('test')
    })

    it('leaves text without mentions unchanged', () => {
      expect(stripMentions('hello world')).toBe('hello world')
    })

    it('trims whitespace', () => {
      expect(stripMentions('  @_user_1  hello  ')).toBe('hello')
    })
  })
})

describe('Feishu: permission card', () => {
  // Helpers to reach into Schema 2.0 body.elements
  function getBodyElements(card: Record<string, unknown>): any[] {
    return ((card.body as any).elements ?? []) as any[]
  }
  function getActionRow(card: Record<string, unknown>): any {
    return getBodyElements(card).find((el) => el.tag === 'column_set')
  }
  function getButtons(card: Record<string, unknown>): any[] {
    return getActionRow(card).columns.map(
      (c: any) => c.elements.find((e: any) => e.tag === 'button'),
    )
  }

  // ----- Schema 2.0 regression -----

  it('uses Schema 2.0 with body.elements wrapper (not top-level elements)', () => {
    const card = buildPermissionCard('Bash', { command: 'npm test' }, 'abc')
    expect(card.schema).toBe('2.0')
    expect(card.elements).toBeUndefined() // old bug had top-level elements
    expect((card.body as any).elements).toBeDefined()
    expect((card.config as any).update_multi).toBe(true)
    expect((card.config as any).wide_screen_mode).toBe(false) // mobile-first
  })

  it('header has title, subtitle, template, icon', () => {
    const card = buildPermissionCard('Bash', { command: 'npm test' }, 'abc')
    const header = card.header as any
    expect(header.title.content).toContain('权限确认')
    expect(header.subtitle.content).toBe('Bash')
    expect(header.template).toBe('orange')
    expect(header.icon.tag).toBe('standard_icon')
  })

  // ----- Three buttons -----

  it('has three action buttons in order: 允许 | 永久允许 | 拒绝', () => {
    const card = buildPermissionCard('Read', {}, 'xyz')
    const [allow, always, deny] = getButtons(card)
    expect(allow.text.content).toContain('允许')
    expect(allow.type).toBe('primary')
    expect(always.text.content).toContain('永久允许')
    expect(always.type).toBe('default')
    expect(deny.text.content).toContain('拒绝')
    expect(deny.type).toBe('danger')
  })

  it('允许 button carries allowed=true and no rule', () => {
    const card = buildPermissionCard('Read', {}, 'req-1')
    const [allow] = getButtons(card)
    expect(allow.value).toEqual({
      action: 'permit',
      requestId: 'req-1',
      allowed: true,
    })
    expect(allow.value.rule).toBeUndefined()
  })

  it('永久允许 button carries allowed=true + rule=always', () => {
    const card = buildPermissionCard('Read', {}, 'req-2')
    const always = getButtons(card)[1]
    expect(always.value).toEqual({
      action: 'permit',
      requestId: 'req-2',
      allowed: true,
      rule: 'always',
    })
  })

  it('拒绝 button carries allowed=false and no rule', () => {
    const card = buildPermissionCard('Read', {}, 'req-3')
    const deny = getButtons(card)[2]
    expect(deny.value).toEqual({
      action: 'permit',
      requestId: 'req-3',
      allowed: false,
    })
  })

  // ----- Tool summary rendering -----

  it('renders Write with ✏️ 写入文件 header and file path target', () => {
    const card = buildPermissionCard(
      'Write',
      { file_path: '/tmp/output.txt', content: 'hi' },
      'req',
    )
    const elements = getBodyElements(card)
    expect(elements[0].content).toContain('✏️')
    expect(elements[0].content).toContain('写入文件')
    expect(elements[0].content).toContain('`Write`')
    // Target rendered as fenced code block
    expect(elements[1].content).toContain('/tmp/output.txt')
    expect(elements[1].content.startsWith('```')).toBe(true)
  })

  it('renders Edit with ✏️ 修改文件', () => {
    const card = buildPermissionCard(
      'Edit',
      { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' },
      'req',
    )
    expect(getBodyElements(card)[0].content).toContain('修改文件')
  })

  it('renders Bash with 🖥️ 执行命令 and command target', () => {
    const card = buildPermissionCard(
      'Bash',
      { command: 'rm -rf /tmp/x' },
      'req',
    )
    const elements = getBodyElements(card)
    expect(elements[0].content).toContain('🖥️')
    expect(elements[0].content).toContain('执行命令')
    expect(elements[1].content).toContain('rm -rf /tmp/x')
  })

  it('truncates very long Bash commands to 160 chars', () => {
    const longCmd = 'echo ' + 'x'.repeat(500)
    const card = buildPermissionCard('Bash', { command: longCmd }, 'req')
    const targetEl = getBodyElements(card)[1]
    expect(targetEl.content).toContain('…')
    // Fenced code wraps ~10 extra chars
    expect(targetEl.content.length).toBeLessThanOrEqual(180)
  })

  it('renders Grep with 🔍 搜索内容 and pattern target', () => {
    const card = buildPermissionCard(
      'Grep',
      { pattern: 'TODO', path: '/src' },
      'req',
    )
    const elements = getBodyElements(card)
    expect(elements[0].content).toContain('🔍')
    expect(elements[1].content).toContain('TODO')
  })

  it('renders WebFetch with 🌐 访问网页 and url target', () => {
    const card = buildPermissionCard(
      'WebFetch',
      { url: 'https://example.com/api' },
      'req',
    )
    const elements = getBodyElements(card)
    expect(elements[0].content).toContain('🌐')
    expect(elements[0].content).toContain('访问网页')
    expect(elements[1].content).toContain('https://example.com/api')
  })

  it('falls back to 🔧 <toolName> for unknown tools', () => {
    const card = buildPermissionCard('CustomTool', { foo: 'bar' }, 'req')
    expect(getBodyElements(card)[0].content).toContain('🔧')
    expect(getBodyElements(card)[0].content).toContain('CustomTool')
  })

  it('has no target line when input is empty', () => {
    const card = buildPermissionCard('Bash', {}, 'req')
    const elements = getBodyElements(card)
    // elements: [header_md, hr, action_column_set]
    expect(elements[1].tag).toBe('hr')
  })

  // ----- Cross-directory detection -----

  it('does NOT show cross-dir warning when file is inside workDir', () => {
    const card = buildPermissionCard(
      'Write',
      { file_path: '/Users/me/proj/src/a.ts' },
      'req',
      '/Users/me/proj',
    )
    const elements = getBodyElements(card)
    const hasWarn = elements.some(
      (el) => typeof el.content === 'string' && el.content.includes('项目目录之外'),
    )
    expect(hasWarn).toBe(false)
    expect((card.header as any).template).toBe('orange')
    expect((card.header as any).subtitle.content).toBe('Write')
  })

  it('DOES show cross-dir warning when file is outside workDir (red template)', () => {
    const card = buildPermissionCard(
      'Write',
      { file_path: '/tmp/evil.sh' },
      'req',
      '/Users/me/proj',
    )
    const elements = getBodyElements(card)
    const warn = elements.find(
      (el) => typeof el.content === 'string' && el.content.includes('项目目录之外'),
    )
    expect(warn).toBeDefined()
    expect((card.header as any).template).toBe('red')
    expect((card.header as any).subtitle.content).toContain('跨目录')
  })

  it('does NOT check cross-dir for Bash (no filePath)', () => {
    const card = buildPermissionCard(
      'Bash',
      { command: 'rm -rf /tmp/x' },
      'req',
      '/Users/me/proj',
    )
    expect((card.header as any).template).toBe('orange')
  })

  it('does not warn when workDir is not provided', () => {
    const card = buildPermissionCard(
      'Write',
      { file_path: '/tmp/x.ts' },
      'req',
      // workDir omitted
    )
    const elements = getBodyElements(card)
    const hasWarn = elements.some(
      (el) => typeof el.content === 'string' && el.content.includes('项目目录之外'),
    )
    expect(hasWarn).toBe(false)
  })
})

describe('Feishu: isOutsideWorkDir', () => {
  it('returns false for file inside workDir', () => {
    expect(isOutsideWorkDir('/Users/me/proj/src/a.ts', '/Users/me/proj')).toBe(false)
  })

  it('returns false for file directly in workDir', () => {
    expect(isOutsideWorkDir('/Users/me/proj/a.ts', '/Users/me/proj')).toBe(false)
  })

  it('returns true for file in a sibling directory', () => {
    expect(isOutsideWorkDir('/Users/me/other/a.ts', '/Users/me/proj')).toBe(true)
  })

  it('returns true for /tmp file', () => {
    expect(isOutsideWorkDir('/tmp/evil.sh', '/Users/me/proj')).toBe(true)
  })

  it('handles workDir with trailing slash', () => {
    expect(isOutsideWorkDir('/Users/me/proj/src/a.ts', '/Users/me/proj/')).toBe(false)
  })

  it('resolves relative paths against workDir', () => {
    expect(isOutsideWorkDir('src/a.ts', '/Users/me/proj')).toBe(false)
    expect(isOutsideWorkDir('../other/a.ts', '/Users/me/proj')).toBe(true)
  })

  it('does not match prefix collisions (proj vs proj2)', () => {
    // /Users/me/proj2/a.ts starts with "/Users/me/proj" as a string
    // but is NOT inside /Users/me/proj
    expect(isOutsideWorkDir('/Users/me/proj2/a.ts', '/Users/me/proj')).toBe(true)
  })
})

describe('Feishu: project picker card', () => {
  const sampleProjects: RecentProject[] = [
    {
      projectPath: '/Users/dev/claude-code-haha',
      realPath: '/Users/dev/claude-code-haha',
      projectName: 'claude-code-haha',
      isGit: true,
      repoName: 'claude-code-haha',
      branch: 'main',
      modifiedAt: '2026-04-11T00:00:00Z',
      sessionCount: 3,
    },
    {
      projectPath: '/Users/dev/desktop',
      realPath: '/Users/dev/desktop',
      projectName: 'desktop',
      isGit: false,
      repoName: null,
      branch: null,
      modifiedAt: '2026-04-10T00:00:00Z',
      sessionCount: 1,
    },
  ]

  function getBodyElements(card: Record<string, unknown>): any[] {
    return ((card.body as any).elements ?? []) as any[]
  }

  function getRows(card: Record<string, unknown>): any[] {
    return getBodyElements(card).filter((el) => el.tag === 'column_set')
  }

  function getRowButton(row: any): any {
    const buttonCol = row.columns.find((c: any) =>
      c.elements.some((e: any) => e.tag === 'button'),
    )
    return buttonCol.elements.find((e: any) => e.tag === 'button')
  }

  function getRowInfoElements(row: any): any[] {
    const infoCol = row.columns.find((c: any) =>
      c.elements.every((e: any) => e.tag === 'markdown'),
    )
    return infoCol.elements
  }

  it('uses Schema 2.0 with body.elements wrapper', () => {
    const card = buildProjectPickerCard(sampleProjects)
    expect(card.schema).toBe('2.0')
    expect((card.config as any).update_multi).toBe(true)
    expect((card.body as any).elements).toBeDefined()
  })

  it('header has title and project-count subtitle', () => {
    const card = buildProjectPickerCard(sampleProjects)
    expect((card.header as any).title.content).toContain('选择项目')
    expect((card.header as any).subtitle.content).toContain('2')
    expect((card.header as any).subtitle.content).toContain('最近项目')
  })

  it('subtitle notes truncation when more than 10 projects exist', () => {
    const many: RecentProject[] = Array.from({ length: 15 }, (_, i) => ({
      ...sampleProjects[0]!,
      projectName: `proj-${i}`,
      realPath: `/p/${i}`,
    }))
    const card = buildProjectPickerCard(many)
    const subtitle = (card.header as any).subtitle.content
    expect(subtitle).toContain('15')
    expect(subtitle).toContain('显示前 10')
  })

  it('body contains one column_set row per project', () => {
    const card = buildProjectPickerCard(sampleProjects)
    expect(getRows(card).length).toBe(2)
  })

  it('each row has exactly 2 columns: info (weighted) + button (auto)', () => {
    const card = buildProjectPickerCard(sampleProjects)
    for (const row of getRows(card)) {
      expect(row.columns.length).toBe(2)
      expect(row.columns[0].width).toBe('weighted')
      expect(row.columns[0].vertical_align).toBe('center')
      expect(row.columns[1].width).toBe('auto')
      expect(row.columns[1].vertical_align).toBe('center')
    }
  })

  it('info column has title markdown + notation path markdown', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const row1 = getRows(card)[0]
    const info = getRowInfoElements(row1)

    expect(info.length).toBe(2)
    // Title markdown
    expect(info[0].tag).toBe('markdown')
    expect(info[0].content).toContain('**claude-code-haha**')
    expect(info[0].content).toContain('*main*')
    // Path markdown (notation = small grey)
    expect(info[1].tag).toBe('markdown')
    expect(info[1].text_size).toBe('notation')
    expect(info[1].content).toContain('claude-code-haha')
  })

  it('row without branch has no separator dot in title', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const row2 = getRows(card)[1]
    const title = getRowInfoElements(row2)[0].content
    expect(title).toContain('**desktop**')
    expect(title).not.toContain('·')
  })

  it('row button says 选择 with small size and carries per-project value', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const rows = getRows(card)

    const btn1 = getRowButton(rows[0])
    expect(btn1.text.content).toBe('选择')
    expect(btn1.size).toBe('small')
    expect(btn1.value.action).toBe('pick_project')
    expect(btn1.value.realPath).toBe('/Users/dev/claude-code-haha')
    expect(btn1.value.projectName).toBe('claude-code-haha')

    const btn2 = getRowButton(rows[1])
    expect(btn2.value.realPath).toBe('/Users/dev/desktop')
  })

  it('first row button is primary, rest are default', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const rows = getRows(card)
    expect(getRowButton(rows[0]).type).toBe('primary')
    expect(getRowButton(rows[1]).type).toBe('default')
  })

  it('body tail has hr and notation footer hint', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const elements = getBodyElements(card)
    const hrIdx = elements.findIndex((el) => el.tag === 'hr')
    expect(hrIdx).toBeGreaterThan(0)
    expect(elements[hrIdx + 1].tag).toBe('markdown')
    expect(elements[hrIdx + 1].text_size).toBe('notation')
  })

  it('caps to first 10 projects', () => {
    const many: RecentProject[] = Array.from({ length: 15 }, (_, i) => ({
      ...sampleProjects[0]!,
      projectName: `proj-${i}`,
      realPath: `/p/${i}`,
    }))
    const card = buildProjectPickerCard(many)
    const rows = getRows(card)
    expect(rows.length).toBe(10)
    expect(getRowButton(rows[9]).value.realPath).toBe('/p/9')
  })

  it('uses ~ shortcut when path is under $HOME', () => {
    const home = process.env.HOME
    if (!home) return
    const project: RecentProject = {
      ...sampleProjects[0]!,
      realPath: `${home}/some/sub/dir`,
      projectName: 'sub-dir',
    }
    const card = buildProjectPickerCard([project])
    const pathEl = getRowInfoElements(getRows(card)[0])[1]
    expect(pathEl.content).toBe('~/some/sub/dir')
  })

  it('middle-truncates very long paths with ellipsis', () => {
    const veryLong = '/x/'.repeat(40) + 'project' // ~123 chars
    const project: RecentProject = {
      ...sampleProjects[0]!,
      realPath: veryLong,
      projectName: 'project',
    }
    const card = buildProjectPickerCard([project])
    const content = getRowInfoElements(getRows(card)[0])[1].content
    expect(content).toContain('…')
    expect(content.length).toBeLessThanOrEqual(56)
    expect(content.endsWith('project')).toBe(true)
  })
})

describe('Feishu: card.action.trigger parsing', () => {
  it('parses permit action from event', () => {
    const event = {
      operator: { open_id: 'ou_user_1' },
      action: { value: { action: 'permit', requestId: 'abcde', allowed: true } },
      context: { open_chat_id: 'oc_chat_123' },
    }

    expect(event.action.value.action).toBe('permit')
    expect(event.action.value.requestId).toBe('abcde')
    expect(event.action.value.allowed).toBe(true)
    expect(event.context.open_chat_id).toBe('oc_chat_123')
  })

  it('parses pick_project action from event', () => {
    const event = {
      operator: { open_id: 'ou_user_1' },
      action: {
        value: {
          action: 'pick_project',
          realPath: '/Users/dev/claude-code-haha',
          projectName: 'claude-code-haha',
        },
      },
      context: { open_chat_id: 'oc_chat_123' },
    }

    expect(event.action.value.action).toBe('pick_project')
    expect(event.action.value.realPath).toBe('/Users/dev/claude-code-haha')
    expect(event.action.value.projectName).toBe('claude-code-haha')
  })

  it('ignores non-handled actions', () => {
    const event = {
      action: { value: { action: 'other_action' } },
    }
    expect(['permit', 'pick_project']).not.toContain(event.action.value.action)
  })
})
