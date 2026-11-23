import type { JSX } from "react";
import { IconHome, IconArticles, IconLocal, IconSocial, IconSettings, IconAudit, IconAnalytics } from "./Icons";

export interface AppNavItem { href: string; label: string; icon: JSX.Element }

/**
 * GrowPilot's main sections, in sidebar order.
 *
 * The sidebar and the article page's GrowPilot menu both read this list, so the
 * full-screen article page always offers the same way back into the product.
 * Nothing unbuilt is listed: an entry for a screen that does not exist is worse
 * than its absence.
 */
export const APP_NAV: AppNavItem[] = [
  { href: "/home", label: "Overview", icon: <IconHome /> },
  { href: "/articles", label: "Blog Automation", icon: <IconArticles /> },
  { href: "/social", label: "Social Media Timeline", icon: <IconSocial /> },
  { href: "/social-insights", label: "Social Insights", icon: <IconAnalytics /> },
  { href: "/reviews", label: "GMB Reviews", icon: <IconLocal /> },
  { href: "/business", label: "Business Intelligence", icon: <IconAudit /> },
  { href: "/settings", label: "Settings", icon: <IconSettings /> },
];
