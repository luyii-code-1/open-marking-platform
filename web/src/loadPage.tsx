import { Component, lazy, Suspense, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'

export function PageLoading() {
  return <div className="route-loading" role="status">正在加载…</div>
}

class PageError extends Component<{ onRetry: () => void; retried: boolean; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div role="alert" className="route-loading">
      <span>页面暂时无法打开。</span><button type="button" onClick={this.props.onRetry}>重试</button>
      {this.props.retried && <button type="button" onClick={() => window.location.reload()}>刷新网页</button>}
    </div>
    return this.props.children
  }
}

export function loadPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  const initial = lazy(load)
  return function Page(props: ComponentProps<T>) {
    const [attempt, setAttempt] = useState(0)
    const [current, setCurrent] = useState(() => initial)
    const Loaded = current as ComponentType<ComponentProps<T>>
    function retry() {
      setCurrent(() => lazy(load))
      setAttempt(value => value + 1)
    }
    return <PageError key={attempt} retried={attempt > 0} onRetry={retry}><Suspense fallback={<PageLoading/>}><Loaded {...props}/></Suspense></PageError>
  }
}
