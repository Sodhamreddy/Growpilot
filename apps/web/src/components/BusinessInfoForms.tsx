"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Editors for the parts of a business profile a person has to supply.
 *
 * Each section saves on its own rather than the page having one Save button.
 * A customer filling gaps works through them one at a time, often over several
 * sittings, and a single form that loses everything on one validation error is
 * the wrong shape for that.
 */

const NETWORKS = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "x", label: "X" },
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
  { id: "pinterest", label: "Pinterest" },
] as const;

export interface SocialProfile {
  network: string;
  handle: string;
  url: string;
}

export interface LocationRow {
  id: string;
  label: string;
  streetAddress: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
}

export interface ServiceRow {
  id: string;
  value: string;
  verified: boolean;
  sourceUrl: string | null;
}

async function send(url: string, method: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const parsed: unknown = await res.json().catch(() => null);
    return (
      (parsed as { error?: { message?: string } } | null)?.error?.message ??
      "That did not save. Please try again."
    );
  } catch {
    return "Could not reach the server.";
  }
}

function Status({ error, saved }: { error: string | null; saved: boolean }) {
  if (error) return <p className="small" style={{ color: "var(--danger)", margin: "8px 0 0" }}>{error}</p>;
  if (saved) return <p className="small muted" style={{ margin: "8px 0 0" }}>Saved.</p>;
  return null;
}

/* ─────────────────────────── Brand ─────────────────────────── */

export function BrandSection({
  businessId, canEdit, initialLogoUrl, initialGmbName,
}: {
  businessId: string;
  canEdit: boolean;
  initialLogoUrl: string | null;
  initialGmbName: string | null;
}) {
  const router = useRouter();
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl ?? "");
  const [gmbName, setGmbName] = useState(initialGmbName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const embeddedLogo = logoUrl.startsWith("data:image/");

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const err = await send("/api/business/info", "PATCH", {
      businessId,
      logoUrl: logoUrl.trim() || null,
      gmbName: gmbName.trim() || null,
    });
    setBusy(false);
    if (err) setError(err);
    else {
      setSaved(true);
      router.refresh();
    }
  }

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="formgrid">
        <label className="field">
          <span className="fieldlabel">Logo URL</span>
          <input
            type="url"
            value={embeddedLogo ? "" : logoUrl}
            disabled={!canEdit}
            placeholder={embeddedLogo ? "Uploaded during setup — enter a URL to replace it" : "https://yoursite.com/logo.png"}
            onChange={(e) => setLogoUrl(e.target.value)}
          />
          <span className="hint">
            Use an https image address, or upload a file during setup. Used wherever generated content carries your brand.
          </span>
        </label>

        <label className="field">
          <span className="fieldlabel">Google Business Profile name</span>
          <input
            type="text"
            value={gmbName}
            disabled={!canEdit}
            placeholder="Kleza Solutions Pvt Ltd"
            onChange={(e) => setGmbName(e.target.value)}
          />
          <span className="hint">
            Exactly as it appears on Google. Often longer than the name on your site — review
            replies use this one so customers recognise it.
          </span>
        </label>
      </div>

      {logoUrl.trim().startsWith("https://") || embeddedLogo ? (
        <div className="row" style={{ marginTop: 14, alignItems: "center", gap: 12 }}>
          <img
            src={logoUrl.trim()}
            alt="Logo preview"
            style={{ height: 40, width: "auto", maxWidth: 180, objectFit: "contain" }}
          />
          <span className="small muted">Preview — if nothing shows, the address is not an image.</span>
        </div>
      ) : null}

      {canEdit ? (
        <div style={{ marginTop: 16 }}>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      ) : null}
      <Status error={error} saved={saved} />
    </div>
  );
}

/* ────────────────────────── Services ────────────────────────── */

export function ServicesSection({
  businessId, canEdit, initial,
}: {
  businessId: string;
  canEdit: boolean;
  initial: ServiceRow[];
}) {
  const router = useRouter();
  const rows = initial;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    const err = await send("/api/business/services", "POST", { businessId, value: value.trim() });
    setBusy(false);
    if (err) { setError(err); return; }
    setValue("");
    router.refresh();
  }

  async function remove(factId: string) {
    setError(null);
    const err = await send("/api/business/services", "DELETE", { businessId, factId });
    if (err) { setError(err); return; }
    router.refresh();
  }

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      {rows.length === 0 ? (
        <p className="small muted" style={{ margin: "0 0 14px" }}>
          No services listed. Keyword research works from this list, so nothing can be planned
          until there is at least one.
        </p>
      ) : (
        <div className="tablewrap" style={{ marginBottom: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th style={{ width: 110 }}>Source</th>
                {canEdit ? <th style={{ width: 80 }} /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>{s.value}</td>
                  <td>
                    <span className={`badge ${s.sourceUrl ? "neutral" : "ok"}`}>
                      {s.sourceUrl ? "from site" : "added"}
                    </span>
                  </td>
                  {canEdit ? (
                    <td>
                      <button type="button" className="btn small" onClick={() => void remove(s.id)}>
                        Remove
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit ? (
        <div className="row" style={{ gap: 10 }}>
          <input
            type="text"
            value={value}
            placeholder="Website Development — scalable sites for growing businesses"
            style={{ flex: 1 }}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          />
          <button type="button" className="btn primary" disabled={busy || !value.trim()} onClick={() => void add()}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      ) : null}
      <Status error={error} saved={false} />
    </div>
  );
}

/* ────────────────────────── Locations ────────────────────────── */

const EMPTY_LOCATION = {
  label: "", streetAddress: "", locality: "", region: "", postalCode: "", country: "", phone: "",
};

export function LocationsSection({
  businessId, canEdit, initial,
}: {
  businessId: string;
  canEdit: boolean;
  initial: LocationRow[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ ...EMPTY_LOCATION });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const err = await send("/api/business/locations", "POST", { businessId, ...draft });
    setBusy(false);
    if (err) { setError(err); return; }
    setDraft({ ...EMPTY_LOCATION });
    setAdding(false);
    router.refresh();
  }

  async function remove(locationId: string) {
    const err = await send("/api/business/locations", "DELETE", { businessId, locationId });
    if (err) { setError(err); return; }
    router.refresh();
  }

  const missing = (l: LocationRow) =>
    [
      !l.streetAddress && "street",
      !l.locality && "city",
      !l.postalCode && "postal code",
      !l.phone && "phone",
    ].filter(Boolean) as string[];

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      {initial.length === 0 ? (
        <p className="small muted" style={{ margin: "0 0 14px" }}>
          No locations. Local content and directory listings both need a complete address.
        </p>
      ) : (
        <div className="tablewrap" style={{ marginBottom: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Address</th>
                <th style={{ width: 140 }}>Phone</th>
                <th style={{ width: 130 }}>Complete</th>
                {canEdit ? <th style={{ width: 80 }} /> : null}
              </tr>
            </thead>
            <tbody>
              {initial.map((l) => {
                const gaps = missing(l);
                return (
                  <tr key={l.id}>
                    <td><strong>{l.label}</strong></td>
                    <td className="muted small">
                      {[l.streetAddress, l.locality, l.region, l.postalCode, l.country]
                        .filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="muted small">{l.phone ?? "—"}</td>
                    <td>
                      <span className={`badge ${gaps.length ? "warn" : "ok"}`}>
                        {gaps.length ? `missing ${gaps.join(", ")}` : "complete"}
                      </span>
                    </td>
                    {canEdit ? (
                      <td>
                        <button type="button" className="btn small" onClick={() => void remove(l.id)}>
                          Remove
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && !adding ? (
        <button type="button" className="btn" onClick={() => setAdding(true)}>Add a location</button>
      ) : null}

      {canEdit && adding ? (
        <>
          <div className="formgrid">
            {([
              ["label", "Label", "Headquarters"],
              ["streetAddress", "Street address", "7300 W 110th St, Suite 700"],
              ["locality", "City", "Overland Park"],
              ["region", "State or region", "KS"],
              ["postalCode", "Postal code", "66210"],
              ["country", "Country", "United States"],
              ["phone", "Phone", "+1 913 555 0134"],
            ] as const).map(([key, label, placeholder]) => (
              <label className="field" key={key}>
                <span className="fieldlabel">{label}</span>
                <input
                  type="text"
                  value={draft[key]}
                  placeholder={placeholder}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 10, marginTop: 14 }}>
            <button type="button" className="btn primary" disabled={busy || !draft.label.trim()} onClick={() => void create()}>
              {busy ? "Saving…" : "Save location"}
            </button>
            <button type="button" className="btn" onClick={() => { setAdding(false); setDraft({ ...EMPTY_LOCATION }); }}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
      <Status error={error} saved={false} />
    </div>
  );
}

/* ──────────────────────── Social channels ──────────────────────── */

export function SocialSection({
  businessId, canEdit, initial,
}: {
  businessId: string;
  canEdit: boolean;
  initial: SocialProfile[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<SocialProfile[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const setUrl = (network: string, url: string) => {
    setRows((current) => {
      const rest = current.filter((r) => r.network !== network);
      if (!url.trim()) return rest;
      // The handle is the last non-empty path segment — what a person would
      // read off the profile — with the leading @ some networks display.
      const handle = url.trim().replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? network;
      return [...rest, { network, handle: handle.replace(/^@/, ""), url: url.trim() }];
    });
  };

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const err = await send("/api/business/info", "PATCH", { businessId, socialProfiles: rows });
    setBusy(false);
    if (err) setError(err);
    else { setSaved(true); router.refresh(); }
  }

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="formgrid">
        {NETWORKS.map((n) => {
          const row = rows.find((r) => r.network === n.id);
          return (
            <label className="field" key={n.id}>
              <span className="fieldlabel">{n.label}</span>
              <input
                type="url"
                value={row?.url ?? ""}
                disabled={!canEdit}
                placeholder={`https://${n.id}.com/yourbusiness`}
                onChange={(e) => setUrl(n.id, e.target.value)}
              />
            </label>
          );
        })}
      </div>
      <p className="small muted" style={{ margin: "12px 0 0" }}>
        Listing a channel tells us which networks to plan content for. Posting to them needs a
        connected account, which is a separate step in Integrations.
      </p>
      {canEdit ? (
        <div style={{ marginTop: 16 }}>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save channels"}
          </button>
        </div>
      ) : null}
      <Status error={error} saved={saved} />
    </div>
  );
}

/* ────────────────────── WordPress connection ────────────────────── */

export function WordPressSection({
  businessId, canEdit, connected,
}: {
  businessId: string;
  canEdit: boolean;
  connected: { displayName: string | null; status: string } | null;
}) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [applicationPassword, setApplicationPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const err = await send("/api/integrations/wordpress", "POST", {
      businessId,
      baseUrl: baseUrl.trim(),
      username: username.trim(),
      applicationPassword,
    });
    setBusy(false);
    if (err) setError(err);
    else {
      setSaved(true);
      // Never keep the credential in component state after it is stored.
      setApplicationPassword("");
      router.refresh();
    }
  }

  async function disconnect() {
    setBusy(true);
    const err = await send("/api/integrations/wordpress", "DELETE", { businessId });
    setBusy(false);
    if (err) setError(err);
    else router.refresh();
  }

  if (connected && connected.status === "connected") {
    return (
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <strong>Connected</strong>
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              {connected.displayName ?? "WordPress"} — approved articles are sent here as drafts.
            </p>
          </div>
          {canEdit ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void disconnect()}>
              {busy ? "…" : "Disconnect"}
            </button>
          ) : null}
        </div>
        <Status error={error} saved={false} />
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="formgrid">
        <label className="field">
          <span className="fieldlabel">Site address</span>
          <input
            type="url"
            value={baseUrl}
            disabled={!canEdit}
            placeholder="https://yoursite.com"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <span className="hint">Must be https — an application password is equivalent to a login.</span>
        </label>

        <label className="field">
          <span className="fieldlabel">WordPress username</span>
          <input
            type="text"
            value={username}
            disabled={!canEdit}
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="fieldlabel">Application password</span>
          <input
            type="password"
            value={applicationPassword}
            disabled={!canEdit}
            autoComplete="new-password"
            placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
            onChange={(e) => setApplicationPassword(e.target.value)}
          />
          <span className="hint">
            In WordPress: Users → Profile → Application Passwords. Spaces are fine.
          </span>
        </label>
      </div>

      <p className="small muted" style={{ margin: "12px 0 0", maxWidth: "70ch" }}>
        We check the credential against your site before saving it, including that the user can
        create posts. It is encrypted at rest and never sent back to the browser.
      </p>

      {canEdit ? (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !baseUrl.trim() || !username.trim() || !applicationPassword}
            onClick={() => void connect()}
          >
            {busy ? "Checking…" : "Connect"}
          </button>
        </div>
      ) : null}
      <Status error={error} saved={saved} />
    </div>
  );
}
