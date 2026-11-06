import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import styles from './Dialog.module.css';

export type DialogSize = 'small' | 'medium' | 'large' | 'wide';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  hideClose?: boolean;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'medium',
  hideClose = false,
  className = '',
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onClose}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content
          className={`${styles.panel} ${styles[size]} ${className}`}
          data-size={size}
          aria-describedby={undefined}
        >
          <header className={styles.header}>
            <DialogPrimitive.Title className={styles.title}>
              {title}
            </DialogPrimitive.Title>
            {hideClose ? null : (
              <button
                type="button"
                className={styles.close}
                aria-label="关闭"
                onClick={onClose}
              >
                <CloseIcon />
              </button>
            )}
          </header>
          <div className={styles.body}>{children}</div>
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
