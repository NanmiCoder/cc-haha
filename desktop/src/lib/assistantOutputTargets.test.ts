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

  it('ignores localhost URLs printed inside fenced log output', () => {
    const targets = extractAssistantOutputTargets(
      [
        '日志前 50 行：',
        '```log',
        '[08:29:36][INFO] 代理服务已启动: 127.0.0.1:15721',
        '[08:29:36][INFO] Claude Live 配置已接管，代理地址: http://127.0.0.1:15721',
        '```',
      ].join('\n'),
      { workDir },
    )

    expect(targets).toEqual([])
  })

  it('ignores markdown links printed inside fenced code blocks', () => {
    const targets = extractAssistantOutputTargets(
      ['```md', '调试输出: [preview](http://localhost:5173/) [page](index.html)', '```'].join('\n'),
      { workDir },
    )

    expect(targets).toEqual([])
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

describe('extractAssistantOutputTargets with changedFiles reconciliation', () => {
  it('corrects a bare mention to the real changed path in a subfolder', () => {
    // The reported bug: the model writes /private/tmp/todo-app/index.html but the
    // prose only says `index.html`, so the chip used to point at the (missing)
    // workdir-root index.html. With the turn's real changed files it is corrected.
    const targets = extractAssistantOutputTargets('已创建 `index.html`，直接用浏览器打开。', {
      workDir: '/private/tmp',
      changedFiles: [
        '/private/tmp/todo-app/index.html',
        '/private/tmp/todo-app/style.css',
        '/private/tmp/todo-app/app.js',
      ],
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      kind: 'local-html',
      href: 'todo-app/index.html',
      normalizedPath: 'todo-app/index.html',
      subtitle: 'todo-app/index.html',
    })
  })

  it('drops a mentioned file that the turn never changed', () => {
    const targets = extractAssistantOutputTargets('参考旧文件 old-report.html 和新结果 result.html', {
      workDir: '/work',
      changedFiles: ['/work/out/result.html'],
    })

    expect(targets.map((target) => target.normalizedPath)).toEqual(['out/result.html'])
  })

  it('keeps localhost url chips untouched while reconciling files', () => {
    const targets = extractAssistantOutputTargets('启动后访问 http://localhost:5173/ ，源码见 index.html', {
      workDir: '/work',
      changedFiles: ['/work/app/index.html'],
    })

    const byKind = new Map(targets.map((target) => [target.kind, target]))
    expect(byKind.get('localhost-url')?.href).toBe('http://localhost:5173/')
    expect(byKind.get('local-html')?.normalizedPath).toBe('app/index.html')
  })

  it('rewrites a changed file outside the workdir to its absolute posix path', () => {
    const targets = extractAssistantOutputTargets('已创建 todo.html', {
      workDir: 'C:/Users/me/tmp/session',
      changedFiles: ['D:\\workspace\\demo\\todo.html'],
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      kind: 'local-html',
      href: 'D:/workspace/demo/todo.html',
      normalizedPath: 'D:/workspace/demo/todo.html',
    })
  })

  it('falls back to text-only behavior when changedFiles is empty', () => {
    const targets = extractAssistantOutputTargets('已创建 `index.html`', {
      workDir: '/private/tmp',
      changedFiles: [],
    })

    // No reconciliation → original bare-path behavior (mention kept as-is).
    expect(targets).toMatchObject([{ kind: 'local-html', normalizedPath: 'index.html' }])
  })

  it('does not correct when the basename is ambiguous across changed files', () => {
    const targets = extractAssistantOutputTargets('见 index.html', {
      workDir: '/work',
      changedFiles: ['/work/a/index.html', '/work/b/index.html'],
    })

    // Ambiguous basename match → no unique target, mention dropped rather than guessed.
    expect(targets).toHaveLength(0)
  })
})
