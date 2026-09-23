"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { FormEvent } from "react";

export function SocialDateFilter({ active }: { active: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function applyCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get("from") ?? "");
    const to = String(form.get("to") ?? "");
    if (!from || !to || from > to) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set("period", "custom");
    next.set("from", from);
    next.set("to", to);
    next.delete("days");
    router.push(`/social-insights?${next}`);
  }

  return <form className={`si-custom-filter ${active === "custom" ? "active" : ""}`} onSubmit={applyCustom}>
    <label><span>From</span><input name="from" type="date" defaultValue={searchParams.get("from") ?? ""} required /></label>
    <label><span>To</span><input name="to" type="date" defaultValue={searchParams.get("to") ?? ""} required /></label>
    <button type="submit">Apply</button>
  </form>;
}
