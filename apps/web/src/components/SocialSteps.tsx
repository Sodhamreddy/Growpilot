import Link from "next/link";

/**
 * The social flow as five steps: topics, calendar, copy, images, publishing.
 *
 * Links rather than client state, so each step has a URL and the month being
 * worked on travels with it: moving from the October calendar to its copy
 * lands on October's copy.
 *
 * A step with no `href` is shown but not linked, with the reason, because a
 * step that opens onto nothing reads as the product being broken.
 */

interface Step {
  title: string;
  sub: string;
  href?: (monthKey: string | undefined) => string;
  /** Why the step cannot be opened yet. */
  missing?: string;
}

const STEPS: Step[] = [
  { title: "Choose topics", sub: "pick this month's ideas", href: () => "/social" },
  {
    title: "Calendar", sub: "put them on dates",
    href: (m) => (m ? `/social/calendar?month=${m}` : "/social/calendar"),
  },
  {
    title: "Content pack", sub: "write & approve the text",
    href: (m) => (m ? `/social/content?month=${m}` : "/social/content"),
  },
  {
    title: "Image Pack", sub: "create & approve visuals",
    href: (m) => (m ? `/social/images?month=${m}` : "/social/images"),
  },
  {
    title: "Schedule", sub: "publish approved posts",
    href: (m) => (m ? `/social/schedule?month=${m}` : "/social/schedule"),
  },
];

export function SocialSteps({ current, monthKey }: { current: 1 | 2 | 3 | 4 | 5; monthKey?: string }) {
  return (
    <nav className="socialsteps" aria-label="Social media steps">
      <ol>
        {STEPS.map((s, i) => {
          const n = i + 1;
          const body = (
            <>
              <span className="socialstep-n" aria-hidden>{n}</span>
              <span className="socialstep-text">
                <strong>{s.title}</strong>
                <small>{s.missing ? "not built yet" : s.sub}</small>
              </span>
            </>
          );
          return (
            <li key={s.title}>
              {s.href ? (
                <Link
                  className="socialstep"
                  href={s.href(monthKey)}
                  aria-current={n === current ? "step" : undefined}
                >
                  <span className="sr-only">Step {n}: </span>{body}
                </Link>
              ) : (
                <span className="socialstep off" aria-disabled="true" title={s.missing}>
                  <span className="sr-only">Step {n}, {s.missing} </span>{body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
