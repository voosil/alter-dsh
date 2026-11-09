import { useState, type ReactNode } from 'react';
import { documentAssetUrl } from './asset-url';
import type { AlterDoc, BlockNode, InlineNode, Mark } from './types';
import styles from './AlterDocumentView.module.css';

function safeHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(href)) return href;
  return undefined;
}

/** Wrap one text run with its marks, innermost first. */
function markedText(text: string, marks: Mark[] | undefined, key: string): ReactNode {
  let node: ReactNode = text;
  if (marks === undefined) return node;
  const ordered = [...marks].sort((left, right) => {
    const order = ['code', 'underline', 'highlight', 'strike', 'italic', 'bold', 'link'];
    return order.indexOf(left.type) - order.indexOf(right.type);
  });
  for (const mark of ordered) {
    switch (mark.type) {
      case 'bold':
        node = <strong>{node}</strong>;
        break;
      case 'italic':
        node = <em>{node}</em>;
        break;
      case 'underline':
        node = <u>{node}</u>;
        break;
      case 'strike':
        node = <s>{node}</s>;
        break;
      case 'code':
        node = <code>{node}</code>;
        break;
      case 'highlight':
        node = <mark>{node}</mark>;
        break;
      case 'link': {
        const href = safeHref(mark.attrs?.href);
        node = href === undefined ? node : <a href={href}>{node}</a>;
        break;
      }
    }
  }
  return <span key={key}>{node}</span>;
}

/** Render inline content of one textblock. */
export function renderInlineContent(content: InlineNode[] | undefined): ReactNode {
  if (content === undefined || content.length === 0) return null;
  return content.map((node, index) => {
    const key = `inline-${index}`;
    if (node.type === 'hardBreak') return <br key={key} />;
    return markedText(node.text, node.marks, key);
  });
}

function plainText(content: InlineNode[] | undefined): string {
  if (content === undefined) return '';
  return content
    .map((node) => (node.type === 'text' ? node.text : '\n'))
    .join('');
}

function children(block: BlockNode): ReactNode {
  return (block.children ?? []).map((child) => renderBlock(child));
}

function renderList(block: BlockNode, ordered: boolean, task: boolean): ReactNode {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={task ? styles.taskList : styles.list}>
      {(block.children ?? []).map((item) => {
        const checked = item.attrs.checked === true;
        return (
          <li key={item.id} className={task ? styles.taskItem : undefined}>
            {task ? (
              <span className={styles.checkbox} aria-hidden="true">
                {checked ? '☑' : '☐'}
              </span>
            ) : null}
            {children(item)}
          </li>
        );
      })}
    </Tag>
  );
}

function renderTable(block: BlockNode): ReactNode {
  const rows = block.children ?? [];
  const headerRows =
    typeof block.attrs.headerRows === 'number' ? block.attrs.headerRows : 1;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.id}>
              {(row.children ?? []).map((cell) => {
                const header = rowIndex < headerRows;
                const Tag = header ? 'th' : 'td';
                return (
                  <Tag key={cell.id} className={styles.cell}>
                    {renderInlineContent(cell.content)}
                  </Tag>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function objectPlaceholder(
  block: BlockNode,
  kind: 'mindmap' | 'component',
): ReactNode {
  const objectId = block.attrs.objectId;
  const label = kind === 'mindmap' ? '思维导图' : '交互组件';
  const title =
    kind === 'mindmap'
      ? typeof block.attrs.caption === 'string'
        ? block.attrs.caption
        : undefined
      : typeof block.attrs.title === 'string'
        ? block.attrs.title
        : undefined;
  return (
    <div className={styles.objectCard} data-object-kind={kind}>
      <div className={styles.objectHead}>
        <span className={styles.objectKind}>{label}</span>
        {title === undefined ? null : <span className={styles.objectTitle}>{title}</span>}
      </div>
      <div className={styles.objectMeta}>
        {typeof objectId === 'string' ? objectId : '（无对象）'}
      </div>
      <div className={styles.objectHint}>对象渲染器随后接入</div>
    </div>
  );
}

function AssetFigure({
  assetId,
  alt,
  caption,
}: {
  assetId: string | undefined;
  alt: string;
  caption: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = assetId !== undefined && !failed;
  return (
    <figure className={styles.imageCard}>
      {showImage ? (
        <img
          className={styles.image}
          src={documentAssetUrl(assetId)}
          alt={alt}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className={styles.imagePlaceholder}>{alt || '图片'}</div>
      )}
      <figcaption className={styles.imageMeta}>
        {assetId ?? '（无资产）'}
        {caption === undefined ? '' : ` · ${caption}`}
      </figcaption>
    </figure>
  );
}

function renderBlock(block: BlockNode): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <p key={block.id} className={styles.paragraph}>
          {renderInlineContent(block.content)}
        </p>
      );
    case 'heading': {
      const level = typeof block.attrs.level === 'number' ? block.attrs.level : 1;
      const Tag = `h${Math.min(6, Math.max(1, level))}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag key={block.id} className={styles.heading} data-level={level}>
          {renderInlineContent(block.content)}
        </Tag>
      );
    }
    case 'bulletList':
      return <div key={block.id}>{renderList(block, false, false)}</div>;
    case 'orderedList':
      return <div key={block.id}>{renderList(block, true, false)}</div>;
    case 'taskList':
      return <div key={block.id}>{renderList(block, false, true)}</div>;
    case 'blockquote':
      return (
        <blockquote key={block.id} className={styles.quote}>
          {children(block)}
        </blockquote>
      );
    case 'codeBlock': {
      const lang = typeof block.attrs.lang === 'string' ? block.attrs.lang : undefined;
      return (
        <pre key={block.id} className={styles.codeBlock}>
          <code data-lang={lang}>{plainText(block.content)}</code>
        </pre>
      );
    }
    case 'divider':
      return <hr key={block.id} className={styles.divider} />;
    case 'table':
      return <div key={block.id}>{renderTable(block)}</div>;
    case 'image': {
      const alt = typeof block.attrs.alt === 'string' ? block.attrs.alt : '';
      const assetId =
        typeof block.attrs.assetId === 'string' ? block.attrs.assetId : undefined;
      return (
        <AssetFigure
          key={block.id}
          assetId={assetId}
          alt={alt}
          caption={
            typeof block.attrs.caption === 'string' ? block.attrs.caption : undefined
          }
        />
      );
    }
    case 'callout': {
      const tone = typeof block.attrs.tone === 'string' ? block.attrs.tone : 'info';
      const title = typeof block.attrs.title === 'string' ? block.attrs.title : undefined;
      return (
        <div key={block.id} className={styles.callout} data-tone={tone}>
          {title === undefined ? null : <div className={styles.calloutTitle}>{title}</div>}
          <div className={styles.calloutBody}>{children(block)}</div>
        </div>
      );
    }
    case 'mindmap':
      return <div key={block.id}>{objectPlaceholder(block, 'mindmap')}</div>;
    case 'component':
      return <div key={block.id}>{objectPlaceholder(block, 'component')}</div>;
    default:
      return (
        <div key={block.id} className={styles.opaque}>
          [unsupported node: {block.type}]
        </div>
      );
  }
}

/** Render one AlterDoc's block tree (pure; used by SSR tests too). */
export function DocumentContent({ doc }: { doc: AlterDoc }) {
  return (
    <div className={styles.content} data-revision={doc.revision}>
      {doc.blocks.map((block) => renderBlock(block))}
    </div>
  );
}
