import type { ComponentProps, ReactNode } from 'react';
import styles from './NavigationButton.module.css';

export type NavigationButtonProps = Omit<
  ComponentProps<'button'>,
  'children' | 'aria-label'
> & {
  label: string;
  icon: ReactNode;
};

export function NavigationButton({
  label,
  icon,
  className = '',
  type = 'button',
  ...props
}: NavigationButtonProps) {
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      className={`${styles.button} ${className}`}
    >
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.label} aria-hidden="true">
        {label}
      </span>
    </button>
  );
}
