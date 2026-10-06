import React from 'react'

interface Props {
  children: React.ReactNode
  /** 出错时显示的名称，用于提示是哪个页面崩了 */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * 渲染进程错误边界：任何一个视图抛错只影响当前页，
 * 不会白屏整个 app。提供「重试」按钮重新挂载子树。
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 走 preload 暴露的日志通道（若可用），否则退回 console
    try {
      console.error(`[ErrorBoundary${this.props.label ? ' ' + this.props.label : ''}]`, error, info.componentStack)
    } catch {
      /* ignore */
    }
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-10 text-center animate-fade-in">
          <div className="text-4xl mb-4">⚠️</div>
          <h2 className="text-white text-lg font-semibold mb-1">
            {this.props.label ? `「${this.props.label}」页面出错了` : '页面出错了'}
          </h2>
          <p className="text-sm text-slate-400 max-w-md mb-1">这个视图渲染时抛了异常，已隔离，不影响其他页面。</p>
          <pre className="text-xs text-rose-300/80 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2 max-w-lg overflow-auto mb-4">
            {this.state.error.message}
          </pre>
          <button className="btn btn-primary" onClick={this.reset}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
