"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { IconChevron, IconTrash } from "./Icons";

/**
 * Which client the dashboard is showing, and how to add another.
 *
 * An agency runs several businesses from one login. They share the workspace's
 * AI budget, member list and publishing policy, because those belong to the
 * agency; everything a client owns — its crawl, its facts, its voice, its
 * topics, its articles — is scoped by business and never bleeds across.
 *
 * This replaces the static workspace card that already sat here naming the
 * current client. Making the label the control puts the switch where a person
 * already looks to check which client they are in.
 */

export interface ClientRow {
  id: string;
  name: string;
  websiteUrl: string | null;
  confirmedAt: string | null;
  crawlStatus: string | null;
}

function clientSetupState(client: ClientRow): { label: string; tone: string } | null {
  if (client.confirmedAt) return null;
  if (client.crawlStatus === "pending" || client.crawlStatus === "running") {
    return { label: "reading site", tone: "working" };
  }
  if (client.crawlStatus === "failed" || client.crawlStatus === "blocked") {
    return { label: "scan failed", tone: "failed" };
  }
  if (client.crawlStatus === "succeeded") {
    return { label: "review profile", tone: "review" };
  }
  return { label: "needs setup", tone: "" };
}

/** The profile fields the add form collects beyond name and website. */
const PROFILE_FIELDS = [
  {
    key: "industry",
    label: "Industry",
    placeholder: "Home health care",
    hint: "Decides which social categories this client gets.",
  },
  {
    key: "audience",
    label: "Who they serve",
    placeholder: "Adult children arranging care for an ageing parent",
  },
  {
    key: "description",
    label: "What the business does",
    placeholder: "One or two sentences, as the business would say it.",
    multiline: true,
  },
  {
    key: "usp",
    label: "What makes them different",
    placeholder: "Nurse-led, same-day start, no long contract",
  },
  {
    key: "primaryCta",
    label: "What a reader should do",
    placeholder: "Call for a free care assessment",
  },
  {
    key: "gmbName",
    label: "Google Business Profile name",
    placeholder: "Exactly as the listing is registered",
    hint: "Used in review replies, where a near-miss reads as the wrong business.",
  },
] as const;

type ProfileKey = (typeof PROFILE_FIELDS)[number]["key"];
const EMPTY_PROFILE = Object.fromEntries(
  PROFILE_FIELDS.map((f) => [f.key, ""]),
) as Record<ProfileKey, string>;

export function ClientSwitcher({
  clients,
  selectedId,
  plan,
  canAdd,
  canRemove,
}: {
  clients: ClientRow[];
  selectedId: string | null;
  plan: string;
  canAdd: boolean;
  /** Removing a client is the owner's decision; everybody else sees no control. */
  canRemove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [profile, setProfile] = useState<Record<ProfileKey, string>>(EMPTY_PROFILE);
  const [details, setDetails] = useState(false);
  /** Which client the remove confirmation is open for, if any. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Which client to show while the switch is in flight.
   *
   * The server prop is the authority; this only covers the few hundred
   * milliseconds between the click and the refresh landing, so the label does
   * not sit on the old name while the request is out.
   *
   * It used to be ordinary state seeded from the prop and synced by an effect.
   * React preserves client state across router.refresh(), and the effect only
   * fires when the prop's identity changes, so once the two disagreed the
   * component kept its own value indefinitely. With a crawl running,
   * ClientCrawlRefresh calls router.refresh() every eight seconds, and each
   * one re-rendered the sidebar from stale state while the page underneath
   * showed the client actually selected. That is the "switching does not
   * switch" report, and why it repeated.
   *
   * Clearing the guess as soon as the prop agrees keeps the server in charge:
   * anything it says that this did not predict now wins immediately.
   */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const activeId = pendingId ?? selectedId;

  useEffect(() => {
    if (pendingId && pendingId === selectedId) setPendingId(null);
  }, [pendingId, selectedId]);

  const current = clients.find((c) => c.id === activeId) ?? clients[0];

  async function select(id: string) {
    if (id === current?.id) { setOpen(false); return; }
    setPendingId(id);
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: id }),
      });
      if (!res.ok) {
        const body: unknown = await res.json();
        // Drop the guess and fall back to whatever the server last said.
        setPendingId(null);
        setError((body as { error?: { message?: string } }).error?.message ?? "Could not switch.");
        setOpen(true);
        return;
      }
      router.refresh();
    } catch {
      setPendingId(null);
      setError("Could not reach the server.");
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  function resetAdd() {
    setName("");
    setUrl("");
    setProfile(EMPTY_PROFILE);
    setDetails(false);
    setAdding(false);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Only send what was filled in. An empty string would be stored as an
      // empty field, which then blocks the crawl from seeding it.
      const supplied = Object.fromEntries(
        Object.entries(profile).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
      );
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          websiteUrl: url.trim() || undefined,
          ...supplied,
        }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "Could not add that.");
        return;
      }
      resetAdd();
      setOpen(false);
      router.push("/settings/business");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Remove a client.
   *
   * The server refuses when the client has articles, so the destructive case
   * is already fenced off server-side; this confirmation exists for the other
   * one, where a client with a crawl, a voice and a topic pool but no article
   * yet would otherwise vanish on a single click.
   */
  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: id }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "Could not remove that.");
        return;
      }
      setConfirming(null);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="clientswitch">
      <button
        type="button"
        className="wscard wscard-btn"
        aria-expanded={open}
        aria-haspopup="menu"
        /*
         * Closing the menu discards everything that was in progress in it.
         *
         * `setAdding(false)` alone left two states alive. A delete
         * confirmation survived the close, so reopening the menu later showed
         * a red "Remove X? … cannot be restored" row with an armed button,
         * presented as though it had just been asked for — one click from
         * irreversible loss. And the add form kept its typed profile, so the
         * next client added inherited the previous one's industry, audience
         * and description, which then went straight into its writing
         * instructions where it reads plausibly enough to survive review.
         */
        onClick={() => {
          setOpen(!open);
          resetAdd();
          setConfirming(null);
          setError(null);
        }}
      >
        <span className="wsavatar">{(current?.name ?? "W")[0]!.toUpperCase()}</span>
        <span className="wsmeta">
          <strong>{current?.name ?? "No client yet"}</strong>
          <span>
            {clients.length > 1 ? `${clients.length} clients` : `${plan} workspace`}
          </span>
        </span>
        <span className={`chev${open ? " open" : ""}`} aria-hidden>
          <IconChevron size={14} />
        </span>
      </button>
      <span className="sr-only" aria-live="polite">
        {busy ? `Switching to ${current?.name ?? "client"}` : ""}
      </span>

      {open ? (
        <div className="clientmenu" role="menu">
          {clients.map((c) => {
            const setup = clientSetupState(c);

            /*
             * Confirming a removal replaces the row rather than opening a
             * dialog over it. The name stays on screen next to the button
             * that destroys it, which is the thing a person needs to reread.
             */
            if (confirming === c.id) {
              return (
                <div key={c.id} className="clientconfirm">
                  <p>
                    Remove <strong>{c.name}</strong>? Its profile, crawl, voice and topics go
                    with it and cannot be restored.
                  </p>
                  <div className="row" style={{ gap: 8 }}>
                    <button type="button" className="btn danger small" disabled={busy}
                            onClick={() => void remove(c.id)}>
                      {busy ? "Removing…" : "Remove"}
                    </button>
                    <button type="button" className="btn small" disabled={busy}
                            onClick={() => { setConfirming(null); setError(null); }}>
                      Keep
                    </button>
                  </div>
                </div>
              );
            }

            return (
            <div key={c.id} className={`clientrow${c.id === current?.id ? " on" : ""}`}>
              <button
                type="button"
                role="menuitem"
                className="clientitem"
                disabled={busy}
                onClick={() => void select(c.id)}
              >
                <span className="clientitem-name">{c.name}</span>
                {/*
                  * An unconfirmed client has been added but its profile never
                  * checked, so everything generated for it would be built on
                  * facts nobody verified. Worth saying in the list rather than
                  * discovering three screens later.
                  */}
                {setup ? <span className={`clientitem-flag ${setup.tone}`}>{setup.label}</span> : null}
              </button>
              {/*
                * Removing the last client would leave the dashboard with
                * nothing to show and no obvious way back, so the control is
                * hidden rather than shown and then refused.
                */}
              {canRemove && clients.length > 1 ? (
                <button
                  type="button"
                  className="clientremove"
                  title={`Remove ${c.name}`}
                  aria-label={`Remove ${c.name}`}
                  disabled={busy}
                  onClick={() => { setConfirming(c.id); setError(null); }}
                >
                  <IconTrash size={13} />
                </button>
              ) : null}
            </div>
            );
          })}

          {canAdd ? (
            adding ? (
              <form className="clientadd" onSubmit={(e) => void add(e)}>
                <label>
                  <span>Client name</span>
                  <input
                    type="text"
                    placeholder="Client name"
                    value={name}
                    disabled={busy}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  <span>Website for automatic setup</span>
                  <input
                    type="url"
                    inputMode="url"
                    placeholder="https://clientwebsite.com"
                    value={url}
                    disabled={busy}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </label>
                <p className="small muted" style={{ margin: "2px 0 6px" }}>
                  Add a website to import services, locations, brand colours and a logo. Leave it
                  empty only when you want to enter the profile manually.
                </p>

                {/*
                  * The rest of the profile, folded away.
                  *
                  * With a website the crawl fills all of it, so putting six
                  * more boxes in front of every new client would ask for work
                  * that is about to be done anyway. Open when the site is
                  * thin, blocked, or does not exist yet — and anything typed
                  * here is kept, never overwritten by a later scan.
                  */}
                <details className="clientadd-more" open={details}>
                  <summary onClick={(e) => { e.preventDefault(); setDetails(!details); }}>
                    {details ? "Hide details" : "Add details now"}
                    <span className="small muted">
                      {url.trim() ? " · optional, the scan fills these" : " · no website to scan"}
                    </span>
                  </summary>

                  {PROFILE_FIELDS.map((f) => (
                    <label key={f.key}>
                      <span>{f.label}</span>
                      {"multiline" in f && f.multiline ? (
                        <textarea
                          rows={3}
                          placeholder={f.placeholder}
                          value={profile[f.key]}
                          disabled={busy}
                          onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                        />
                      ) : (
                        <input
                          type="text"
                          placeholder={f.placeholder}
                          value={profile[f.key]}
                          disabled={busy}
                          onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                        />
                      )}
                      {"hint" in f && f.hint ? <em className="clientadd-hint">{f.hint}</em> : null}
                    </label>
                  ))}
                </details>

                <div className="row" style={{ gap: 8 }}>
                  <button type="submit" className="btn primary small"
                          disabled={busy || !name.trim()}>
                    {busy ? "Adding…" : url.trim() ? "Add and scan website" : "Add manually"}
                  </button>
                  <button type="button" className="btn small" disabled={busy}
                          onClick={() => { resetAdd(); setError(null); }}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="clientitem clientitem-add"
                      onClick={() => setAdding(true)}>
                + Add a client
              </button>
            )
          ) : null}

          {error ? <p className="error small" style={{ margin: "8px 10px 4px" }}>{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
