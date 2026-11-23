import type { JSX } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AuthForm } from "@/components/AuthForm";
import { Logo, IconSource, IconVoice, IconShield } from "@/components/Logo";

/**
 * Sign-in / sign-up.
 *
 * A dark brand panel on the left carries the product story; the form sits on a
 * plain light ground on the right. Below 900px the panel is dropped rather than
 * stacked — it is supporting copy, and stacking would push the form below the
 * fold.
 */

const POINTS: { icon: JSX.Element; title: string; desc: string }[] = [
  {
    icon: <IconSource />,
    title: "Reads your website first",
    desc: "Every fact it learns is stored with the page and the sentence it came from, so you can check the source before a word is written.",
  },
  {
    icon: <IconVoice />,
    title: "Writes in your voice",
    desc: "Tone, vocabulary and calls to action are learned from your own copy, then kept as rules you can edit at any time.",
  },
  {
    icon: <IconShield />,
    title: "Nothing publishes itself",
    desc: "Every draft passes grounding, brand and SEO checks — and still waits for a person to approve it.",
  },
];

/**
 * Why a Google sign-in attempt did not finish.
 *
 * The callback redirects here with a short code rather than rendering an error
 * page, because the useful next step is always "try again" and that lives on
 * this page. Each message says what happened without implying the customer did
 * something wrong — most of these are our configuration or a timeout.
 */
const AUTH_ERRORS: Record<string, string> = {
  cancelled: "Google sign-in was cancelled.",
  not_configured: "Google sign-in is not configured on this server.",
  expired: "That sign-in attempt timed out. Please try again.",
  state_mismatch: "That sign-in attempt could not be verified. Please try again.",
  nonce_mismatch: "That sign-in attempt could not be verified. Please try again.",
  exchange_failed: "Google would not complete the sign-in. Please try again.",
  no_id_token: "Google did not return an identity. Please try again.",
  token_invalid: "Google's response could not be verified. Please try again.",
  google_unreachable: "Could not reach Google. Check your connection and try again.",
  no_email: "That Google account has no email address attached.",
  sign_in_failed: "Could not sign you in with that Google account.",
  email_sign_in_required: "This address uses email sign-in. Sign in with your password, or use Forgot password. Google accounts are not automatically linked for your security.",
};

/**
 * Where to go after signing in, when a page sent the person here (an invite link does).
 * Only a path inside this app: never another site, and never a protocol-relative "//host".
 */
function safeNext(value: string | undefined): string | null {
  return value && /^\/(?![/\\])[^\s\\]{0,300}$/.test(value) ? value : null;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string; next?: string }>;
}) {
  const { auth_error: authError, next: nextParam } = await searchParams;
  const next = safeNext(nextParam);
  if (await getSession()) redirect(next ?? "/home");

  const authMessage = authError
    ? AUTH_ERRORS[authError] ?? "Sign-in did not complete. Please try again."
    : null;

  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="auth-mark">
          <Logo size={28} className="logo" />
          <span className="wordmark">
            GrowPilot <span>Studio</span>
          </span>
        </div>

        <h1 className="auth-pitch">The workspace that learns your <span>business first.</span></h1>
        <p className="auth-sub">
          SEO research, content and brand voice in one place — grounded in what your business
          actually says about itself.
        </p>

        <ul className="auth-points">
          {POINTS.map((p) => (
            <li key={p.title}>
              <span className="ico">{p.icon}</span>
              <span>
                <strong>{p.title}</strong>
                <span className="desc">{p.desc}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="auth-glance" aria-label="Growth at a glance">
          <div className="auth-glance-head"><strong>Your Growth at a Glance</strong><span>Last 30 days⌄</span></div>
          <div className="auth-glance-grid">
            <span><i>▣</i><b>12</b><small>Posts Published</small><em>↑ +20%</em></span>
            <span><i>⌯</i><b>28</b><small>Social Posts</small><em>↑ +35%</em></span>
            <span><i>☆</i><b>4.8</b><small>Average Rating</small><em>↑ +0.3</em></span>
            <span><i>▥</i><b>1.2K</b><small>Website Visits</small><em>↑ +42%</em></span>
          </div>
        </div>

        <p className="auth-foot"><span>● More Visibility</span><span>● More Customers</span><span>● Less Manual Work</span></p>
      </aside>

      <div className="auth-form-side">
        <div className="auth-form-inner">
          <div className="auth-mobile-mark">
            <Logo size={26} className="logo" />
            <span className="wordmark">
              GrowPilot <span>Studio</span>
            </span>
          </div>

          <div className="auth-form-head">
            <h1>Welcome back</h1>
            <p>{next?.startsWith("/join/") ? "Sign in to accept your invite." : "Sign in to your workspace, or create a new one."}</p>
          </div>

          {authMessage ? (
            <div className="error" style={{ marginBottom: 16 }} role="alert">
              {authMessage}
            </div>
          ) : null}

          {/* Google sign-in is offered only when it is actually configured.
              A button that leads to a misconfiguration error is worse than no
              button — it looks like the product is broken rather than the
              feature being unavailable. */}
          {/*
            * GOOGLE_CLIENT_ID, not GOOGLE_OAUTH_CLIENT_ID.
            *
            * This read a name that exists nowhere else: the config schema,
            * the OAuth start route and .env.example all use GOOGLE_CLIENT_ID.
            * So the button stayed disabled even with credentials set
            * correctly, and the only clue was a tooltip saying Google was not
            * configured — when it was.
            */}
          <AuthForm next={next} googleEnabled={Boolean(
            (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID) &&
            (process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET),
          )} />
          <div className="auth-trust"><span>♢ Secure</span><span>• Private</span><span>• Built for your growth</span></div>
        </div>
      </div>
    </div>
  );
}
