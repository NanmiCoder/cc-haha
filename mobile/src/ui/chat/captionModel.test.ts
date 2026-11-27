import { describe, expect, test } from 'bun:test'
import type { ChatItem } from '../../core/types'
import { captionParts, currentStepLabel, pendingStepLabel } from './captionModel'

const tool = (id: string, toolName: string, input: unknown, patch: Partial<ChatItem> = {}): ChatItem => ({
  id,
  type: 'tool',
  text: '',
  toolName,
  toolUseId: id,
  input,
  ...patch,
})
const user = (id: string): ChatItem => ({ id, type: 'user', text: '做点事' })
const done = { result: 'ok', pending: false }

describe('currentStepLabel', () => {
  test('取最近一个还没有结果的工具调用', () => {
    const items = [
      user('u'),
      tool('a', 'Read', { file_path: '/repo/a.ts' }, done),
      tool('b', 'Bash', { command: 'bun test src/core/connectHost.test.ts' }, { pending: true }),
    ]
    expect(currentStepLabel(items)).toMatchObject({ verb: '运行', object: 'bun test src/core/connectHost.test.ts', mono: true })
  })
  test('历史里打开的会话没有 pending 标记，只是没有结果，也算进行中', () => {
    expect(currentStepLabel([user('u'), tool('a', 'Read', { file_path: '/repo/a.ts' })], '/repo')).toMatchObject({
      verb: '读取',
      object: 'a.ts',
    })
  })
  test('全部有结果、没有工具、或最后是用户消息：没有当前步骤', () => {
    expect(currentStepLabel([user('u'), tool('a', 'Read', {}, done)])).toBeNull()
    expect(currentStepLabel([])).toBeNull()
    expect(currentStepLabel([tool('a', 'Bash', { command: 'x' }, { pending: true }), user('u')])).toBeNull()
  })
  test('只看最近一条用户消息之后；更早一轮没收尾的工具不算', () => {
    expect(currentStepLabel([tool('old', 'Bash', { command: 'x' }), user('u2')])).toBeNull()
  })
  test('子 Agent 内部的步骤（带 parentToolUseId）不是主 Agent 当前在做的事', () => {
    const items = [
      user('u'),
      tool('agent', 'Agent', { description: '梳理', subagent_type: 'explorer' }, { pending: true }),
      tool('inner', 'Read', { file_path: '/repo/x.ts' }, { pending: true, parentToolUseId: 'agent' }),
    ]
    expect(currentStepLabel(items)).toMatchObject({ verb: '子 Agent', object: '梳理' })
  })
  test('命令说明优先于命令原文成为当前步骤', () => {
    const items = [
      user('u'),
      tool('b', 'Bash', { command: 'bun test', description: '运行单元测试' }, { pending: true }),
    ]
    expect(currentStepLabel(items)).toMatchObject({ verb: '运行单元测试', description: true })
  })
  test('工具有多个未完成时取最后一个', () => {
    const items = [
      user('u'),
      tool('a', 'Read', { file_path: '/a' }, { pending: true }),
      tool('b', 'Grep', { pattern: 'foo' }, { pending: true }),
    ]
    expect(currentStepLabel(items)?.verb).toBe('搜索')
  })
})

describe('captionParts 文案', () => {
  test('运行中：正在 + 动词，对象保留字体语义', () => {
    expect(captionParts({ step: { verb: '运行', object: 'bun test', mono: true } })).toEqual({
      tone: 'run',
      lead: '正在运行',
      object: 'bun test',
      mono: true,
    })
    expect(captionParts({ step: { verb: '搜网页', object: '天气', mono: false } })).toMatchObject({
      lead: '正在搜网页',
      object: '天气',
      mono: false,
    })
  })
  test('没有工具：正在思考；整理上下文优先于步骤', () => {
    expect(captionParts({})).toEqual({ tone: 'run', lead: '正在思考', mono: false })
    expect(captionParts({ step: null })).toMatchObject({ lead: '正在思考' })
    expect(captionParts({ compacting: true, step: { verb: '运行', mono: true } })).toEqual({
      tone: 'run',
      lead: '正在整理上下文',
      mono: false,
    })
  })
  test('命令自带说明时整句成为状态，不再套动词', () => {
    expect(captionParts({ step: { verb: '运行单元测试', mono: false, description: true } })).toEqual({
      tone: 'run',
      lead: '正在运行单元测试',
      mono: false,
    })
    expect(captionParts({ step: { verb: 'Run tests', mono: false, description: true } }).lead).toBe('Run tests')
    // 英文里的弯引号、破折号不是中文，不能拼成「正在Don’t run」。
    expect(captionParts({ step: { verb: 'Run the user’s tests', mono: false, description: true } }).lead).toBe(
      'Run the user’s tests'
    )
    // 假名、谚文也是「中文类」语序，加“正在”；纯假名说明不能退化成裸动词。
    expect(captionParts({ step: { verb: 'テストを実行', mono: false, description: true } }).lead).toBe(
      '正在テストを実行'
    )
    expect(captionParts({ step: { verb: '테스트 실행', mono: false, description: true } }).lead).toBe('正在테스트 실행')
    expect(
      captionParts({ waiting: true, step: { verb: '运行单元测试', mono: false, description: true } })
    ).toMatchObject({ tone: 'attention', lead: '等你批准 · 运行单元测试' })
  })
  test('思考块、子 Agent、未知工具的措辞不会读成病句', () => {
    expect(captionParts({ step: { verb: '思考过程', mono: false } }).lead).toBe('正在思考')
    expect(captionParts({ step: { verb: '子 Agent', object: '梳理', mono: false } }).lead).toBe('正在运行子 Agent')
    expect(captionParts({ step: { verb: 'CustomTool', object: 'x', mono: false } }).lead).toBe('正在调用 CustomTool')
  })
  test('等你批准：琥珀色，带上批准的是哪一步；没有步骤时只说等你批准', () => {
    expect(captionParts({ waiting: true, step: { verb: '运行', object: 'bun test src/core/connectHost.test.ts', mono: true } })).toEqual({
      tone: 'attention',
      lead: '等你批准 · 运行',
      object: 'bun test src/core/connectHost.test.ts',
      mono: true,
    })
    expect(captionParts({ waiting: true })).toMatchObject({ tone: 'attention', lead: '等你批准' })
    expect(captionParts({ waiting: true, step: { verb: '思考过程', mono: false } })).toMatchObject({ lead: '等你批准' })
  })
  test('等批准优先于整理上下文', () => {
    expect(captionParts({ waiting: true, compacting: true }).tone).toBe('attention')
  })
})

describe('pendingStepLabel', () => {
  test('并行调用时说的是正在等批准的那一个，不是最后一个', () => {
    const items = [
      user('u'),
      tool('edit-a', 'Edit', { file_path: '/p/src/todo.ts', old_string: 'a', new_string: 'b' }),
      tool('edit-b', 'Edit', { file_path: '/p/README.md', old_string: 'a', new_string: 'b' }),
    ]
    expect(currentStepLabel(items, '/p')?.object).toContain('README.md')
    expect(pendingStepLabel(items, 'edit-a', '/p')?.object).toContain('src/todo.ts')
  })
  test('找不到对应调用或没有 id 时返回 null', () => {
    const items = [user('u'), tool('t', 'Bash', { command: 'bun test' })]
    expect(pendingStepLabel(items, 'missing')).toBeNull()
    expect(pendingStepLabel(items, undefined)).toBeNull()
  })
})
