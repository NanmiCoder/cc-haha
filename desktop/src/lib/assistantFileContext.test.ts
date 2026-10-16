import { describe, expect, it } from 'vitest'
import { resolveAssistantFileHref } from './assistantFileContext'

describe('resolveAssistantFileHref', () => {
  it('preserves parsed literal paths and reveal positions under the declared root', () => {
    expect(resolveAssistantFileHref(
      { path: 'docs/literal%20name.md', line: 7, column: 3 },
      '输出目录：`/work/QA%20root`',
    )).toEqual({ path: '/work/QA%20root/docs/literal%20name.md', line: 7, column: 3 })
  })

  it('resolves only explicit directory declarations including Windows and spaces', () => {
    expect(resolveAssistantFileHref('public/audio/track.wav', '项目根目录是 `/external/my project/`：')).toBe('/external/my project/public/audio/track.wav')
    expect(resolveAssistantFileHref('out/movie.mp4', 'Project root: `D:\\work\\demo\\`')).toBe('D:/work/demo/out/movie.mp4')
    expect(resolveAssistantFileHref('report.pdf', '参考 `/external/docs/`')).toBe('report.pdf')
  })

  it('ignores declarations inside fences and preserves absolute paths and remote URLs', () => {
    expect(resolveAssistantFileHref('report.pdf', '```txt\n项目根目录是 `/example/`\n```')).toBe('report.pdf')
    expect(resolveAssistantFileHref('/other/report.pdf', '输出目录：`/output/`')).toBe('/other/report.pdf')
    expect(resolveAssistantFileHref('https://example.com/report.pdf', '输出目录：`/output/`')).toBe('https://example.com/report.pdf')
  })

  it('declines multiple roots and applies a single declaration to the whole reply', () => {
    const content = '项目根目录是 `/one/`\nreport.pdf\n项目根目录是 `/two/`\nreport.pdf'
    expect(resolveAssistantFileHref('report.pdf', content)).toBe('report.pdf')
    expect(resolveAssistantFileHref('report.pdf', 'report.pdf\n项目根目录是 `/one/`')).toBe('/one/report.pdf')
  })
})
