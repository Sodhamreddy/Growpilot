/**
 * Product mark.
 *
 * Three bars rising left to right, the growth curve the product is named for.
 * Free-standing rather than set in a tile: a dark tile made the mark read as
 * an app icon dropped onto the page, where bars on the page ground read as
 * part of the wordmark beside them.
 *
 * Pure geometry, so it stays crisp at 20px and carries no asset to maintain.
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="GrowPilot Studio"
    >
      {/* Shortest to tallest, the middle bar brightest so the eye lands centre. */}
      <rect x="2"  y="17" width="7" height="13" rx="3" fill="#2E7D4F" />
      <rect x="12" y="10" width="7" height="20" rx="3" fill="#4CAF50" />
      <rect x="22" y="3"  width="7" height="27" rx="3" fill="#2E7D4F" />
    </svg>
  );
}

/** Small stroke icons for the auth panel's proof points. */
export function IconSource({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4 3.5h8l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z"
        stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
      />
      <path d="M11.5 3.5v4.5h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.5 11.5h7M6.5 14h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconVoice({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2.5a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0v-4a3 3 0 0 1 3-3Z"
        stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
      />
      <path
        d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5v3"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
      />
    </svg>
  );
}

export function IconShield({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2.5l6 2.2v5c0 3.7-2.5 6.9-6 7.8-3.5-.9-6-4.1-6-7.8v-5l6-2.2Z"
        stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
      />
      <path d="M7.4 10.1l1.9 1.9 3.4-3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
