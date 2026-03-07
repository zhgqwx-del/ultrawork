import { Component, type ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
          <AlertTriangle className="h-12 w-12 text-orange-500" />
          <h2 className="text-lg font-semibold text-[var(--color-fg)]">
            Something went wrong
          </h2>
          <p className="max-w-md text-center text-sm text-[var(--color-fg-muted)]">
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white transition-colors hover:opacity-90"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
