// SPDX-License-Identifier: AGPL-3.0-or-later

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Contains a render/runtime crash in the source editor (or any child) so it degrades to a
 * readable message **in that pane** instead of tearing down the whole `<AppRoot>` — which would
 * blank the window AND, on desktop, leave the renderer unable to answer the quit-confirm IPC
 * (an unclosable blank app). A runtime plugin's `binding` is the most likely culprit (e.g. a
 * CodeMirror extension built against a different `@codemirror/state` instance), so the fallback
 * offers a **Try again** that clears the boundary's error state and re-renders the children
 * (after the underlying cause is resolved, e.g. a fresh build/navigation).
 */
interface Props {
  children: ReactNode;
  /** Shown above the error so the user knows which surface failed. */
  label?: string;
}
interface State {
  error: Error | null;
}

export class EditorErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it for diagnostics; the boundary keeps the rest of the app alive.
    console.error(`[inplan] ${this.props.label ?? "editor"} crashed — contained by the error boundary`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="ap-editor-error" role="alert">
        <p className="ap-editor-error-title">{this.props.label ?? "This view"} couldn't load.</p>
        <p className="ap-editor-error-msg">{error.message}</p>
        <button className="ap-editor-error-retry" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
