import { Component, type ErrorInfo, type ReactNode } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { Button } from './Button';

/**
 * Catches render-time exceptions so a thrown error shows a styled, recoverable
 * panel instead of a blank white screen. Wrapped around the route outlet (so a
 * crashing page keeps the app chrome) and again at the root (so a shell crash
 * is still caught). Granular per-route boundaries land in the robustness phase.
 *
 * React error boundaries must be class components — there is no hook equivalent.
 */

interface Props {
  children: ReactNode;
  /** Short label describing the scope, e.g. "page" — shown in the fallback. */
  scope?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(
      `[stitchworks] error caught by ErrorBoundary${this.props.scope ? ` (${this.props.scope})` : ''}:`,
      error,
      info.componentStack,
    );
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          height: '100%',
          minHeight: 240,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: 32,
          background: SW_COLORS.paperDeep,
          fontFamily: SW_FONTS.body,
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 46,
            height: 46,
            borderRadius: '50%',
            background: SW_COLORS.brandLite,
            color: SW_COLORS.brandDeep,
            fontSize: 24,
            fontWeight: 800,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          !
        </div>
        <div
          style={{
            fontFamily: SW_FONTS.display,
            fontSize: 18,
            color: SW_COLORS.ink,
          }}
        >
          Something went wrong
        </div>
        <div
          style={{
            fontSize: 13,
            color: SW_COLORS.muted,
            maxWidth: 460,
            lineHeight: 1.5,
            fontFamily: SW_FONTS.mono,
            background: SW_COLORS.paper,
            border: `1px solid ${SW_COLORS.line}`,
            borderRadius: SW_RADIUS.sm,
            padding: '10px 12px',
            wordBreak: 'break-word',
          }}
        >
          {error.message || String(error)}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <Button variant="secondary" onClick={this.reset}>
            Try again
          </Button>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>
      </div>
    );
  }
}
