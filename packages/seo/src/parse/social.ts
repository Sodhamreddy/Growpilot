/**
 * Social accounts, read off a website's own outbound links.
 *
 * Nearly every site puts its social icons in the footer, so the accounts are
 * already sitting in the pages we crawl. Asking a person to type six handles
 * they have already published is work the crawl can do, and work nobody
 * actually does: before this, every client in the system had an empty social
 * profiles list.
 *
 * What this is not: a follower count, a post history, or proof the account is
 * still active. It is the set of accounts the business links to, which is the
 * question "which networks does this client run" — enough to decide what kind
 * of content to plan, and honest about being no more than that.
 */

/**
 * Networks worth recognising, and how to pull the handle out of a URL.
 *
 * The path pattern is deliberately loose about prefixes ("company/", "pages/",
 * "@") because the same network spells its own URLs several ways, and strict
 * about what counts as a handle, because the alternative is storing a fragment
 * of a share widget as though it were an account.
 */
const NETWORKS: { network: string; host: RegExp; handle: RegExp }[] = [
  {
    network: "facebook",
    // A vanity name only. "profile.php?id=…" is handled separately below,
    // because its identity lives in the query string, not the path.
    host: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i,
    handle: /^\/(?:pages\/)?([A-Za-z0-9.-]{2,})/,
  },
  {
    network: "instagram",
    host: /(^|\.)instagram\.com$/i,
    handle: /^\/([A-Za-z0-9._]{2,})/,
  },
  {
    network: "linkedin",
    host: /(^|\.)linkedin\.com$/i,
    handle: /^\/(?:company|in|school|showcase)\/([A-Za-z0-9._-]{2,})/,
  },
  {
    network: "x",
    host: /(^|\.)(twitter\.com|x\.com)$/i,
    handle: /^\/([A-Za-z0-9_]{2,15})/,
  },
  {
    /*
     * youtu.be is deliberately excluded.
     *
     * Its entire path is a video id, with no route segment to recognise, so
     * `youtu.be/dQw4w9WgXcQ` parses as a channel called "dQw4w9WgXcQ". Any
     * site embedding a video that way would gain a YouTube "account" it does
     * not have, and that seeds YouTube content categories for a business with
     * no channel. A real channel is always linked from youtube.com.
     */
    network: "youtube",
    host: /(^|\.)youtube\.com$/i,
    handle: /^\/(?:c\/|channel\/|user\/)?(@?[A-Za-z0-9._-]{2,})/,
  },
  {
    network: "tiktok",
    host: /(^|\.)tiktok\.com$/i,
    handle: /^\/(@[A-Za-z0-9._]{2,})/,
  },
  {
    network: "pinterest",
    host: /(^|\.)pinterest\.[a-z.]{2,6}$/i,
    handle: /^\/([A-Za-z0-9._-]{2,})/,
  },
  {
    network: "yelp",
    host: /(^|\.)yelp\.[a-z.]{2,6}$/i,
    handle: /^\/biz\/([A-Za-z0-9._-]{2,})/,
  },
];

/*
 * Paths that look like an account and are not one.
 *
 * Every social network uses its own domain for share widgets, login walls and
 * legal pages. A footer "Share on Facebook" button resolves to
 * facebook.com/sharer/sharer.php, which matches the handle pattern and would
 * be stored as an account called "sharer" — wrong in a way nobody would spot
 * until a post was scheduled to it.
 */
const RESERVED = [
  "sharer", "share", "share_channel", "intent", "home", "login", "signup",
  "privacy", "policies", "policy", "terms", "legal", "about", "help",
  "support", "settings", "search", "explore", "watch", "results", "feed",
  "hashtag", "embed", "widgets", "plugins", "dialog", "tr", "pin", "p",
  "sharearticle", "sharing", "groups", "events", "marketplace", "gaming",
  // Content routes, not accounts. A site linking one of its own posts, reels
  // or videos would otherwise store the route name as the handle: an
  // "Instagram account" called `reel`, a "YouTube channel" called `shorts`.
  "reel", "reels", "stories", "story", "tv", "shorts", "playlist", "post",
  "posts", "video", "videos", "photo", "photos", "media", "live", "clip",
];

/*
 * Paths that look like an account and are not one.
 *
 * Two shapes, and the second is the one that bit: a bare name from the list
 * above, or *any* script endpoint. The first version anchored the list with
 * `$`, so it caught `/sharer/sharer.php` (segment `sharer`) but not the more
 * common `/sharer.php`, whose first segment is `sharer.php`. That stored a
 * Facebook account called "sharer.php" from an ordinary share button, which
 * is precisely what this exists to stop.
 */
const NOT_AN_ACCOUNT = new RegExp(
  `^(?:${RESERVED.join("|")}$|.*\\.(?:php|aspx?|html?|cgi|jsp)$)`,
  "i",
);

export interface FoundProfile {
  network: string;
  handle: string;
  url: string;
}

/**
 * The social accounts among a set of outbound links.
 *
 * Takes the `externalLinks` the crawler already collects, so no page needs to
 * be fetched or parsed again.
 *
 * One account per network, the first one seen. A site that links its own
 * Instagram and then an employee's would otherwise store both, and there is no
 * reliable way to tell which is the business from the URL alone; the footer
 * link is the business's far more often than not.
 */
export function findSocialProfiles(externalLinks: string[]): FoundProfile[] {
  const found = new Map<string, FoundProfile>();

  for (const link of externalLinks) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;

    const match = NETWORKS.find((n) => n.host.test(url.hostname));
    if (!match || found.has(match.network)) continue;

    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    const handle = match.handle.exec(path)?.[1];
    if (!handle || NOT_AN_ACCOUNT.test(handle)) continue;

    found.set(match.network, {
      network: match.network,
      handle: handle.replace(/^@/, ""),
      // The canonical account URL, not the link as written: sites link their
      // own accounts with tracking parameters and inconsistent trailing paths.
      url: `${url.origin}${path}`,
    });
  }

  return [...found.values()];
}
