import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { CODE_LINK_CLASS, FILE_LINK_CLASS } from '@/lib/markdownAutolink'
import type { PreviewLinkTarget } from '@/lib/previewLinkRouter'

// Most surfaces get a handler; the cases that deliberately have none say so.
const noop = () => true

function renderMarkdown(
  content: string,
  props: { streaming?: boolean; onLinkClick?: ((href: PreviewLinkTarget) => boolean) | null } = {},
) {
  const handler = props.onLinkClick === null ? undefined : props.onLinkClick ?? noop
  const { container } = render(
    <MarkdownRenderer
      content={content}
      cache={false}
      streaming={props.streaming}
      onLinkClick={handler ? (href) => handler(href) : undefined}
    />,
  )
  return container
}

function fileLinks(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLAnchorElement>(`a.${FILE_LINK_CLASS}`)]
}

describe('MarkdownRenderer file references', () => {
  it('links the shape our system prompt asks the model to produce', () => {
    const links = fileLinks(renderMarkdown('已修复 desktop/src/lib/foo.ts:42 的越界。'))
    expect(links).toHaveLength(1)
    expect(links[0]!.textContent).toBe('desktop/src/lib/foo.ts:42')
    expect(links[0]!.dataset.filePath).toBe('desktop/src/lib/foo.ts')
    expect(links[0]!.dataset.fileLine).toBe('42')
  })

  it('survives sanitizing for the two shapes whose href would be stripped', () => {
    // DOMPurify's ALLOWED_URI_REGEXP rejects `foo.ts:42` and `C:\src\app.ts` as
    // unknown schemes. The data attributes are why these still work.
    for (const { markdown, path } of [
      { markdown: '见 `app.ts:42`', path: 'app.ts' },
      { markdown: '见 `C:\\src\\app.ts:7`', path: 'C:\\src\\app.ts' },
    ]) {
      const links = fileLinks(renderMarkdown(markdown))
      expect(links, markdown).toHaveLength(1)
      expect(links[0]!.dataset.filePath).toBe(path)
    }
  })

  it('links a whole-span inline code reference but not a command containing one', () => {
    const linked = renderMarkdown('改 `desktop/src/lib/foo.ts:42`')
    expect(fileLinks(linked)).toHaveLength(1)
    expect(linked.querySelector(`a.${CODE_LINK_CLASS} code`)).not.toBeNull()

    const command = renderMarkdown('跑 `bun test src/a.test.ts`')
    expect(fileLinks(command)).toHaveLength(0)
    expect(command.querySelector('code')?.textContent).toBe('bun test src/a.test.ts')
  })

  it('leaves bare paths alone while the reply is still streaming', () => {
    // A half-typed path is a valid shorter path, so linking mid-stream makes one
    // line flicker through several targets.
    expect(fileLinks(renderMarkdown('已修复 desktop/src/lib/foo.ts:42', { streaming: true }))).toHaveLength(0)
    expect(fileLinks(renderMarkdown('已修复 desktop/src/lib/foo.ts:42', { streaming: false }))).toHaveLength(1)
  })

  it('links the references once the same message finishes streaming', () => {
    // The real sequence: nothing is linked while the model is still typing, and
    // the finished summary — the part that names the files it touched — is where
    // the links appear.
    const content = '完成了，改动在 desktop/src/lib/foo.ts:42 和 `src/app.ts:7`'
    const view = render(<MarkdownRenderer content={content} cache={false} streaming onLinkClick={noop} />)
    expect(fileLinks(view.container)).toHaveLength(1) // the inline-code one only

    view.rerender(<MarkdownRenderer content={content} cache={false} streaming={false} onLinkClick={noop} />)
    expect(fileLinks(view.container)).toHaveLength(2)
  })

  it('still links a completed inline-code reference while streaming', () => {
    // An unclosed backtick is not a codespan, so by the time this renders the
    // reference is already whole — no flicker to guard against.
    expect(fileLinks(renderMarkdown('改 `src/foo.ts:42`', { streaming: true }))).toHaveLength(1)
  })

  it('links nothing on a surface that cannot handle a click', () => {
    // 11 of this component's 13 callers pass no handler: release notes, agent
    // prompts, thinking blocks, plan previews, the markdown file preview…
    // A link there would look live and do nothing.
    const bare = renderMarkdown('见 desktop/src/lib/foo.ts:42', { onLinkClick: null })
    expect(fileLinks(bare)).toHaveLength(0)

    // Including the inline-code form, whose anchor renderCodespan already emitted.
    const inlineCode = renderMarkdown('见 `desktop/src/lib/foo.ts:42`', { onLinkClick: null })
    expect(fileLinks(inlineCode)).toHaveLength(0)
    // …but the code chip itself must survive the unwrapping.
    expect(inlineCode.querySelector('code')?.textContent).toBe('desktop/src/lib/foo.ts:42')
  })

  it('never re-links a path that is already inside a URL', () => {
    const container = renderMarkdown('见 https://github.com/NanmiCoder/cc-haha/blob/main/src/app.ts')
    expect(fileLinks(container)).toHaveLength(0)
    expect(container.querySelector('a[href^="https://"]')).not.toBeNull()
  })

  it('does not touch code blocks', () => {
    const container = renderMarkdown('```ts\nimport x from "./src/app.ts"\n```')
    expect(fileLinks(container)).toHaveLength(0)
  })

  it('leaves prose that only looks like a path as text', () => {
    expect(fileLinks(renderMarkdown('用 console.log 打印，版本 v0.5.0，域名 cchaha.ai'))).toHaveLength(0)
  })

  it('hands the click a reference classifyPreviewLink can parse', () => {
    const onLinkClick = vi.fn().mockReturnValue(true)
    const container = renderMarkdown('见 src/app.ts:42:8', { onLinkClick })
    fileLinks(container)[0]!.click()
    expect(onLinkClick).toHaveBeenCalledWith({ path: 'src/app.ts', line: 42, column: 8 })
  })

  it.each([
    ['file:///tmp/cc-haha-qa-checklist-v0.6.6.html', { path: '/tmp/cc-haha-qa-checklist-v0.6.6.html' }],
    ['file:///tmp/%E6%B8%85%E5%8D%95.html', { path: '/tmp/清单.html' }],
    ['/tmp/app.ts:42', { path: '/tmp/app.ts', line: 42 }],
    // #1556: CommonMark's two spellings of a space reach the opener as the file on disk.
    ['docs/My%20Notes.md', { path: 'docs/My Notes.md' }],
    ['<D:/cchaha/cchaha d/记忆.md>', { path: 'D:/cchaha/cchaha d/记忆.md' }],
  ])('preserves explicit local Markdown destination %s through sanitization', (href, expected) => {
    const onLinkClick = vi.fn().mockReturnValue(true)
    const container = renderMarkdown(`[打开文件](${href})`, { onLinkClick })
    container.querySelector<HTMLAnchorElement>('a')!.click()
    expect(onLinkClick).toHaveBeenCalledWith(expected)
  })

  it('does not show explicit local file links as actionable without a handler', () => {
    const container = renderMarkdown('[打开文件](file:///tmp/report.html)', { onLinkClick: null })
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent?.trim()).toBe('打开文件')
  })

  it('keeps unsafe schemes out of the file click route', () => {
    const onLinkClick = vi.fn().mockReturnValue(true)
    const container = renderMarkdown('[unsafe](javascript:alert%281%29)', { onLinkClick })
    const link = container.querySelector<HTMLAnchorElement>('a')!
    expect(link.hasAttribute('href')).toBe(false)
    expect(link.hasAttribute('data-file-path')).toBe(false)
    link.click()
    expect(onLinkClick).not.toHaveBeenCalled()
  })

  it('links owner/repo#123 to GitHub', () => {
    // The second half of the prompt contract (prompts.ts:438), which also had no
    // implementation. Unlike a file link this is a real URL, so it keeps its href.
    const container = renderMarkdown('见 NanmiCoder/cc-haha#1146')
    const link = container.querySelector<HTMLAnchorElement>('a[href^="https://github.com"]')
    expect(link?.getAttribute('href')).toBe('https://github.com/NanmiCoder/cc-haha/issues/1146')
    expect(link?.textContent).toBe('NanmiCoder/cc-haha#1146')
    expect(fileLinks(container)).toHaveLength(0)
  })

  it('keeps a markdown link with a line suffix clickable', () => {
    const onLinkClick = vi.fn().mockReturnValue(true)
    const container = renderMarkdown('见 [构建步骤](.github/workflows/release-desktop.yml:386)', { onLinkClick })
    container.querySelector<HTMLAnchorElement>('a')!.click()
    expect(onLinkClick).toHaveBeenCalledWith({ path: '.github/workflows/release-desktop.yml', line: 386 })
  })
})
