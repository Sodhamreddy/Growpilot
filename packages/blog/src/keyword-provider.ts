import { AppError, executionSignal } from "@ob/core";
import { StubKeywordProvider, type KeywordDataProvider, type KeywordMetrics } from "./keywords.js";

export class DataForSeoProvider implements KeywordDataProvider {
  readonly name = "dataforseo";
  constructor(private readonly login: string, private readonly password: string, private readonly locationCode: number) {}
  async metrics(terms: string[], opts: { location?: string; language?: string } = {}): Promise<KeywordMetrics[]> {
    const eligible = terms.filter(t => t.length <= 80 && t.trim().split(/\s+/).length <= 10);
    if (!eligible.length) return terms.map(term => ({ term, volume: null, difficulty: null, cpcMicros: null }));
    const res = await fetch("https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live", {
      method: "POST", signal: executionSignal(AbortSignal.timeout(30_000)),
      headers: { Authorization: `Basic ${Buffer.from(`${this.login}:${this.password}`).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ keywords: eligible.slice(0, 700), language_code: opts.language ?? "en",
        ...(opts.location ? { location_name: opts.location } : { location_code: this.locationCode }) }]),
    });
    const body = await res.json() as { status_code?: number; tasks?: { status_code: number; result?: { items?: any[] }[] }[] };
    const task = body.tasks?.[0];
    if (!res.ok || body.status_code !== 20000 || task?.status_code !== 20000) throw new AppError("provider_error", "Keyword metrics could not be loaded. Check DataForSEO credentials, credit and location.", { retryable: res.status >= 500 || res.status === 429 });
    const byTerm = new Map((task.result?.[0]?.items ?? []).map(item => [String(item.keyword).toLowerCase(), item]));
    const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    return terms.map(term => {
      const item = byTerm.get(term.toLowerCase());
      const cpc = number(item?.keyword_info?.cpc);
      return { term, volume: number(item?.keyword_info?.search_volume), difficulty: number(item?.keyword_properties?.keyword_difficulty), cpcMicros: cpc === null ? null : Math.round(cpc * 1_000_000) };
    });
  }
  async expand(): Promise<string[]> { return []; }
}
export function configuredKeywordProvider(): KeywordDataProvider {
  const { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password, DATAFORSEO_LOCATION_CODE: location } = process.env;
  if (!login || !password) return new StubKeywordProvider();
  const code = Number(location);
  if (!Number.isInteger(code) || code <= 0) throw new AppError("validation_failed", "Configure DATAFORSEO_LOCATION_CODE before running keyword research.");
  return new DataForSeoProvider(login, password, code);
}
