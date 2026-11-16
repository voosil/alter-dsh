/**
 * 空间/页面引用：输入框内的引用 chip 与输入框上方的引用条。
 *
 * 已发送消息里的引用由 `cards.tsx` 的 `space-ref` UserText 规则渲染成卡片；
 * 这个模块补上「发送之前」的一段：
 *
 * - `spaceRefInsert` 把一条 link 变成 DSH 的 `ReferenceInsert`（source 固定为
 *   `space-ref`，与 UserText 规则 id 一致；`ref` 用 `spaceId:nodeId|space` 这种
 *   稳定可解析的格式，`clipboardText` 始终是规范链接本身）；
 * - 纯函数 `pasteRefsToDraft` / `toDetectSpan` / `uncoveredRefInDraft` 负责
 *   「粘贴多链接只转第一个 / 上限 20 / 去重 / caret 边界 / chip 坐标换算」；
 * - `registerSpaceRefComposer` 在会话作用域占住 `conversation.input.dock`，
 *   渲染引用条（引用 chip + × 删除 + 空态 + 上限提示），并把草稿里裸露的
 *   空间链接就地转成 chip；`autoReferenceSession` 供装配层在新建对话后自动
 *   带入引用。
 *
 * 两条写入通路都以 DSH 已核实的事实为准（实现处均有注释）：
 * 1. 会话作用域事件 `slash/input-insert-reference`：`ctx.sessions.scope(id)`
 *    返回的就是输入 shell 注册监听的那个 AgentContext，`bail` 时把该上下文
 *    作为 dispatch subject 传入即按会话过滤，返回 true 表示编辑器已插入；
 * 2. 降级方案：`inputActions.insertText` 把链接文本换成 `[页面] 名称` 可读文本
 *    （不含 chip），引用条仍然登记该引用。
 *
 * 引用登记只写 Host 的 chat 记录（`ChatStore.actions.setRefs`），不写 localStorage。
 * 本模块不得在运行时 import `@deepseek-ai/*`（自包含 bundle 规则）。
 */
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactElement, ReactNode } from 'react';
import { FileText, Orbit, Plus, X } from 'lucide-react';
import type { Chat, ChatRef, CreateChatRefInput } from '../chat/client';
import { pageLink, parseSpaceLink, spaceLink, type SpaceLinkRef } from '../chat/parse';
import type { ChatStore } from '../chat/store';
import { spaceBridge } from '../integration/bridge';
import {
  SPACE_REF_ARCHIVED_HINT,
  SPACE_REF_MISSING_HINT,
} from './cards';
import styles from './refs.module.css';

// --- 常量 -------------------------------------------------------------------

/**
 * 引用来源名，也是已发送消息的 UserText 规则 id（`cards.tsx` 的
 * `SPACE_REF_ID`）。两边必须一致：`refs.test.ts` 直接断言相等。
 */
export const SPACE_REF_SOURCE = 'space-ref';

/** 一个会话最多登记的引用数量。 */
export const SPACE_REF_LIMIT = 20;

/** 输入框上方引用条所在的槽位。 */
export const SPACE_REF_DOCK_SLOT = 'conversation.input.dock';

/** 引用条在槽位内的注册 id。 */
export const SPACE_REF_DOCK_ID = 'alter-space-refs';

/** 引用条在输入框 dock 列表里的顺序（在 todo/goal 之后）。 */
export const SPACE_REF_DOCK_ORDER = 20;

/** 会话作用域的 chip 插入事件（`@mode bail`，返回 true 表示编辑器已应用）。 */
export const SPACE_REF_INSERT_EVENT = 'slash/input-insert-reference';

/** 引用来源在触发菜单里的顺序（只是占位，不产生候选行）。 */
export const SPACE_REF_SOURCE_ORDER = 100;

/** 上限提示文案（引用条与装配层复用同一句）。 */
export const SPACE_REF_LIMIT_TEXT = `最多引用 ${SPACE_REF_LIMIT} 个空间或页面`;

/** 空态文案。 */
export const SPACE_REF_EMPTY_TEXT = '当前未引用空间或页面';

/** 空态里的选择入口（规范 §4.10）。 */
export const SPACE_REF_PICK_TEXT = '选择空间';

/** 「＋」入口的提示与无障碍名。 */
export const SPACE_REF_ADD_LABEL = '添加引用';

/** 选择面板的加载/失败文案（内联，不用 toast）。 */
export const SPACE_REF_PICK_LOADING = '正在读取可引用的空间与页面…';
export const SPACE_REF_PICK_FAILED = '读取空间与页面失败，请重试';

/** 插入失败（无法在当前位置放 chip）时说明。 */
export const SPACE_REF_INSERT_FAILED = '无法在这个位置插入引用，请把光标放到输入框后重试';

/** 选择面板可选的引用目标。 */
export interface SpaceRefPickTargets {
  readonly spaces: readonly { id: string; name: string }[];
  /** 最近打开的页面；没有时可以是空数组。 */
  readonly pages: readonly { id: string; spaceId: string; title: string }[];
}

/**
 * 读取「＋」选择面板的候选目标。装配层注入 Host 查询（空间列表 + 最近页面）；
 * 缺省时不渲染选择入口。
 */
export type SpaceRefTargetPicker = () => Promise<SpaceRefPickTargets | undefined>;

/** 删除引用后的内联提示；用户继续输入即消失（规范 §4.10）。 */
export const SPACE_REF_REMOVED_TEXT = '已移除引用';

/** 粘贴的链接指向不存在或不可见的对象：保留原文并内联说明（规范 §4.10）。 */
export const SPACE_REF_UNRECOGNIZED_TEXT = '无法识别该链接，或页面已删除/无权限';

/** 引用条标题（悬停提示里带上限）。 */
export const SPACE_REF_DOCK_LABEL = `空间/页面引用（最多 ${SPACE_REF_LIMIT} 个）`;

/** id 形状（与 `src/chat/parse.ts` 的 link 文法保持一致）。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** key 里的两段分隔符；spaceId/nodeId 都不含它。 */
const KEY_SEPARATOR = ':';

/** 空间级引用在 key 尾段的占位词。 */
const SPACE_KEY_MARKER = 'space';

// --- DSH 机制的结构类型（运行时从上下文拿，运行时不 import @deepseek-ai/*）---

/** `TokenSpan`：detect 坐标区间 + 草稿版本。 */
export interface TokenSpan {
  readonly start: number;
  readonly end: number;
  readonly draftRev: number;
}

/**
 * `ReferenceInsert`：编辑器 chip 的插入描述。
 *
 * `appearance` 显式给 undefined：空间/页面没有 DSH 内置的文件/会话字形。
 */
export interface SpaceReferenceInsert {
  readonly source: string;
  readonly ref: string;
  readonly label: string;
  readonly appearance?: 'session' | 'file' | 'folder' | undefined;
  /** 剪贴板/持久化投影，也是发送后 UserText 规则看到的原文。 */
  readonly clipboardText: string;
}

/** `Occurrence` 的结构子集：引用 chip 在剪贴板坐标里占的区间。 */
export interface SpaceRefOccurrence {
  readonly source: string;
  readonly ref: string;
  readonly offset: number;
  readonly length: number;
  readonly clipboardText: string;
}

/** `InputZone.input`（`InputState`）里本模块读到的字段。 */
export interface SpaceRefInputState {
  /** 剪贴板投影草稿（chip 展开成 clipboardText）。 */
  readonly draft: string;
  /** 单调递增的编辑器版本（span CAS 用）。 */
  readonly draftRev: number;
  /** 草稿里 chip 的区间（剪贴板坐标）。 */
  readonly occurrences: readonly SpaceRefOccurrence[];
  /** 提交相位；只读渲染时可能缺省。 */
  readonly phase?: 'plain' | 'adjudicating' | 'claimed' | 'submitting' | 'sending';
}

/** `InputZone.session`（`SessionSnapshot`）里本模块读到的字段。 */
export interface SpaceRefDockSession {
  readonly sessionId: string;
}

/** `InputActions` 里本模块用到的方法。 */
export interface SpaceRefInputActions {
  /** 当前选区的版本守卫快照。 */
  captureInsertion(): TokenSpan;
  /** 用普通文本替换一个区间（降级方案，不产生 chip）。 */
  insertText(text: string, span: TokenSpan): boolean;
}

/** 会话作用域上下文：只需要按 subject 过滤的 bail。 */
export interface SpaceRefScopedContext {
  bail(subject: unknown, name: string, request: unknown): unknown;
}

/** `ctx.sessions` 里本模块用到的方法。 */
export interface SpaceRefSessionsFace {
  scope(sessionId: string): SpaceRefScopedContext | undefined;
}

/** `ctx.slots` 的结构面。 */
export interface SpaceRefSlotsFace {
  inject(key: string, callback: () => () => void): () => void;
  register(options: Record<string, unknown>, component: unknown): () => void;
}

/** 触发源结构面（只为拿到 codec；不产生任何候选行）。 */
export interface SpaceRefTriggerSource {
  readonly trigger: '@';
  readonly name: string;
  readonly order?: number;
  readonly showGroupTitle?: boolean;
  candidates(
    session: SpaceRefDockSession,
    request: { readonly query: string; readonly signal: AbortSignal },
  ): Promise<readonly never[]>;
  onPick(pick: unknown): undefined;
  openReference?(
    session: SpaceRefDockSession,
    reference: { readonly ref: string; readonly appearance?: string },
  ): boolean;
  readonly codec: {
    clipboardText(ref: string): string;
    serialize(ref: string, signal: AbortSignal): Promise<string>;
  };
}

/** `ctx.inputTriggers` 的结构面。 */
export interface SpaceRefInputTriggersFace {
  registerSource(source: SpaceRefTriggerSource): () => void;
}

/** 注册引用 chip/引用条需要的客户端上下文面。 */
export interface SpaceRefComposerContext {
  readonly slots: SpaceRefSlotsFace;
  readonly sessions?: SpaceRefSessionsFace;
  /** 可显式传入；缺省时按需从 `get('inputTriggers')` 懒解析。 */
  readonly inputTriggers?: SpaceRefInputTriggersFace;
  readonly get?: (name: string) => unknown;
}

// --- 引用 key / link / 名称 --------------------------------------------------

/** 一条引用的稳定 key：页面用 `spaceId:nodeId`，空间用 `spaceId:space`。 */
export function spaceRefKey(ref: SpaceLinkRef): string {
  const nodeId = ref.kind === 'page' ? ref.nodeId : null;
  const tail = nodeId === null || nodeId === '' ? SPACE_KEY_MARKER : nodeId;
  return `${ref.spaceId}${KEY_SEPARATOR}${tail}`;
}

/**
 * 解析 {@link spaceRefKey} 产出的 key。
 *
 * 尾段是 `space` 时按空间引用解释：页面 id 恰好叫 `space` 的极端情形无法用
 * 这个 key 形式区分，此时以 chip 的 `clipboardText`（规范链接）为准。
 */
export function parseSpaceRefKey(key: string): SpaceLinkRef | null {
  const at = key.indexOf(KEY_SEPARATOR);
  if (at <= 0 || at >= key.length - 1) return null;
  const spaceId = key.slice(0, at);
  const tail = key.slice(at + 1);
  if (!ID_PATTERN.test(spaceId) || !ID_PATTERN.test(tail)) return null;
  return tail === SPACE_KEY_MARKER
    ? { kind: 'space', spaceId, nodeId: null }
    : { kind: 'page', spaceId, nodeId: tail };
}

/** 一条引用的规范链接（发送后由 `space-ref` 规则渲染成卡片）。 */
export function spaceRefLink(ref: SpaceLinkRef): string {
  return ref.kind === 'page' && ref.nodeId !== null && ref.nodeId !== ''
    ? pageLink(ref.spaceId, ref.nodeId)
    : spaceLink(ref.spaceId);
}

/** key → 规范链接；key 不可解析时原样返回（codec 的自洽兜底）。 */
function spaceRefLinkOfKey(key: string): string {
  const ref = parseSpaceRefKey(key);
  return ref === null ? key : spaceRefLink(ref);
}

/** 取 id 的尾段；空结果用兜底值。 */
function idTail(value: string, fallback: string): string {
  const tail = value.split('/').filter(Boolean).at(-1);
  return tail === undefined || tail === '' ? fallback : tail;
}

/**
 * P0 显示名：页面取 nodeId 尾段、空间取 spaceId 尾段，与已发送卡片的命名
 * 口径一致；可读名称由装配层通过 `label` 参数补。
 */
export function spaceRefDefaultLabel(ref: SpaceLinkRef): string {
  const raw = spaceRefLink(ref);
  if (ref.kind === 'page' && ref.nodeId !== null && ref.nodeId !== '') {
    return idTail(ref.nodeId, raw);
  }
  return idTail(ref.spaceId, raw);
}

/** 解析一条引用的显示名：显式 `label` 优先，否则用 id 尾段。 */
export function spaceRefLabel(ref: SpaceLinkRef, label?: string): string {
  const trimmed = label?.trim() ?? '';
  return trimmed === '' ? spaceRefDefaultLabel(ref) : trimmed;
}

/**
 * 一条 link → 编辑器 chip 的插入描述。
 * @param ref - 解析后的空间/页面引用。
 * @param label - 可读名称；缺省用 id 尾段。
 * @returns `ReferenceInsert`；`clipboardText` 是规范链接本身。
 */
export function spaceRefInsert(ref: SpaceLinkRef, label?: string): SpaceReferenceInsert {
  return {
    source: SPACE_REF_SOURCE,
    ref: spaceRefKey(ref),
    label: spaceRefLabel(ref, label),
    appearance: undefined,
    clipboardText: spaceRefLink(ref),
  };
}

/** 降级方案的可读文本：`[页面] 名称` / `[空间] 名称`。 */
export function spaceRefPlaceholderText(ref: SpaceLinkRef, label?: string): string {
  return `[${ref.kind === 'page' ? '页面' : '空间'}] ${spaceRefLabel(ref, label)}`;
}

// --- 去重与上限 --------------------------------------------------------------

/** 引用身份（与 ChatRef 的结构子集兼容）。 */
export interface SpaceRefLike {
  readonly kind: 'space' | 'page';
  readonly spaceId: string;
  readonly nodeId: string | null;
}

/** 一条引用的去重身份：kind + spaceId + nodeId。 */
export function spaceRefIdentity(ref: SpaceRefLike): string {
  return `${ref.kind}${KEY_SEPARATOR}${ref.spaceId}${KEY_SEPARATOR}${ref.nodeId ?? ''}`;
}

/** 合并结果。 */
export interface MergedRefs {
  /** 合并后的完整引用集合（既有在前，新增按入参顺序）。 */
  readonly refs: SpaceLinkRef[];
  /** 真正新增的引用。 */
  readonly added: SpaceLinkRef[];
}

/**
 * 去重并裁剪到上限的引用合并。
 * @param existing - 已登记的引用（顺序保留）。
 * @param incoming - 待登记的引用。
 * @param limit - 上限；默认 {@link SPACE_REF_LIMIT}。
 * @returns 完整集合与新增项；达到上限后不再追加。
 */
export function mergeRefs(
  existing: readonly SpaceRefLike[],
  incoming: readonly SpaceRefLike[],
  limit = SPACE_REF_LIMIT,
): MergedRefs {
  const capacity = Math.max(0, limit);
  const refs: SpaceLinkRef[] = [];
  const seen = new Set<string>();
  for (const ref of existing) {
    const identity = spaceRefIdentity(ref);
    if (seen.has(identity)) continue;
    if (refs.length >= capacity) break;
    seen.add(identity);
    refs.push({ kind: ref.kind, spaceId: ref.spaceId, nodeId: ref.nodeId });
  }
  const added: SpaceLinkRef[] = [];
  for (const ref of incoming) {
    if (refs.length >= capacity) break;
    const identity = spaceRefIdentity(ref);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const next: SpaceLinkRef = { kind: ref.kind, spaceId: ref.spaceId, nodeId: ref.nodeId };
    refs.push(next);
    added.push(next);
  }
  return { refs, added };
}

/** 引用 → Host 的 `CreateChatRefInput`。 */
export function spaceRefInputOf(ref: SpaceRefLike): CreateChatRefInput {
  return { kind: ref.kind, spaceId: ref.spaceId, nodeId: ref.nodeId };
}

// --- 草稿扫描 ----------------------------------------------------------------

/** 草稿里的一处空间引用。 */
export interface SpaceRefMatch {
  readonly ref: SpaceLinkRef;
  /** 命中的原始链接文本。 */
  readonly raw: string;
  /** 链接在草稿（剪贴板坐标）里的起点。 */
  readonly start: number;
  /** 链接在草稿（剪贴板坐标）里的终点（不含）。 */
  readonly end: number;
}

/** 草稿里全部空间链接，按出现顺序，同一引用只保留第一处。 */
export function refsInDraft(draft: string, from = 0): SpaceRefMatch[] {
  return scanRefs(draft, from).filter((match, index, all) => (
    all.findIndex((item) => spaceRefIdentity(item.ref) === spaceRefIdentity(match.ref)) === index
  ));
}

/**
 * 草稿里第一处「还没有变成 chip」的空间链接。
 * @param draft - 剪贴板投影草稿。
 * @param occurrences - 草稿里 chip 的剪贴板区间。
 * @returns 第一处裸露链接，或 null。
 */
export function uncoveredRefInDraft(
  draft: string,
  occurrences: readonly Pick<SpaceRefOccurrence, 'offset' | 'length'>[],
): SpaceRefMatch | null {
  for (const match of scanRefs(draft, 0)) {
    const covered = occurrences.some((occ) => (
      occ.offset <= match.start && occ.offset + occ.length >= match.end
    ));
    if (!covered) return match;
  }
  return null;
}

/** 不按引用去重的原始扫描（内部用）。 */
function scanRefs(draft: string, from: number): SpaceRefMatch[] {
  const matches: SpaceRefMatch[] = [];
  let cursor = from;
  while (cursor < draft.length) {
    const found = findLink(draft, cursor);
    if (found === null) break;
    matches.push(found);
    cursor = found.end;
  }
  return matches;
}

/** 取 `from` 之后的第一处链接；链接文法只有 `src/chat/parse.ts` 一份。 */
function findLink(draft: string, from: number): SpaceRefMatch | null {
  const pattern =
    /dsh-space:\/\/space\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\/page\/[A-Za-z0-9][A-Za-z0-9_-]*)?|#\/space\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\/doc\/[A-Za-z0-9][A-Za-z0-9_-]*)?/g;
  pattern.lastIndex = from;
  const match = pattern.exec(draft);
  if (match === null) return null;
  const ref = parseSpaceLink(match[0]);
  if (ref === null) return null;
  return { ref, raw: match[0], start: match.index, end: match.index + match[0].length };
}

// --- 坐标换算 ----------------------------------------------------------------

/** chip 在 detect 投影里固定占一个 U+FFFC。 */
const CHIP_DETECT_LENGTH = 1;

/**
 * 剪贴板坐标区间 → detect 坐标的 {@link TokenSpan}。
 *
 * 编辑器里 chip 在剪贴板投影里展开成 `clipboardText`、在 detect 投影里只占
 * 一个字符，所以 chip 之后的偏移要按 `length - 1` 前移。区间碰到/切开 chip
 * 时返回 null：那种区间没法做 CAS 替换。
 * @param occurrences - 草稿里 chip 的剪贴板区间。
 * @param start - 区间起点（剪贴板坐标）。
 * @param end - 区间终点（剪贴板坐标）。
 * @param draftRev - 草稿版本。
 * @returns detect 坐标 span，或 null。
 */
export function toDetectSpan(
  occurrences: readonly Pick<SpaceRefOccurrence, 'offset' | 'length'>[],
  start: number,
  end: number,
  draftRev: number,
): TokenSpan | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start) return null;
  let shift = 0;
  for (const occ of occurrences) {
    const occEnd = occ.offset + occ.length;
    if (occ.offset < end && occEnd > start) return null;
    if (occEnd <= start) shift += occ.length - CHIP_DETECT_LENGTH;
  }
  const detectStart = start - shift;
  const detectEnd = end - shift;
  if (detectStart < 0 || detectEnd <= detectStart) return null;
  return { start: detectStart, end: detectEnd, draftRev };
}

// --- 粘贴/输入转换（纯函数） --------------------------------------------------

/** {@link pasteRefsToDraft} 的可选项。 */
export interface PasteRefsOptions {
  /** 已登记的引用（去重与上限的基数）。 */
  readonly existing?: readonly SpaceRefLike[];
  /** 上限；默认 {@link SPACE_REF_LIMIT}。 */
  readonly limit?: number;
  /** 显式可读名称。 */
  readonly label?: (ref: SpaceLinkRef) => string | undefined;
  /** 降级文本的生成器；默认 {@link spaceRefPlaceholderText}。 */
  readonly placeholder?: (ref: SpaceLinkRef, label: string) => string;
}

/** {@link pasteRefsToDraft} 的结果。 */
export interface PasteRefsResult {
  /** 应用降级文本后的草稿；没有转换时原样返回。 */
  readonly draft: string;
  /** 调整后的 caret（超出原草稿时夹到边界内）。 */
  readonly caret: number;
  /** 本次唯一要转换的链接（chip 的目标）；空表示不转换。 */
  readonly converted: SpaceRefMatch | null;
  /** 替换 `converted` 的可读文本（降级方案写进草稿的那一段）；空表示不转换。 */
  readonly readable: string | null;
  /** 本次要登记的引用；已登记或超出上限时为 null。 */
  readonly registered: SpaceLinkRef | null;
  /** 允许集合里其余尚未登记的引用（顺序同草稿）。 */
  readonly remaining: readonly SpaceLinkRef[];
}

/**
 * 一次「粘贴/输入」转换的纯决策。
 *
 * 规则：
 * 1. 只转换一个：草稿里最先出现、且在允许集合（`refs`）里的那一处链接；
 * 2. 上限：已登记数达到上限时不再转换（`converted` 为 null）；
 * 3. 去重：目标已登记时照常转换（chip 仍会出现），但不重复登记；
 * 4. `remaining` 给出允许集合里其余尚未登记的引用，供调用方后续逐个处理；
 * 5. `readable` 是替换该链接的可读文本（降级方案原样写进草稿）。
 * @param draft - 当前草稿（剪贴板投影）。
 * @param caret - 当前 caret（剪贴板坐标）；用于换算替换后的 caret。
 * @param refs - 允许转换的引用集合；空集合表示什么都不转。
 * @param options - 既有引用、上限、名称与降级文本。
 * @returns 转换结果；`draft` 是降级文本形态。
 */
export function pasteRefsToDraft(
  draft: string,
  caret: number,
  refs: readonly SpaceRefLike[],
  options: PasteRefsOptions = {},
): PasteRefsResult {
  const limit = options.limit ?? SPACE_REF_LIMIT;
  const existing = options.existing ?? [];
  const clampedCaret = Number.isFinite(caret) ? Math.min(Math.max(0, Math.trunc(caret)), draft.length) : 0;
  const unchanged: PasteRefsResult = {
    draft,
    caret: clampedCaret,
    converted: null,
    readable: null,
    registered: null,
    remaining: [],
  };
  if (refs.length === 0) return unchanged;
  const allowed = new Set(refs.map((ref) => spaceRefIdentity(ref)));
  const found = scanRefs(draft, 0);
  const qualifying = found.filter((match) => allowed.has(spaceRefIdentity(match.ref)));
  if (qualifying.length === 0) return unchanged;
  const existingIds = new Set(existing.map((ref) => spaceRefIdentity(ref)));
  const capacity = Math.max(0, limit - existing.length);
  const fresh = qualifying.filter((match) => !existingIds.has(spaceRefIdentity(match.ref)));
  // 先算「还没登记的」再决定是否转换：达到上限时连转换也不做。
  if (capacity <= 0) {
    return { ...unchanged, remaining: fresh.map((match) => match.ref) };
  }
  const target = qualifying[0] as SpaceRefMatch;
  const targetIdentity = spaceRefIdentity(target.ref);
  const registered = existingIds.has(targetIdentity) ? null : target.ref;
  const remaining = fresh
    .filter((match) => spaceRefIdentity(match.ref) !== targetIdentity)
    .map((match) => match.ref);
  const label = spaceRefLabel(target.ref, options.label?.(target.ref));
  const replacement = options.placeholder === undefined
    ? spaceRefPlaceholderText(target.ref, label)
    : options.placeholder(target.ref, label);
  const nextDraft = `${draft.slice(0, target.start)}${replacement}${draft.slice(target.end)}`;
  const delta = replacement.length - (target.end - target.start);
  const nextCaret = clampedCaret >= target.end
    ? clampedCaret + delta
    : clampedCaret > target.start
      ? target.start + replacement.length
      : clampedCaret;
  return {
    draft: nextDraft,
    caret: Math.min(Math.max(0, nextCaret), nextDraft.length),
    converted: target,
    readable: replacement,
    registered,
    remaining,
  };
}

// --- 引用登记（Host chat 记录） ----------------------------------------------

/** 引用条/自动引用读写的模块级依赖（`registerSpaceRefComposer` 装配）。 */
interface ComposerRuntime {
  readonly ctx: SpaceRefComposerContext;
  readonly store: ChatStore;
  /** 粘贴转换前的目标校验；缺省时不做校验。 */
  readonly resolveTarget: SpaceRefTargetResolver | undefined;
  /** 「＋」选择面板的候选来源；缺省时不渲染选择入口。 */
  readonly pickTargets: SpaceRefTargetPicker | undefined;
  /** `space-ref` 触发源（codec）的注册结果；null 表示尚未/无法注册。 */
  sourceDispose: (() => void) | null;
}

/**
 * 粘贴转换前的目标校验：`true` 表示对象仍存在且对当前用户可见。
 * 装配层注入 Host 查询；缺省时不做校验（照常转换，失效由引用 state 派生）。
 */
export type SpaceRefTargetResolver = (ref: SpaceLinkRef) => Promise<boolean>;

let runtime: ComposerRuntime | null = null;

/** 待插入空草稿的自动引用（新建对话后由 `autoReferenceSession` 排队）。 */
const pendingAutoChips = new Map<string, SpaceLinkRef>();

/** 稳定的空引用集合（避免每次渲染换引用）。 */
const EMPTY_CHAT_REFS: readonly ChatRef[] = [];

/** 把引用集合写成 Host 记录（去重 + 上限）。 */
async function writeRefs(
  store: ChatStore,
  sessionId: string,
  refs: readonly SpaceRefLike[],
): Promise<boolean> {
  const chat = store.chatOfSession(sessionId);
  if (chat === undefined) return false;
  const merged = mergeRefs(chat.refs, refs);
  if (merged.added.length === 0) return false;
  await store.actions.setRefs(sessionId, merged.refs.map(spaceRefInputOf));
  return true;
}

/**
 * 供装配层调用：新建对话后自动带入一条引用。
 *
 * 写 Host 的 chat 记录（`setRefs`），并把该引用排进「待插 chip」队列 —— 引用条
 * 组件在该会话草稿为空时用 `captureInsertion()` + 会话作用域事件把 chip 插进
 * 输入框。会话没有 chat 记录时返回 false（没有可以登记引用的地方）。
 * @param sessionId - 目标 DSH 会话。
 * @param target - 引用目标：整个空间或一页。
 * @returns 是否写入了新引用（已登记过时返回 false，但 chip 仍会排入待插队列）。
 * @throws 当 Host 写入失败时拒绝；调用方按软失败处理（`.catch(() => undefined)`）。
 */
export async function autoReferenceSession(
  sessionId: string,
  target: {
    readonly kind: 'space' | 'page';
    readonly spaceId: string;
    readonly nodeId?: string | null;
  },
): Promise<boolean> {
  const current = runtime;
  if (current === null) return false;
  return applyAutoReference(current.store, sessionId, target);
}

/**
 * {@link autoReferenceSession} 的显式 store 版本（装配层可绕开模块级单例，
 * 也让单元测试不依赖装配顺序）。
 */
export async function applyAutoReference(
  store: ChatStore,
  sessionId: string,
  target: {
    readonly kind: 'space' | 'page';
    readonly spaceId: string;
    readonly nodeId?: string | null;
  },
): Promise<boolean> {
  if (store.chatOfSession(sessionId) === undefined) return false;
  const ref: SpaceLinkRef = {
    kind: target.kind,
    spaceId: target.spaceId,
    nodeId: target.kind === 'page' ? target.nodeId ?? null : null,
  };
  // 先写记录再排队：写入失败时不给空草稿留一枚「登记不上」的 chip。
  const written = await writeRefs(store, sessionId, [ref]);
  pendingAutoChips.set(sessionId, ref);
  return written;
}

// --- 会话作用域事件：插入 chip ----------------------------------------------

/** 取会话作用域上下文；会话未 retain 时为 undefined（无 shell 可插）。 */
function scopeOf(sessionId: string): SpaceRefScopedContext | undefined {
  const sessions = runtime?.ctx.sessions;
  if (sessions === undefined) return undefined;
  try {
    return sessions.scope(sessionId);
  } catch {
    // 会话代际已结束：当作没有 shell。
    return undefined;
  }
}

/** 懒解析并注册 `space-ref` 触发源（chip 的 codec 必须先就位）。 */
function ensureReferenceSource(): boolean {
  const current = runtime;
  if (current === null) return false;
  if (current.sourceDispose !== null) return true;
  const triggers = current.ctx.inputTriggers ?? resolveInputTriggers(current.ctx);
  if (triggers === undefined) return false;
  try {
    current.sourceDispose = triggers.registerSource(spaceRefTriggerSource);
    return true;
  } catch {
    return false;
  }
}

/** 从上下文按名字取 `inputTriggers`（不声明 inject，避免依赖装配顺序）。 */
function resolveInputTriggers(ctx: SpaceRefComposerContext): SpaceRefInputTriggersFace | undefined {
  if (typeof ctx.get !== 'function') return undefined;
  try {
    return ctx.get('inputTriggers') as SpaceRefInputTriggersFace | undefined;
  } catch {
    return undefined;
  }
}

/**
 * 在会话作用域里插入一枚引用 chip。
 *
 * 只有 codec 已就位（发送时能把 chip 序列化回规范链接）才会插入：否则发送会
 * 因为「没有 reference source 的序列化器」而失败。
 * @param sessionId - 目标会话。
 * @param reference - chip 描述。
 * @param span - detect 坐标区间（见 {@link toDetectSpan}）。
 * @returns 编辑器是否真的插入了。
 */
export function insertSpaceRefChip(
  sessionId: string,
  reference: SpaceReferenceInsert,
  span: TokenSpan,
): boolean {
  if (!ensureReferenceSource()) return false;
  const scoped = scopeOf(sessionId);
  if (scoped === undefined) return false;
  try {
    // 会话作用域 dispatch：把 scope 上下文同时当作 subject 和接收者，事件才会
    // 按会话过滤（`dsh-client-ui-conversation/src/client/input/hub.ts` 在
    // binding.ctx 上监听，正是 sessions.scope(id) 返回的那个上下文）。
    return scoped.bail(scoped, SPACE_REF_INSERT_EVENT, { reference, span }) === true;
  } catch {
    return false;
  }
}

/** `space-ref` 触发源：只提供 codec / chip 点击行为，不产生任何候选行。 */
const spaceRefTriggerSource: SpaceRefTriggerSource = {
  trigger: '@',
  name: SPACE_REF_SOURCE,
  order: SPACE_REF_SOURCE_ORDER,
  // 候选行为空：不渲染分组标题，避免在 @ 菜单里出现空标题行。
  showGroupTitle: false,
  candidates: () => Promise.resolve([]),
  onPick: () => undefined,
  openReference(_session, reference) {
    const ref = parseSpaceRefKey(reference.ref);
    if (ref === null) return false;
    const bridge = spaceBridge();
    if (bridge === null) return false;
    // A space chip opens the space entry; a page chip opens the page tab.
    bridge.openPageInRightbar({
      spaceId: ref.spaceId,
      nodeId: ref.kind === 'page' ? ref.nodeId : null,
    });
    return true;
  },
  codec: {
    // chip 的持久化投影就是规范链接本身：发送后由 `space-ref` 规则渲染卡片。
    clipboardText: (ref) => spaceRefLinkOfKey(ref),
    serialize: (ref) => Promise.resolve(spaceRefLinkOfKey(ref)),
  },
};

// --- 引用条组件 --------------------------------------------------------------

/** 引用条组件 props：`InputZone` 的 owner 面 + 会话标准钩子。 */
export interface SpaceRefDockProps {
  readonly session: SpaceRefDockSession;
  readonly input: SpaceRefInputState;
  readonly inputActions: SpaceRefInputActions;
}

/** 订阅 chat store（模块级单例，装配后才有值）。 */
function subscribeChats(listener: () => void): () => void {
  return runtime?.store.chats.subscribe(listener) ?? (() => undefined);
}

/** 读会话绑定的 chat 记录。 */
function useSessionChat(sessionId: string): Chat | undefined {
  return useSyncExternalStore(
    subscribeChats,
    () => runtime?.store.chatOfSession(sessionId),
    () => undefined,
  );
}

/** 错误对象 → 内联文案（不用 toast）。 */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : '请重试';
}

/** 渲染一枚引用 chip：图标 + 名称 + ×。 */
function renderRefChip(
  ref: ChatRef,
  removing: string | null,
  onRemove: (ref: ChatRef) => void,
): ReactElement {
  const page = ref.kind === 'page';
  const name = ref.label === '' ? spaceRefDefaultLabel(ref) : ref.label;
  const action = `移除引用：${name}`;
  const hint = ref.state === 'missing'
    ? SPACE_REF_MISSING_HINT
    : ref.state === 'archived'
      ? SPACE_REF_ARCHIVED_HINT
      : null;
  const link = spaceRefLink(ref);
  return createElement(
    'span',
    {
      key: ref.id,
      className: hint === null ? styles.chip : `${styles.chip} ${styles.chipFaded}`,
      title: hint === null ? link : `${hint}（${link}）`,
      'data-state': ref.state,
    },
    createElement(page ? FileText : Orbit, {
      className: styles.icon,
      size: 13,
      strokeWidth: 1.6,
      'aria-hidden': 'true',
    }),
    createElement('span', { className: styles.name }, name),
    createElement('span', { className: styles.tag }, page ? '页面' : '空间'),
    createElement(
      'button',
      {
        type: 'button',
        className: styles.remove,
        title: action,
        'aria-label': action,
        disabled: removing === ref.id,
        onClick: () => onRemove(ref),
      },
      createElement(X, { size: 12, strokeWidth: 2, 'aria-hidden': 'true' }),
    ),
  );
}

/**
 * 输入框上方的引用条。
 *
 * 只对「绑定了 Space 会话记录」的会话渲染（普通会话没有登记引用的地方，渲染
 * 空态只会是噪音）。副作用有两条，都走已核实的通路：
 * 1. 草稿里出现裸露的空间链接 → 就地转成 chip（每草稿版本最多一个，对应
 *    「粘贴多链接只转第一个」）；chip 通路不可用时用 `insertText` 换成
 *    `[页面] 名称` 可读文本；
 * 2. `autoReferenceSession` 排队的引用 → 空草稿时插入 chip。
 * @param props - 会话、输入状态与输入动作。
 * @returns 引用条；未绑定会话时为 null。
 */
export function SpaceRefDock(props: SpaceRefDockProps): ReactElement | null {
  const sessionId = props.session.sessionId;
  const chat = useSessionChat(sessionId);
  const refs = chat?.refs ?? EMPTY_CHAT_REFS;
  const draft = props.input.draft;
  const draftRev = props.input.draftRev;
  const occurrences = props.input.occurrences;
  const actions = props.inputActions;
  const [removing, setRemoving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickTargets, setPickTargets] = useState<SpaceRefPickTargets | null>(null);
  const lastDraft = useRef<string | null>(null);

  const removeRef = useCallback((ref: ChatRef): void => {
    const current = runtime;
    if (current === null) return;
    const record = current.store.chatOfSession(sessionId);
    if (record === undefined) return;
    setRemoving(ref.id);
    setNotice(null);
    const next = record.refs
      .filter((item) => item.id !== ref.id)
      .map((item) => spaceRefInputOf(item));
    void current.store.actions
      .setRefs(sessionId, next)
      .then(() => {
        setNotice(SPACE_REF_REMOVED_TEXT);
      })
      .catch((error: unknown) => {
        setNotice(`移除引用失败：${messageOf(error)}`);
      })
      .finally(() => {
        setRemoving(null);
      });
  }, [sessionId]);

  /**
   * 在光标处插入一枚引用 chip 并登记它。
   *
   * 只登记、不插 chip 是不行的：Agent 从消息正文里的链接得知「引用了什么」，
   * 引用条只是登记面，所以插入失败时不登记，并内联说明原因。
   */
  const addRef = useCallback((target: SpaceLinkRef): void => {
    const current = runtime;
    if (current === null) return;
    const record = current.store.chatOfSession(sessionId);
    if (record === undefined) return;
    if (record.refs.length >= SPACE_REF_LIMIT) {
      setNotice(SPACE_REF_LIMIT_TEXT);
      return;
    }
    const identity = spaceRefIdentity(target);
    if (record.refs.some((item) => spaceRefIdentity(item) === identity)) {
      // 已引用：不重复添加，收起面板即可（卡片就在条上）。
      setPickerOpen(false);
      return;
    }
    const span = actions.captureInsertion();
    if (!insertSpaceRefChip(sessionId, spaceRefInsert(target), span)) {
      setNotice(SPACE_REF_INSERT_FAILED);
      return;
    }
    const next = mergeRefs(record.refs, [target]);
    setNotice(null);
    setPickerOpen(false);
    void current.store.actions
      .setRefs(sessionId, next.refs.map(spaceRefInputOf))
      .catch((error: unknown) => {
        setNotice(`登记引用失败：${messageOf(error)}`);
      });
  }, [actions, sessionId]);

  /** 打开「＋」面板并读取候选目标；失败时面板内行内说明。 */
  const openPicker = useCallback((): void => {
    const current = runtime;
    if (current === null || current.pickTargets === undefined) return;
    setPickerOpen(true);
    setPickerError(null);
    if (pickTargets !== null) return;
    setPickerBusy(true);
    void current.pickTargets()
      .then((value) => {
        if (value === undefined) {
          setPickerError(SPACE_REF_PICK_FAILED);
          return;
        }
        setPickTargets(value);
      })
      .catch((error: unknown) => {
        setPickerError(`${SPACE_REF_PICK_FAILED}（${messageOf(error)}）`);
      })
      .finally(() => setPickerBusy(false));
  }, [pickTargets]);

  useEffect(() => {
    const current = runtime;
    if (current === null) return;
    const phase = props.input.phase;
    if (phase !== undefined && phase !== 'plain' && phase !== 'claimed') return;
    // 引用登记只对绑定了 chat 记录的会话可用；chip 本身对所有会话可用（chip 的
    // clipboardText 就是链接，发送后仍由 `space-ref` 规则渲染卡片）。
    const bound = chat !== undefined;

    // 1. 新建对话的自动引用：空草稿时把排队的 chip 插进去。
    const pending = pendingAutoChips.get(sessionId);
    if (pending !== undefined && draft.trim() === '') {
      const span = actions.captureInsertion();
      if (span.start === 0 && span.end === 0 && span.draftRev === draftRev) {
        if (insertSpaceRefChip(sessionId, spaceRefInsert(pending), span)) {
          pendingAutoChips.delete(sessionId);
        }
      }
    }

    // 2. 草稿里裸露的空间链接 → chip（chip 不可用时降级为可读文本）。
    //    chip 的 clipboardText 就是链接本身，所以插入成功后草稿文本不变；以
    //    「草稿文本是否变化」为闸门，一次变化最多转换一个链接 —— 这就是
    //    「粘贴多链接只转第一个」。
    const changed = lastDraft.current !== draft;
    lastDraft.current = draft;
    if (!changed) return;
    // 用户继续输入：上一条内联提示（含「已移除引用」）自然消失。
    setNotice(null);
    const link = uncoveredRefInDraft(draft, occurrences);
    if (link === null) return;
    // caret 只用于降级文本的落点换算；引用条不消费它（chip 走 span 替换），
    // 而 `InputState` 不带剪贴板坐标的 caret，所以按草稿末尾传入。
    const conversion = pasteRefsToDraft(draft, draft.length, [link.ref], {
      existing: chat?.refs ?? EMPTY_CHAT_REFS,
    });
    const converted = conversion.converted;
    if (converted === null) return; // 已达上限：保留链接文本，交给发送后的卡片。
    const span = toDetectSpan(occurrences, converted.start, converted.end, draftRev);
    /** 把链接换成 chip（或降级文本）并登记引用。 */
    const commit = (): void => {
      const chipped = span !== null
        && insertSpaceRefChip(sessionId, spaceRefInsert(converted.ref), span);
      if (!chipped) {
        // 降级方案（chip 通路不可用）：把链接换成 `[页面] 名称` 可读文本，引用条
        // 仍然登记该引用。没有 chat 记录时不降级 —— 换了文本又没有登记处，等于
        // 把链接丢了。rev 过期时 insertText 自己会拒绝，链接文本不受损。
        if (!bound || span === null || conversion.readable === null) return;
        actions.insertText(conversion.readable, span);
      }
      const registered = conversion.registered;
      if (!bound || registered === null) return;
      const nextRefs = mergeRefs(chat.refs, [registered]);
      if (nextRefs.added.length === 0) return;
      void current.store.actions
        .setRefs(sessionId, nextRefs.refs.map(spaceRefInputOf))
        .catch((error: unknown) => {
          setNotice(`登记引用失败：${messageOf(error)}`);
        });
    };
    const resolveTarget = current.resolveTarget;
    if (resolveTarget === undefined) {
      commit();
      return;
    }
    // 只有目标仍存在且可见才转换；否则保留原文并内联说明。校验结果回来前
    // 读者可能已经继续输入（`lastDraft` 变了），那就什么都不做，不覆盖新内容。
    const stillCurrent = (): boolean => lastDraft.current === draft;
    void resolveTarget(converted.ref)
      .then((visible) => {
        if (!stillCurrent()) return;
        if (visible) {
          commit();
          return;
        }
        setNotice(SPACE_REF_UNRECOGNIZED_TEXT);
      })
      .catch(() => {
        // 校验查询失败：按只读不到结果处理，照常转换（失效由引用 state 派生）。
        if (stillCurrent()) commit();
      });
  }, [chat, draft, draftRev, occurrences, props.input.phase, actions, sessionId]);

  if (chat === undefined) return null;

  /** 「＋」选择面板：空间与最近页面，行内展开（不用 toast）。 */
  const renderPicker = (): ReactElement => {
    const rows: ReactElement[] = [];
    if (pickerBusy) {
      rows.push(createElement('span', { key: 'busy', className: styles.pickerHint }, SPACE_REF_PICK_LOADING));
    } else if (pickerError !== null) {
      rows.push(createElement('span', { key: 'error', className: styles.noticeError }, pickerError));
    } else if (pickTargets !== null) {
      const spaces = pickTargets.spaces.filter(
        (space) => !referenced.has(spaceRefIdentity({ kind: 'space', spaceId: space.id, nodeId: null })),
      );
      const pages = pickTargets.pages.filter(
        (page) => !referenced.has(spaceRefIdentity({ kind: 'page', spaceId: page.spaceId, nodeId: page.id })),
      );
      if (spaces.length > 0) {
        rows.push(createElement('span', { key: 'spaces-title', className: styles.pickerGroup }, '空间'), ...spaces.map((space) => createElement(
          'button',
          {
            key: `space-${space.id}`,
            type: 'button',
            className: styles.pickerItem,
            onClick: () => addRef({ kind: 'space', spaceId: space.id, nodeId: null }),
          },
          space.name,
        )));
      }
      if (pages.length > 0) {
        rows.push(createElement('span', { key: 'pages-title', className: styles.pickerGroup }, '最近页面'), ...pages.map((page) => createElement(
          'button',
          {
            key: `page-${page.id}`,
            type: 'button',
            className: styles.pickerItem,
            title: page.title === '' ? '无标题' : page.title,
            onClick: () => addRef({ kind: 'page', spaceId: page.spaceId, nodeId: page.id }),
          },
          page.title === '' ? '无标题' : page.title,
        )));
      }
      if (rows.length === 0) {
        rows.push(createElement('span', { key: 'none', className: styles.pickerHint }, '没有可引用的空间或页面'));
      }
    }
    return createElement(
      'div',
      { className: styles.picker, role: 'group', 'aria-label': SPACE_REF_ADD_LABEL },
      ...rows,
    );
  };

  const capReached = refs.length >= SPACE_REF_LIMIT;
  const hint: ReactNode = notice ?? (capReached ? SPACE_REF_LIMIT_TEXT : null);
  const canPick = runtime?.pickTargets !== undefined;
  const referenced = new Set(refs.map((ref) => spaceRefIdentity(ref)));
  return createElement(
    'div',
    { className: styles.dock, 'data-space-refs': '' },
    createElement(
      'div',
      { className: styles.bar, title: SPACE_REF_DOCK_LABEL },
      createElement('span', { className: styles.label }, '引用'),
      refs.length === 0
        ? createElement(
          'span',
          { className: styles.empty },
          SPACE_REF_EMPTY_TEXT,
          canPick
            ? createElement(
              'button',
              {
                type: 'button',
                className: styles.pickEntry,
                title: SPACE_REF_PICK_TEXT,
                onClick: openPicker,
              },
              SPACE_REF_PICK_TEXT,
            )
            : null,
        )
        : createElement(
          'div',
          { className: styles.chips },
          ...refs.map((ref) => renderRefChip(ref, removing, removeRef)),
          canPick && !capReached
            ? createElement(
              'button',
              {
                type: 'button',
                className: styles.addButton,
                title: SPACE_REF_ADD_LABEL,
                'aria-label': SPACE_REF_ADD_LABEL,
                'aria-expanded': pickerOpen,
                onClick: () => {
                  if (pickerOpen) setPickerOpen(false);
                  else openPicker();
                },
              },
              createElement(Plus, { size: 12, strokeWidth: 2, 'aria-hidden': true }),
            )
            : null,
        ),
      hint === null
        ? null
        : createElement(
          'span',
          { className: notice === null ? styles.notice : `${styles.notice} ${styles.noticeError}` },
          hint,
        ),
    ),
    pickerOpen ? renderPicker() : null,
  );
}

// --- 注册入口 ----------------------------------------------------------------

/** 注册引用 chip/引用条需要的依赖。 */
export interface SpaceRefComposerDeps {
  /** 客户端上下文（slots + sessions + 可选 inputTriggers）。 */
  readonly ctx: SpaceRefComposerContext;
  /** chat store 单例（`createChatStore`），引用登记的唯一权威。 */
  readonly store: ChatStore;
  /**
   * 粘贴转换前的目标校验（可选的 Host 查询）。返回 false 时保留链接原文并
   * 内联提示；查询本身失败时照常转换（不因一次网络错误挡住可用的链接）。
   */
  readonly resolveTarget?: SpaceRefTargetResolver;
  /**
   * 「＋」选择面板的候选来源（空间列表 + 最近页面）。缺省时引用条只展示已登记
   * 的引用，不渲染「＋」与空态里的选择入口。
   */
  readonly pickTargets?: SpaceRefTargetPicker;
}

/**
 * 注册「输入框内引用 chip + 引用条」。
 *
 * 做三件事：占住 `conversation.input.dock` 渲染引用条；懒注册 `space-ref`
 * 触发源（提供 chip → 链接的 codec）；把 store/ctx 交给模块级运行时供
 * `autoReferenceSession` 使用。
 * @param deps - 客户端上下文与 chat store。
 * @returns 一个 cleanup，按注册的逆序拆除。
 */
export function registerSpaceRefComposer(deps: SpaceRefComposerDeps): () => void {
  const previous = runtime;
  const state: ComposerRuntime = {
    ctx: deps.ctx,
    store: deps.store,
    resolveTarget: deps.resolveTarget,
    pickTargets: deps.pickTargets,
    sourceDispose: null,
  };
  runtime = state;
  let disposeDock: (() => void) | null = null;
  deps.ctx.slots.inject(SPACE_REF_DOCK_SLOT, () => {
    const dispose = deps.ctx.slots.register(
      {
        name: SPACE_REF_DOCK_SLOT,
        id: SPACE_REF_DOCK_ID,
        order: SPACE_REF_DOCK_ORDER,
      },
      SpaceRefDock,
    );
    disposeDock = dispose;
    return dispose;
  });
  // 立即尝试注册 codec：chip 点击（openReference）在第一次插入之前就可用。
  ensureReferenceSource();
  return () => {
    disposeDock?.();
    disposeDock = null;
    state.sourceDispose?.();
    state.sourceDispose = null;
    pendingAutoChips.clear();
    runtime = previous;
  };
}
