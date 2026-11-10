/**
 * React node views for the custom Alter blocks.
 *
 * - `alterCallout` keeps its child blocks editable (`NodeViewContent`).
 * - `alterImage` is an atom with an inline attribute editor (alt / caption /
 *   CSS width); `alterFile` is a downloadable attachment card; `alterMindmap`
 *   opens the tree editor through a window event; `alterComponent` previews a
 *   validated built-in declarative component and asks the editor surface to
 *   edit its props. Object payloads never enter the editor document.
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
import { useContext, useState, type MouseEvent, type ReactNode } from 'react';
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { getComponentDefinition, type ComponentPayload } from '@alter/protocol';
import styles from './AlterTiptapEditor.module.css';
import { documentAssetUrl } from '../asset-url';
import {
  MINDMAP_EDIT_EVENT,
  type MindmapEditRequest,
} from '../objects/mindmap';
import {
  COMPONENT_EDIT_EVENT,
  ComponentFallbackCard,
  ComponentRenderer,
  useComponentObjectState,
  type ComponentEditRequest,
} from '../components';
import componentStyles from '../components/components.module.css';
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

/** Read a finite number node attribute. */
function attrNumber(props: ReactNodeViewProps, key: string): number | undefined {
  const value = (props.node.attrs as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Human-readable byte size for file cards. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * CSS width values accepted for `image.width` (empty clears the attribute).
 * Only fixed units and `auto` are allowed; anything that could smuggle CSS
 * (functions, `calc`, `url`, `;`) is rejected.
 */
const IMAGE_WIDTH_PATTERN = /^(?:\d+(?:\.\d+)?(?:px|%|rem|em|vw|vh|ch)|auto)$/;

/** Readable validation error for an image width value, if any. */
export function validateImageWidth(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > 32) return '宽度值过长（最多 32 个字符）';
  if (!IMAGE_WIDTH_PATTERN.test(trimmed)) {
    return '宽度格式不正确：支持 320px、50%、12rem 或 auto';
  }
  return undefined;
}

/** Normalize an image width input: trimmed value, or null when empty. */
export function normalizeImageWidth(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

/** Editable card for an image block: preview plus alt/caption/width editor. */
export function AlterImageNodeView(props: ReactNodeViewProps) {
  const alt = attrText(props, 'alt');
  const caption = attrText(props, 'caption');
  const width = attrText(props, 'width');
  const assetId = attrText(props, 'assetId');
  const editable = props.editor.isEditable;
  const [editing, setEditing] = useState(false);
  const [draftAlt, setDraftAlt] = useState('');
  const [draftCaption, setDraftCaption] = useState('');
  const [draftWidth, setDraftWidth] = useState('');
  const [error, setError] = useState<string | null>(null);

  const openEditor = (): void => {
    setDraftAlt(alt ?? '');
    setDraftCaption(caption ?? '');
    setDraftWidth(width ?? '');
    setError(null);
    setEditing(true);
  };

  const save = (): void => {
    const widthError = validateImageWidth(draftWidth);
    if (widthError !== undefined) {
      setError(widthError);
      return;
    }
    // `updateAttributes` creates a normal editor transaction: the autosave
    // diff turns it into `update_attrs` for the Host.
    props.updateAttributes({
      alt: draftAlt.trim() === '' ? null : draftAlt.trim(),
      caption: draftCaption.trim() === '' ? null : draftCaption.trim(),
      width: normalizeImageWidth(draftWidth),
    });
    setEditing(false);
  };

  return (
    <NodeViewWrapper
      as="div"
      className={styles.objectCard}
      data-kind="image"
      data-selected={props.selected ? 'true' : undefined}
      contentEditable={false}
    >
      <div className={styles.objectHead} contentEditable={false}>
        <span className={styles.objectKind}>图片</span>
        <span className={styles.objectTitle}>{alt ?? '图片块'}</span>
        {editable ? (
          <button
            type="button"
            className={styles.objectEdit}
            aria-label="编辑图片"
            title="编辑图片属性"
            onClick={openEditor}
          >
            编辑
          </button>
        ) : null}
        <RemoveButton label="删除图片块" onRemove={props.deleteNode} />
      </div>
      {editing ? (
        <div className={styles.objectPanel} contentEditable={false}>
          <label className={styles.objectField}>
            <span>替代文本</span>
            <input
              className={styles.objectInput}
              aria-label="替代文本"
              value={draftAlt}
              maxLength={500}
              onChange={(event) => setDraftAlt(event.target.value)}
            />
          </label>
          <label className={styles.objectField}>
            <span>图片说明</span>
            <input
              className={styles.objectInput}
              aria-label="图片说明"
              value={draftCaption}
              maxLength={500}
              onChange={(event) => setDraftCaption(event.target.value)}
            />
          </label>
          <label className={styles.objectField}>
            <span>宽度</span>
            <input
              className={styles.objectInput}
              aria-label="图片宽度"
              placeholder="如 320px 或 50%"
              value={draftWidth}
              maxLength={32}
              onChange={(event) => setDraftWidth(event.target.value)}
            />
          </label>
          {error === null ? null : (
            <p className={styles.objectError} role="alert">
              {error}
            </p>
          )}
          <div className={styles.objectPanelActions}>
            <button
              type="button"
              className={styles.objectRemove}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.objectSave}
              aria-label="保存图片属性"
              onClick={save}
            >
              保存
            </button>
          </div>
        </div>
      ) : null}
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
            style={width === undefined ? undefined : { width }}
            src={documentAssetUrl(assetId)}
            alt={alt ?? '图片'}
          />
        )}
      </div>
      {caption === undefined ? null : (
        <div className={styles.objectCaptionLine} contentEditable={false}>
          {caption}
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** Downloadable file card: name, mime, size and an attachment link. */
export function AlterFileNodeView(props: ReactNodeViewProps) {
  const name = attrText(props, 'name') ?? '附件';
  const mime = attrText(props, 'mime');
  const assetId = attrText(props, 'assetId');
  const bytes = attrNumber(props, 'bytes');
  return (
    <NodeViewWrapper
      as="div"
      className={styles.objectCard}
      data-kind="file"
      data-selected={props.selected ? 'true' : undefined}
      contentEditable={false}
    >
      <div className={styles.objectHead} contentEditable={false}>
        <span className={styles.objectKind} aria-hidden="true">
          📎
        </span>
        <span className={styles.objectTitle}>{name}</span>
        <RemoveButton label="删除文件卡" onRemove={props.deleteNode} />
      </div>
      <div className={styles.objectMeta} contentEditable={false}>
        {mime ?? '未知类型'}
        {bytes === undefined ? '' : ` · ${formatFileSize(bytes)}`}
      </div>
      <div className={styles.objectActions} contentEditable={false}>
        {assetId === undefined ? (
          <span className={styles.objectHint}>（缺少资产 id）</span>
        ) : (
          <a
            className={styles.objectDownload}
            href={documentAssetUrl(assetId)}
            download={name}
            rel="noopener noreferrer"
          >
            下载附件
          </a>
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
  /** Optional header action (mindmap edit entry). */
  action?: ReactNode;
  /** Placeholder body text. */
  hint?: string;
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
        {props.action}
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
        {props.hint ?? '对象渲染器随后接入'}
      </div>
    </NodeViewWrapper>
  );
}

/** Edit entry of a mindmap card: asks the editor surface to open the dialog. */
function MindmapEditButton({
  view,
  objectId,
}: {
  view: ReactNodeViewProps;
  objectId: string | undefined;
}) {
  if (objectId === undefined || !view.editor.isEditable) return null;
  const blockId = attrText(view, 'blockId');
  return (
    <button
      type="button"
      className={styles.objectEdit}
      aria-label="编辑思维导图"
      title="编辑思维导图"
      onClick={() => {
        if (typeof window === 'undefined') return;
        const detail: MindmapEditRequest = {
          objectId,
          ...(blockId === undefined ? {} : { blockId }),
        };
        window.dispatchEvent(
          new CustomEvent<MindmapEditRequest>(MINDMAP_EDIT_EVENT, { detail }),
        );
      }}
    >
      编辑思维导图
    </button>
  );
}

/** Mindmap card with the tree-editor entry; payload stays in the object side table. */
export function AlterMindmapNodeView(props: ReactNodeViewProps) {
  const objectId = attrText(props, 'objectId');
  return (
    <ObjectCard
      view={props}
      kind="mindmap"
      label="思维导图"
      title={attrText(props, 'caption')}
      description={undefined}
      action={<MindmapEditButton view={props} objectId={objectId} />}
      hint={
        props.editor.isEditable
          ? '点击「编辑思维导图」编辑内容'
          : '思维导图对象（只读）'
      }
    />
  );
}

/** Edit entry of a component card: asks the editor surface to open its form. */
function ComponentEditButton({
  view,
  objectId,
  payload,
}: {
  view: ReactNodeViewProps;
  objectId: string | undefined;
  payload: ComponentPayload | undefined;
}) {
  if (objectId === undefined || !view.editor.isEditable) return null;
  const blockId = attrText(view, 'blockId');
  return (
    <button
      type="button"
      className={styles.objectEdit}
      aria-label="编辑组件"
      title="编辑组件"
      onClick={() => {
        if (typeof window === 'undefined') return;
        const detail: ComponentEditRequest = {
          objectId,
          ...(blockId === undefined ? {} : { blockId }),
          ...(payload === undefined ? {} : { payload }),
        };
        window.dispatchEvent(
          new CustomEvent<ComponentEditRequest>(COMPONENT_EDIT_EVENT, {
            detail,
          }),
        );
      }}
    >
      编辑组件
    </button>
  );
}

/**
 * Declarative component card: safe built-in preview plus a props editor entry.
 * The payload is loaded by the editor surface through `object.get` and shared
 * through the component object cache; an unknown/broken payload degrades to a
 * readable card instead of crashing the editor.
 */
export function AlterComponentNodeView(props: ReactNodeViewProps) {
  const objectId = attrText(props, 'objectId');
  const objectState = useComponentObjectState(objectId);
  const payload =
    objectState?.status === 'ready' ? objectState.payload : undefined;
  const definition =
    payload === undefined ? undefined : getComponentDefinition(payload.componentId);
  const title = attrText(props, 'title') ?? definition?.name;
  const description = attrText(props, 'description');
  return (
    <NodeViewWrapper
      as="div"
      className={styles.objectCard}
      data-kind="component"
      data-selected={props.selected ? 'true' : undefined}
    >
      <div className={styles.objectHead} contentEditable={false}>
        <span className={styles.objectKind}>交互组件</span>
        <span className={styles.objectTitle}>{title ?? objectId ?? '组件块'}</span>
        <ComponentEditButton
          view={props}
          objectId={objectId}
          payload={payload}
        />
        <RemoveButton
          label="删除交互组件块"
          onRemove={props.deleteNode}
        />
      </div>
      <div className={styles.objectMeta} contentEditable={false}>
        {payload === undefined
          ? objectId ?? '（缺少对象 id）'
          : `${payload.componentId} · v${payload.componentVersion}`}
      </div>
      {description === undefined ? null : (
        <div className={styles.objectHint} contentEditable={false}>
          {description}
        </div>
      )}
      <div
        className={componentStyles.preview}
        data-component-preview="true"
        contentEditable={false}
      >
        {objectId === undefined ? (
          <div className={componentStyles.previewMuted}>（缺少对象 id）</div>
        ) : objectState === undefined || objectState.status === 'loading' ? (
          <div className={componentStyles.previewMuted}>正在加载组件…</div>
        ) : objectState.status === 'error' ? (
          <ComponentFallbackCard message={objectState.message} />
        ) : (
          <ComponentRenderer
            payload={objectState.payload}
            readOnly={!props.editor.isEditable}
          />
        )}
      </div>
    </NodeViewWrapper>
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
