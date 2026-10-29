import styles from "./LoadingIndicator.module.css";

export function LoadingIndicator({ label = "Loading…", size = "small" }: {
  label?: string;
  size?: "small" | "large";
}) {
  return <span className={`${styles.indicator} ${size === "large" ? styles.large : ""}`} role="status" aria-live="polite" aria-atomic="true">
    <span className={styles.spinner} aria-hidden="true" />
    <span>{label}</span>
  </span>;
}
