import { z } from "zod";

/** The password rule for every new account: sign-up and joining by invite. AuthForm's hint mirrors it. */
export const newPasswordSchema = z.string()
  .min(8, "Use at least 8 characters.")
  .max(200)
  .regex(/[A-Z]/, "Add one uppercase letter.")
  .regex(/[a-z]/, "Add one lowercase letter.")
  .regex(/[0-9]/, "Add one number.")
  .regex(/[^A-Za-z0-9]/, "Add one special character.");
