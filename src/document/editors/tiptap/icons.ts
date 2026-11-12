/**
 * Icon geometry for kernel-owned menus and cards.
 *
 * The frozen editor draws these with `lucide-react`; the kernel is DOM-only
 * (no React), so it carries the same geometry as data. The shapes are the
 * exact `node` arrays of lucide-react 1.60.0
 * (ISC), which keeps the menus visually identical to the frozen UI.
 *
 * @module @alter-dsh/space/document/editors/tiptap/icons
 */

/** One child element of a lucide icon (`path`, `rect`, `circle`, …). */
export interface IconChild {
  tag: string;
  attrs: Readonly<Record<string, string>>;
}

/** Icon names the kernel needs, matching the frozen editor's imports. */
export const ICON_NAMES = [
  'text',
  'type',
  'heading1',
  'heading2',
  'heading3',
  'list',
  'listOrdered',
  'listTodo',
  'quote',
  'code2',
  'minus',
  'table2',
  'imagePlus',
  'paperclip',
  'bold',
  'underline',
  'strikethrough',
  'highlighter',
  'messageSquarePlus',
] as const;

/** One icon name. */
export type IconName = (typeof ICON_NAMES)[number];

/** Lucide geometry per icon (lucide's `__iconData.node`). */
export const ICON_CHILDREN: Readonly<Record<IconName, readonly IconChild[]>> = {
  text: [
    { tag: 'path', attrs: {"d":"M21 5H3"} },
    { tag: 'path', attrs: {"d":"M15 12H3"} },
    { tag: 'path', attrs: {"d":"M17 19H3"} },
  ],
  type: [
    { tag: 'path', attrs: {"d":"M12 4v16"} },
    { tag: 'path', attrs: {"d":"M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"} },
    { tag: 'path', attrs: {"d":"M9 20h6"} },
  ],
  heading1: [
    { tag: 'path', attrs: {"d":"M4 12h8"} },
    { tag: 'path', attrs: {"d":"M4 18V6"} },
    { tag: 'path', attrs: {"d":"M12 18V6"} },
    { tag: 'path', attrs: {"d":"m17 12 3-2v8"} },
  ],
  heading2: [
    { tag: 'path', attrs: {"d":"M4 12h8"} },
    { tag: 'path', attrs: {"d":"M4 18V6"} },
    { tag: 'path', attrs: {"d":"M12 18V6"} },
    { tag: 'path', attrs: {"d":"M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"} },
  ],
  heading3: [
    { tag: 'path', attrs: {"d":"M4 12h8"} },
    { tag: 'path', attrs: {"d":"M4 18V6"} },
    { tag: 'path', attrs: {"d":"M12 18V6"} },
    { tag: 'path', attrs: {"d":"M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"} },
    { tag: 'path', attrs: {"d":"M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"} },
  ],
  list: [
    { tag: 'path', attrs: {"d":"M3 5h.01"} },
    { tag: 'path', attrs: {"d":"M3 12h.01"} },
    { tag: 'path', attrs: {"d":"M3 19h.01"} },
    { tag: 'path', attrs: {"d":"M8 5h13"} },
    { tag: 'path', attrs: {"d":"M8 12h13"} },
    { tag: 'path', attrs: {"d":"M8 19h13"} },
  ],
  listOrdered: [
    { tag: 'path', attrs: {"d":"M11 5h10"} },
    { tag: 'path', attrs: {"d":"M11 12h10"} },
    { tag: 'path', attrs: {"d":"M11 19h10"} },
    { tag: 'path', attrs: {"d":"M4 4h1v5"} },
    { tag: 'path', attrs: {"d":"M4 9h2"} },
    { tag: 'path', attrs: {"d":"M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"} },
  ],
  listTodo: [
    { tag: 'path', attrs: {"d":"M13 5h8"} },
    { tag: 'path', attrs: {"d":"M13 12h8"} },
    { tag: 'path', attrs: {"d":"M13 19h8"} },
    { tag: 'path', attrs: {"d":"m3 17 2 2 4-4"} },
    { tag: 'rect', attrs: {"x":"3","y":"4","width":"6","height":"6","rx":"1"} },
  ],
  quote: [
    { tag: 'path', attrs: {"d":"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"} },
    { tag: 'path', attrs: {"d":"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"} },
  ],
  code2: [
    { tag: 'path', attrs: {"d":"m18 16 4-4-4-4"} },
    { tag: 'path', attrs: {"d":"m6 8-4 4 4 4"} },
    { tag: 'path', attrs: {"d":"m14.5 4-5 16"} },
  ],
  minus: [
    { tag: 'path', attrs: {"d":"M5 12h14"} },
  ],
  table2: [
    { tag: 'path', attrs: {"d":"M3 9h18"} },
    { tag: 'path', attrs: {"d":"M9 3v18"} },
    { tag: 'rect', attrs: {"x":"3","y":"3","width":"18","height":"18","rx":"2"} },
  ],
  imagePlus: [
    { tag: 'path', attrs: {"d":"M16 5h6"} },
    { tag: 'path', attrs: {"d":"M19 2v6"} },
    { tag: 'path', attrs: {"d":"M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"} },
    { tag: 'path', attrs: {"d":"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"} },
    { tag: 'circle', attrs: {"cx":"9","cy":"9","r":"2"} },
  ],
  paperclip: [
    { tag: 'path', attrs: {"d":"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"} },
  ],
  bold: [
    { tag: 'path', attrs: {"d":"M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"} },
  ],
  underline: [
    { tag: 'path', attrs: {"d":"M6 4v6a6 6 0 0 0 12 0V4"} },
    { tag: 'line', attrs: {"x1":"4","x2":"20","y1":"20","y2":"20"} },
  ],
  strikethrough: [
    { tag: 'path', attrs: {"d":"M16 4H9a3 3 0 0 0-2.83 4"} },
    { tag: 'path', attrs: {"d":"M14 12a4 4 0 0 1 0 8H6"} },
    { tag: 'line', attrs: {"x1":"4","x2":"20","y1":"12","y2":"12"} },
  ],
  highlighter: [
    { tag: 'path', attrs: {"d":"m9 11-6 6v3h9l3-3"} },
    { tag: 'path', attrs: {"d":"m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"} },
  ],
  messageSquarePlus: [
    { tag: 'path', attrs: {"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"} },
    { tag: 'path', attrs: {"d":"M12 8v6"} },
    { tag: 'path', attrs: {"d":"M9 11h6"} },
  ],
};

/** Lucide's own name per icon, used for the `svg` class (`lucide-bold`). */
export const ICON_LUCIDE_NAME: Readonly<Record<IconName, string>> = {
  text: 'text-align-start',
  type: 'type',
  heading1: 'heading-1',
  heading2: 'heading-2',
  heading3: 'heading-3',
  list: 'list',
  listOrdered: 'list-ordered',
  listTodo: 'list-todo',
  quote: 'quote',
  code2: 'code-xml',
  minus: 'minus',
  table2: 'table-2',
  imagePlus: 'image-plus',
  paperclip: 'paperclip',
  bold: 'bold',
  underline: 'underline',
  strikethrough: 'strikethrough',
  highlighter: 'highlighter',
  messageSquarePlus: 'message-square-plus',
};

/** Options of {@link createIcon}. */
export interface CreateIconOptions {
  /** Square size in px (lucide default 24; the toolbar passes 15). */
  size?: number;
  /** Stroke width (lucide default 2; the frozen UI uses 1.6–1.8). */
  strokeWidth?: number;
}

/**
 * Create one lucide-shaped `svg` element.
 *
 * The attribute set mirrors what `lucide-react` renders (namespace, 24 box,
 * `fill="none"`, `stroke="currentColor"`, round caps, `lucide lucide-<name>`
 * class), so the frozen stylesheet's size/stroke overrides hit the same DOM.
 */
export function createIcon(
  name: IconName,
  options: CreateIconOptions = {},
): SVGSVGElement {
  const size = options.size ?? 24;
  const strokeWidth = options.strokeWidth ?? 2;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `lucide lucide-${ICON_LUCIDE_NAME[name]}`);
  for (const child of ICON_CHILDREN[name]) {
    const element = document.createElementNS(
      'http://www.w3.org/2000/svg',
      child.tag,
    );
    for (const [attribute, value] of Object.entries(child.attrs)) {
      element.setAttribute(attribute, value);
    }
    svg.append(element);
  }
  return svg;
}
