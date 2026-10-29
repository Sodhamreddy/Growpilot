"use client";

import { useId, useRef, useState } from "react";
import { IconEdit, IconSpark } from "./Icons";
import { BlogPromptSettings, type BlogPrompts } from "./BlogPromptSettings";
import { TopicSuggester } from "./TopicSuggester";
import styles from "./BlogQueue.module.css";

export function BlogHeaderActions({
  businessId,
  businessName = "",
  canEdit,
  blockedReason,
  prompts,
}: {
  businessId: string | null;
  businessName?: string;
  canEdit: boolean;
  blockedReason: string | null;
  prompts: BlogPrompts;
}) {
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructionsOpened, setInstructionsOpened] = useState(false);
  const [showTopics, setShowTopics] = useState(false);
  const [topicsOpened, setTopicsOpened] = useState(false);
  const topicsId = useId();
  const instructionsId = useId();
  const topicsRef = useRef<HTMLElement>(null);

  const configured = [prompts.topics, prompts.article, prompts.reference]
    .filter((s) => s.trim()).length;

  function createBlog() {
    setTopicsOpened(true); setShowTopics(true); setShowInstructions(false);
    requestAnimationFrame(() => topicsRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.headingCopy}><h1>Blog</h1><p>{businessName ? `${businessName} · ` : ""}Create content, review drafts and publish when ready.</p></div>
        <div className={styles.actions}>
          <button type="button" className={styles.button} aria-expanded={showInstructions} aria-controls={instructionsId}
            disabled={!businessId} title={!businessId ? "Add a business profile to set writing instructions." : undefined}
            onClick={() => { setInstructionsOpened(true); setShowInstructions(value => !value); setShowTopics(false); }}>
            <IconEdit size={15} /><span>Writing instructions</span>{configured ? <span className={styles.configuredDot} title={`${configured} of 3 instructions set`} aria-hidden /> : null}
          </button>
          {canEdit && <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!businessId || Boolean(blockedReason)}
            title={blockedReason ?? "Start with topic ideas from your business profile"} aria-expanded={showTopics} aria-controls={topicsId} onClick={createBlog}>
            <IconSpark size={16} /> Create blog
          </button>}
        </div>
      </header>

      {/*
        * Why the reason sits here rather than only on the button.
        *
        * A disabled control with a tooltip tells someone they cannot proceed
        * but not what to go and fix — and on a touch screen there is no hover
        * to reveal it at all.
        */}
      {blockedReason ? (
        <p className={styles.notice}>
          {blockedReason}
        </p>
      ) : null}

      {instructionsOpened && businessId ? (
        <section className={styles.panel} id={instructionsId} hidden={!showInstructions} aria-label="Writing instructions">
          <div className={styles.panelHeader}><div><h2>Writing instructions</h2><p>Set the voice and direction for future articles.</p></div>
            <button type="button" className={styles.closeButton} aria-label="Close writing instructions" onClick={() => setShowInstructions(false)}>×</button></div>
          <BlogPromptSettings businessId={businessId} canEdit={canEdit} initial={prompts} startOpen />
        </section>
      ) : null}

      {businessId && topicsOpened ? (
        <section className={`${styles.panel} ${styles.creationPanel}`} id={topicsId} hidden={!showTopics} ref={topicsRef} aria-label="Create a blog">
          <div className={styles.panelHeader}><div><h2>Choose a topic to get started</h2><p>Review its brief before generating a draft. AI suggestions use your workspace budget.</p></div>
            <button type="button" className={styles.closeButton} aria-label="Close topic suggestions" onClick={() => setShowTopics(false)}>×</button></div>
          <TopicSuggester businessId={businessId} canEdit={canEdit} blockedReason={blockedReason} compact autoRun />
        </section>
      ) : null}
    </>
  );
}
