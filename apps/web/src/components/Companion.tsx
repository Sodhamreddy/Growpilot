"use client";

import { useState, useRef, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { IconSpark, IconArrow } from "./Icons";

/**
 * The dashboard companion.
 *
 * Ask it where something is, or tell it what to do. It answers questions
 * directly, navigates immediately, and asks before anything that spends money
 * or changes content.
 *
 * It does not run actions itself. The server returns a validated intent and
 * this calls the same endpoint the equivalent button would have called, so
 * every role check and rate limit stays in one place rather than being
 * reimplemented behind a chat box.
 */

interface Turn {
  role: "user" | "assistant";
  content: string;
  /** Set on an assistant turn that is waiting for a yes. */
  pending?: {
    intent: string;
    args: Record<string, unknown>;
    action: string;
  };
  /** Set once a pending action has been answered, so it stops asking. */
  resolved?: "done" | "declined" | "failed";
}

export function Companion() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, open]);

  /** The article on screen, so "shorten the intro" knows what to shorten. */
  const articleId = /^\/articles\/([0-9a-f-]{36})/.exec(pathname)?.[1];

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;

    setTurns((t) => [...t, { role: "user", content: message }]);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/companion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          currentPath: pathname,
          ...(articleId ? { articleId } : {}),
          // Enough for a follow-up to resolve, not the whole session.
          history: turns.slice(-6).map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        intent?: string;
        args?: Record<string, unknown>;
        reply?: string;
        needsConfirmation?: boolean;
        action?: string | null;
        error?: { message?: string };
      };

      if (!res.ok) {
        setTurns((t) => [...t, {
          role: "assistant",
          content: body.error?.message ?? "Something went wrong.",
        }]);
        return;
      }

      const turn: Turn = { role: "assistant", content: body.reply ?? "" };
      if (body.needsConfirmation && body.action && body.intent) {
        turn.pending = { intent: body.intent, args: body.args ?? {}, action: body.action };
      }
      setTurns((t) => [...t, turn]);

      // Reversible actions happen without asking.
      if (!body.needsConfirmation && body.intent === "navigate") {
        const route = ROUTES[String(body.args?.["route"] ?? "")];
        if (route) router.push(route);
      }
    } catch {
      setTurns((t) => [...t, { role: "assistant", content: "Could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  /** Run a confirmed action through the endpoint a button would have used. */
  async function confirm(index: number) {
    const turn = turns[index];
    if (!turn?.pending) return;
    const { intent, args } = turn.pending;

    setBusy(true);
    const mark = (resolved: Turn["resolved"], note?: string) =>
      setTurns((t) => t.map((x, i) =>
        i === index
          ? { ...x, resolved, content: note ? `${x.content}\n\n${note}` : x.content }
          : x,
      ));

    try {
      let res: Response;
      switch (intent) {
        case "generate_topics":
          res = await fetch("/api/social/topics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ categoryId: args["categoryId"] }),
          });
          break;
        case "plan_month":
          res = await fetch("/api/social/calendar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              businessId: args["businessId"],
              monthKey: args["month"],
              mode: "preview",
            }),
          });
          break;
        default:
          /*
           * Declared but not wired.
           *
           * Saying so beats a button that appears to work. `generate_blog` and
           * `revise_section` need a topic and an open article respectively,
           * and guessing either would be worse than refusing.
           */
          mark("failed", "That one is not wired up yet. Use the button on the page.");
          return;
      }

      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        mark("failed", body.error?.message ?? "That did not work.");
        return;
      }
      mark("done", "Done.");
      router.refresh();
    } catch {
      mark("failed", "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="companion-fab" onClick={() => setOpen(true)}
              aria-label="Open the assistant">
        <IconSpark size={18} />
      </button>
    );
  }

  return (
    <div className="companion" role="dialog" aria-label="Assistant">
      <div className="companion-head">
        <strong>Assistant</strong>
        <button type="button" className="companion-close" onClick={() => setOpen(false)}
                aria-label="Close">×</button>
      </div>

      <div className="companion-body">
        {turns.length === 0 ? (
          <div className="companion-empty">
            <p className="small muted" style={{ margin: "0 0 10px" }}>
              Ask where something is, or tell me what to do.
            </p>
            {["Where do I set the brand voice?", "Go to social", "Generate Recipes topics"]
              .map((s) => (
                <button key={s} type="button" className="btn small"
                        style={{ marginRight: 6, marginBottom: 6 }}
                        onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
          </div>
        ) : null}

        {turns.map((t, i) => (
          <div key={i} className={`companion-turn ${t.role}`}>
            <div className="companion-bubble">{t.content}</div>

            {t.pending && !t.resolved ? (
              <div className="companion-confirm">
                <p className="small" style={{ margin: "0 0 8px" }}>{t.pending.action}</p>
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn primary small" disabled={busy}
                          onClick={() => void confirm(i)}>
                    Yes, do it
                  </button>
                  <button type="button" className="btn small" disabled={busy}
                          onClick={() => setTurns((ts) =>
                            ts.map((x, j) => j === i ? { ...x, resolved: "declined" } : x))}>
                    No
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}

        {busy ? <div className="companion-turn assistant">
          <div className="companion-bubble muted">Thinking…</div>
        </div> : null}

        <div ref={endRef} />
      </div>

      <form className="companion-input"
            onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input
          type="text"
          value={input}
          disabled={busy}
          placeholder="Ask or tell me what to do…"
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn primary small" disabled={busy || !input.trim()}
                aria-label="Send">
          <IconArrow size={14} />
        </button>
      </form>
    </div>
  );
}

/** Mirrors ROUTES in @ob/companion. Kept here so the client does not import it. */
const ROUTES: Record<string, string> = {
  home: "/home",
  blog: "/articles",
  social: "/social",
  reviews: "/reviews",
  keywords: "/keywords",
  voice: "/voice",
  business: "/business",
  businessInfo: "/settings/business",
  integrations: "/integrations",
  preferences: "/preferences",
};
