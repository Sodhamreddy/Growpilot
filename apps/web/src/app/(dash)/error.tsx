"use client";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="content" role="alert">
    <h1>This page could not load</h1>
    <p>Your saved work is still available. Try loading the page again.</p>
    <button className="btn" onClick={reset}>Try again</button>
  </div>;
}
