import { redirect } from "next/navigation";
import { getSession, checkResetToken } from "@/lib/auth";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";
import { Logo } from "@/components/Logo";

/**
 * Set a new password from an emailed link.
 *
 * The token is validated on the server before the form renders, so an expired
 * or spent link says so immediately rather than accepting a new password and
 * only then admitting it cannot be used.
 */

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  // Somebody already signed in does not need a reset link to change a password.
  if (await getSession()) redirect("/preferences");

  const { token = "" } = await searchParams;
  const valid = token ? await checkResetToken(token) : false;

  return (
    <div className="auth auth--single">
      <div className="auth-form-side">
        <div className="auth-form-inner">
          <div className="auth-mobile-mark" style={{ display: "flex" }}>
            <Logo size={26} className="logo" />
            <span className="wordmark">
              GrowPilot <span>Studio</span>
            </span>
          </div>

          <ResetPasswordForm token={token} valid={valid} />
        </div>
      </div>
    </div>
  );
}
