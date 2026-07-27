import { Component } from 'react'

const copy = {
  zh: {
    body: '这一页没能渲染出来。刷新一般能解决；如果一直这样，麻烦去 GitHub 提个 issue。',
    reload: '刷新页面',
    title: '出了点问题'
  },
  en: {
    body: 'This page failed to render. A reload usually fixes it — if it keeps happening, please open an issue on GitHub.',
    reload: 'Reload',
    title: 'Something broke'
  }
}

/**
 * 没有它的话，任意一个组件在渲染或 effect 里抛错都会把整棵树卸载掉，
 * 用户看到的是纯白页面而不是错误。文档站不该因为一处小故障就整个消失。
 */
export default class ErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error('[site] 渲染失败', error, info?.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children

    const locale = document.documentElement.lang === 'en' ? 'en' : 'zh'
    const c = copy[locale]

    return (
      <main className="not-found">
        <p>ERROR</p>
        <h1>{c.title}</h1>
        <p className="not-found__hint">{c.body}</p>
        <div className="not-found__actions">
          <button className="btn btn--primary" onClick={() => window.location.reload()} type="button">
            {c.reload}
          </button>
          <a
            className="btn btn--ghost"
            href="https://github.com/NanmiCoder/cc-haha/issues"
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        </div>
      </main>
    )
  }
}
