import { describe, expect, test } from 'bun:test'
import { ensureParserInitialized, getParserModule, type TsNode } from './bashParser'

function parse(command: string) {
  const parser = getParserModule()
  expect(parser).not.toBeNull()
  return parser!.parse(command, Infinity)
}

function collectTypes(node: TsNode | null, types = new Set<string>()) {
  if (!node) return types
  types.add(node.type)
  for (const child of node.children) {
    collectTypes(child, types)
  }
  return types
}

describe('pure TypeScript bash parser', () => {
  test('parses command chains with assignments, redirects, and pipelines', async () => {
    await ensureParserInitialized()

    const root = parse('NODE_ENV=test npm run build > out.log 2>&1 | tee report.log')
    const types = collectTypes(root)

    expect(root?.type).toBe('program')
    expect(types.has('variable_assignment')).toBe(true)
    expect(types.has('command')).toBe(true)
    expect(types.has('pipeline')).toBe(true)
    expect(types.has('redirected_statement')).toBe(true)
    expect(root?.text).toContain('npm run build')
  })

  test('parses control flow and command substitutions', () => {
    const root = parse([
      'for file in "$@"; do',
      '  if [[ -f "$file" ]]; then',
      '    echo "$(basename "$file")"',
      '  fi',
      'done',
    ].join('\n'))
    const types = collectTypes(root)

    expect(types.has('for_statement')).toBe(true)
    expect(types.has('if_statement')).toBe(true)
    expect(types.has('command_substitution')).toBe(true)
    expect(types.has('test_command')).toBe(true)
  })

  test('preserves UTF-8 byte offsets for non-ASCII command text', () => {
    const root = parse('echo "你好" && printf "%s\\n" done')

    expect(root).not.toBeNull()
    expect(root!.endIndex).toBe(new TextEncoder().encode(root!.text).length)
    expect(root!.text).toContain('你好')
  })

  test('parses heredocs, case statements, and functions', () => {
    const root = parse([
      'deploy() {',
      '  case "$1" in',
      '    prod) cat <<EOF',
      'ready',
      'EOF',
      '    ;;',
      '  esac',
      '}',
    ].join('\n'))
    const types = collectTypes(root)

    expect(types.has('function_definition')).toBe(true)
    expect(types.has('case_statement')).toBe(true)
    expect(types.has('heredoc_redirect')).toBe(true)
    expect(types.has('heredoc_body')).toBe(true)
  })
})
