"use client";

import { useState } from "react";
import { IconEdit, IconSpark } from "./Icons";
import { BlogPromptSettings, type BlogPrompts } from "./BlogPromptSettings";
import { TopicSuggester } from "./TopicSuggester";

/**
 * The two things you do on this page, beside the title.
 *
 * Both used to be full-width cards carrying a paragraph each, stacked above
 * the article list. That gave two one-click actions the same visual weight as
 * the work itself, and pushed the articles below the fold — the page looked
 * busy while offering very little.
 *
 * As header buttons they stay findable and stop competing. The explanation
 * moves inside: instructions open a panel, suggestions render only once there
 * are topics to look at.
 */

export function BlogHeaderActions({
  businessId,
  canEdit,
  blockedReason,
  prompts,
}: {
  businessId: string | null;
  canEdit: boolean;
  blockedReason: string | null;
  prompts: BlogPrompts;
}) {
  const [showInstructions, setShowInstructions] = useState(false);
  /*
   * A counter, not a boolean.
   *
   * Bumping it remounts the suggester, which is what makes "Suggest again"
   * from the header actually re-run rather than toggling a panel that is
   * already open.
   */
  const [runId, setRunId] = useState(0);
  const [asked, setAsked] = useState(false);

  const configured = [prompts.topics, prompts.article, prompts.reference]
    .filter((s) => s.trim()).length;

  return (
    <>
      <div className="headeractions">
        <button
          type="button"
          className={`actionbtn${showInstructions ? " on" : ""}`}
          aria-expanded={showInstructions}
          aria-label="Writing instructions"
          onClick={() => setShowInstructions((v) => !v)}
        >
          <span className="actionbtn-icon" aria-hidden><IconEdit size={15} /></span>
          <span style={{ whiteSpace: "nowrap", fontSize: 13 }}>Writing instructions</span>
          {configured ? (
            <span className="dot" title={`${configured} of 3 set`} aria-hidden />
          ) : null}
        </button>

        {businessId && canEdit ? (
          <button
            type="button"
            /*
             * Styled inline rather than through `.actionbtn.primary`.
             *
             * The class version rendered as an empty outlined box on the
             * user's machine — green border, white fill, invisible white
             * label — while the source, the compiled chunk and the served
             * stylesheet all read correctly. Rather than keep guessing at
             * which layer dropped the rule, the two declarations that make
             * this button legible are stated on the element, where nothing
             * in the cascade can reach them.
             */
            className="actionbtn"
            style={{
              background: "var(--accent)",
              borderColor: "var(--accent)",
              color: "#fff",
            }}
            disabled={Boolean(blockedReason)}
            title={blockedReason ?? undefined}
            aria-label={asked ? "Suggest again" : "Suggest topics"}
            onClick={() => { setAsked(true); setRunId((n) => n + 1); }}
          >
            <span className="actionbtn-icon" aria-hidden><IconSpark size={15} /></span>
            <span style={{ whiteSpace: "nowrap", fontSize: 13, color: "#fff" }}>
              {asked ? "Suggest again" : "Suggest topics"}
            </span>
          </button>
        ) : null}
      </div>

      {/*
        * Why the reason sits here rather than only on the button.
        *
        * A disabled control with a tooltip tells someone they cannot proceed
        * but not what to go and fix — and on a touch screen there is no hover
        * to reveal it at all.
        */}
      {blockedReason ? (
        <p className="small" style={{ color: "var(--warn)", margin: "10px 0 0" }}>
          {blockedReason}
        </p>
      ) : null}

      {showInstructions ? (
        <div style={{ marginTop: 18 }}>
          <BlogPromptSettings canEdit={canEdit} initial={prompts} startOpen />
        </div>
      ) : null}

      {businessId && asked ? (
        <div style={{ marginTop: 18 }}>
          <TopicSuggester
            key={runId}
            businessId={businessId}
            canEdit={canEdit}
            blockedReason={blockedReason}
            compact
            autoRun
          />
        </div>
      ) : null}
    </>
  );
}
