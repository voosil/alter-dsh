import { forwardRef, type TextareaHTMLAttributes } from 'react';
import styles from './Control.module.css';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ invalid = false, className = '', ...props }, ref) {
    return (
      <textarea
        {...props}
        ref={ref}
        className={`${styles.control} ${styles.textarea} ${className}`}
        data-invalid={invalid || undefined}
        aria-invalid={invalid || undefined}
      />
    );
  },
);
