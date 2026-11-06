import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import styles from './IconButton.module.css';

export type TooltipPlacement = 'top' | 'right' | 'bottom' | 'left';
export type IconButtonSize = 'sm' | 'md';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  tooltip?: string;
  size?: IconButtonSize;
  tooltipPlacement?: TooltipPlacement;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon,
      tooltip = label,
      size = 'md',
      className = '',
      tooltipPlacement = 'bottom',
      type = 'button',
      'aria-expanded': ariaExpanded,
      ...props
    },
    ref,
  ) {
    const button = (
      <button
        {...props}
        ref={ref}
        type={type}
        aria-label={label}
        aria-expanded={ariaExpanded}
        className={`${styles.button} ${className}`}
        data-size={size}
      >
        {icon}
      </button>
    );

    if (!tooltip) {
      return button;
    }

    /**
     * 展开状态只关掉提示，不改变组件结构：换回裸按钮会让 React 卸载当前的
     * 按钮节点，调用方在 onClick 里拿到的 anchor 随即脱离文档，菜单就会
     * 量到 0 尺寸并跑到左上角。
     */
    return (
      <TooltipPrimitive.Provider delayDuration={400}>
        <TooltipPrimitive.Root open={ariaExpanded === true ? false : undefined}>
          <TooltipPrimitive.Trigger asChild>{button}</TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              side={tooltipPlacement}
              sideOffset={6}
              collisionPadding={8}
              className={styles.tooltip}
            >
              {tooltip}
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
    );
  },
);
