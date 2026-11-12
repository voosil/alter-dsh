/**
 * Slash-menu command table.
 *
 * The frozen editor answers `/` at the start of a line with the same block
 * commands; parity means the same ids, labels, search keywords and order, so a
 * user's muscle memory and typed query keep working after the kernel swap.
 * `table-plain` (表格（无表头）) is the one deliberate addition: the frozen
 * editor could only insert a table with a header row.
 *
 * This table is data only: what a command *does* is the kernel's job
 * (`editors/tiptap/slash.ts`), and how it looks is the frozen stylesheet's
 * (`.slashMenu` / `.slashItem`).
 *
 * @module @alter-dsh/space/document/editors/slash-commands
 */

/** One insertable block command. */
export interface SlashCommand {
  id: string;
  label: string;
  /** Search terms (English + Chinese) matched case-insensitively. */
  keywords: readonly string[];
  /**
   * How the command changes the line:
   * - `block`: turn the line into an AST block type;
   * - `table`: insert a table followed by an empty paragraph;
   * - `image` / `file`: open the file picker and insert an asset.
   */
  kind: 'block' | 'table' | 'image' | 'file';
  /** AST node the command turns the current line into (`kind === 'block'`). */
  node?:
    | 'paragraph'
    | 'heading'
    | 'bulletList'
    | 'orderedList'
    | 'taskList'
    | 'blockquote'
    | 'codeBlock'
    | 'divider';
  /** Heading level when `node === 'heading'`. */
  level?: number;
  /**
   * Header rows of an inserted table (`kind === 'table'`).
   *
   * `1` is the frozen table (one header row + two body rows); `0` inserts a
   * plain 3x3 table whose cells are all body cells.
   */
  headerRows?: number;
}

/** The command list, in the frozen editor's display order. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'text', label: '正文', keywords: ['text', 'paragraph', '正文', '段落'], kind: 'block', node: 'paragraph' },
  { id: 'h1', label: '标题 1', keywords: ['h1', 'heading1', '标题', '一级'], kind: 'block', node: 'heading', level: 1 },
  { id: 'h2', label: '标题 2', keywords: ['h2', 'heading2', '标题', '二级'], kind: 'block', node: 'heading', level: 2 },
  { id: 'h3', label: '标题 3', keywords: ['h3', 'heading3', '标题', '三级'], kind: 'block', node: 'heading', level: 3 },
  { id: 'bullet', label: '无序列表', keywords: ['bullet', 'list', 'ul', '列表', '无序'], kind: 'block', node: 'bulletList' },
  { id: 'ordered', label: '有序列表', keywords: ['number', 'ordered', 'ol', '列表', '有序'], kind: 'block', node: 'orderedList' },
  { id: 'todo', label: '待办', keywords: ['todo', 'task', 'checkbox', '待办', '事项'], kind: 'block', node: 'taskList' },
  { id: 'quote', label: '引用', keywords: ['quote', 'blockquote', '引用', '>', '》'], kind: 'block', node: 'blockquote' },
  { id: 'code', label: '代码块', keywords: ['code', '代码'], kind: 'block', node: 'codeBlock' },
  { id: 'divider', label: '分割线', keywords: ['divider', 'hr', '分割线'], kind: 'block', node: 'divider' },
  { id: 'table', label: '表格', keywords: ['table', '表格'], kind: 'table', headerRows: 1 },
  { id: 'table-plain', label: '表格（无表头）', keywords: ['table', 'plain', '无表头', '表格'], kind: 'table', headerRows: 0 },
  { id: 'image', label: '图片', keywords: ['image', 'img', '图片'], kind: 'image' },
  { id: 'file', label: '文件', keywords: ['file', 'attachment', '文件', '附件'], kind: 'file' },
] as const;

/** Whether `query` appears in `text` as an in-order subsequence. */
export function isSubsequence(query: string, text: string): boolean {
  if (query === '') return true;
  let cursor = 0;
  for (const character of text) {
    if (character === query[cursor]) cursor += 1;
    if (cursor === query.length) return true;
  }
  return false;
}

/**
 * Match rank of one command for a query (`null` = not offered).
 *
 * Parity with the frozen editor: every candidate (id, label, keywords) is
 * scored exact > prefix > substring > subsequence, the best score wins, and a
 * lower rank sorts first. The subsequence tier is what makes `/wdxl` find
 * 无序列表, so dropping it would silently remove a search behavior users rely on.
 */
export function commandMatchRank(
  command: SlashCommand,
  query: string,
): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return 0;
  let best: number | null = null;
  for (const candidate of [command.id, command.label, ...command.keywords]) {
    const text = candidate.toLowerCase();
    let rank: number | null = null;
    if (text === needle) rank = 0;
    else if (text.startsWith(needle)) rank = 1;
    else if (text.includes(needle)) rank = 2;
    else if (isSubsequence(needle, text)) rank = 3;
    if (rank !== null && (best === null || rank < best)) best = rank;
    if (best === 0) break;
  }
  return best;
}

/** Filter and rank commands for a typed query; empty query keeps all. */
export function filterSlashCommands(
  query: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  if (query.trim() === '') return [...commands];
  return commands
    .map((command, index) => ({
      command,
      index,
      rank: commandMatchRank(command, query),
    }))
    .filter(
      (entry): entry is { command: SlashCommand; index: number; rank: number } =>
        entry.rank !== null,
    )
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.command);
}