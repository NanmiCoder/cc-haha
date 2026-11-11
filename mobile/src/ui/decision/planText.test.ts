import { expect, test } from 'bun:test'
import {
  planBlocks,
  planExcerpt,
  planFilePath,
  planSource,
  planSpans,
} from './planText'

const fixturePlan =
  '# 用相机扫桌面二维码完成配对\n\n1. 扫码页：识别二维码里的地址和访问令牌\n   `src/app/connect.tsx`\n2. 校验地址，拒绝带路径或账号密码的地址\n   `src/core/connection.ts`\n\n3. 补测试\n\n## 会改的文件\n\n- src/app/connect.tsx\n- src/core/client.ts\n\n```sh\nbun test\n```\n普通段落第一行\n第二行'

test('plans parse into title, numbered steps with continuations, sections, lists and code', () => {
  expect(planBlocks(fixturePlan)).toEqual([
    { type: 'title', text: '用相机扫桌面二维码完成配对' },
    {
      type: 'ordered',
      items: [
        { marker: '1', lines: ['扫码页：识别二维码里的地址和访问令牌', '`src/app/connect.tsx`'] },
        { marker: '2', lines: ['校验地址，拒绝带路径或账号密码的地址', '`src/core/connection.ts`'] },
        { marker: '3', lines: ['补测试'] },
      ],
    },
    { type: 'heading', text: '会改的文件' },
    {
      type: 'bullets',
      items: [
        { marker: '•', lines: ['src/app/connect.tsx'] },
        { marker: '•', lines: ['src/core/client.ts'] },
      ],
    },
    { type: 'code', text: 'bun test' },
    { type: 'paragraph', text: '普通段落第一行\n第二行' },
  ])
})

test('nested bullets stay under their step and rules are skipped', () => {
  expect(planBlocks('1. 步骤\n   - 子项\n---\n正文')).toEqual([
    { type: 'ordered', items: [{ marker: '1', lines: ['步骤', '· 子项'] }] },
    { type: 'paragraph', text: '正文' },
  ])
})

test('inline code, bold and bare file paths become monospace spans', () => {
  expect(planSpans('补 `schedules.test.ts` 的 **交互** 测试')).toEqual([
    { text: '补 ' },
    { text: 'schedules.test.ts', code: true },
    { text: ' 的 ' },
    { text: '交互', bold: true },
    { text: ' 测试' },
  ])
  expect(planSpans('改 src/app/schedule/[id].tsx 和 README')).toEqual([
    { text: '改 ' },
    { text: 'src/app/schedule/[id].tsx', code: true },
    { text: ' 和 README' },
  ])
})

test('the compact card excerpt is the first two meaningful lines without markup', () => {
  expect(planExcerpt(fixturePlan)).toBe(
    '用相机扫桌面二维码完成配对\n1. 扫码页：识别二维码里的地址和访问令牌'
  )
  expect(planExcerpt('```\ncode\n```\n**只有一行**')).toBe('只有一行')
})

test('plan text and file path come only from real input fields', () => {
  expect(planSource({ plan: '  ', planContent: '# 计划' })).toBe('# 计划')
  expect(planSource({ plan: 3 })).toBeNull()
  expect(planFilePath({ planFilePath: '/p.md' })).toBe('/p.md')
  expect(planFilePath({ filePath: '' })).toBeUndefined()
})
