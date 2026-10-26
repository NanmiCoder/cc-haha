/**
 * 把桌面端随应用发布的连接器 logo（desktop/public/connectors/*.svg）栅格成 96px PNG，
 * 放进 mobile/assets/connectors/，并生成静态索引 src/ui/connectorIconSources.ts（Metro 需要静态 require）。
 * 桌面新增或更换 logo 后重新运行：bun scripts/connector-icons.ts（需要 rsvg-convert）。
 * 品牌标识归各服务所有，来源见 desktop/public/connectors/SOURCES.md，不代表任何背书。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const source = join(root, '..', 'desktop', 'public', 'connectors')
const target = join(root, 'assets', 'connectors')
mkdirSync(target, { recursive: true })

const ids = readdirSync(source)
  .filter((file) => file.endsWith('.svg'))
  .map((file) => file.slice(0, -4))
  .sort()
for (const id of ids)
  execFileSync('rsvg-convert', ['-w', '96', '-h', '96', '-o', join(target, `${id}.png`), join(source, `${id}.svg`)])

const lines = ids.map((id) => `  ${JSON.stringify(id)}: require('../../assets/connectors/${id}.png'),`)
writeFileSync(
  join(root, 'src', 'ui', 'connectorIconSources.ts'),
  `// 由 scripts/connector-icons.ts 生成，不要手改。\nexport const connectorIconSources: Record<string, number> = {\n${lines.join('\n')}\n}\n`
)
console.log(`${ids.length} connector icons`)
