import { describe, expect, it } from 'vitest'
import { extractAssistantOutputTargets } from './assistantOutputTargets'

const workDir = '/Users/nanmi/project/demo'

describe('extractAssistantOutputTargets', () => {
  it('extracts markdown links for workspace html, markdown, and images', () => {
    const content = [
      '已完成：',
      '- [index.html](/Users/nanmi/project/demo/index.html)',
      '- [notes](docs/result.md)',
      '- [preview](assets/hero.png)',
    ].join('\n')

    const targets = extractAssistantOutputTargets(content, { workDir })

    expect(targets.map((target) => [target.kind, target.href, target.normalizedPath])).toEqual([
      ['local-html', '/Users/nanmi/project/demo/index.html', 'index.html'],
      ['markdown', 'docs/result.md', 'docs/result.md'],
      ['image', 'assets/hero.png', 'assets/hero.png'],
    ])
  })

  it('detects a naked relative video path as a video target', () => {
    const targets = extractAssistantOutputTargets('渲染完成，见 outputs/clip.mp4 。', { workDir })

    expect(targets).toMatchObject([
      {
        kind: 'video',
        href: 'outputs/clip.mp4',
        normalizedPath: 'outputs/clip.mp4',
        source: 'plain-path',
      },
    ])
  })

  it('detects a markdown link to a video as a video target', () => {
    const targets = extractAssistantOutputTargets('[v](demo.webm)', { workDir })

    expect(targets).toMatchObject([
      {
        kind: 'video',
        href: 'demo.webm',
        normalizedPath: 'demo.webm',
        source: 'markdown-link',
      },
    ])
  })

  it('rejects a video path outside the active workspace (sandbox)', () => {
    const targets = extractAssistantOutputTargets('[bad](/etc/x.mp4)', { workDir })

    expect(targets).toEqual([])
  })

  it('normalizes markdown destinations with angle brackets, spaces, and line suffixes', () => {
    const content = [
      '[html](</Users/nanmi/project/demo/My Page/index.html>)',
      '[lined](/Users/nanmi/project/demo/index.html:12)',
    ].join('\n')

    const targets = extractAssistantOutputTargets(content, { workDir })

    expect(targets.map((target) => [target.href, target.normalizedPath])).toEqual([
      ['/Users/nanmi/project/demo/My Page/index.html', 'My Page/index.html'],
      ['/Users/nanmi/project/demo/index.html', 'index.html'],
    ])
  })

  it('accepts safe Windows workspace paths with case-insensitive segments', () => {
    const targets = extractAssistantOutputTargets(
      '[Preview](C:/users/nanmi/project/demo/out/index.html)',
      { workDir: 'C:/Users/nanmi/project/demo' },
    )

    expect(targets).toMatchObject([
      {
        kind: 'local-html',
        href: 'C:/users/nanmi/project/demo/out/index.html',
        normalizedPath: 'out/index.html',
      },
    ])
  })

  it('accepts absolute paths when the workdir is filesystem root', () => {
    const targets = extractAssistantOutputTargets(
      '[Preview](/tmp/demo/index.html)',
      { workDir: '/' },
    )

    expect(targets).toMatchObject([
      {
        kind: 'local-html',
        href: '/tmp/demo/index.html',
        normalizedPath: 'tmp/demo/index.html',
      },
    ])
  })

  it('extracts naked localhost and loopback URLs', () => {
    const targets = extractAssistantOutputTargets(
      'Open http://localhost:5173 and http://127.0.0.1:3000/app and http://[::1]:4173/app now.',
      { workDir },
    )

    expect(targets).toMatchObject([
      { kind: 'localhost-url', href: 'http://localhost:5173' },
      { kind: 'localhost-url', href: 'http://127.0.0.1:3000/app' },
      { kind: 'localhost-url', href: 'http://[::1]:4173/app' },
    ])
  })

  it('trims markdown/code punctuation around naked localhost URLs', () => {
    const targets = extractAssistantOutputTargets(
      '地址：`http://localhost:9527/`，备用：http://127.0.0.1:3000/app)。',
      { workDir },
    )

    expect(targets.map((target) => target.href)).toEqual([
      'http://localhost:9527/',
      'http://127.0.0.1:3000/app',
    ])
  })

  it('keeps markdown localhost links as markdown-link targets with authored labels', () => {
    const targets = extractAssistantOutputTargets(
      '[Preview](http://localhost:4173) then http://localhost:4173',
      { workDir },
    )

    expect(targets).toMatchObject([
      {
        kind: 'localhost-url',
        href: 'http://localhost:4173',
        title: 'Preview',
        source: 'markdown-link',
      },
    ])
    expect(targets).toHaveLength(1)
  })

  it('rejects paths outside the active workspace', () => {
    const targets = extractAssistantOutputTargets(
      '[secret](/Users/nanmi/private/secret.html) [ok](/Users/nanmi/project/demo/public/index.html)',
      { workDir },
    )

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      kind: 'local-html',
      normalizedPath: 'public/index.html',
    })
  })

  it('deduplicates repeated targets while preserving order', () => {
    const content = [
      '[index](index.html)',
      'Again: http://localhost:5173',
      '[index copy](./index.html)',
      'Again: http://localhost:5173',
    ].join('\n')

    const targets = extractAssistantOutputTargets(content, { workDir })

    expect(targets.map((target) => target.href)).toEqual(['index.html', 'http://localhost:5173'])
  })

  it('extracts files from absolute-root directory trees inside code blocks', () => {
    const targets = extractAssistantOutputTargets(
      [
        '目录结构',
        '```',
        '/Users/nanmi/project/demo/generated/',
        '├── README.md                    # Markdown 说明文件',
        '├── index.html                   # 静态页面',
        '└── todo-app/',
        '    └── index.html',
        '```',
      ].join('\n'),
      { workDir },
    )

    expect(targets.map((target) => [target.href, target.normalizedPath])).toEqual([
      ['/Users/nanmi/project/demo/generated/README.md', 'generated/README.md'],
      ['/Users/nanmi/project/demo/generated/index.html', 'generated/index.html'],
      ['/Users/nanmi/project/demo/generated/todo-app/index.html', 'generated/todo-app/index.html'],
    ])
  })

  it('ignores orphan preview file names inside code blocks', () => {
    const targets = extractAssistantOutputTargets(
      ['```', 'index.html', 'README.md', '```'].join('\n'),
      { workDir },
    )

    expect(targets).toEqual([])
  })

  it('preserves first-seen order across mixed target types', () => {
    const targets = extractAssistantOutputTargets(
      'Open http://localhost:5173 first, then [index](index.html), then docs/guide.md.',
      { workDir },
    )

    expect(targets.map((target) => target.href)).toEqual([
      'http://localhost:5173',
      'index.html',
      'docs/guide.md',
    ])
  })

  it('limits the result set to high-confidence preview targets', () => {
    const targets = extractAssistantOutputTargets(
      'Read https://example.com and maybe file:///etc/passwd, but use report.pdf only externally.',
      { workDir },
    )

    expect(targets).toEqual([])
  })

  it('caps results at 6 by default', () => {
    const targets = extractAssistantOutputTargets(
      [
        '[one](one.html)',
        '[two](two.html)',
        '[three](three.html)',
        '[four](four.html)',
        '[five](five.html)',
        '[six](six.html)',
        '[seven](seven.html)',
      ].join('\n'),
      { workDir },
    )

    expect(targets.map((target) => target.href)).toEqual([
      'one.html',
      'two.html',
      'three.html',
      'four.html',
      'five.html',
      'six.html',
    ])
  })

  it('respects an explicit limit override', () => {
    const targets = extractAssistantOutputTargets(
      '[one](one.html) [two](two.html) [three](three.html)',
      { workDir, limit: 2 },
    )

    expect(targets.map((target) => target.href)).toEqual(['one.html', 'two.html'])
  })
})
