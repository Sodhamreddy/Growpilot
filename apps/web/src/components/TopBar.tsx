import Link from "next/link";

/**
 * Breadcrumb bar above the page content.
 *
 * The right side labels the running environment. It reads "Sample data" only
 * when the workspace really is running against the seeded demo business — it
 * is a fact about the data, not decoration.
 */
export function TopBar({
  section,
  page,
  sampleData,
  initials,
}: {
  section: string;
  page: string;
  sampleData?: boolean;
  initials: string;
}) {
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/home">{section}</Link>
        <span className="sep">/</span>
        <span className="here">{page}</span>
      </nav>
      <div className="spacer" />
      {sampleData ? <span className="env">Demo · Seeded data</span> : null}
      <span className="avatar">{initials}</span>
    </header>
  );
}
