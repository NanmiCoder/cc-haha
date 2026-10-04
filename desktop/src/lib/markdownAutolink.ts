import type { MarkedExtension, Tokens } from 'marked'
import { isBareUrlOnly, matchBareUrl } from './urlBoundary'
import { parseFilePathRef, splitTextByFilePaths, type FilePathRef } from './filePathBoundary'

/**
 * Replace marked's built-in GFM `url` tokenizer with a CJK-aware one.
 *
 * Only the boundary logic changes — returning `false` hands the input back to
 * the built-in tokenizer, which still covers schemeless `www.` links and bare
 * email addresses. See `urlBoundary.ts` for why the built-in boundaries are
 * wrong in Chinese prose.
 */
export const cjkAwareAutolink: MarkedExtension = {
  tokenizer: {
    url(src: string): Tokens.Link | false {
      const url = matchBareUrl(src)
      if (!url) return false

      return {
        type: 'link',
        raw: url,
        href: url,
        title: null,
        text: url,
        tokens: [{ type: 'text', raw: url, text: url }],
      }
    },
  },
}

/** Class marking an anchor that wraps an inline-code chip rather than prose. */
export const CODE_LINK_CLASS = 'md-code-link'

/** Class marking an anchor that points at a workspace file rather than a URL. */
export const FILE_LINK_CLASS = 'md-file-link'

/**
 * File links carry their target in `data-*`, never in `href`.
 *
 * Two of the shapes we have to support are rejected by the sanitizer's
 * `ALLOWED_URI_REGEXP`, which treats a leading `word:` as an unknown scheme:
 * `foo.ts:42` and `C:\src\app.ts` both lose their href entirely. Rather than
 * widen the URI allow-list — the thing standing between us and `javascript:` —
 * the path travels as data and the anchor gets `role`/`tabindex` for the
 * affordances an href would have provided.
 */
export function fileLinkAttributes(ref: FilePathRef): string {
  const attrs = [
    'role="link"',
    'tabindex="0"',
    `data-file-path="${escapeHtml(ref.path)}"`,
  ]
  if (ref.line) attrs.push(`data-file-line="${ref.line}"`)
  if (ref.column) attrs.push(`data-file-column="${ref.column}"`)
  return attrs.join(' ')
}

/**
 * Undo the file links `renderCodespan` produced, leaving the `<code>` behind.
 *
 * `renderCodespan` is installed on marked's shared renderer, so it cannot see
 * whether the surface being rendered has a click handler. Callers with no handler
 * — release notes, agent prompts, thinking blocks, the markdown file preview —
 * would otherwise show an inline-code reference styled as a link that does
 * nothing when clicked. Stripping is cheap and keeps one rule true everywhere:
 * if it cannot be opened, it does not look like a link.
 */
export function unwrapFileLinks(container: HTMLElement): void {
  container.querySelectorAll<HTMLAnchorElement>(`a.${FILE_LINK_CLASS}`).forEach((anchor) => {
    anchor.replaceWith(...anchor.childNodes)
  })
}

/**
 * Marks a file link the author wrote as a Markdown link (`[app.ts](src/app.ts)`).
 * Every other file link is a guess — a code span or a stretch of prose that looks
 * like a path — and a guess is only worth a link once the file is known to exist.
 */
export const AUTHORED_FILE_LINK_ATTRIBUTE = 'data-file-authored'

/** Answers which guessed file links point at nothing. */
export type FileLinkVerifier = {
  /** Paths known missing, when every path is already known; otherwise undefined. */
  peekMissing(paths: string[]): ReadonlySet<string> | undefined
  /** Paths known missing. A path that could not be checked is not missing. */
  findMissing(paths: string[]): Promise<ReadonlySet<string>>
}

const GUESSED_FILE_LINK_SELECTOR = `a.${FILE_LINK_CLASS}:not([${AUTHORED_FILE_LINK_ATTRIBUTE}])`

export function guessedFileLinkPaths(container: ParentNode): string[] {
  return [...container.querySelectorAll<HTMLAnchorElement>(GUESSED_FILE_LINK_SELECTOR)]
    .map((anchor) => anchor.dataset.filePath ?? '')
    .filter(Boolean)
}

/** Undo the guessed file links `keep` turns down, leaving their code or text behind. */
export function unwrapGuessedFileLinks(container: ParentNode, keep: (path: string) => boolean): void {
  container.querySelectorAll<HTMLAnchorElement>(GUESSED_FILE_LINK_SELECTOR).forEach((anchor) => {
    if (!keep(anchor.dataset.filePath ?? '')) anchor.replaceWith(...anchor.childNodes)
  })
}

/**
 * Rebuild the `path:line` reference an anchor stands for.
 *
 * Since the target travels in `data-*`, this is how it gets back to a string —
 * and re-serializing to the reference syntax keeps `classifyPreviewLink` the
 * single parser for both these anchors and hand-written markdown destinations.
 */
export function fileRefFromElement(element: HTMLElement | null | undefined): string | null {
  const path = element?.dataset.filePath
  if (!path) return null
  const line = element?.dataset.fileLine
  const column = element?.dataset.fileColumn
  if (!line) return path
  return column ? `${path}:${line}:${column}` : `${path}:${line}`
}

/**
 * Turn bare file references in already-rendered markup into anchors.
 *
 * Runs on the DOM after sanitizing rather than as a marked tokenizer, so that it
 * can be skipped while a reply streams — see {@link splitTextByFilePaths} for why
 * a half-typed path must not become a link. Working on the DOM also means URLs
 * are already anchors by now, so the `github.com/a/b.ts` inside an href is
 * structurally out of reach.
 */
export function linkifyFilePaths(container: HTMLElement): void {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // `a` — already a link. `pre` — a code block, which has its own viewer.
      // `code` — an inline chip, handled by renderCodespan so that a whole-span
      // path links while `bun test a.ts` stays a command.
      return parent.closest('a, pre, code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })

  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    textNodes.push(node as Text)
  }

  for (const textNode of textNodes) {
    const segments = splitTextByFilePaths(textNode.data)
    if (segments.every((segment) => segment.type === 'text')) continue

    const fragment = container.ownerDocument.createDocumentFragment()
    for (const segment of segments) {
      if (segment.type === 'text') {
        fragment.append(container.ownerDocument.createTextNode(segment.value))
        continue
      }

      const anchor = container.ownerDocument.createElement('a')
      anchor.textContent = segment.value

      if (segment.type === 'github') {
        // A real URL, so this one gets a real href and opens externally like any
        // other remote link.
        anchor.href = segment.ref.url
        anchor.target = '_blank'
        anchor.rel = 'noreferrer noopener'
        fragment.append(anchor)
        continue
      }

      anchor.className = FILE_LINK_CLASS
      anchor.setAttribute('role', 'link')
      anchor.tabIndex = 0
      anchor.dataset.filePath = segment.ref.path
      if (segment.ref.line) anchor.dataset.fileLine = String(segment.ref.line)
      if (segment.ref.column) anchor.dataset.fileColumn = String(segment.ref.column)
      fragment.append(anchor)
    }
    textNode.replaceWith(fragment)
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render inline code, linking it when the whole span is nothing but a bare URL
 * or a file reference.
 *
 * `codespan` runs before `url` in marked's inline loop, so a very common
 * assistant phrasing — "访问 `http://localhost:3000`" — produced a `<code>` that
 * could not be clicked at all. Wrapping the chip in an anchor keeps the code
 * styling while routing the click through the normal preview-link handler.
 *
 * The same is true of `` `desktop/src/lib/foo.ts:42` ``, which is the shape our
 * system prompt asks for and therefore the most common file reference of all.
 * Unlike bare paths in prose this needs no streaming guard: an unclosed backtick
 * is not a codespan, so marked leaves it as text until the span is complete.
 *
 * Deliberately whole-span only: `` `curl http://localhost:3000` `` and
 * `` `bun test src/a.test.ts` `` are commands, not links, and stay plain code.
 */
export function renderCodespan({ text }: Tokens.Codespan): string {
  const code = `<code>${escapeHtml(text)}</code>`
  if (isBareUrlOnly(text)) {
    return `<a href="${escapeHtml(text.trim())}" class="${CODE_LINK_CLASS}">${code}</a>`
  }

  const ref = parseFilePathRef(text)
  if (ref) {
    return `<a class="${CODE_LINK_CLASS} ${FILE_LINK_CLASS}" ${fileLinkAttributes(ref)}>${code}</a>`
  }

  return code
}
