import Link from "next/link";
import { shiftMonth, monthName as monthLabel } from "@/lib/social-calendar";

/**
 * Previous / month / next, shared by the calendar and the content packs.
 *
 * Both steps work on one month at a time, and moving between them should not
 * lose which month that is, so they navigate the same way.
 */
export function SocialMonthNav({
  monthKey,
  currentMonthKey,
  basePath,
  titleId,
  children,
}: {
  monthKey: string;
  /** The month today falls in, for the jump-back link. */
  currentMonthKey: string;
  /** "/social/calendar". The month is added as `?month=`. */
  basePath: string;
  titleId?: string;
  /** Summary shown on the right. */
  children?: React.ReactNode;
}) {
  const prev = shiftMonth(monthKey, -1);
  const next = shiftMonth(monthKey, 1);
  const href = (m: string) => `${basePath}?month=${m}`;

  return (
    <div className="socal-toolbar">
      <div className="socal-nav">
        <Link className="socal-navbtn" href={href(prev)} aria-label={`Previous month, ${monthLabel(prev)}`}>‹</Link>
        <h2 id={titleId}>{monthLabel(monthKey)}</h2>
        <Link className="socal-navbtn" href={href(next)} aria-label={`Next month, ${monthLabel(next)}`}>›</Link>
        {monthKey !== currentMonthKey ? (
          <Link className="socal-jump" href={href(currentMonthKey)}>This month</Link>
        ) : null}
      </div>
      {children ? <div className="socal-summary">{children}</div> : null}
    </div>
  );
}
