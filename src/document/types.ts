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
