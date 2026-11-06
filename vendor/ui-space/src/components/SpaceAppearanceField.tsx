import { Check } from 'lucide-react';
import { spaceColorOptions, spaceIconOptions } from './space-icons';
import styles from './SpaceAppearanceField.module.css';

/**
 * 空间图标与颜色选择。创建空间与空间配置共用同一套选项和交互。
 */
export function SpaceAppearanceField({
  icon,
  color,
  onIconChange,
  onColorChange,
  label = '图标',
}: {
  icon: string;
  color: string;
  onIconChange: (icon: string) => void;
  onColorChange: (color: string) => void;
  label?: string;
}) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.iconPalette} role="group" aria-label="空间图标">
        {spaceIconOptions.map((option) => {
          const OptionIcon = option.icon;
          const selected = icon === option.id;
          return (
            <button
              key={option.id}
              type="button"
              className={styles.iconOption}
              aria-label={`图标：${option.label}`}
              aria-pressed={selected}
              data-selected={selected || undefined}
              style={selected ? { color, background: `${color}1a` } : undefined}
              onClick={() => onIconChange(option.id)}
            >
              <OptionIcon size={17} strokeWidth={1.7} />
            </button>
          );
        })}
      </div>
      <div className={styles.colorPalette} role="group" aria-label="图标颜色">
        {spaceColorOptions.map((option) => {
          const selected = color === option.value;
          return (
            <button
              key={option.id}
              type="button"
              className={styles.colorOption}
              aria-label={`颜色：${option.label}`}
              aria-pressed={selected}
              data-selected={selected || undefined}
              style={{ background: option.value }}
              onClick={() => onColorChange(option.value)}
            >
              {selected ? (
                <Check size={11} strokeWidth={2.4} aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
