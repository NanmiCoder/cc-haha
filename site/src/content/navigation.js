import { findDoc, getAllDocs } from './docs'

const sectionOrder = [
  'guide',
  'desktop',
  'features',
  'agent',
  'skills',
  'memory',
  'im',
  'channel',
  'reference',
]

const sectionLabels = {
  zh: {
    agent: '多 Agent',
    channel: 'Channel 研究',
    desktop: '桌面工作台',
    features: '核心能力',
    guide: '开始使用',
    im: '远程连接',
    memory: '记忆系统',
    reference: '开发者参考',
    skills: 'Skills 系统',
  },
  en: {
    agent: 'Multi-Agent',
    channel: 'Channel research',
    desktop: 'Desktop workspace',
    features: 'Core capabilities',
    guide: 'Get started',
    im: 'Remote access',
    memory: 'Memory',
    reference: 'Developer reference',
    skills: 'Skills',
  },
}

const preferredLabels = new Map([
  ['/desktop', '桌面端概览'],
  ['/desktop/01-quick-start', '三分钟快速上手'],
  ['/desktop/02-architecture', '桌面端架构'],
  ['/desktop/03-features', '完整功能地图'],
  ['/desktop/04-installation', '安装与更新'],
  ['/desktop/05-FAQ', '桌面端排障'],
  ['/desktop/06-h5-access', '手机与浏览器访问'],
  ['/desktop/pets', '桌面宠物'],
  ['/features/computer-use', 'Computer Use'],
  ['/features/computer-use-architecture', 'Computer Use 架构'],
  ['/guide/quick-start', 'CLI 安装与启动'],
  ['/guide/cli-reference', 'CLI 参考'],
  ['/guide/global-usage', '全局使用（任意目录启动）'],
  ['/guide/faq', '常见问题与求助'],
  ['/guide/env-vars', '环境变量'],
  ['/guide/contributing', '贡献指南与本地质量门禁'],
  ['/guide/third-party-models', '连接模型服务'],
  ['/agent', '多 Agent 系统概览'],
  ['/agent/01-usage-guide', '使用指南'],
  ['/agent/02-implementation', '实现原理'],
  ['/agent/03-agent-framework', 'Agent 框架深度解析'],
  ['/skills/01-usage-guide', '使用指南'],
  ['/skills/02-implementation', '实现原理'],
  ['/memory', '记忆系统概览'],
  ['/memory/01-usage-guide', '使用指南'],
  ['/memory/02-implementation', '实现原理'],
  ['/memory/03-autodream', 'AutoDream 记忆整合'],
  ['/im', 'IM 接入总览'],
  ['/channel', 'Channel 源码研究'],
  ['/channel/01-channel-system', 'Channel 系统架构解析'],
  ['/channel/02-im-gateway-proposal', 'IM Gateway 方案设计（历史设计稿）'],
  ['/reference/local-server', '本地服务与 API'],
  ['/reference/fixes', '泄露源码修复说明'],
  ['/reference/project-structure', '项目结构'],
  ['/en/desktop', 'Desktop overview'],
  ['/en/desktop/01-quick-start', 'Quick start'],
  ['/en/desktop/03-features', 'Feature map'],
  ['/en/desktop/04-installation', 'Install & update'],
  ['/en/desktop/05-FAQ', 'Desktop troubleshooting'],
  ['/en/desktop/06-h5-access', 'Browser & mobile access'],
  ['/en/desktop/pets', 'Desktop pets'],
  ['/en/features/computer-use', 'Computer Use'],
  ['/en/guide/quick-start', 'CLI quick start'],
  ['/en/guide/third-party-models', 'Connect a model'],
  ['/en/agent', 'Multi-agent overview'],
  ['/en/agent/01-usage-guide', 'Usage guide'],
  ['/en/agent/02-implementation', 'Implementation'],
  ['/en/agent/03-agent-framework', 'Agent framework deep dive'],
  ['/en/skills/01-usage-guide', 'Usage guide'],
  ['/en/skills/02-implementation', 'Implementation'],
  ['/en/memory', 'Memory system overview'],
  ['/en/memory/01-usage-guide', 'Usage guide'],
  ['/en/memory/02-implementation', 'Implementation'],
  ['/en/memory/03-autodream', 'AutoDream memory consolidation'],
  ['/en/im', 'IM overview'],
  ['/en/reference/local-server', 'Local server & API'],
  ['/en/reference/fixes', 'Fixes vs. leaked source'],
])

export function getDocNavigation(locale = 'zh') {
  const grouped = new Map()
  for (const doc of getAllDocs(locale)) {
    const sectionDocs = grouped.get(doc.section) || []
    sectionDocs.push(doc)
    grouped.set(doc.section, sectionDocs)
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => {
      const leftIndex = sectionOrder.indexOf(left)
      const rightIndex = sectionOrder.indexOf(right)
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
        || left.localeCompare(right)
    })
    .map(([section, sectionDocs]) => ({
      label: sectionLabels[locale]?.[section] || section,
      items: sectionDocs
        .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
        .map((doc) => ({
          label: preferredLabels.get(doc.route) || doc.title,
          route: doc.route,
          title: doc.title,
        })),
    }))
}

export function alternateLocaleRoute(doc) {
  if (!doc) return '/'

  const sourcePath = doc.locale === 'en'
    ? doc.sourcePath.replace(/^en\//, '')
    : `en/${doc.sourcePath}`
  const alternate = findDoc(`/${sourcePath.replace(/(?:\/index)?\.md$/i, '')}`)

  if (alternate) return alternate.route
  return doc.locale === 'en' ? '/docs' : '/en/docs'
}
