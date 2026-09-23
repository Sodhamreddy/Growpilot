/**
 * Icon set.
 *
 * One 20×20 grid, 1.5 stroke, `currentColor` throughout, so icons inherit
 * colour from whatever they sit in and stay optically consistent at 16–18px.
 */

type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 20 20",
  fill: "none" as const,
  "aria-hidden": true,
});
const S = { stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const IconHome = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M3.5 8.2 10 3l6.5 5.2V16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V8.2Z" /><path {...S} d="M8 17v-5h4v5" /></svg>
);
export const IconBusiness = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M3.5 17V6.5l5-3v3.5l5-2.5V17" /><path {...S} d="M2.5 17h15M6 9.5v0M6 12.5v0M11 9.5v0M11 12.5v0" /></svg>
);
export const IconKeywords = ({ size = 17 }: P) => (
  <svg {...base(size)}><circle {...S} cx="9" cy="9" r="5.5" /><path {...S} d="m13.5 13.5 3 3" /></svg>
);
export const IconArticles = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M4.5 3.5h7l4 4V16a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" /><path {...S} d="M11 3.5V8h4.5M7 11h6M7 13.5h4" /></svg>
);
export const IconVoiceNav = ({ size = 17 }: P) => (
  <svg {...base(size)}><rect {...S} x="7" y="2.5" width="6" height="9" rx="3" /><path {...S} d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5v3" /></svg>
);
export const IconCalendar = ({ size = 17 }: P) => (
  <svg {...base(size)}><rect {...S} x="3" y="4.5" width="14" height="12.5" rx="1.5" /><path {...S} d="M3 8.5h14M6.5 2.5v3M13.5 2.5v3" /></svg>
);
export const IconAudit = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M10 2.5 16.5 5v5.2c0 3.6-2.6 6.7-6.5 7.3-3.9-.6-6.5-3.7-6.5-7.3V5L10 2.5Z" /><path {...S} d="m7.5 10 1.8 1.8 3.4-3.6" /></svg>
);
export const IconLocal = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M10 17.5s5.5-4.7 5.5-9a5.5 5.5 0 1 0-11 0c0 4.3 5.5 9 5.5 9Z" /><circle {...S} cx="10" cy="8.5" r="2" /></svg>
);
export const IconSocial = ({ size = 17 }: P) => (
  <svg {...base(size)}><circle {...S} cx="5.5" cy="10" r="2.2" /><circle {...S} cx="14.5" cy="5.5" r="2.2" /><circle {...S} cx="14.5" cy="14.5" r="2.2" /><path {...S} d="m7.6 8.9 4.8-2.3M7.6 11.1l4.8 2.3" /></svg>
);
export const IconAnalytics = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M3.5 16.5h13" /><path {...S} d="M6 16.5v-5M10 16.5V6M14 16.5v-7.5" /></svg>
);
export const IconIntegrations = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M8.5 11.5 6 14a2.8 2.8 0 0 1-4-4l2.5-2.5" /><path {...S} d="M11.5 8.5 14 6a2.8 2.8 0 0 1 4 4l-2.5 2.5" /><path {...S} d="m7.8 12.2 4.4-4.4" /></svg>
);
export const IconSettings = ({ size = 17 }: P) => (
  <svg {...base(size)}><circle {...S} cx="10" cy="10" r="2.5" /><path {...S} d="M16.2 12a1.4 1.4 0 0 0 .3 1.5l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.4 1.4 0 0 0-2.4 1v.2a1.7 1.7 0 1 1-3.4 0v-.1a1.4 1.4 0 0 0-2.4-1l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.4 1.4 0 0 0-1-2.4H2.4a1.7 1.7 0 1 1 0-3.4h.1a1.4 1.4 0 0 0 1-2.4l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.4 1.4 0 0 0 2.4-1V2.4a1.7 1.7 0 1 1 3.4 0v.1a1.4 1.4 0 0 0 2.4 1l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.4 1.4 0 0 0 1 2.4h.2a1.7 1.7 0 1 1 0 3.4h-.1a1.4 1.4 0 0 0-1.3.8Z" /></svg>
);

// ── Stat / state icons ──

export const IconClock = ({ size = 17 }: P) => (
  <svg {...base(size)}><circle {...S} cx="10" cy="10" r="7" /><path {...S} d="M10 6v4l2.5 1.5" /></svg>
);
export const IconEdit = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M13.2 3.6a1.8 1.8 0 0 1 2.5 2.5L7.4 14.4l-3.4.9.9-3.4 8.3-8.3Z" /></svg>
);
export const IconTrash = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M4 5.5h12M8.2 5.5V4.2a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.3M5.4 5.5l.7 10a1 1 0 0 0 1 .9h5.8a1 1 0 0 0 1-.9l.7-10" /></svg>
);
export const IconAlert = ({ size = 17 }: P) => (
  <svg {...base(size)}><circle {...S} cx="10" cy="10" r="7" /><path {...S} d="M10 6.5v4M10 13.3v0" /></svg>
);
export const IconCheck = ({ size = 17 }: P) => (
  <svg {...base(size)}><circle {...S} cx="10" cy="10" r="7" /><path {...S} d="m6.8 10.2 2.1 2.1 4.3-4.6" /></svg>
);
export const IconSpark = ({ size = 17 }: P) => (
  <svg {...base(size)}><path {...S} d="M10 2.5 11.6 7l4.4 1.6-4.4 1.6L10 14.7 8.4 10.2 4 8.6 8.4 7 10 2.5Z" /><path {...S} d="M15.5 13.5 16 15l1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5Z" /></svg>
);
export const IconHelp = ({ size = 17 }: P) => (
  <svg {...base(size)}><circle {...S} cx="10" cy="10" r="7" /><path {...S} d="M8.2 8a1.9 1.9 0 1 1 2.3 1.9c-.4.1-.5.4-.5.8v.4" /><path {...S} d="M10 14v0" /></svg>
);
/** Disclosure chevron. Rotated by CSS to point down when a panel is open. */
export const IconChevron = ({ size = 16 }: P) => (
  <svg {...base(size)}><path {...S} d="m7.5 4.5 5 5.5-5 5.5" /></svg>
);
export const IconArrow = ({ size = 15 }: P) => (
  <svg {...base(size)}><path {...S} d="M4 10h11M11 6l4 4-4 4" /></svg>
);
export const IconInbox = ({ size = 22 }: P) => (
  <svg {...base(size)}><path {...S} d="M3 11.5 5 4.5h10l2 7V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5Z" /><path {...S} d="M3 11.5h3.5l1 2h5l1-2H17" /></svg>
);
