import { useMemo, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import styles from './Popover.module.css';

export type PopoverLayer = 'base' | 'modal';

export interface PopoverProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
  role?: string;
  ariaLabel?: string;
  layer?: PopoverLayer;
  flush?: boolean;
  container?: HTMLElement | null;
}

export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'start',
  width = 200,
  className = '',
  role = 'dialog',
  ariaLabel,
  layer = 'base',
  flush = false,
  container,
}: PopoverProps) {
  const virtualRef = useMemo(() => ({ current: anchor }), [anchor]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onClose}>
      <PopoverPrimitive.Anchor virtualRef={virtualRef} />
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          side="bottom"
          align={align}
          sideOffset={5}
          collisionPadding={8}
          role={role}
          aria-label={ariaLabel}
          className={`${styles.panel} ${className}`}
          style={{ width }}
          data-layer={layer}
          data-flush={flush}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
