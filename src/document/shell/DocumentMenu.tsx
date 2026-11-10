/**
 * Document menu trigger (MoreHorizontal IconButton + `@alter/ui-system` Menu).
 *
 * The menu is presentational: the view builds the actions (copy link, new
 * child, export Markdown, archive/restore) so their handlers can use the view's
 * controlled title and archived state.
 *
 * @module @alter-dsh/space/document/shell/DocumentMenu
 */
import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { IconButton, Menu, type MenuAction } from '@alter/ui-system';

/** Props of {@link DocumentMenu}. */
export interface DocumentMenuProps {
  actions: MenuAction[];
}

/** Render the document menu trigger and its dropdown. */
export function DocumentMenu({ actions }: DocumentMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <IconButton
        label="文档菜单"
        icon={<MoreHorizontal />}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(event.currentTarget)}
      />
      <Menu
        anchor={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        align="end"
        width={196}
        actions={actions}
      />
    </>
  );
}
