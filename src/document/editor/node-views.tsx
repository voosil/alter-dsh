/**
 * React node views for the custom Alter blocks.
 *
 * - `alterCallout` keeps its child blocks editable (`NodeViewContent`).
 * - `alterImage` / `alterMindmap` / `alterComponent` are atoms: they render a
 *   safe placeholder card (asset / object id + title) instead of executing
 *   anything. Object renderers are out of scope for v0.
 * - `alterBookmark` / `alterDocLink` are atom link cards: a web card opens its
 *   URL in a new tab, an internal card navigates through the Space router. The
 *   Space context is optional so the views degrade to read-only previews
 *   instead of throwing when no provider is mounted.
 *
 * Styling lives in `AlterTiptapEditor.module.css` and uses the shared
 * `--alter-*` design tokens.
 *
 * @module @alter-dsh/space/document/editor/node-views
 */
import { useContext, type MouseEvent } from 'react';
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from '@tiptap/react';
import styles from './AlterTiptapEditor.module.css';
import { documentAssetUrl } from '../asset-url';
import { SpaceContext } from '../../../vendor/ui-space/src/runtime';
import { docPath } from '../../../vendor/ui-space/src/space-route';

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
  const assetId = attrText(props, 'assetId');
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
        {assetId ?? '（缺少资产 id）'}
        {width === undefined ? '' : ` · 宽 ${width}`}
      </div>
      <div className={styles.objectPlaceholder} contentEditable={false}>
        {assetId === undefined ? (
          '（缺少资产 id）'
        ) : (
          <img
            className={styles.objectImage}
            src={documentAssetUrl(assetId)}
            alt={alt ?? '图片'}
          />
        )}
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

/** Parse an http(s) URL; anything else must never be opened as a link card. */
function safeWebUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Space context is optional so a node view never throws outside the app. */
function useOptionalSpaceContext() {
  return useContext(SpaceContext);
}

/** Whether a click landed on an inner control (delete button), not the card. */
function clickedControl(event: MouseEvent<HTMLDivElement>): boolean {
  const target = event.target;
  return target instanceof Element && target.closest('button') !== null;
}

/** Link card for an external web page; clicking it opens the URL in a new tab. */
export function AlterBookmarkNodeView(props: ReactNodeViewProps) {
  const url = attrText(props, 'url');
  const title = attrText(props, 'title');
  const description = attrText(props, 'description');
  const icon = attrText(props, 'icon');
  const webUrl = safeWebUrl(url);
  const host = webUrl?.host;
  const label = title ?? host ?? url ?? '网页链接';
  const open = (event: MouseEvent<HTMLDivElement>) => {
    if (
      typeof window === 'undefined' ||
      url === undefined ||
      webUrl === undefined
    )
      return;
    if (clickedControl(event)) return;
    window.open(url, '_blank', 'noopener');
  };
  return (
    <NodeViewWrapper
      as="div"
      className={styles.objectCard}
      data-kind="bookmark"
      data-selected={props.selected ? 'true' : undefined}
      contentEditable={false}
      onClick={open}
    >
      <div className={styles.objectHead} contentEditable={false}>
        <span className={styles.objectKind} aria-hidden="true">
          {icon ?? '🔗'}
        </span>
        <span className={styles.objectTitle}>{label}</span>
        <RemoveButton label="删除网页链接卡" onRemove={props.deleteNode} />
      </div>
      <div className={styles.objectMeta} contentEditable={false}>
        {host ?? url ?? '（缺少链接）'}
      </div>
      {description === undefined ? null : (
        <div className={styles.objectHint} contentEditable={false}>
          {description}
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** Link card for an internal document; clicking it navigates in the Space app. */
export function AlterDocLinkNodeView(props: ReactNodeViewProps) {
  const context = useOptionalSpaceContext();
  const docId = attrText(props, 'docId');
  const title = attrText(props, 'title');
  const label = title ?? docId ?? '文档内链';
  const interactive = context !== null && docId !== undefined;
  const open = (event: MouseEvent<HTMLDivElement>) => {
    if (context === null || docId === undefined) return;
    if (clickedControl(event)) return;
    context.router.navigate(docPath(context.spaceId, docId));
  };
  return (
    <NodeViewWrapper
      as="div"
      className={styles.objectCard}
      data-kind="docLink"
      data-interactive={interactive ? 'true' : 'false'}
      data-selected={props.selected ? 'true' : undefined}
      contentEditable={false}
      onClick={open}
    >
      <div className={styles.objectHead} contentEditable={false}>
        <span className={styles.objectKind} aria-hidden="true">
          📄
        </span>
        <span className={styles.objectTitle}>{label}</span>
        <RemoveButton label="删除文档内链卡" onRemove={props.deleteNode} />
      </div>
      <div className={styles.objectMeta} contentEditable={false}>
        {docId === undefined ? '（缺少文档 id）' : `文档 · ${docId}`}
      </div>
    </NodeViewWrapper>
  );
}
