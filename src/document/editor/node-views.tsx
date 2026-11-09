/**
 * React node views for the custom Alter blocks.
 *
 * - `alterCallout` keeps its child blocks editable (`NodeViewContent`).
 * - `alterImage` / `alterMindmap` / `alterComponent` are atoms: they render a
 *   safe placeholder card (asset / object id + title) instead of executing
 *   anything. Object renderers are out of scope for v0.
 *
 * Styling lives in `AlterTiptapEditor.module.css` and uses the shared
 * `--alter-*` design tokens.
 *
 * @module @alter-dsh/space/document/editor/node-views
 */
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from '@tiptap/react';
import styles from './AlterTiptapEditor.module.css';

const CALLBACK_TONE_LABELS: Record<string, string> = {
  info: '提示',
  warn: '注意',
  success: '完成',
  danger: '风险',
};

function attrText(props: ReactNodeViewProps, key: string): string | undefined {
  const value = (props.node.attrs as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function RemoveButton({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.objectRemove}
      aria-label={label}
      title={label}
      onClick={onRemove}
    >
      删除
    </button>
  );
}

/** Editable callout container with tone label and optional title. */
export function AlterCalloutView(props: ReactNodeViewProps) {
  const tone = attrText(props, 'tone') ?? 'info';
  const title = attrText(props, 'title');
  const icon = attrText(props, 'icon');
  return (
    <NodeViewWrapper
      as="div"
      className={styles.callout}
      data-tone={tone}
      data-selected={props.selected ? 'true' : undefined}
    >
      <div className={styles.calloutHeader} contentEditable={false}>
        <span className={styles.calloutTone}>
          {CALLBACK_TONE_LABELS[tone] ?? CALLBACK_TONE_LABELS.info}
        </span>
        {icon === undefined ? null : (
          <span className={styles.calloutIcon} aria-hidden="true">
            {icon}
          </span>
        )}
        {title === undefined ? null : (
          <span className={styles.calloutTitle}>{title}</span>
        )}
      </div>
      <NodeViewContent className={styles.calloutBody} />
    </NodeViewWrapper>
  );
}

/** Placeholder card for an image block (asset bytes are not loaded in v0). */
export function AlterImageNodeView(props: ReactNodeViewProps) {
  const alt = attrText(props, 'alt');
  const caption = attrText(props, 'caption');
  const width = attrText(props, 'width');
  return (
    <NodeViewWrapper
      as="div"
      className={styles.objectCard}
      data-kind="image"
      data-selected={props.selected ? 'true' : undefined}
    >
      <div className={styles.objectHead} contentEditable={false}>
        <span className={styles.objectKind}>图片</span>
        <span className={styles.objectTitle}>{alt ?? '图片块'}</span>
        {caption === undefined ? null : (
          <span className={styles.objectCaption}>{caption}</span>
        )}
        <RemoveButton label="删除图片块" onRemove={props.deleteNode} />
      </div>
      <div className={styles.objectMeta} contentEditable={false}>
        {attrText(props, 'assetId') ?? '（缺少资产 id）'}
        {width === undefined ? '' : ` · 宽 ${width}`}
      </div>
      <div className={styles.objectPlaceholder} contentEditable={false}>
        图片渲染器随后接入
      </div>
    </NodeViewWrapper>
  );
}

function ObjectCard(props: {
  view: ReactNodeViewProps;
  kind: 'mindmap' | 'component';
  label: string;
  title: string | undefined;
  description: string | undefined;
}) {
  const objectId = attrText(props.view, 'objectId');
  return (
    <NodeViewWrapper
      as="div"
      className={styles.objectCard}
      data-kind={props.kind}
      data-selected={props.view.selected ? 'true' : undefined}
    >
      <div className={styles.objectHead} contentEditable={false}>
        <span className={styles.objectKind}>{props.label}</span>
        <span className={styles.objectTitle}>{props.title ?? objectId ?? '对象块'}</span>
        <RemoveButton
          label={`删除${props.label}块`}
          onRemove={props.view.deleteNode}
        />
      </div>
      <div className={styles.objectMeta} contentEditable={false}>
        {objectId ?? '（缺少对象 id）'}
      </div>
      {props.description === undefined ? null : (
        <div className={styles.objectHint} contentEditable={false}>
          {props.description}
        </div>
      )}
      <div className={styles.objectPlaceholder} contentEditable={false}>
        对象渲染器随后接入
      </div>
    </NodeViewWrapper>
  );
}

/** Placeholder card for a mindmap object block. */
export function AlterMindmapNodeView(props: ReactNodeViewProps) {
  return (
    <ObjectCard
      view={props}
      kind="mindmap"
      label="思维导图"
      title={attrText(props, 'caption')}
      description={undefined}
    />
  );
}

/** Placeholder card for a declarative component block. */
export function AlterComponentNodeView(props: ReactNodeViewProps) {
  return (
    <ObjectCard
      view={props}
      kind="component"
      label="交互组件"
      title={attrText(props, 'title')}
      description={attrText(props, 'description')}
    />
  );
}
