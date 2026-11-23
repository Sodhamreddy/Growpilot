import type { ReactNode } from "react";

/** Line icons for the article workspace. Decorative: the control beside each one carries the name. */
type P = { size?: number };

const icon = (size: number, children: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);

export const IconQuill = ({ size = 22 }: P) => icon(size, <>
  <path d="M17 2.8C10.4 3.2 6 7.6 5.2 14.3" /><path d="M17 2.8c-.4 6.3-4.6 10.4-10.6 11" /><path d="M8.2 10.6h4.6" /><path d="M5.2 14.3 3 17.2" />
</>);
export const IconArrowLeft = ({ size = 16 }: P) => icon(size, <path d="M16 10H4.5M9 5 4 10l5 5" />);
export const IconChevronRight = ({ size = 16 }: P) => icon(size, <path d="m8 5 5 5-5 5" />);
export const IconChevronDown = ({ size = 15 }: P) => icon(size, <path d="m5 8 5 5 5-5" />);
export const IconEye = ({ size = 17 }: P) => icon(size, <><path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10Z" /><circle cx="10" cy="10" r="2.4" /></>);
export const IconPencil = ({ size = 17 }: P) => icon(size, <><path d="M13.6 3.4a1.9 1.9 0 0 1 2.7 2.7L7 15.4l-3.6.9.9-3.6Z" /><path d="m12.2 4.8 2.9 2.9" /></>);
export const IconSparkles = ({ size = 17 }: P) => icon(size, <>
  <path d="M8.5 2.8 9.9 6.9l4.1 1.4-4.1 1.4-1.4 4.1-1.4-4.1L3 8.3l4.1-1.4Z" /><path d="m15.2 12.4.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6Z" />
</>);
export const IconComment = ({ size = 17 }: P) => icon(size, <path d="M10 3.4c4.2 0 7.3 2.6 7.3 6s-3.1 6-7.3 6c-.9 0-1.8-.1-2.6-.4l-3.9 1.7.9-3.2C3.4 12.3 2.7 10.9 2.7 9.4c0-3.4 3.1-6 7.3-6Z" />);
export const IconExpand = ({ size = 17 }: P) => icon(size, <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />);
export const IconCollapse = ({ size = 17 }: P) => icon(size, <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" />);
export const IconLayers = ({ size = 16 }: P) => icon(size, <><path d="m10 2.8 7.2 3.6L10 10 2.8 6.4Z" /><path d="m2.8 10 7.2 3.6 7.2-3.6" /><path d="m2.8 13.6 7.2 3.6 7.2-3.6" /></>);
export const IconFile = ({ size = 16 }: P) => icon(size, <><path d="M5 2.5h6.5L15 6v11.5H5Z" /><path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" /></>);
export const IconCalendarSmall = ({ size = 16 }: P) => icon(size, <><rect x="3" y="4.5" width="14" height="12.5" rx="2" /><path d="M3 8.5h14M7 2.5v4M13 2.5v4" /></>);
export const IconBars = ({ size = 18 }: P) => icon(size, <path d="M4 16.5V11M8 16.5V5M12 16.5V8.5M16 16.5V3.5" />);
export const IconHistory = ({ size = 18 }: P) => icon(size, <><path d="M3.6 10.4A6.5 6.5 0 1 0 5.4 5.4" /><path d="M3.3 3.4v3.4h3.4M10 6.5V10l2.5 1.6" /></>);
export const IconPulse = ({ size = 18 }: P) => icon(size, <path d="M2.5 10.5h3.2l2-5.5 3.6 10 2.1-4.5h4.1" />);
export const IconShare = ({ size = 16 }: P) => icon(size, <><circle cx="14.8" cy="4.6" r="2.1" /><circle cx="5.2" cy="10" r="2.1" /><circle cx="14.8" cy="15.4" r="2.1" /><path d="m7 9 6-3.4M7 11l6 3.4" /></>);
export const IconMore = ({ size = 18 }: P) => icon(size, <><circle cx="4.5" cy="10" r="1.3" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none" /><circle cx="15.5" cy="10" r="1.3" fill="currentColor" stroke="none" /></>);
export const IconTick = ({ size = 15 }: P) => icon(size, <path d="m4 10.5 3.6 3.6L16 5.6" />);
export const IconCheckCircle = ({ size = 17 }: P) => icon(size, <><circle cx="10" cy="10" r="7.6" /><path d="m6.8 10.2 2.2 2.2 4.3-4.6" /></>);
export const IconChecks = ({ size = 17 }: P) => icon(size, <path d="m2.8 10.4 3.4 3.4 7.4-7.6M10.4 13.2l.6.6 6.2-6.4" />);
export const IconInfo = ({ size = 15 }: P) => icon(size, <><circle cx="10" cy="10" r="7.6" /><path d="M10 9.2v4.6M10 6.4v.1" /></>);
export const IconShield = ({ size = 15 }: P) => icon(size, <><path d="M10 2.6 16 5v4.6c0 3.9-2.6 6.5-6 7.8-3.4-1.3-6-3.9-6-7.8V5Z" /><path d="m7.3 10 1.9 1.9 3.5-3.7" /></>);
export const IconExternal = ({ size = 14 }: P) => icon(size, <path d="M8.5 4H4.5v11.5H16v-4M11.5 3.5h5v5M16.5 3.5 9 11" />);
export const IconSupport = ({ size = 20 }: P) => icon(size, <><rect x="3" y="3" width="14" height="14" rx="4" /><path d="M7 11.6c.8 1 1.8 1.5 3 1.5s2.2-.5 3-1.5M7.6 7.9v.1M12.4 7.9v.1" /></>);
export const IconCopy = ({ size = 16 }: P) => icon(size, <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V4.6A1.6 1.6 0 0 0 11.4 3H4.6A1.6 1.6 0 0 0 3 4.6v6.8A1.6 1.6 0 0 0 4.6 13H7" /></>);
export const IconDownload = ({ size = 16 }: P) => icon(size, <path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16.5h12" />);
export const IconWordPress = ({ size = 19 }: P) => icon(size, <><circle cx="10" cy="10" r="7.8" /><path d="m4.9 7.3 2.8 7.2 2.3-5.8 2.3 5.8 2.8-7.2M4.2 7.3h2.3M8.9 7.3h2.2M13.5 7.3h2.3" /></>);
export const IconClose = ({ size = 18 }: P) => icon(size, <path d="m5 5 10 10M15 5 5 15" />);
