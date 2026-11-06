import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './Control.module.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className = '', ...props },
  ref,
) {
  return (
    <input
      {...props}
      ref={ref}
      className={`${styles.control} ${className}`}
      data-invalid={invalid || undefined}
      aria-invalid={invalid || undefined}
    />
  );
});
