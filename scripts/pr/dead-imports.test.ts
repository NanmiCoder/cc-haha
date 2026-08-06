import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ALLOWED_DEAD_IMPORTS,
  DEAD_IMPORT_ROOTS,
  blankNonCode,
  blankingIsSound,
  deadImportKey,
  findDeadImports,
  parseImportClause,
  scanDeadImports,
} from './dead-imports.ts'

const ROOT = process.cwd()

function bindingsOf(source: string): string[] {
  return findDeadImports(source).map((hit) => hit.binding).sort()
}

describe('parseImportClause', () => {
  it('takes the local name, never the upstream one', () => {
    // The alias is what the file can reference; flagging `original` would report a
    // binding that does not exist and miss the one that does.
    expect(parseImportClause('{ original as local }')).toEqual(['local'])
    expect(parseImportClause('Default, { a, b as c }')).toEqual(['Default', 'a', 'c'])
    expect(parseImportClause('* as namespace')).toEqual(['namespace'])
    expect(parseImportClause('Default, * as namespace')).toEqual(['Default', 'namespace'])
  })

  it('strips the type keyword in both positions', () => {
    expect(parseImportClause('type { Config }')).toEqual(['Config'])
    expect(parseImportClause('{ value, type Config }')).toEqual(['value', 'Config'])
  })
})

describe('findDeadImports', () => {
  it('reports an import with no reference and spares one with a reference', () => {
    const source = [
      "import { used, unused } from './x.js'",
      '',
      'export const value = used()',
      '',
    ].join('\n')

    expect(bindingsOf(source)).toEqual(['unused'])
  })

  it('reports the line of the statement that declared the binding', () => {
    const source = [
      "import { a } from './a.js'",
      "import { b } from './b.js'",
      'export const value = a()',
      '',
    ].join('\n')

    expect(findDeadImports(source)).toEqual([{ binding: 'b', line: 2 }])
  })

  it('does not let one import keep another alive', () => {
    // `helper` appears twice in the file, but only ever inside import statements.
    const source = [
      "import { helper } from './one.js'",
      "import { helper as alias } from './two.js'",
      'export const value = alias()',
      '',
    ].join('\n')

    expect(bindingsOf(source)).toEqual(['helper'])
  })

  it('ignores side-effect imports, which declare nothing to be unused', () => {
    expect(findDeadImports("import './register.js'\n")).toEqual([])
  })

  it('counts a re-export as a reference', () => {
    const source = ["import { a } from './a.js'", 'export { a }', ''].join('\n')
    expect(findDeadImports(source)).toEqual([])
  })

  it('reads a multi-line clause', () => {
    const source = [
      'import {',
      '  used,',
      '  unused,',
      "} from './x.js'",
      'export const value = used',
      '',
    ].join('\n')

    expect(bindingsOf(source)).toEqual(['unused'])
  })

  it('requires a whole-identifier match', () => {
    // `usedLater` and `prefix_used` must not keep `used` alive; substring matching
    // would make the check pass on anything with a common enough name.
    const source = [
      "import { used } from './x.js'",
      'export const value = usedLater + prefix_used',
      '',
    ].join('\n')

    expect(bindingsOf(source)).toEqual(['used'])
  })

  it('treats a mention in a comment as dead, which is the whole point over grep', () => {
    // This is exactly how the nine imports left by the handler.ts split read: the
    // symbol moved out and a comment kept saying its name.
    // No backticks in the comment: they would make the template branch blank it and
    // the test would pass without comment handling ever running.
    const source = [
      "import { moved } from './old.js'",
      '// moved now lives in streamBlocks.ts',
      'export const value = 1',
      '',
    ].join('\n')

    expect(bindingsOf(source)).toEqual(['moved'])
  })

  it('treats a mention in a block comment as dead', () => {
    const source = [
      "import { moved } from './old.js'",
      '/* moved now lives in streamBlocks.ts */',
      'export const value = 1',
      '',
    ].join('\n')

    expect(bindingsOf(source)).toEqual(['moved'])
  })

  it('treats a mention in a string as dead', () => {
    const source = [
      "import { label } from './x.js'",
      "export const value = 'label'",
      '',
    ].join('\n')

    expect(bindingsOf(source)).toEqual(['label'])
  })

  it('counts a reference inside a template substitution', () => {
    // A substitution is code wearing a string's clothes. Blanking it would report
    // `format` as dead and send someone to delete a live import.
    const source = [
      "import { format } from './x.js'",
      'export const value = `row: ${format(1)}`',
      '',
    ].join('\n')

    expect(findDeadImports(source)).toEqual([])
  })

  it('counts a reference inside a nested template substitution', () => {
    const source = [
      "import { format } from './x.js'",
      'export const value = `a ${`b ${format(1)}`} c`',
      '',
    ].join('\n')

    expect(findDeadImports(source)).toEqual([])
  })

  it('does not read a URL in a string as a comment', () => {
    // `'https://…'` contains `//`. Treating it as a comment blanks the rest of the
    // line, and everything referenced there looks dead.
    const source = [
      "import { send } from './x.js'",
      "export const value = send('https://example.com/a')",
      '',
    ].join('\n')

    expect(findDeadImports(source)).toEqual([])
  })

  it('does not read a quote inside a regular expression as a string', () => {
    // src/utils/terminalShellEnvironment.ts does this. Mis-lexing it blanked 130
    // lines and reported six live imports as dead.
    const source = [
      "import { quote } from './x.js'",
      'const escape = (value: string) => `\'${value.replace(/\'/g, "x")}\'`',
      'export const value = quote(escape)',
      '',
    ].join('\n')

    expect(findDeadImports(source)).toEqual([])
  })

  it('does not read a slash inside a regular expression character class as the end', () => {
    const source = [
      "import { split } from './x.js'",
      'const pattern = /[^/]+/g',
      'export const value = split(pattern)',
      '',
    ].join('\n')

    expect(findDeadImports(source)).toEqual([])
  })

  // Each of the three below places the import's only reference *after* the tricky
  // construct on the same line. A desync blanks to the end of that line, so the
  // import goes dead — put the reference on a later line and the assertion holds
  // even while the lexer is broken.

  it('does not let a comment decide how the next line lexes', () => {
    // A comment is whitespace to the grammar. Reading the last word out of the raw
    // source made `tone` the token before the slash, so the regex lexed as a
    // division and its apostrophe opened a string that ate the rest of the line —
    // src/hooks/useIssueFlagBanner.ts, verbatim.
    // The comment has to sit between the last code token and the slash, which is
    // where the array of patterns in that file puts it.
    const source = [
      "import { match } from './x.js'",
      'export const value =',
      '  // comma or exclamation implies correction tone',
      "  /\\bthat'?s (wrong|incorrect)\\b/i.test(match)",
      '',
    ].join('\n')

    expect(blankingIsSound(source)).toBe(true)
    expect(findDeadImports(source)).toEqual([])
  })

  it('does not run two keywords together into one token', () => {
    // `return false` accumulated as `returnfalse`, so the next `return /re/` no
    // longer looked like a keyword and its character class swallowed the line.
    const source = [
      "import { probe } from './x.js'",
      'export function guard(value: string): boolean {',
      '  if (!value) return false',
      "  return /[\\w$)\\]'\"`]/.test(probe(value))",
      '}',
      '',
    ].join('\n')

    expect(blankingIsSound(source)).toBe(true)
    expect(findDeadImports(source)).toEqual([])
  })

  it('tells a non-null assertion apart from a negated regex test', () => {
    // `estimates[i]! / total` divides; `!/re/.test(x)` negates. Both put `!`
    // immediately before the slash.
    const source = [
      "import { share, guard } from './x.js'",
      'export const ratio = (parts: number[], total: number) => parts[0]! / share(total)',
      'export const clean = (value: string) => !/[<>]/.test(guard(value))',
      '',
    ].join('\n')

    expect(blankingIsSound(source)).toBe(true)
    expect(findDeadImports(source)).toEqual([])
  })

  it('does not mistake division for a regular expression', () => {
    // `(a) / 2 ... /` would swallow the code between two divisions.
    const source = [
      "import { half, third } from './x.js'",
      'export const value = (half(4)) / 2 + (third(9)) / 3',
      '',
    ].join('\n')

    expect(findDeadImports(source)).toEqual([])
  })
})

describe('blankNonCode', () => {
  it('keeps line numbers stable so a report points at the right line', () => {
    const source = ['/* a', '   b */', 'const x = 1', ''].join('\n')
    expect(blankNonCode(source).split('\n').length).toBe(source.split('\n').length)
  })

  it('reports a desync instead of hiding it', () => {
    // Nothing in the repository is expected to hit this, but the analyser must not
    // claim soundness for a file it could not parse.
    expect(blankingIsSound("import { a } from './a.js'\nexport const b = a\n")).toBe(true)
    expect(blankingIsSound('const = = =\n')).toBe(false)
  })
})

describe('dead imports in owned source', () => {
  const { dead, scannedFiles, degradedFiles } = scanDeadImports(ROOT)

  it('scans the directories it claims to own', () => {
    // An empty or mis-rooted scan passes every other assertion in this file.
    expect(DEAD_IMPORT_ROOTS).toEqual(['src', 'scripts', 'adapters'])
    expect(scannedFiles).toContain('src/server/ws/handler.ts')
    expect(scannedFiles).toContain('scripts/pr/dead-imports.ts')
    expect(scannedFiles).toContain('adapters/feishu/index.ts')
    expect(scannedFiles.length).toBeGreaterThan(1_000)
    // desktop/ is out of scope on purpose — its tsconfig already sets
    // noUnusedLocals — so a root list that swept it in would be a mistake.
    expect(scannedFiles.some((file) => file.startsWith('desktop/'))).toBe(false)
  })

  it('analysed every file it scanned', () => {
    expect(
      degradedFiles,
      'blanking desynced on these files, so they were not analysed. Fix blankNonCode '
        + 'for the construct they use — do not narrow DEAD_IMPORT_ROOTS around them.',
    ).toEqual([])
  })

  it('catches a planted dead import in every file it owns', () => {
    // Fixtures prove the analyser works on code shaped like a fixture. This proves
    // it works on these files, whose import style it has to actually match — the
    // failure that would otherwise leave the check green and blind.
    for (const file of scannedFiles) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      const planted = `import { plantedDeadImport } from './__nonexistent.js'\n${source}`
      expect(
        findDeadImports(planted).map((hit) => hit.binding),
        `planted a dead import into ${file} and the check did not report it`,
      ).toContain('plantedDeadImport')
    }
  })

  it('has no import that nothing references', () => {
    const reported = dead
      .map(deadImportKey)
      .filter((key) => !(key in ALLOWED_DEAD_IMPORTS))
      .sort()

    expect(
      reported,
      'nothing in these files references these imports. Delete them; if a sibling '
        + 'needs the symbol, that sibling should import it.',
    ).toEqual([])
  })

  it('has no stale allowlist entries', () => {
    const live = new Set(dead.map(deadImportKey))
    const stale = Object.keys(ALLOWED_DEAD_IMPORTS).filter((key) => !live.has(key))
    expect(stale, 'these are no longer dead; drop them from ALLOWED_DEAD_IMPORTS').toEqual([])
  })
})
