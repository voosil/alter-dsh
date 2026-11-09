/**
 * Browser-side structural types for the Alter document AST.
 *
 * The Host owns the authoritative schema; the client only needs the subset it
 * renders (and, later, edits). Keep this file structural: importing Host code
 * into the browser bundle would pull Node types into the client graph.
 *
 * @module @alter-dsh/space/document/types
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Mark {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight' | 'link';
  attrs?: { href?: string };
}

export type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'hardBreak' };

export interface BlockNode {
  id: string;
  type: string;
  attrs: Record<string, JsonValue>;
  content?: InlineNode[];
  children?: BlockNode[];
}

export interface AlterDoc {
  format: 'alter-doc/1';
  schemaVersion: number;
  revision: number;
  blocks: BlockNode[];
}

/** Result of the Host `doc.get` endpoint. */
export interface DocumentSnapshot {
  docId: string;
  revision: number;
  title: string;
  doc: AlterDoc;
}

/** One exact text edit inside a textblock's plain text. */
export interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

/** Client-side structural mirror of the Host operation union. */
export type Operation =
  | {
      op: 'insert_blocks';
      parent?: string | null;
      after?: string;
      index?: number;
      blocks?: BlockNode[];
      markdown?: string;
    }
  | {
      op: 'insert_markdown';
      parent?: string | null;
      after?: string;
      index?: number;
      markdown: string;
    }
  | {
      op: 'replace_block';
      target: string;
      blocks?: BlockNode[];
      markdown?: string;
    }
  | { op: 'update_text'; target: string; edits: TextEdit[] }
  | {
      op: 'update_attrs';
      target: string;
      attrs: Record<string, JsonValue | null>;
    }
  | {
      op: 'move_block';
      target: string;
      parent?: string | null;
      after?: string;
      index?: number;
    }
  | { op: 'delete_block'; target: string; mode?: 'remove' | 'unwrap' }
  | {
      op: 'transform_block';
      target: string;
      to: string;
      attrs?: Record<string, JsonValue>;
    }
  | { op: 'update_object'; target: string; payload: JsonValue };
