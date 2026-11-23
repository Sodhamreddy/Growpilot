import { redirect } from "next/navigation";
import Link from "next/link";
import { eq, desc } from "drizzle-orm";
import { getClient } from "@/lib/tenant";
import { getSession, listMemberships } from "@/lib/auth";
import { db } from "@/lib/services";
import { workspaces, businesses, businessSources } from "@ob/db";
import { Logo } from "@/components/Logo";
import { UserMenu } from "@/components/UserMenu";
import { WorkerBanner } from "@/components/WorkerBanner";
import { ClientSwitcher } from "@/components/ClientSwitcher";
import { ClientCrawlRefresh } from "@/components/ClientCrawlRefresh";
import { Companion } from "@/components/Companion";
import { NavCurrentMarker } from "@/components/NavCurrentMarker";
import { IconHelp } from "@/components/Icons";
import { APP_NAV, type AppNavItem } from "@/components/AppNav";
import { currentBlogAccess } from "@/lib/blog-access-server";
import { BLOG_HOME } from "@/lib/blog-access";

/*
 * Never cached.
 *
 * This layout reads which client is selected and renders the switcher from it.
 * Every page beneath it already declares this; the layout did not, so Next
 * served a cached shell while the pages under it re-rendered. Switching client
 * changed the page and left the sidebar naming the old one, which reads as the
 * switch having failed — and the switcher's own optimistic state made it look
 * like it had worked for a moment first.
 */
export const dynamic = "force-dynamic";

/**
 * Authenticated shell — spec §10.2 sidebar.
 *
 * The three automation pillars are the product: blog posts to WordPress, a
 * social timeline built from local events, and Google review responses.
 * Everything else here is either an input to those pillars (keywords, brand
 * voice, business facts) or a place to inspect what they did.
 *
 * Nothing unbuilt is listed. A "Roadmap" group of navigable placeholders used
 * to sit at the bottom; it was removed along with those routes, because a
 * sidebar full of things that do not work makes the three that do harder to
 * find — and a customer cannot tell which is which by looking.
 */

/**
 * One flat list, no group headings (APP_NAV).
 *
 * Six items is short enough to read at a glance, and the labels already say
 * what each is: "AUTOMATION" above three automations was a heading that
 * repeated its own contents. Removing it took a row of chrome out of the rail
 * without losing anything. The full-screen article page offers the same list.
 */
const NAV = APP_NAV;

/**
 * Configuration, behind one entry.
 *
 * All real screens, all things a person sets once and rarely returns to.
 * Listed flat they were six of eleven links, competing with the work itself.
 */
export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/signin");

  const database = db();
  const [[workspace], clientRows, sourceRows, currentClient, memberships, access] = await Promise.all([
    database.select({
      name: workspaces.name,
      plan: workspaces.plan,
      onboardingCompletedAt: workspaces.onboardingCompletedAt,
      // Onboarding settings remain workspace-wide.
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1),
    database.select({
      id: businesses.id,
      name: businesses.name,
      websiteUrl: businesses.websiteUrl,
      confirmedAt: businesses.confirmedAt,
    })
    .from(businesses)
    .where(eq(businesses.workspaceId, session.workspaceId))
    .orderBy(desc(businesses.createdAt)),
    database.select({
      businessId: businessSources.businessId,
      crawlStatus: businessSources.crawlStatus,
      createdAt: businessSources.createdAt,
    })
    .from(businessSources)
    .where(eq(businessSources.workspaceId, session.workspaceId))
    .orderBy(desc(businessSources.createdAt)),
    getClient(),
    // For the workspace switcher: someone invited into another workspace belongs to more than one.
    listMemberships(session.userId),
    // Content team and Manager members (who are not admins) only work on blogs.
    currentBlogAccess(),
  ]);
  const nav = access.blogOnly ? NAV.filter((item) => item.href === BLOG_HOME) : NAV;

  // A workspace that has not finished onboarding has no business, no profile
  // and no voice — every module would render an empty state. Send them to the
  // flow instead (spec §2: signup → discovery → … → dashboard).
  if (!workspace?.onboardingCompletedAt) redirect("/onboarding");

  const latestSourceByBusiness = new Map<string, (typeof sourceRows)[number]>();
  for (const source of sourceRows) {
    if (!latestSourceByBusiness.has(source.businessId)) latestSourceByBusiness.set(source.businessId, source);
  }

  const clients = clientRows.map((c) => ({
    ...c,
    // Serialised for the client component: a Date does not survive the
    // boundary, and only the presence of one is read.
    confirmedAt: c.confirmedAt ? c.confirmedAt.toISOString() : null,
    crawlStatus: latestSourceByBusiness.get(c.id)?.crawlStatus ?? null,
  }));
  /*
   * The stored id only counts if it still names a client.
   *
   * `??` falls back on null, not on a dangling id, so a client deleted
   * elsewhere left `selectedId` naming a row that no longer exists. That id
   * was then handed to the crawl poller, which polled a deleted business, and
   * to the switcher, which computed its highlight and its "already selected"
   * guard against a fallback rather than a real selection.
   */
  const storedId = currentClient?.id;
  const selectedClient =
    clients.find((client) => client.id === storedId) ?? clients[0] ?? null;
  const selectedId = selectedClient?.id ?? null;

  const initials =
    (session.name ?? session.email)
      .split(/[\s@.]+/).filter(Boolean).slice(0, 2)
      .map((p) => p[0]!.toUpperCase()).join("") || "?";

  return (
    <div className="shell">
      <ClientCrawlRefresh businessId={selectedId} status={selectedClient?.crawlStatus ?? null} />
      <aside className="sidebar">
        <NavCurrentMarker />
        <Link href={access.blogOnly ? BLOG_HOME : "/home"} className="brand">
          <Logo size={34} />
          <span className="brandtext">
            <strong>GrowPilot</strong>
            <em>Studio</em>
          </span>
        </Link>

        {/*
          * The workspace card becomes the client switcher.
          *
          * An agency runs several businesses from one login, and the card was
          * already sitting here showing which one. Making it the control that
          * changes it puts the switch where a person already looks to check.
          */}
        <ClientSwitcher
          clients={clients}
          selectedId={selectedId}
          plan={workspace?.plan ?? "trial"}
          canAdd={session.role === "owner" || session.role === "admin"}
          canRemove={session.role === "owner"}
        />

        {/*
          * Three pillars, one home, and everything else folded away.
          *
          * The sidebar had eleven links in three labelled groups, of which six
          * were configuration a person visits rarely and then not again. Given
          * equal billing they competed with the three tools the product is
          * for, and the eye had to sort them every time.
          *
          * Setup is a <details> rather than a route: keeping it one click away
          * costs nothing, and moving it to its own page would hide the fact
          * that brand voice and keywords exist at all.
          */}
        <nav className="nav">
          <div className="navgroup">
            {nav.map((i) => <NavLink key={i.href} item={i} />)}
          </div>
        </nav>

        <div className="sidefoot">
          <UserMenu
            name={session.name ?? session.email.split("@")[0]!}
            email={session.email}
            role={access.blogOnly && access.teamLabel ? access.teamLabel : session.role}
            initials={initials}
            workspaces={memberships.map((m) => ({ id: m.id, name: m.name }))}
            activeWorkspaceId={session.workspaceId}
          />

          {/*
            * Help sits under the account, not in the nav.
            *
            * It is not a place in the product, it is a way out of one, and
            * putting it among the tools would imply otherwise.
            */}
          <a className="sidehelp" href="mailto:support@kleza.io?subject=GrowPilot%20support">
            <span className="ico"><IconHelp size={16} /></span>
            <span>Help &amp; Support</span>
          </a>
        </div>
      </aside>

      <main className="main">
        <WorkerBanner />
        {children}
      </main>

      {/* Floats over every page: the thing it is asked about is usually on screen. */}
      <Companion key={selectedId ?? "no-client"} />
    </div>
  );
}

function NavLink({ item }: { item: AppNavItem }) {
  return (
    <Link href={item.href} className="navlink" prefetch>
      <span className="ico">{item.icon}</span>
      <span className="navtext">{item.label}</span>
    </Link>
  );
}
