import Link from "next/link";

export default function NotFound() {
  return <main className="content"><h1>Page not found</h1><p>This page may have moved or been removed.</p><Link href="/home">Return to dashboard</Link></main>;
}
