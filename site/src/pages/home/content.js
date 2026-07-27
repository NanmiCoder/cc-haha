import sessionMain from '../../../../docs/images/app/session-main.webp'
import workspaceDiff from '../../../../docs/images/app/workspace-diff.webp'
import workspacePreview from '../../../../docs/images/app/workspace-preview.webp'
import providerAdd from '../../../../docs/images/app/settings-provider-add.webp'
import skillMarket from '../../../../docs/images/app/skill-market.webp'
import scheduleCreate from '../../../../docs/images/app/schedule-create.webp'
import h5Session from '../../../../docs/images/app/h5-session.webp'
import petDesktop from '../../../../docs/images/app/pet-desktop.webp'

// 吉祥物与截图一样从 docs/ 取 —— docs/ 是站点唯一的媒体源。
// 原图是桌面端的 agent-mascots，改动那边时记得同步这四张。
import dada from '../../../../docs/images/mascots/dada.png'
import huhu from '../../../../docs/images/mascots/huhu.png'
import bubu from '../../../../docs/images/mascots/bubu.png'
import huihui from '../../../../docs/images/mascots/huihui.png'

export const images = {
  h5Session,
  petDesktop,
  providerAdd,
  scheduleCreate,
  sessionMain,
  skillMarket,
  workspaceDiff,
  workspacePreview
}

export const content = {
  zh: {
    hero: {
      title: '让 Claude Code 有个能看见的地方干活',
      lede: '本地优先的桌面客户端：会话、改动、Agent、定时任务都摆在明处。接哪个模型你说了算，改哪一行你点头才算。',
      primary: '下载桌面端',
      secondary: '三步跑通第一条会话',
      badges: ['macOS · Windows · Linux', '开源免费', '数据留在本机'],
      caption: '真实截图：一条会话读完项目、改了三个文件，改动就在对话里逐行摊开。'
    },
    capabilities: {
      title: '它替你做的事',
      lede: '不是一个聊天框，是一整套把「想法」变成「已合并」的工序。',
      items: [
        ['写代码', '说清目标，它读项目、拆任务、动手改，每一步的工具调用都能展开看。'],
        ['审改动', '改了哪些文件、每行怎么改，Diff 逐行摆出来；不点头就不落地。'],
        ['隔离试验', '把试验放进独立工作树，主分支一个字都不动。'],
        ['派 Agent', '大活拆给子 Agent 并行跑，进度和后台任务都汇总在活动面板。'],
        ['装技能', '技能市场里看中就装，来源和安全状态摆在明处。'],
        ['到点自动跑', '重复流程设成定时任务，在独立会话里执行，每次都留记录。'],
        ['操作电脑', 'Computer Use 让它看屏幕、点鼠标、敲键盘，敏感操作等你点头。'],
        ['出门接着聊', '手机浏览器扫码进 H5，或者从飞书 / Telegram / 微信继续同一条会话。']
      ]
    },
    tour: {
      title: '所有截图都拍自 v0.5.0，没有概念图',
      lede: '装好之后你看到的就是这个样子。',
      tabs: [
        {
          id: 'session',
          label: '会话',
          title: '说一句话，看它一步步做完',
          body: '选好项目、权限模式和模型就能开工。它读了哪些文件、执行了什么命令、改了哪一行，全都留在对话里。',
          image: sessionMain
        },
        {
          id: 'review',
          label: '审阅',
          title: '改了什么，逐个文件看清楚',
          body: '右侧工作区列出本轮改动，点开就是带语法高亮的 Diff。看不顺眼可以撤销整轮。',
          image: workspaceDiff
        },
        {
          id: 'preview',
          label: '预览',
          title: '页面效果，会话里直接验证',
          body: '内置浏览器打开本地服务，改完当场看效果；截图和元素选择都能带回对话继续说。',
          image: workspacePreview
        },
        {
          id: 'models',
          label: '模型',
          title: '接哪个模型，你自己定',
          body: 'Claude / ChatGPT / Grok 官方账号直接登录，也可以接 DeepSeek、Kimi、智谱、MiniMax，或者本地跑的 LM Studio 与 Ollama。',
          image: providerAdd
        },
        {
          id: 'skills',
          label: '技能',
          title: '缺什么手艺，装什么手艺',
          body: '技能市场聚合 ClawHub 与 SkillHub，每个技能都标了来源和安全状态，装之前先看清楚。',
          image: skillMarket
        },
        {
          id: 'schedule',
          label: '定时',
          title: '设好时间，它按时回来交活',
          body: '定好频率、模型、目录和通知方式；任务在独立会话里执行，每跑一次都有记录可查。',
          image: scheduleCreate
        },
        {
          id: 'remote',
          label: '手机',
          title: '离开电脑，会话不断',
          body: '扫码用手机浏览器接着聊。锁屏切后台也不会打断正在跑的任务，回来就能看结果。',
          image: h5Session
        }
      ]
    },
    crew: {
      title: '干活的时候，桌面上有个伴',
      lede: '一个转圈图标代表所有状态太敷衍了。搭搭、弧弧、补补、回回随任务状态换动作——忙不忙，瞟一眼就知道。',
      link: '怎么养一只自己的',
      members: [
        ['搭搭', 'Dada', '构建', '把想法一块块搭成能跑的东西。'],
        ['弧弧', 'Huhu', '规划', '复杂任务也能画出一条清楚的路线。'],
        ['补补', 'Bubu', '修复', '找到裂缝，验证之后再补好它。'],
        ['回回', 'Huihui', '交付', '新回复一到，抱着齿轮就接着跑。']
      ]
    },
    paths: {
      title: '你是哪一种',
      lede: '文档只分两条路，别的都是这两条的支线。',
      items: [
        {
          eyebrow: '我想用起来',
          title: '从 0 到 1 把它跑起来',
          body: '装好应用、接上模型、跑通第一条会话，再一个个把功能用熟。不需要懂代码。',
          links: [
            ['/start/install', '下载与安装'],
            ['/start/models', '连接模型服务'],
            ['/start/first-session', '跑通第一条会话'],
            ['/desktop', '桌面端功能地图']
          ]
        },
        {
          eyebrow: '我想拆开看',
          title: '架构、实现与贡献',
          body: 'CLI 内核怎么分层、Agent 与 Skills 怎么调度、记忆怎么落盘、本地服务有哪些 API。',
          links: [
            ['/internals', '架构总览'],
            ['/internals/agent', '多 Agent 系统'],
            ['/internals/server', '本地 Server 与 API'],
            ['/internals/contributing', '参与贡献']
          ]
        }
      ]
    },
    install: {
      title: '装上试试',
      lede: 'GitHub Releases 有三平台安装包；想从源码跑也就三行命令。',
      primary: '下载安装包',
      docs: '安装遇到问题',
      commandLabel: '从源码运行',
      copy: '复制',
      copied: '已复制'
    },
    footer: {
      tagline: '本地优先的 Claude Code 桌面客户端',
      columns: [
        ['文档', [['/start', '开始使用'], ['/desktop', '桌面端功能'], ['/im', 'IM 接入'], ['/cli', '命令行']]],
        ['开发者', [['/internals', '架构总览'], ['/internals/structure', '项目结构'], ['/internals/contributing', '参与贡献']]]
      ]
    }
  },

  en: {
    hero: {
      title: 'Give Claude Code somewhere you can watch it work',
      lede: 'A local-first desktop client. Sessions, diffs, agents and scheduled runs all sit in the open. You pick the model; nothing lands until you say so.',
      primary: 'Download the app',
      secondary: 'Run your first session',
      badges: ['macOS · Windows · Linux', 'Open source', 'Your data stays local'],
      caption: 'A real screenshot: one session read the project, changed three files, and laid every edit out inline.'
    },
    capabilities: {
      title: 'What it does for you',
      lede: 'Not a chat box — the whole path from an idea to a merged change.',
      items: [
        ['Write code', 'State the goal. It reads the project, splits the work, and edits — every tool call open for inspection.'],
        ['Review edits', 'Which files changed and exactly how, line by line. Nothing lands without your nod.'],
        ['Isolate experiments', 'Keep risky work in its own worktree and leave your main branch untouched.'],
        ['Delegate', 'Split big jobs across subagents; progress and background tasks roll up into one panel.'],
        ['Install skills', 'Browse the marketplace with source and safety status shown up front.'],
        ['Run on a clock', 'Turn routines into scheduled jobs that run in their own sessions and leave a record.'],
        ['Drive the desktop', 'Computer Use can see the screen, click and type. Sensitive moves still wait for you.'],
        ['Keep going anywhere', 'Scan into the mobile web app, or continue the same session from Feishu, Telegram or WeChat.']
      ]
    },
    tour: {
      title: 'Every screenshot is v0.5.0. No concept art.',
      lede: 'What you see is what opens after install.',
      tabs: [
        { id: 'session', label: 'Session', title: 'Say it once. Watch it get done.', body: 'Pick a project, a permission mode and a model. Every file it read, every command it ran and every line it changed stays in the thread.', image: sessionMain },
        { id: 'review', label: 'Review', title: 'Know exactly what changed', body: 'The workspace lists this turn’s edits; open any file for a syntax-highlighted diff. Don’t like it? Undo the whole turn.', image: workspaceDiff },
        { id: 'preview', label: 'Preview', title: 'Check the page without leaving', body: 'Open your dev server in the built-in browser, see the result immediately, and bring screenshots or picked elements back into the thread.', image: workspacePreview },
        { id: 'models', label: 'Models', title: 'Bring your own model', body: 'Sign in to Claude, ChatGPT or Grok, or point it at DeepSeek, Kimi, Zhipu, MiniMax — or LM Studio and Ollama running on your own machine.', image: providerAdd },
        { id: 'skills', label: 'Skills', title: 'Missing a trick? Install it.', body: 'The marketplace aggregates ClawHub and SkillHub, and labels every skill with its source and safety status before you install.', image: skillMarket },
        { id: 'schedule', label: 'Schedule', title: 'Set the time. It comes back with results.', body: 'Choose a cadence, model, directory and notification. Jobs run in their own sessions and every run leaves a record.', image: scheduleCreate },
        { id: 'remote', label: 'Mobile', title: 'Step away, keep the session', body: 'Scan the QR code and continue in your phone browser. Locking the screen won’t kill a running task.', image: h5Session }
      ]
    },
    crew: {
      title: 'Someone to keep you company while it works',
      lede: 'One spinner for every state felt lazy. Dada, Huhu, Bubu and Huihui change what they are doing with the task — one glance tells you.',
      link: 'Raise one of your own',
      members: [
        ['Dada', 'Dada', 'Build', 'Turns an idea into something you can run.'],
        ['Huhu', 'Huhu', 'Plan', 'Finds a clear route through complicated work.'],
        ['Bubu', 'Bubu', 'Fix', 'Finds the crack, proves it, then patches it.'],
        ['Huihui', 'Huihui', 'Ship', 'Grabs the gear and moves the moment a reply lands.']
      ]
    },
    paths: {
      title: 'Which one are you',
      lede: 'The docs run along two tracks. Everything else branches off them.',
      items: [
        {
          eyebrow: 'I want to use it',
          title: 'From zero to a working session',
          body: 'Install the app, connect a model, finish your first session, then learn the features one at a time. No code required.',
          links: [
            ['/en/start/install', 'Install'],
            ['/en/start/models', 'Connect a model'],
            ['/en/start/first-session', 'Your first session'],
            ['/en/desktop', 'Feature map']
          ]
        },
        {
          eyebrow: 'I want to read the source',
          title: 'Architecture, internals and contributing',
          body: 'How the CLI core is layered, how agents and skills are scheduled, how memory is persisted, what the local server exposes.',
          links: [
            ['/en/internals', 'Architecture overview'],
            ['/en/internals/agent', 'Multi-agent system'],
            ['/en/internals/server', 'Local server & API'],
            ['/en/internals/contributing', 'Contributing']
          ]
        }
      ]
    },
    install: {
      title: 'Try it',
      lede: 'Installers for all three platforms on GitHub Releases — or three commands from source.',
      primary: 'Download',
      docs: 'Install troubleshooting',
      commandLabel: 'Run from source',
      copy: 'Copy',
      copied: 'Copied'
    },
    footer: {
      tagline: 'A local-first desktop client for Claude Code',
      columns: [
        ['Docs', [['/en/start', 'Get started'], ['/en/desktop', 'Desktop app'], ['/en/im', 'Messaging'], ['/en/cli', 'Command line']]],
        ['Developers', [['/en/internals', 'Architecture'], ['/en/internals/structure', 'Project structure'], ['/en/internals/contributing', 'Contributing']]]
      ]
    }
  }
}

export const mascots = [dada, huhu, bubu, huihui]
export const mascotAccents = ['#2eaa91', '#3577d4', '#e56645', '#7657c8']
