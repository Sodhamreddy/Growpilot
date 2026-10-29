import { sign } from "node:crypto";
import { AppError, executionSignal } from "@ob/core";
export interface MeasurementCredential {
  clientEmail: string;
  privateKey: string;
  property: string;
}
export type MeasurementProvider = "google_search_console" | "google_analytics";
export interface MeasurementRow { metric: string; date: Date; value: number; dimensions: Record<string, string> }

async function json(url: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(url, { method: "POST", signal: executionSignal(AbortSignal.timeout(30_000)),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) throw new AppError("provider_error", `Google measurement request failed (HTTP ${res.status}). Check property access and API enablement.`, { retryable: res.status === 429 || res.status >= 500 });
  return res.json();
}

async function accessToken(credential: MeasurementCredential, provider: MeasurementProvider): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: credential.clientEmail,
    scope: provider === "google_search_console" ? "https://www.googleapis.com/auth/webmasters.readonly" : "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), credential.privateKey).toString("base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: executionSignal(AbortSignal.timeout(15_000)),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!res.ok) throw new AppError("forbidden", "Google rejected the service account. Check its key and property access.");
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new AppError("provider_error", "Google returned no access token.");
  return data.access_token;
}

export function measurementWindow(days = 28): { start: Date; end: Date } {
  const end = new Date(Date.now() - 3 * 86400000);
  end.setUTCHours(0, 0, 0, 0);
  return { start: new Date(end.getTime() - (days - 1) * 86400000), end };
}

export async function fetchMeasurement(provider: MeasurementProvider, credential: MeasurementCredential, days = 28): Promise<MeasurementRow[]> {
  if (provider === "google_analytics" && !/^\d+$/.test(credential.property)) throw new AppError("validation_failed", "Enter the numeric GA4 property ID.");
  const token = await accessToken(credential, provider);
  const { start, end } = measurementWindow(days);
  const startDate = start.toISOString().slice(0, 10), endDate = end.toISOString().slice(0, 10);
  const out: MeasurementRow[] = [];
  if (provider === "google_search_console") {
    // Date-only totals avoid double counting page/query dimensions in the dashboard.
    const data = await json(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(credential.property)}/searchAnalytics/query`,
      { startDate, endDate, dimensions: ["date"], rowLimit: 25000 }, token);
    for (const row of data.rows ?? []) {
      const date = new Date(`${row.keys[0]}T00:00:00Z`);
      for (const metric of ["clicks", "impressions"]) {
        if (Number.isFinite(row[metric])) out.push({ metric: `search_${metric}`, date, value: row[metric], dimensions: {} });
      }
    }
    // Query rows are stored separately from site totals; GSC may omit anonymized queries.
    for (let startRow = 0; startRow < 100_000; startRow += 25_000) {
      const queries = await json(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(credential.property)}/searchAnalytics/query`,
        { startDate, endDate, dimensions: ["date", "query"], rowLimit: 25000, startRow }, token);
      for (const row of queries.rows ?? []) {
        const date = new Date(`${row.keys[0]}T00:00:00Z`);
        for (const metric of ["clicks", "impressions"]) {
          if (Number.isFinite(row[metric])) out.push({ metric: `search_query_${metric}`, date, value: row[metric], dimensions: { query: row.keys[1] } });
        }
      }
      if ((queries.rows?.length ?? 0) < 25_000) break;
    }
  } else {
    const metrics = ["sessions", "screenPageViews", "keyEvents"];
    const data = await json(`https://analyticsdata.googleapis.com/v1beta/properties/${credential.property}:runReport`,
      { dateRanges: [{ startDate, endDate }], dimensions: [{ name: "date" }], metrics: metrics.map(name => ({ name })), limit: 1000 }, token);
    for (const row of data.rows ?? []) {
      const key = row.dimensionValues[0].value;
      const date = new Date(`${key.slice(0,4)}-${key.slice(4,6)}-${key.slice(6,8)}T00:00:00Z`);
      metrics.forEach((metric, i) => {
        const value = Number(row.metricValues[i]?.value);
        if (Number.isFinite(value)) out.push({ metric: `ga4_${metric}`, date, value, dimensions: {} });
      });
    }
  }
  return out;
}
