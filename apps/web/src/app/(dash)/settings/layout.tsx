import { requireFullAccess } from "@/lib/blog-access-server";

/** Blog-only review team members are sent to Blog Automation (lib/blog-access). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  await requireFullAccess();
  return children;
}
