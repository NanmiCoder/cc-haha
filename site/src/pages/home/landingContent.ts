export type LandingLocale = 'zh' | 'en'
export type TaskCategory = 'code' | 'apps' | 'review'
export type FeatureImageKey = 'session' | 'settings' | 'workspace'

export interface TaskSuggestion {
  label: string
  prompt: string
  category: TaskCategory
}

export interface LandingFeature {
  id: TaskCategory
  title: string
  body: string
  kicker: string
  detail: string
  route: string
  imageKey: FeatureImageKey
}

export interface LandingContent {
  hero: {
    eyebrow: string
    headline: [string, string]
    description: string
    promptDefault: string
  }
  taskSuggestions: TaskSuggestion[]
  features: LandingFeature[]
  workflowSteps: { title: string; body: string; route: string }[]
  faqs: { question: string; answer: string }[]
  closing: { title: string; body: string }
}

export const landingContent: Record<LandingLocale, LandingContent> = {
  zh: {
    hero: {
      eyebrow: '你的桌面 AI 搭档 · 免费开源',
      headline: ['把琐碎交给 AI，', '把时间留给生活。'],
      description: '写代码、操作应用、审阅改动。给 cc-haha 一个目标，让想法开始发生。',
      promptDefault: '帮我把这个项目的首页做得更好看。先了解现有风格，再完成页面，检查手机端，并告诉我改了什么。'
    },
    taskSuggestions: [
      { label: '做一个新页面', prompt: '帮我把这个项目的首页做得更好看。先了解现有风格，再完成页面，检查手机端，并告诉我改了什么。', category: 'code' },
      { label: '让应用替我忙', prompt: '在「备忘录」里新建一条「本周计划」，写下阅读、散步和整理项目三个事项。只操作这一条笔记。', category: 'apps' },
      { label: '检查这次改动', prompt: '审阅当前项目的未提交改动，找出可能的功能问题，说明对应文件、原因和建议。先不要修改文件。', category: 'review' }
    ],
    features: [
      {
        id: 'code',
        kicker: '01 / 从一句话开始',
        title: '想法有了，剩下的一起做。',
        body: '一个新功能，一个恼人的 Bug，或者迟迟没动手的个人项目。说出目标，cc-haha 会读取代码、编辑文件、运行命令，把过程留在同一条会话里。',
        detail: '你的项目 · 你的模型 · 清晰可见的过程',
        route: '/start/first-session',
        imageKey: 'session'
      },
      {
        id: 'apps',
        kicker: '02 / 走出编辑器',
        title: '工作，也发生在别的窗口里。',
        body: '开启 Computer Use，让 AI 看见并操作桌面应用。从整理一条笔记，到完成一段重复操作，任务可以继续走下去。',
        detail: 'macOS 原生控制不占用真实鼠标和键盘；Windows 使用兼容执行器。',
        route: '/desktop/computer-use',
        imageKey: 'settings'
      },
      {
        id: 'review',
        kicker: '03 / 结果看得见',
        title: '每一处改动，都有迹可循。',
        body: '在工作区查看文件差异，给具体代码留下意见，再打开内置浏览器看看实际效果。把反馈说清楚，让下一轮更接近你的想法。',
        detail: '文件差异 · 行级评论 · 页面预览',
        route: '/desktop/workspace',
        imageKey: 'workspace'
      }
    ],
    workflowSteps: [
      { title: '住进你的电脑', body: '下载桌面应用，打开手边的项目。', route: '/start/install' },
      { title: '接上熟悉的模型', body: '官方账号、API 或本地模型，选择适合你的。', route: '/start/models' },
      { title: '交代一件小事', body: '说清目标与范围，选好这次任务的权限。', route: '/start/first-session' },
      { title: '看看它做得怎样', body: '检查结果，留下反馈，再决定下一步。', route: '/desktop/workspace' }
    ],
    faqs: [
      { question: 'cc-haha 免费吗？', answer: 'cc-haha 免费、开源。模型服务不包含在应用中：使用官方账号或 API 时，订阅和调用费用由相应服务商收取。也可以连接本机运行的 LM Studio 或 Ollama。' },
      { question: '我的电脑能用吗？', answer: '桌面应用提供 macOS、Windows 和 Linux 安装包，支持对应的 Intel / AMD 与 ARM 架构。按下载指南选择适合系统的版本即可。Computer Use 的平台支持有所不同，见下方说明。' },
      { question: '可以用我已经有的模型吗？', answer: '可以。支持通过 Claude、ChatGPT、Grok 官方账号登录，也可配置第三方 API 或连接本地模型。可用模型取决于账号权限和服务商；完整的 Agent 工作流还需要模型支持工具调用。' },
      { question: 'Computer Use 会抢我的鼠标吗？', answer: 'macOS 14.4 及更新版本的原生运行组件通过独立虚拟光标操作，不占用真实鼠标和键盘；少数操作可能改变应用焦点。Windows 的兼容执行器会移动真实鼠标。Linux 暂无执行器。启用前需要完成应用内确认及相应系统授权。' },
      { question: '我能控制 AI 改哪些东西吗？', answer: '可以选择权限模式。默认「询问权限」会在需要授权的写文件、执行命令操作前请求确认，也可以切换到仅规划等模式。编辑后可在工作区审阅差异、留下反馈。Computer Use 单独启用并确认后可操作所有受支持应用，因此也要在任务中写清范围。' }
    ],
    closing: {
      title: '下一件想做的事，交给它试试。',
      body: '从一个小任务开始，让今天多一点自己的时间。'
    }
  },
  en: {
    hero: {
      eyebrow: 'Your desktop AI companion · Free & open source',
      headline: ['Less busywork.', 'More room for life.'],
      description: 'Write code, work across apps, and review every change. Give cc-haha a goal and put your ideas in motion.',
      promptDefault: 'Give this project a better homepage. Get to know its existing style, build the page, check it on mobile, and show me what changed.'
    },
    taskSuggestions: [
      { label: 'Build a new page', prompt: 'Give this project a better homepage. Get to know its existing style, build the page, check it on mobile, and show me what changed.', category: 'code' },
      { label: 'Work across apps', prompt: 'In Notes, create a note called “This week” with three items: read, go for a walk, and tidy up my project. Only change this new note.', category: 'apps' },
      { label: 'Review my changes', prompt: 'Review the uncommitted changes in this project for functional issues. Include the file, reasoning, and a suggested fix for each finding. Do not edit files yet.', category: 'review' }
    ],
    features: [
      {
        id: 'code',
        kicker: '01 / Start with a thought',
        title: 'You have the idea. Build it together.',
        body: 'A new feature, a stubborn bug, or that personal project waiting to happen. Describe the goal. cc-haha reads code, edits files, and runs commands, with the work visible in one conversation.',
        detail: 'Your project · Your model · A process you can follow',
        route: '/en/start/first-session',
        imageKey: 'session'
      },
      {
        id: 'apps',
        kicker: '02 / Beyond the editor',
        title: 'Work happens in other windows, too.',
        body: 'Enable Computer Use to let AI see and operate desktop apps. From organizing a note to working through a repetitive sequence, your task can keep moving.',
        detail: 'Native macOS control leaves your physical mouse and keyboard free. Windows uses a compatibility executor.',
        route: '/en/desktop/computer-use',
        imageKey: 'settings'
      },
      {
        id: 'review',
        kicker: '03 / See the result',
        title: 'Every change tells its story.',
        body: 'Inspect file diffs, leave feedback on a line of code, and open the built-in browser to see the page in action. Make the next iteration closer to what you had in mind.',
        detail: 'File diffs · Line comments · Page previews',
        route: '/en/desktop/workspace',
        imageKey: 'workspace'
      }
    ],
    workflowSteps: [
      { title: 'Make room on your desktop', body: 'Download the app and open a project.', route: '/en/start/install' },
      { title: 'Bring a model you know', body: 'Choose an official account, an API, or a local model.', route: '/en/start/models' },
      { title: 'Hand over one small task', body: 'Set the goal, scope, and permission mode.', route: '/en/start/first-session' },
      { title: 'See how it turned out', body: 'Review the result, leave feedback, and choose what comes next.', route: '/en/desktop/workspace' }
    ],
    faqs: [
      { question: 'Is cc-haha free?', answer: 'cc-haha is free and open source. Model services are separate: subscriptions and API usage are billed by the provider you choose. You can also connect to a model running locally through LM Studio or Ollama.' },
      { question: 'Will it work on my computer?', answer: 'Desktop packages are available for macOS, Windows, and Linux, with supported Intel / AMD and ARM builds. Choose the right package in the installation guide. Computer Use has separate platform requirements, described below.' },
      { question: 'Can I use a model I already have?', answer: 'Yes. Sign in with an official Claude, ChatGPT, or Grok account, configure a third-party API, or connect a local model. Available models depend on your account and provider. Agent workflows also require a model that supports tool calling.' },
      { question: 'Will Computer Use take over my mouse?', answer: 'On macOS 14.4 and later, the native runtime uses an independent virtual cursor and leaves your physical mouse and keyboard free, although some actions may change app focus. The Windows compatibility executor moves the physical mouse. Linux does not currently have an executor. Enabling the feature requires in-app consent and the relevant system permissions.' },
      { question: 'Can I control what AI changes?', answer: 'Choose a permission mode. The default Ask mode requests approval for file writes and commands that require authorization; other modes include planning only. Review edits and leave feedback in the workspace. Computer Use is enabled separately: once confirmed, it can operate all supported apps, so define the scope in your task as well.' }
    ],
    closing: {
      title: 'What would you like to do next?',
      body: 'Start with one small task. Make a little more room for yourself today.'
    }
  }
}
