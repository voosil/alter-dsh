/**
 * Error boundary for the restored document page.
 *
 * A render/runtime exception anywhere in the document body (editor, comment
 * rail, history panel, dialogs) must not white-screen the Space panel: this
 * boundary swaps the crashed subtree for a readable fallback with two ways
 * out —「重试」resets the boundary and 「返回空间目录」navigates back.
 *
 * The component intentionally carries **no CSS**: the owner passes the
 * existing `DocumentView.module.css` class names through `classNames`, so the
 * fallback borrows the document shell look without touching the frozen
 * stylesheet or the normal-state DOM.
 *
 * Failures are handed to `reportDocumentError` from `componentDidCatch`
 * so a crashing client leaves a structured trace (E1/E2).
 *
 * @module @alter/ui-space/components/DocumentErrorBoundary
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@alter/ui-system';
import { reportDocumentError } from '@alter-space/document-runtime';

/** Existing document-shell class names the fallback reuses. */
export interface DocumentErrorBoundaryClassNames {
  scroller?: string;
  paper?: string;
  header?: string;
  title?: string;
  body?: string;
  actions?: string;
}

export interface DocumentErrorBoundaryProps {
  children: ReactNode;
  /** Space document id, attached to the diagnostic report. */
  docId?: string;
  /** Reset the boundary when this value changes (e.g. document/revision). */
  resetKey?: string | number;
  title?: string;
  message?: string;
  classNames?: DocumentErrorBoundaryClassNames;
  /** Navigate back to the space overview. */
  onGoOverview?: () => void;
}

interface DocumentErrorBoundaryState {
  error: Error | null;
}

/** Render/runtime catch-all for one document page. */
export class DocumentErrorBoundary extends Component<
  DocumentErrorBoundaryProps,
  DocumentErrorBoundaryState
> {
  state: DocumentErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DocumentErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    reportDocumentError('render', error, {
      docId: this.props.docId,
      operation: 'render',
    });
  }

  componentDidUpdate(previous: DocumentErrorBoundaryProps): void {
    if (
      this.state.error !== null &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const classes = this.props.classNames ?? {};
    return (
      <div className={classes.scroller} role="alert" data-document-error="true">
        <article className={classes.paper}>
          <header className={classes.header}>
            <h1 className={classes.title}>
              {this.props.title ?? '无法显示文档内容'}
            </h1>
          </header>
          <div className={classes.body}>
            <p>
              {this.props.message ??
                '文档界面出现异常，可重试；若持续失败，请返回空间目录后重新打开。'}
            </p>
            <div className={classes.actions}>
              <Button variant="secondary" onClick={this.reset}>
                重试
              </Button>
              {this.props.onGoOverview === undefined ? null : (
                <Button variant="primary" onClick={this.props.onGoOverview}>
                  返回空间目录
                </Button>
              )}
            </div>
          </div>
        </article>
      </div>
    );
  }
}
