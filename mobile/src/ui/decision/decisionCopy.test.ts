import { expect, test } from 'bun:test'
import {
  appendSuggestion,
  approvalDescription,
  approvalSubject,
  approvalTitle,
  denySuggestions,
  denySummary,
  denyTitle,
  isFileChange,
  rememberLabel,
  toolKind,
  workDirCaption,
} from './decisionCopy'

test('approval titles follow the tool type and fall back to the real tool name', () => {
  expect(approvalTitle('Bash')).toBe('想运行命令')
  expect(approvalTitle('PowerShell')).toBe('想运行命令')
  for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit'])
    expect(approvalTitle(tool)).toBe('想修改文件')
  // Write may create or overwrite; the protocol does not say which.
  expect(approvalTitle('Write')).toBe('想写入文件')
  expect(approvalTitle('WebFetch')).toBe('想联网')
  expect(approvalTitle('WebSearch')).toBe('想联网')
  for (const tool of ['Read', 'Grep', 'Glob'])
    expect(approvalTitle(tool)).toBe('想读取文件')
  expect(approvalTitle('mcp__github__create_issue')).toBe(
    '想使用 mcp__github__create_issue'
  )
  expect(isFileChange('Edit')).toBe(true)
  expect(isFileChange('Write')).toBe(true)
  expect(isFileChange('Bash')).toBe(false)
  expect(toolKind('Glob')).toBe('read')
})

test('deny state titles and quick notes name the specific action', () => {
  expect(denyTitle('Bash')).toBe('不运行这条命令')
  expect(denyTitle('Edit')).toBe('不修改这个文件')
  expect(denyTitle('Write')).toBe('不写入这个文件')
  expect(denyTitle('WebSearch')).toBe('不做这次搜索')
  expect(denyTitle('Read')).toBe('不读取这个文件')
  expect(denyTitle('Custom')).toBe('不使用 Custom')
  expect(denySuggestions('Bash')).toEqual(['先说说为什么要跑', '换个更稳妥的做法'])
  expect(denySuggestions('Edit')[0]).toBe('先说说为什么要改')
})

test('remember labels never invent a command prefix the phone cannot see', () => {
  const label = rememberLabel('Bash')
  expect(label).toBe('这段会话里，同类命令不再问我')
  expect(label).not.toContain('开头')
  expect(rememberLabel('WebFetch')).toBe('这段会话里，同一网站不再问我')
  expect(rememberLabel('Edit')).toBe('这段会话里，同类修改不再问我')
  expect(rememberLabel('Write')).toBe('这段会话里，同类修改不再问我')
  expect(rememberLabel('Custom')).toBe('这段会话里不再询问 Custom')
})

test('subjects come from real tool input fields and fall back to JSON', () => {
  expect(approvalSubject('Bash', { command: 'bun test' })).toEqual({
    text: 'bun test',
    prompt: '$ ',
  })
  expect(approvalSubject('Read', { file_path: '/a/b.ts' })).toEqual({
    text: '/a/b.ts',
  })
  expect(approvalSubject('Grep', { pattern: 'TODO', path: 'src' })).toEqual({
    text: 'TODO',
  })
  expect(approvalSubject('WebFetch', { url: 'https://x.dev', prompt: 'p' })).toEqual({
    text: 'https://x.dev',
  })
  expect(approvalSubject('Custom', { a: 1 }).text).toBe('{\n  "a": 1\n}')
  expect(approvalSubject('Custom', { a: 'x'.repeat(900) }).text.length).toBe(601)
  expect(denySummary('Bash', { command: 'git status\ngit diff' })).toBe(
    '$ git status'
  )
  expect(denySummary('Edit', { file_path: 'src/a.ts' })).toBe('src/a.ts')
})

test('description prefers the protocol field and then the Bash description', () => {
  expect(approvalDescription('服务端说明', { description: 'x' })).toBe('服务端说明')
  expect(approvalDescription(undefined, { description: '跑单元测试' })).toBe(
    '跑单元测试'
  )
  expect(approvalDescription('  ', { description: 3 })).toBeUndefined()
})

test('work directory caption abbreviates only the user home and hides when unknown', () => {
  expect(workDirCaption('/Users/me/code/cc-haha')).toBe('在 ~/code/cc-haha')
  expect(workDirCaption('/home/dev')).toBe('在 ~')
  expect(workDirCaption('C:\\Users\\dev\\repo')).toBe('在 ~\\repo')
  expect(workDirCaption('/opt/Users/x')).toBe('在 /opt/Users/x')
  expect(workDirCaption('')).toBeUndefined()
  expect(workDirCaption(undefined)).toBeUndefined()
})

test('quick notes fill an empty input or append once to the end', () => {
  expect(appendSuggestion('', '换个更稳妥的做法')).toBe('换个更稳妥的做法')
  expect(appendSuggestion('先别跑', '换个更稳妥的做法')).toBe(
    '先别跑。换个更稳妥的做法'
  )
  expect(appendSuggestion('先别跑。 ', '换个更稳妥的做法')).toBe(
    '先别跑。换个更稳妥的做法'
  )
  expect(appendSuggestion('换个更稳妥的做法', '换个更稳妥的做法')).toBe(
    '换个更稳妥的做法'
  )
})
