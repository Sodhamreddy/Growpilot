/**
 * Business profile completeness — what the pipeline still needs from a person.
 *
 * Onboarding is skippable by design, and the crawler cannot find everything:
 * a logo is rarely in the markup in any reliable form, a Google Business
 * Profile name lives on Google, and social handles are often only in an icon
 * row with no text. So a workspace routinely arrives here with real gaps.
 *
 * This reports them as named, actionable items rather than a percentage.
 * "72% complete" tells a customer nothing they can act on; "no locations, so
 * local content cannot be written" tells them exactly what to do and what it
 * costs them not to. Each item therefore carries the consequence of leaving it
 * empty, not just its name.
 */

export type CheckSeverity = "blocking" | "recommended" | "optional";

export interface CompletenessItem {
  id: string;
  label: string;
  /** Which part of the product cares about this field. */
  area: "profile" | "services" | "locations" | "local" | "social" | "publishing";
  severity: CheckSeverity;
  done: boolean;
  /** What is lost while this is empty. Written for the customer. */
  consequence: string;
  /** Where to go to fix it. */
  action: string;
}

export interface CompletenessInput {
  business: {
    name: string;
    industry: string | null;
    audience: string | null;
    description: string | null;
    usp: string | null;
    websiteUrl: string | null;
    logoUrl: string | null;
    gmbName: string | null;
    socialProfiles: { network: string; handle: string; url: string }[];
    confirmedAt: Date | null;
  } | null;
  serviceCount: number;
  locations: {
    streetAddress: string | null;
    locality: string | null;
    postalCode: string | null;
    phone: string | null;
  }[];
  /** Providers with a healthy connection right now. */
  connectedProviders: string[];
  /** Whether this workspace asked for local and social work during onboarding. */
  goals: string[];
}

export interface CompletenessReport {
  items: CompletenessItem[];
  blocking: CompletenessItem[];
  recommended: CompletenessItem[];
  optional: CompletenessItem[];
  /** Everything that is not optional and not done. */
  outstanding: number;
  /** True when nothing blocking remains. */
  readyToGenerate: boolean;
}

export function assessCompleteness(input: CompletenessInput): CompletenessReport {
  const b = input.business;
  const wantsLocal = input.goals.includes("local");
  const wantsSocial = input.goals.includes("social");

  const items: CompletenessItem[] = [];

  const add = (
    id: string,
    label: string,
    area: CompletenessItem["area"],
    severity: CheckSeverity,
    done: boolean,
    consequence: string,
    action: string,
  ) => items.push({ id, label, area, severity, done, consequence, action });

  // ── The profile itself ──
  add("business", "Business added", "profile", "blocking", Boolean(b),
    "Nothing can be generated without a business.",
    "Add your website and run a crawl.");

  add("confirmed", "Profile confirmed", "profile", "blocking", Boolean(b?.confirmedAt),
    "Generation stays blocked until someone confirms what we extracted is correct.",
    "Review the extracted profile and confirm it.");

  add("industry", "Industry", "profile", "recommended", Boolean(b?.industry),
    "Without it, content is written in generic terms rather than your field's.",
    "Set it in Business info.");

  add("audience", "Audience", "profile", "recommended", Boolean(b?.audience),
    "Content is pitched at no one in particular.",
    "Describe who you sell to.");

  add("usp", "What makes you different", "profile", "recommended", Boolean(b?.usp),
    "Articles describe your category instead of your business.",
    "Add a one-line differentiator.");

  add("logo", "Logo", "profile", "optional", Boolean(b?.logoUrl),
    "Generated images and social cards carry no brand mark.",
    "Paste a logo URL.");

  // ── Services ──
  add("services", "Services listed", "services", "blocking", input.serviceCount > 0,
    "Keyword research has nothing to work from, so no plan can be built.",
    "Add at least one service.");

  add("services_depth", "Three or more services", "services", "recommended",
    input.serviceCount >= 3,
    "A thin service list produces a thin content plan with little to cluster.",
    "Add the rest of what you offer.");

  // ── Locations ──
  const napComplete = input.locations.filter(
    (l) => l.streetAddress && l.locality && l.postalCode && l.phone,
  ).length;

  add("locations", "At least one location", "locations", wantsLocal ? "blocking" : "recommended",
    input.locations.length > 0,
    wantsLocal
      ? "Local SEO was one of your goals, and none of it can run without an address."
      : "Content cannot reference where you operate.",
    "Add your business address.");

  add("nap", "Address and phone complete", "locations",
    wantsLocal ? "blocking" : "recommended",
    input.locations.length > 0 && napComplete === input.locations.length,
    "An incomplete address cannot be published to directories, and inconsistent " +
      "details across the web hurt local ranking.",
    "Fill in the missing street, city, postal code or phone.");

  // ── Google Business Profile ──
  add("gmb_name", "Google Business Profile name", "local",
    wantsLocal ? "recommended" : "optional", Boolean(b?.gmbName),
    "Review replies and local content use your site's name, which is often not the " +
      "name customers see on Google.",
    "Enter the listing name exactly as Google shows it.");

  add("gmb_connected", "Google Business Profile connected", "local",
    wantsLocal ? "recommended" : "optional",
    input.connectedProviders.includes("google_business_profile"),
    "Reviews cannot be read and replies cannot be posted.",
    "Connect Google Business Profile in Integrations.");

  // ── Social ──
  add("social_profiles", "Social channels listed", "social",
    wantsSocial ? "recommended" : "optional",
    (b?.socialProfiles.length ?? 0) > 0,
    "We do not know which networks to plan content for.",
    "Add the profiles you already run.");

  const socialConnected = ["linkedin", "facebook", "instagram", "x"].some((p) =>
    input.connectedProviders.includes(p),
  );
  add("social_connected", "A social account connected", "social",
    wantsSocial ? "recommended" : "optional", socialConnected,
    "Posts can be drafted and approved but not published.",
    "Connect an account in Integrations.");

  // ── Publishing ──
  const cmsConnected = ["wordpress", "webflow", "ghost", "webhook"].some((p) =>
    input.connectedProviders.includes(p),
  );
  add("cms", "Somewhere to publish", "publishing", "recommended", cmsConnected,
    "Approved articles have nowhere to go and stay in the dashboard.",
    "Connect WordPress in Integrations.");

  const blocking = items.filter((i) => i.severity === "blocking" && !i.done);
  const recommended = items.filter((i) => i.severity === "recommended" && !i.done);
  const optional = items.filter((i) => i.severity === "optional" && !i.done);

  return {
    items,
    blocking,
    recommended,
    optional,
    outstanding: blocking.length + recommended.length,
    readyToGenerate: blocking.length === 0,
  };
}
