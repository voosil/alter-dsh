import { Fragment, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import styles from './Menu.module.css';

export interface MenuAnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 菜单定位目标：普通菜单用触发元素；嵌在父浮层里的子菜单改用父浮层的
 * 边缘矩形，让菜单贴着父浮层外侧展开，而不是盖在父浮层上面。
 */
export type MenuAnchor = HTMLElement | MenuAnchorRect;

type AnchorRect = MenuAnchorRect;

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  active?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  anchor: MenuAnchor | null;
  open: boolean;
  onClose: () => void;
  actions: MenuAction[];
  align?: 'start' | 'end';
  /** 展开方向：默认在锚点下方；`right` 用于贴在父浮层右侧的子菜单。 */
  side?: 'bottom' | 'right';
  width?: number;
  heading?: string;
}

export function Menu({
  anchor,
  open,
  onClose,
  actions,
  align = 'start',
  side = 'bottom',
  width = 196,
  heading,
}: MenuProps) {
  const anchorRect = anchorRectFor(anchor, open);

  return (
    <DropdownMenuPrimitive.Root
      open={open}
      onOpenChange={onClose}
      modal={false}
    >
      {createPortal(
        <DropdownMenuPrimitive.Trigger asChild>
          <button
            type="button"
            className={styles.anchor}
            style={
              anchorRect
                ? {
                    top: anchorRect.top,
                    left: anchorRect.left,
                    width: anchorRect.width,
                    height: anchorRect.height,
                  }
                : undefined
            }
            tabIndex={-1}
            aria-hidden="true"
          />
        </DropdownMenuPrimitive.Trigger>,
        document.body,
      )}
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          side={side}
          align={align}
          sideOffset={5}
          collisionPadding={8}
          className={styles.panel}
          style={{ width }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {heading ? (
            <DropdownMenuPrimitive.Label className={styles.heading}>
              {heading}
            </DropdownMenuPrimitive.Label>
          ) : null}
          {actions.map((action) => (
            <Fragment key={action.id}>
              {action.separatorBefore ? (
                <DropdownMenuPrimitive.Separator className={styles.separator} />
              ) : null}
              <DropdownMenuPrimitive.Item
                className={styles.item}
                data-danger={action.danger || undefined}
                data-active={action.active || undefined}
                disabled={action.disabled}
                onSelect={() => action.onSelect()}
              >
                {action.icon ? (
                  <span className={styles.icon} aria-hidden="true">
                    {action.icon}
                  </span>
                ) : null}
                <span>{action.label}</span>
              </DropdownMenuPrimitive.Item>
            </Fragment>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/**
 * 菜单位置来自锚点元素的实际矩形。锚点一旦脱离文档，`getBoundingClientRect`
 * 会返回全 0，菜单就会贴到视口左上角；这里对同一个锚点沿用上一次量到的位置。
 */
const anchorRects = new WeakMap<HTMLElement, AnchorRect>();

function anchorRectFor(
  anchor: MenuAnchor | null,
  open: boolean,
): AnchorRect | null {
  if (!open || !anchor) return null;
  if (!isElement(anchor)) return anchor;
  const measured = measureAnchor(anchor);
  if (measured) {
    anchorRects.set(anchor, measured);
    return measured;
  }
  return anchorRects.get(anchor) ?? null;
}

function isElement(anchor: MenuAnchor): anchor is HTMLElement {
  return typeof HTMLElement !== 'undefined' && anchor instanceof HTMLElement;
}

function measureAnchor(element: HTMLElement): AnchorRect | null {
  if (!element.isConnected) return null;
  const { top, left, width, height } = element.getBoundingClientRect();
  if (!width && !height && !top && !left) return null;
  return { top, left, width, height };
}
