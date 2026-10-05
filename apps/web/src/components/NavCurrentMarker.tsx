"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/** Keeps the server-rendered navigation in sync with the active route. */
export function NavCurrentMarker() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const routes = [
      "/home", "/articles", "/social", "/social/calendar", "/social/content", "/reviews", "/business", "/settings",
      "/settings/business", "/voice", "/integrations", "/preferences", "/keywords",
    ];
    const preload = () => routes.forEach((route) => router.prefetch(route));
    const win = window as Window & { requestIdleCallback?: (callback: () => void) => number };
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(preload);
      return () => window.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(preload, 250);
    return () => window.clearTimeout(id);
  }, [router]);

  useEffect(() => {
    const links = document.querySelectorAll<HTMLAnchorElement>(".sidebar .navlink");
    let settingsActive = false;
    links.forEach((link) => {
      const href = link.getAttribute("href") ?? "";
      const active = pathname === href || (href !== "/home" && pathname.startsWith(`${href}/`));
      if (active) {
        link.setAttribute("aria-current", "page");
        if (link.closest(".navsetup")) settingsActive = true;
      }
      else link.removeAttribute("aria-current");
    });
    const settings = document.querySelector<HTMLDetailsElement>(".sidebar .navsetup");
    if (settingsActive && settings) settings.open = true;
  }, [pathname]);

  return null;
}
