import lock from './skillBundles.lock.json'
import type { ConnectorCategory, ConnectorDefinition, SkillBundleRecipe } from './types.js'

// Sources, complete skill subtrees and license files are pinned in the lock.
// Installation only downloads verified files; runtimes are separate prerequisites.
export const SKILL_RECIPES: SkillBundleRecipe[] = lock

const details: Array<{ id: string, name: string, category: ConnectorCategory, description: string, example: string, requirements: string }> = [
  { id: 'hyperframes', name: 'HyperFrames', category: 'design', description: '用 HTML 和动画代码制作视频、字幕与产品演示。', example: '用 HyperFrames 为产品制作一段 20 秒的介绍视频。', requirements: '安装固定版本的 5 项完整技能与参考资料，不安装渲染器。实际渲染需要 Node.js 22+、HyperFrames CLI 与 FFmpeg；语音和在线素材服务可能需要单独配置及付费。' },
  { id: 'obsidian', name: 'Obsidian 工具包', category: 'productivity', description: '编辑 Markdown 笔记、Canvas 画布与 Bases 数据视图。', example: '把这些项目笔记整理为 Obsidian Canvas 关系图。', requirements: '本地文件编辑无需云端账号。CLI 操作需要安装并运行 Obsidian；网页内容提取等可选功能需要相应 CLI。本安装仅提供技能文件。' },
  { id: 'drawio', name: 'draw.io 图表', category: 'design', description: '生成可编辑的架构图、流程图和关系图。', example: '把这段系统说明整理成可编辑的 draw.io 架构图。', requirements: '可直接编写 .drawio XML 文件；Mermaid 转换、自动布局及图片导出需要 draw.io 桌面版 CLI。安装技能不会安装桌面应用。' },
  { id: 'frontend-design', name: '前端界面设计', category: 'design', description: '为网页和应用编写具有清晰视觉层次的前端界面。', example: '为我的知识管理应用设计并实现首页。', requirements: '安装 Anthropic 的前端设计技能。预览与构建需要目标项目的前端依赖和运行环境；本技能不提供托管或图片生成服务。' },
  { id: 'canvas-design', name: '海报与视觉画布', category: 'design', description: '创作海报、静态视觉作品与 PDF 画布，附带字体。', example: '设计一张科技活动海报，并导出为 PDF。', requirements: '安装完整设计技能、字体及对应许可。生成图像或 PDF 需要 Python 和相应绘图依赖；不会自动安装这些运行库。' },
  { id: 'algorithmic-art', name: '生成式艺术', category: 'design', description: '用 p5.js 创建可调参数的算法艺术与交互画面。', example: '制作一个可调整颜色与密度的流场艺术页面。', requirements: '包含示例模板和参考代码。预览需要浏览器及 p5.js 资源；安装不执行脚本，也不调用生成模型。' },
  { id: 'webapp-testing', name: '网页测试工具包', category: 'development', description: '使用 Playwright 检查本地网页、交互行为与截图。', example: '检查本地应用的登录表单校验和页面布局。', requirements: '包含测试技能、Python 辅助脚本及示例。实际运行需要 Python、Playwright 和浏览器，以及待测应用；安装不会自动下载浏览器。' },
  { id: 'mcp-builder', name: 'MCP 开发工具包', category: 'development', description: '构建与评估 MCP 服务，提供 TypeScript 和 Python 参考。', example: '为我们的内部知识库设计一个 MCP 服务。', requirements: '包含协议设计参考和评估脚本。开发需 Node.js 或 Python 及 MCP SDK；模型评估、第三方 API 使用需用户自行配置凭据，可能产生费用。' },
]

export const SKILL_CONNECTORS: ConnectorDefinition[] = details.map(item => {
  const recipe = SKILL_RECIPES.find(recipe => recipe.id === item.id)!
  return {
    id: item.id, displayName: item.name, description: item.description, category: item.category,
    capabilities: [item.description], example: item.example, requirements: item.requirements,
    collection: 'tools', region: 'global', transport: 'skills', credentialMode: 'isolated',
    pluginId: `office-${item.id}@haha-connectors`, packageName: item.name, version: recipe.version,
    homepage: `https://github.com/${recipe.repository}/tree/${recipe.commit}`,
    platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'],
  }
})

export function getSkillRecipe(id: string, version?: string): SkillBundleRecipe | undefined {
  return SKILL_RECIPES.find(recipe => recipe.id === id && (version === undefined || recipe.version === version))
}
