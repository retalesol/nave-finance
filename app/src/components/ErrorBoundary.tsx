import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        className="flex items-center justify-center"
        style={{ minHeight: '100vh', backgroundColor: 'hsl(var(--background))' }}
      >
        <div className="w-full max-w-sm px-6 text-center">
          <div
            className="mx-auto mb-6 flex items-center justify-center rounded-2xl"
            style={{
              width: '56px',
              height: '56px',
              backgroundColor: 'hsl(var(--destructive-muted))',
              border: '1px solid hsl(var(--destructive) / 0.2)',
            }}
          >
            <span style={{ fontSize: '22px', color: 'hsl(var(--destructive))' }}>!</span>
          </div>

          <h1
            className="text-display"
            style={{
              fontSize: '22px',
              letterSpacing: '-0.02em',
              color: 'hsl(var(--foreground))',
              marginBottom: '8px',
            }}
          >
            Something went wrong
          </h1>

          <p
            style={{
              fontSize: '13.5px',
              lineHeight: 1.6,
              color: 'hsl(var(--muted-foreground))',
              marginBottom: '24px',
            }}
          >
            An unexpected error occurred. Try reloading — if the problem
            persists, please contact support.
          </p>

          {this.state.error && (
            <div
              className="mb-5 px-4 py-3 rounded-xl border text-left overflow-auto"
              style={{
                maxHeight: '100px',
                backgroundColor: 'hsl(var(--surface-1))',
                borderColor: 'hsl(var(--border))',
              }}
            >
              <code
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'hsl(var(--destructive))',
                  wordBreak: 'break-word',
                }}
              >
                {this.state.error.message}
              </code>
            </div>
          )}

          <button
            onClick={this.handleReload}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition-all"
            style={{
              fontSize: '13.5px',
              backgroundColor: 'hsl(var(--foreground))',
              color: 'hsl(var(--background))',
            }}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
