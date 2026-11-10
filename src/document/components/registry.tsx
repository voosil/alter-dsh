/**
 * Safe component registry: catalog id → built-in React renderer.
 *
 * Rendering is fail-closed:
 * - an unknown component id (removed/never built in) degrades to a card;
 * - a payload that violates the catalog schema degrades to a card;
 * - a renderer that throws is caught by an error boundary and degrades too.
 *
 * The document never carries executable code; "registry" here is a static
 * `Record` of bundled components, not a loader.
 *
 * @module @alter-dsh/space/document/components/registry
 */
import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import {
  getComponentDefinition,
  validateComponentPayload,
  type ComponentPayload,
} from '@alter/protocol';
import { COMPONENT_RENDERERS } from './renderers';
import styles from './components.module.css';

/** Boundary that keeps one broken preview from crashing the whole editor. */
class ComponentRenderBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Previews are non-critical: degrade to the fallback card silently.
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Visible degradation card for unknown, invalid or broken components. */
export function ComponentFallbackCard({
  payload,
  message,
}: {
  payload?: ComponentPayload;
  message: string;
}): ReactNode {
  return (
    <div
      className={styles.fallback}
      data-component-fallback="true"
      role="status"
    >
      <div className={styles.fallbackTitle}>组件不可用</div>
      <div className={styles.fallbackMessage}>{message}</div>
      {payload === undefined ? null : (
        <div className={styles.fallbackMeta}>{payload.componentId}</div>
      )}
    </div>
  );
}

/** Render one validated catalog component; unknown/broken payloads degrade. */
export function ComponentRenderer({
  payload,
  readOnly = false,
}: {
  payload: ComponentPayload;
  readOnly?: boolean;
}): ReactNode {
  const definition = getComponentDefinition(payload.componentId);
  if (definition === undefined) {
    return (
      <ComponentFallbackCard
        payload={payload}
        message={`未知组件：${payload.componentId}`}
      />
    );
  }
  const errors = validateComponentPayload(payload);
  if (errors.length > 0) {
    return (
      <ComponentFallbackCard payload={payload} message={errors[0] ?? '组件数据无效'} />
    );
  }
  const Renderer = COMPONENT_RENDERERS[payload.componentId];
  if (Renderer === undefined) {
    return <ComponentFallbackCard payload={payload} message="组件渲染器未注册" />;
  }
  return (
    <ComponentRenderBoundary
      fallback={
        <ComponentFallbackCard payload={payload} message="组件渲染失败" />
      }
    >
      <Renderer payload={payload} readOnly={readOnly} />
    </ComponentRenderBoundary>
  );
}
