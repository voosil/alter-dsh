/**
 * Frozen stylesheet class names for the AST-native kernel.
 *
 * The document editor's stylesheet (`vendor/ui-space/.../Editor.module.css`) is
 * **CSS Modules**: the build hashes every local class (`surface` →
 * `surface_88ste_5`). The frozen page receives the hashed names through its
 * own `styles.*` import; a kernel that hard-codes `class="surface"` renders completely
 * unstyled — no body typography, no card shells, no menu look.
 *
 * This module is the one place that resolves the hashes, so the kernel's DOM
 * carries exactly the class names the frozen CSS expects. The literal names are
 * imported read-only: the kernel never defines or edits the frozen stylesheet,
 * it only attaches to it.
 *
 * @module @alter-dsh/space/document/editors/tiptap/classes
 */
import editorStyles from '@alter/ui-space/components/editor/Editor.module.css';

/**
 * Read one local class name, falling back to its source name.
 *
 * The stylesheet is the frozen UI's; a loader that does not evaluate CSS
 * Modules (e.g. a bare-script smoke test) still gets a usable, stable value
 * instead of `undefined`, so class-dependent logic never crashes.
 */
function local(name: string): string {
  const resolved = editorStyles[name];
  return typeof resolved === 'string' && resolved !== '' ? resolved : name;
}

/** Every frozen class the kernel attaches to its own DOM. */
export const KERNEL_CLASS = {
  /** Relative-position context + the link-card arrow variable. */
  editor: local('editor'),
  /** Editable body container: block typography, placeholder, selection. */
  surface: local('surface'),
  /** Floating format bar shell. */
  floating: local('floating'),
  /** One format-bar button. */
  toolButton: local('toolButton'),
  /** Format-bar group divider. */
  toolDivider: local('toolDivider'),
  /** Selected-character counter bubble. */
  wordCount: local('wordCount'),
  /** Slash menu shell. */
  slashMenu: local('slashMenu'),
  /** One slash-menu row. */
  slashItem: local('slashItem'),
  /** Slash-menu icon wrapper. */
  slashIcon: local('slashIcon'),
  /** Slash-menu empty state. */
  slashEmpty: local('slashEmpty'),
  /** Dark action bar shared by links and tables. */
  linkBar: local('linkBar'),
  /** Link edit form (page-owned dialog body). */
  linkForm: local('linkForm'),
  /** One labelled field inside the link form. */
  linkField: local('linkField'),
  /** Inline validation text inside the link form. */
  linkError: local('linkError'),
} as const;