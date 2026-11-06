import { PanelLeft } from 'lucide-react';
import { useSpaceContext } from '../runtime';
import styles from './DirectoryButton.module.css';

export function DirectoryButton() {
  const { openDirectory } = useSpaceContext();
  return (
    <button
      type="button"
      className={styles.button}
      aria-label="打开空间目录"
      title="打开空间目录"
      onClick={openDirectory}
    >
      <PanelLeft size={16} strokeWidth={1.6} />
    </button>
  );
}
