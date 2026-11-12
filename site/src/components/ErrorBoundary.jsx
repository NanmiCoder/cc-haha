import { Component } from 'react'

const copy = {
  body: 'This page failed to render. A reload usually fixes it — if it keeps happening, please open an issue on GitHub.',
  reload: 'Reload',
  title: 'Something broke'
}

/**
 * Without this, any component throwing during render or in an effect unmounts the whole tree,
 * and the user sees a blank white page instead of an error. The docs site shouldn't vanish over one small fault.
 */
export default class ErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error('[site] render failed', error, info?.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children

    const c = copy

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
