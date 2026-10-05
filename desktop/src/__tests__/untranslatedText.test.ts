// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Text a user reads has to come from the locale files. A string typed straight
 * into JSX renders the same in every locale, and nothing else notices: the
 * "1 image" header over the pictures in a reply stayed English in the Chinese UI.
 *
 * So every component is read here. JSX text, the attributes a user reads or a
 * screen reader speaks, and string literals rendered as children all have to go
 * through `t()`. Text inside <kbd>, <code>, <pre> or <style>, and icon ligatures,
 * is not prose. A literal that only stands in when the translate function is
 * missing (`t?.('key') ?? 'Fallback'`) is not what users see either.
 *
 * What is left reads the same in every language — a product or format name, an
 * example value, a key cap — and is listed below, file by file, with no entry
 * that the source no longer has.
 */

const srcRoot = path.resolve(import.meta.dirname, '..')

/** Not part of the product: the dev-only component gallery and test support. */
const SKIPPED_DIRECTORIES = new Set([path.join(srcRoot, 'dev'), path.join(srcRoot, 'test')])

/** Attributes whose value a user reads, or a screen reader speaks. */
const TEXT_ATTRIBUTE = /^(?:title|alt|placeholder|label|content|aria-(?:label|description|roledescription|valuetext|placeholder))$|(?:Label|Title|Text|Description|Hint|Message|Tooltip)$/

/** HTML attributes that take a keyword rather than text, though their names look like text. */
const KEYWORD_ATTRIBUTES = new Set(['enterKeyHint'])

/** Elements whose text is code, a key cap or a style sheet rather than prose. */
const NON_PROSE_ELEMENTS = new Set(['kbd', 'Keycap', 'code', 'pre', 'style', 'script'])

/**
 * Literals that read the same in every language, by file. Anything else goes
 * through `t()`; an entry here says why it does not have to.
 */
const LANGUAGE_NEUTRAL: Record<string, string[]> = {
  'components/agentTeams/AgentTeamsCanvas.tsx': ['zZ'], // a sleeping agent's glyph
  'components/agentTeams/AgentTeamsWorkbench.tsx': ['Agent Teams ·'], // product name, kept in every locale
  'components/chat/MermaidRenderer.tsx': ['mermaid'], // the diagram language, as a code block labels it
  'components/chat/ToolCallBlock.tsx': ['bash', 'powershell'], // shell names, as a code block labels them
  'components/layout/H5ConnectionView.tsx': ['https://chat.example.com'], // example URL
  'components/layout/Sidebar.tsx': ['cc-', 'haha', 'GitHub'], // wordmark, brand
  'components/market/FrontmatterPanel.tsx': ['true', 'false'], // YAML values, shown as written
  'components/market/InstallConfirmDialog.tsx': ['…/skills/'], // a path
  'components/market/MarketSkillDetail.tsx': ['SKILL.md'], // a file name
  'components/settings/ProviderImageGenerationFields.tsx': ['sk-...'], // key format
  'components/workbench/WorkspaceReviewTab.tsx': ['feature/base', 'HEAD~1'], // example git refs
  'components/workspace/WorkspaceDiffSurface.tsx': ['diff --git'], // the git header, read to screen readers
  'features/pets/PetSettings.tsx': ['px', 'moon-cat'], // unit, example ID
  'pages/Connectors.tsx': ['MCP', 'CLI'], // transport names
  'components/search/GlobalSearchModal.tsx': ['esc'], // the key, as printed on its keycap
  'pages/MemorySettings.tsx': ['Markdown'], // file format
  'pages/settings/AboutSettings.tsx': [ // product, repository and author; example proxy
    'Claude Code Haha', 'GitHub', 'NanmiCoder/cc-haha', '程序员阿江-Relakkes', 'http://127.0.0.1:7890',
  ],
  'pages/settings/ChatAppearanceSettings.tsx': ['px', '${}px'], // unit
  'pages/settings/GeneralSettings.tsx': ['http://127.0.0.1:7890', 'tvly-...'], // example proxy, key format
  'pages/settings/ProviderSettings.tsx': ['OpenAI Chat', 'OpenAI Responses', 'sk-...'], // API format names, key format
  'pages/settings/PublicAccessSettings.tsx': ['/remote'], // a URL path
}

/** Untranslated text that needs a wider change first. Keep this short; each entry says why. */
const KNOWN_GAPS: Record<string, string[]> = {
  // A ui primitive cannot read the locale (components/ui/contract.test.ts keeps
  // stores out of it), so this label has to come from the Modal's callers: 19 of
  // them, and the 34 behind ActionDialog and ConfirmDialog.
  'components/ui/Modal.tsx': ['Close dialog'],
}

type Finding = { file: string; line: number; text: string }

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(full) ? [] : sourceFiles(full)
    return entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name) ? [full] : []
  })
}

function tagName(element: ts.JsxElement): string {
  return element.openingElement.tagName.getText()
}

/** An icon font renders its ligature (`close`, `image`) as a glyph, not as words. */
function isIcon(element: ts.JsxElement): boolean {
  return element.openingElement.attributes.properties.some((attribute) => (
    ts.isJsxAttribute(attribute)
    && attribute.name.getText() === 'className'
    && attribute.initializer !== undefined
    && /material-symbols/.test(attribute.initializer.getText())
  ))
}

function isTranslation(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression) && expression.expression.getText() === 't'
}

/** String literals an expression renders as written: itself, or a branch of `?:`, `&&`, `||`, `??`. */
function renderedLiterals(expression: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(expression)) return renderedLiterals(expression.expression)
  if (ts.isConditionalExpression(expression)) {
    return [...renderedLiterals(expression.whenTrue), ...renderedLiterals(expression.whenFalse)]
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return renderedLiterals(expression.right)
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      // A fallback for a missing translate function is not what users see.
      return isTranslation(expression.left)
        ? []
        : [...renderedLiterals(expression.left), ...renderedLiterals(expression.right)]
    }
    return []
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text]
  if (ts.isTemplateExpression(expression)) {
    return [expression.head.text + expression.templateSpans.map((span) => '${}' + span.literal.text).join('')]
  }
  return []
}

function findUntranslatedText(file: string, code: string): Finding[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Finding[] = []
  const report = (node: ts.Node, raw: string) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!/\p{L}{2,}/u.test(text.replaceAll('${}', ' '))) return
    found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && (NON_PROSE_ELEMENTS.has(tagName(node)) || isIcon(node))) return
    if (ts.isJsxText(node)) {
      report(node, node.text)
    } else if (
      ts.isJsxAttribute(node)
      && TEXT_ATTRIBUTE.test(node.name.getText())
      && !KEYWORD_ATTRIBUTES.has(node.name.getText())
    ) {
      const value = node.initializer
      if (value && ts.isStringLiteral(value)) report(node, value.text)
      else if (value && ts.isJsxExpression(value) && value.expression) {
        for (const text of renderedLiterals(value.expression)) report(node, text)
      }
    } else if (
      ts.isJsxExpression(node)
      && node.expression
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const text of renderedLiterals(node.expression)) report(node, text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const files = sourceFiles(srcRoot)
const findings = files.flatMap((file) => findUntranslatedText(path.relative(srcRoot, file), readFileSync(file, 'utf8')))

function isExempt(finding: Finding): boolean {
  return [LANGUAGE_NEUTRAL, KNOWN_GAPS].some((exemptions) => exemptions[finding.file]?.includes(finding.text))
}

describe('user-visible text goes through the locale files', () => {
  it('flags text typed into JSX and leaves code, key caps, icons and fallbacks alone', () => {
    const fixture = [
      'export function Gallery({ count, t }) {',
      '  return (',
      '    <div title="Gallery" aria-label={`${count} pictures`}>',
      "      {count === 1 ? '1 image' : `${count} images`}",
      '      <span>Unable to load image</span>',
      '      <input enterKeyHint="search" placeholder="Search skills" />',
      '      <span className="material-symbols-outlined">image</span>',
      '      <kbd>Esc</kbd>',
      '      <code>diff --git</code>',
      "      <span>{t?.('chat.retry') ?? 'Retry'}</span>",
      "      <span title={t('chat.retry')}>{t('chat.retry')}</span>",
      '      <span>{count}</span>',
      '    </div>',
      '  )',
      '}',
    ].join('\n')

    expect(findUntranslatedText('Gallery.tsx', fixture).map((finding) => finding.text)).toEqual([
      'Gallery',
      '${} pictures',
      '1 image',
      '${} images',
      'Unable to load image',
      'Search skills',
    ])
  })

  it('reads the source tree it is guarding', () => {
    // A scan that found nothing would pass every rule below.
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((file) => file.endsWith('InlineImageGallery.tsx'))).toBe(true)
  })

  it('routes every text a user reads through t()', () => {
    const untranslated = findings
      .filter((finding) => !isExempt(finding))
      .map((finding) => `${finding.file}:${finding.line}  ${finding.text}`)

    // Put the text in all five locale files and render it with t(). Only text that
    // reads the same in every language belongs in LANGUAGE_NEUTRAL.
    expect(untranslated).toEqual([])
  })

  it('keeps no exemption for text the source no longer has', () => {
    const stale = [LANGUAGE_NEUTRAL, KNOWN_GAPS].flatMap((exemptions) => Object.entries(exemptions).flatMap(
      ([file, texts]) => texts
        .filter((text) => !findings.some((finding) => finding.file === file && finding.text === text))
        .map((text) => `${file}  ${text}`),
    ))

    expect(stale).toEqual([])
  })
})
