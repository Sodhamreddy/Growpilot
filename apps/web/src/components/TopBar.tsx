import Link from "next/link";

/**
 * Breadcrumb bar above the page content.
 *
 * The right side labels the running environment. It reads "Sample data" only
 * when the workspace really is running against the seeded demo business — it
 * is a fact about the data, not decoration.
 *
 * `teamRole` names a review team member's part in the blog review ("Content
 * team", "Manager"), so someone who only sees Blog Automation knows why.
 */
export function TopBar({
  section,
  page,
  sampleData,
  initials,
  homeHref = "/home",
  teamRole = null,
}: {
  section: string;
  page: string;
  sampleData?: boolean;
  initials: string;
  homeHref?: string;
  teamRole?: { label: string; duty: string | null } | null;
}) {
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href={homeHref}>{section}</Link>
        <span className="sep">/</span>
        <span className="here">{page}</span>
      </nav>
      <div className="spacer" />
      {sampleData ? <span className="env">Demo · Seeded data</span> : null}
      {teamRole ? <span className="teamrole" title={teamRole.duty ?? undefined}><span>Your role:</span> {teamRole.label}</span> : null}
      <span className="avatar">{initials}</span>
    </header>
  );
}
