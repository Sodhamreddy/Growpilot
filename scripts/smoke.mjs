// CI-only checks against the disposable seeded database. Never run against customer data.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.CI, "true", "This smoke check requires a disposable CI environment.");
const base = "http://127.0.0.1:3002";
let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try { ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* starting */ }
  if (ready) break;
  await delay(1000);
}
assert.ok(ready, "Web readiness failed");
const login = await fetch(`${base}/api/auth/signin`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "demo@example.com", password: "demo-password-please-change" }) });
assert.equal(login.status, 200, "Seeded sign-in failed");
const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
assert.ok(cookie.includes("ob_session="));
for (const path of ["/api/clients", "/api/analytics/overview", "/integrations", "/articles"]) {
  const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
  assert.equal(response.status, 200, `${path} failed`);
}
const invalid = await fetch(`${base}/api/analytics/overview?days=invalid`, { headers: { cookie } });
assert.equal(invalid.status, 422, "Invalid query must be rejected");
console.log("Health, authentication, client data, analytics, and dashboard smoke checks passed.");
