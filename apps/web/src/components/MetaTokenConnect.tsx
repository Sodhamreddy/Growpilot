"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Connect Facebook and Instagram by pasting a token.
 *
 * The OAuth button beside this is the better route and stays the default. This
 * exists because Meta will not accept `localhost` as an App Domain, so the
 * redirect cannot complete against a local dev server — and waiting for a
 * deployed URL to see whether any of this works is a long way to find out.
 *
 * Written as a disclosure rather than a second primary button: somebody who
 * can use OAuth should, and this should not compete for the same click.
 */
export function MetaTokenConnect({
  connected,
  pageNames,
}: {
  connected: boolean;
  /** What the stored connection currently reaches, for the connected state. */
  pageNames: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  /** Refreshes remaining while the first sync lands. Zero means idle. */
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    if (polls <= 0) return;
    const timer = window.setTimeout(() => {
      router.refresh();
      setPolls((n) => n - 1);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [polls, router]);

  /*
   * An app token is recognisable without asking Meta.
   *
   * It is literally the app id and secret joined by a pipe, so the character
   * is a reliable tell — and Explorer defaults to this type, which makes it
   * the most common paste. Catching it here turns a round trip and a Graph
   * error into an instant, specific answer.
   */
  const looksLikeAppToken = token.includes("|");

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (looksLikeAppToken) {
      setError(
        "That is an App token — the pipe character gives it away. In Graph API Explorer, " +
        "change \"User or Page\" to \"User Token\" and generate again. A User token starts " +
        "with EAA and is several hundred characters long.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/integrations/meta/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "That token did not work.");
        return;
      }
      const payload = body as {
        pages?: { name: string; instagram: boolean }[];
        syncing?: boolean;
      };
      const pages = payload.pages ?? [];
      setResult(
        `Connected ${pages.length} page${pages.length === 1 ? "" : "s"}: ` +
        pages.map((p) => p.name + (p.instagram ? " (+ Instagram)" : "")).join(", ") +
        (payload.syncing ? ". Pulling the last 30 days now…" : "."),
      );
      /*
       * Watch for the first rows, then stop.
       *
       * The sync runs on the analytics queue and takes a few seconds to a
       * minute depending on how many posts a page has. Without this the page
       * sits on an empty state until somebody reloads, which looks exactly
       * like a connection that did not work.
       *
       * Bounded rather than open-ended: eight checks at five seconds covers
       * a slow sync, and a poll that never gives up is a poll that hammers a
       * broken job forever.
       */
      if (payload.syncing) setPolls(8);
      // Cleared immediately: it is a live credential and there is no reason
      // for it to sit in a form field after it has been stored.
      setToken("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/meta/token", { method: "DELETE" });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError((body as { error?: { message?: string } }).error?.message ?? "Could not disconnect.");
        return;
      }
      setResult(null);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (connected) {
    return (
      <div className="metatoken connected">
        <div>
          <strong>Facebook connected</strong>
          <p>{pageNames ?? "Insights sync on the next run."}</p>
        </div>
        <button type="button" className="btn small" disabled={busy} onClick={() => void disconnect()}>
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    );
  }

  return (
    <div className="metatoken">
      <button type="button" className="metatoken-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide manual connection" : "Connect with an access token instead"}
      </button>

      {open ? (
        <form onSubmit={(e) => void connect(e)}>
          {/*
            * The steps, in the form.
            *
            * Generating a token is four clicks in a tool most people have
            * never opened, and sending somebody to find the instructions
            * elsewhere is where this stops being usable.
            */}
          <ol className="metatoken-steps">
            <li>
              Open the{" "}
              <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">
                Graph API Explorer
              </a>{" "}
              and select your app.
            </li>
            <li>
              Add these permissions: <code>pages_show_list</code>, <code>pages_read_engagement</code>,{" "}
              <code>read_insights</code>, <code>instagram_basic</code>,{" "}
              <code>instagram_manage_insights</code>.
            </li>
            <li>Click <strong>Generate Access Token</strong> and approve the popup.</li>
            <li>Copy the token and paste it below.</li>
          </ol>

          <label>
            <span>Access token</span>
            <textarea
              rows={3}
              value={token}
              placeholder="EAAG…"
              disabled={busy}
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
            />
          </label>

          <p className="small muted" style={{ margin: "0 0 10px" }}>
            Stored encrypted and never shown again. It lasts about 60 days, after which it needs
            pasting again — OAuth does not have that limitation and is the better option once this
            app has a public URL.
          </p>

          {looksLikeAppToken ? (
            <p className="error small" style={{ margin: "0 0 10px" }}>
              This is an App token. Switch &ldquo;User or Page&rdquo; to &ldquo;User Token&rdquo; in Explorer.
            </p>
          ) : null}

          <button type="submit" className="btn primary small"
                  disabled={busy || token.trim().length < 40 || looksLikeAppToken}>
            {busy ? "Checking with Meta…" : "Connect"}
          </button>
        </form>
      ) : null}

      {result ? (
        <p className="metatoken-ok">
          {result}
          {polls > 0 ? <span className="metatoken-polling"> checking for data…</span> : null}
        </p>
      ) : null}
      {error ? <p className="error small" style={{ margin: "10px 0 0" }}>{error}</p> : null}
    </div>
  );
}
