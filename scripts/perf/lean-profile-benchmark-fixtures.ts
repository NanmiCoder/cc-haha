export type BenchmarkFixture = {
  id: string
  title: string
  kind?: 'web'
  prompt: string
  files: Record<string, string>
  acceptance: string
}

const packageFile = JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test/*.test.mjs' } }, null, 2) + '\n'
const instructions = 'Work only in this project. Do not install packages or access the network. Preserve existing public tests; add regression tests in a new file. Use node:test and built-in Node modules. Run the tests before finishing.\n'
const imports = "import assert from 'node:assert/strict'\nimport { pathToFileURL } from 'node:url'\nimport { join } from 'node:path'\nconst root = process.argv[2]\nconst load = p => import(pathToFileURL(join(root, p)).href)\n"

export const BENCHMARK_FIXTURES: BenchmarkFixture[] = [
  {
    id: 'invoice',
    title: 'Fix invoice totals and zero-value options',
    prompt: 'Fix calculateInvoice in this small order project. quantity=0 must be kept, and an explicit discountRate=0 must not fall back to the account default discount. Round each line amount and discount to the cent before summing, and the returned amount must keep correct numeric precision. Prices must be finite non-negative numbers, quantities non-negative integers, and discounts finite numbers from 0 to 1; throw RangeError on invalid input. Keep the API and existing tests, add regression tests and run npm test. Do not install dependencies or access the network.',
    files: {
      'package.json': packageFile,
      'CLAUDE.md': instructions,
      'README.md': '# Invoice totals\n`calculateInvoice(items, options)` returns `{ subtotal, discount, total }`. Items use numeric `unitPrice` and `quantity`. Options use `discountRate` and `accountDefaultRate`; omitted rates default to zero. All prices are major currency units.\n',
      'src/invoice.mjs': `export function calculateInvoice(items, options = {}) {
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * (item.quantity || 1), 0)
  const rate = options.discountRate || options.accountDefaultRate || 0
  const discount = subtotal * rate
  return { subtotal, discount, total: subtotal - discount }
}
`,
      'test/invoice.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateInvoice } from ${JSON.stringify('../src/invoice.mjs')}
test('explicit zero rate and zero quantity survive defaults', () => {
  assert.deepEqual(calculateInvoice([{ unitPrice: 12, quantity: 0 }, { unitPrice: 9, quantity: 2 }], { discountRate: 0, accountDefaultRate: 0.1 }), { subtotal: 18, discount: 0, total: 18 })
})
test('decimal arithmetic returns exact cents', () => {
  assert.deepEqual(calculateInvoice([{ unitPrice: 0.1, quantity: 3 }], { discountRate: 0.1 }), { subtotal: 0.3, discount: 0.03, total: 0.27 })
})
`,
    },
    acceptance: imports + `const { calculateInvoice: invoice } = await load('src/invoice.mjs')
assert.deepEqual(invoice([]), { subtotal: 0, discount: 0, total: 0 })
assert.deepEqual(invoice([{ unitPrice: 12, quantity: 0 }, { unitPrice: 9, quantity: 2 }], { discountRate: 0, accountDefaultRate: 0.2 }), { subtotal: 18, discount: 0, total: 18 })
assert.deepEqual(invoice([{ unitPrice: 0.105, quantity: 1 }, { unitPrice: 0.105, quantity: 1 }]), { subtotal: 0.22, discount: 0, total: 0.22 })
assert.deepEqual(invoice([{ unitPrice: 10.05, quantity: 3 }], { accountDefaultRate: 0.1 }), { subtotal: 30.15, discount: 3.02, total: 27.13 })
assert.deepEqual(invoice([{ unitPrice: 2.5, quantity: 2 }], { discountRate: 1 }), { subtotal: 5, discount: 5, total: 0 })
for (const item of [{unitPrice:-1,quantity:1},{unitPrice:Infinity,quantity:1},{unitPrice:1,quantity:-1},{unitPrice:1,quantity:0.5},{unitPrice:1,quantity:NaN}]) assert.throws(() => invoice([item]), RangeError)
for (const discountRate of [-0.1, 1.1, NaN, Infinity]) assert.throws(() => invoice([{unitPrice:1,quantity:1}], {discountRate}), RangeError)
console.log('ACCEPTED invoice: zero values, cents, defaults, full discount, validation')
`,
  },
  {
    id: 'notes-export',
    title: 'Implement note filtering and export across files',
    prompt: 'Add two options to the existing note exporter: --tag <name> filters by exact tag (tag matching is case-insensitive), and --format json|markdown (default markdown). The selector selectNotes(notes, {tag}={}) must not mutate its input and sorts by numeric id ascending; JSON output is the array of selected notes, Markdown keeps the existing format with exactly one trailing newline, and an empty set outputs an empty string. The CLI must read the given JSON file; unknown options, missing values or unsupported formats exit non-zero with a clear error on stderr. Keep the existing API and tests, add regression tests and run npm test. Do not install dependencies or access the network.',
    files: {
      'package.json': packageFile,
      'CLAUDE.md': instructions,
      'README.md': '# Notes export\nRun `node src/cli.mjs notes.json`. Note shape: `{ id: number, title: string, body: string, tags: string[] }`. Markdown is `## <title>\\n\\n<body>` per note, separated by two newlines.\n',
      'src/notes.mjs': `export function selectNotes(notes) {
  return [...notes].sort((a, b) => a.id - b.id)
}
export function renderMarkdown(notes) {
  return notes.map(note => '## ' + note.title + '\\n\\n' + note.body).join('\\n\\n') + (notes.length ? '\\n' : '')
}
`,
      'src/cli.mjs': `import { readFile } from 'node:fs/promises'
import { selectNotes, renderMarkdown } from ${JSON.stringify('./notes.mjs')}
const notes = JSON.parse(await readFile(process.argv[2], 'utf8'))
process.stdout.write(renderMarkdown(selectNotes(notes)))
`,
      'notes.json': JSON.stringify([{ id: 20, title: 'Release', body: 'Ship safely.', tags: ['Work'] }, { id: 3, title: 'Shopping', body: 'Milk.', tags: ['home'] }, { id: 11, title: 'Review', body: 'Check tests.', tags: ['work', 'code'] }], null, 2) + '\n',
      'test/notes.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectNotes, renderMarkdown } from ${JSON.stringify('../src/notes.mjs')}
test('existing unfiltered rendering', () => {
  const notes = [{id:2,title:'B',body:'two',tags:[]},{id:1,title:'A',body:'one',tags:[]}]
  assert.deepEqual(selectNotes(notes).map(n => n.id), [1,2])
  assert.equal(renderMarkdown(selectNotes(notes)), '## A\\n\\none\\n\\n## B\\n\\ntwo\\n')
  assert.equal(notes[0].id, 2)
})
`,
    },
    acceptance: imports + `import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const { selectNotes, renderMarkdown } = await load('src/notes.mjs')
const notes = JSON.parse(readFileSync(join(root, 'notes.json'), 'utf8'))
const original = JSON.stringify(notes)
assert.deepEqual(selectNotes(notes, {tag:'WORK'}).map(n => n.id), [11,20])
assert.deepEqual(selectNotes(notes, {tag:'wor'}), [])
assert.equal(JSON.stringify(notes), original)
assert.equal(renderMarkdown([]), '')
const run = args => spawnSync(process.execPath, [join(root,'src/cli.mjs'), join(root,'notes.json'), ...args], {encoding:'utf8'})
const json = run(['--tag','work','--format','json'])
assert.equal(json.status, 0, json.stderr)
assert.deepEqual(JSON.parse(json.stdout).map(n => n.id), [11,20])
const markdown = run(['--format','markdown','--tag','WORK'])
assert.equal(markdown.status, 0, markdown.stderr)
assert.equal(markdown.stdout, '## Review\\n\\nCheck tests.\\n\\n## Release\\n\\nShip safely.\\n')
assert.equal(run(['--tag','missing']).stdout, '')
for (const args of [['--wat'],['--tag'],['--format'],['--format','html']]) {
  const result=run(args)
  assert.notEqual(result.status,0, JSON.stringify(args))
  assert.ok(result.stderr.trim().length > 0)
}
console.log('ACCEPTED notes-export: filtering, ordering, immutability, both formats, CLI errors')
`,
  },
  {
    id: 'parallel-import',
    title: 'Independent module fixes with sub-agent collaboration',
    prompt: 'Fix two independent modules of the data importer: parseCsv(text) must support quoted commas, escaped double quotes, CRLF/LF line endings and newlines inside fields; empty input returns [], a trailing newline produces no empty record, and an unclosed quote throws SyntaxError. inDateRange(value,start,end) compares by UTC calendar date, inclusive on both ends; start/end are valid YYYY-MM-DD and value is a valid ISO timestamp; invalid dates or an inverted range throw RangeError. Keep the API and existing tests, add regression tests for each, and finally run the full npm test. If an Agent tool is available, hand the two modules to two sub-agents to handle independently and integrate the results; otherwise do it yourself. If a task list tool is available, use it to track these three steps. Do not install dependencies or access the network.',
    files: {
      'package.json': packageFile,
      'CLAUDE.md': instructions,
      'README.md': '# Import helpers\nTwo independent pure modules provide CSV row parsing and inclusive UTC-date filtering. Each exports the function named in its filename.\n',
      'src/parseCsv.mjs': `export function parseCsv(text) {
  return text.trim().split('\\n').map(row => row.split(','))
}
`,
      'src/inDateRange.mjs': `export function inDateRange(value, start, end) {
  const timestamp = new Date(value).getTime()
  return timestamp > new Date(start).getTime() && timestamp < new Date(end).getTime()
}
`,
      'test/import.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from ${JSON.stringify('../src/parseCsv.mjs')}
import { inDateRange } from ${JSON.stringify('../src/inDateRange.mjs')}
test('CSV preserves quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsv('name,note\\r\\nAda,"hi, ""friend"""\\r\\n'), [['name','note'],['Ada','hi, "friend"']])
})
test('date bounds include the entire UTC end day', () => {
  assert.equal(inDateRange('2026-10-28T23:59:59.999Z','2026-10-27','2026-10-28'), true)
  assert.equal(inDateRange('2026-10-27T00:00:00Z','2026-10-27','2026-10-28'), true)
})
`,
    },
    acceptance: imports + `const { parseCsv } = await load('src/parseCsv.mjs')
const { inDateRange } = await load('src/inDateRange.mjs')
assert.deepEqual(parseCsv(''), [])
assert.deepEqual(parseCsv('a,b\\nc,d\\n'), [['a','b'],['c','d']])
assert.deepEqual(parseCsv('a,b\\r\\nc,d\\r\\n'), [['a','b'],['c','d']])
assert.deepEqual(parseCsv('"a,b","x""y"\\n"line1\\nline2",z'), [['a,b','x"y'],['line1\\nline2','z']])
assert.deepEqual(parseCsv(' a ,b,'), [[' a ','b','']])
assert.throws(() => parseCsv('a,"unfinished'), SyntaxError)
assert.equal(inDateRange('2026-10-28T23:59:59.999Z','2026-10-27','2026-10-28'), true)
assert.equal(inDateRange('2026-10-27T00:00:00Z','2026-10-27','2026-10-28'), true)
assert.equal(inDateRange('2026-10-29T00:30:00+02:00','2026-10-28','2026-10-28'), true)
assert.equal(inDateRange('2026-10-29T00:00:00Z','2026-10-27','2026-10-28'), false)
for (const args of [['invalid','2026-10-27','2026-10-28'],['2026-10-28T00:00:00Z','2026-10-29','2026-10-28'],['2026-10-28T00:00:00Z','2026-02-30','2026-10-28']]) assert.throws(() => inDateRange(...args), RangeError)
console.log('ACCEPTED parallel-import: CSV quoting/newlines/errors and inclusive UTC date range')
`,
  },
]

/** A separate live capability smoke, excluded from the three coding comparisons. */
export const WEB_BENCHMARK_FIXTURE: BenchmarkFixture = {
  id: 'web-docs',
  title: 'Native search and official docs fetch',
  kind: 'web',
  prompt: 'Actually call WebSearch to find the API base URL and the OpenAI SDK compatibility notes in the official DeepSeek API docs, then actually call WebFetch to read https://api-docs.deepseek.com/ and cross-check. In sources.md in the current directory, write two confirmed facts in English, each with its official source link; state whether each tool succeeded or failed, and do not invent results from memory. Only access official DeepSeek material, and do not install dependencies or modify other files.',
  files: { 'CLAUDE.md': 'This is a disposable documentation research workspace. Write only sources.md. Use official DeepSeek sources and report any failed tools honestly.\n' },
  acceptance: imports + `import { readFileSync } from 'node:fs'
const text = readFileSync(join(root,'sources.md'),'utf8')
assert.ok(text.includes('https://api.deepseek.com'), 'missing API base URL')
assert.match(text, /OpenAI/i, 'missing SDK compatibility fact')
assert.ok(text.includes('https://api-docs.deepseek.com/'), 'missing official documentation source')
assert.ok(text.trim().length > 80, 'report is empty or too short')
console.log('ACCEPTED web-docs: artifact contains API URL, SDK compatibility and official source')
`,
}
