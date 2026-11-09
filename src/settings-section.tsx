/**
 * Section shell shared by the settings page and its storage section: the left
 * intro column carries the title, the right body the rows. Keeping this in one
 * place is what makes every settings section line up on the same two rails.
 */
import type { ReactNode } from 'react';
import styles from './settings.module.css';

export interface SettingsSectionProps {
  /** Id prefix for the section and its title, e.g. `settings-archive`. */
  id: string;
  title: string;
  children: ReactNode;
}

export function SettingsSection({ id, title, children }: SettingsSectionProps) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.sectionIntro}>
        <h2 className={styles.sectionTitle} id={`${id}-title`}>
          {title}
        </h2>
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}
