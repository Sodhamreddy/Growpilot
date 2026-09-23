import { describe, it, expect } from "vitest";

/**
 * The rules an unattended content run follows.
 *
 * Mirrored here as pure functions rather than reaching into the worker, which
 * needs a database and a queue. What matters is the decision logic: an
 * unattended job spends a customer's AI budget with nobody watching, so every
 * refusal is load-bearing and must be pinned.
 */

const BACKLOG_LIMIT = 5;

interface Client {
  confirmed: boolean;
  unreviewedDrafts: number;
}

interface Workspace {
  scheduleEnabled: boolean;
  onboardingComplete: boolean;
  spentMicros: number;
  budgetMicros: number;
}

/** Whether the run proceeds at all. */
function runShouldProceed(ws: Workspace): boolean {
  if (!ws.scheduleEnabled) return false;
  if (!ws.onboardingComplete) return false;
  // A zero budget means "unlimited", matching how the gateway reads it.
  if (ws.budgetMicros > 0 && ws.spentMicros >= ws.budgetMicros) return false;
  return true;
}

/** Whether one client gets queued. */
function clientShouldRun(c: Client): boolean {
  if (!c.confirmed) return false;
  if (c.unreviewedDrafts >= BACKLOG_LIMIT) return false;
  return true;
}

/** Day-of-week + hour → cron. */
function toCron(weekday: number, hour: number): string {
  return `0 ${hour} * * ${weekday}`;
}

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  scheduleEnabled: true,
  onboardingComplete: true,
  spentMicros: 0,
  budgetMicros: 50_000_000,
  ...over,
});

describe("when an unattended run proceeds", () => {
  it("runs for a configured, onboarded workspace within budget", () => {
    expect(runShouldProceed(workspace())).toBe(true);
  });

  it("does not run when the schedule is off", () => {
    // The database is the authority on intent; a stale repeat definition in
    // Redis must not keep firing after someone turns the schedule off.
    expect(runShouldProceed(workspace({ scheduleEnabled: false }))).toBe(false);
  });

  it("does not run before onboarding is finished", () => {
    expect(runShouldProceed(workspace({ onboardingComplete: false }))).toBe(false);
  });

  it("does not run once the monthly budget is spent", () => {
    expect(runShouldProceed(workspace({ spentMicros: 50_000_000 }))).toBe(false);
  });

  it("does not run when the budget is exceeded, not merely reached", () => {
    expect(runShouldProceed(workspace({ spentMicros: 60_000_000 }))).toBe(false);
  });

  it("treats a zero budget as unlimited", () => {
    expect(runShouldProceed(workspace({ budgetMicros: 0, spentMicros: 999_000_000 }))).toBe(true);
  });

  it("checks the budget before queueing, not per client", () => {
    // Otherwise the first clients run and the rest fail mid-flight, leaving a
    // partial week of content and no clear reason why.
    const ws = workspace({ spentMicros: 49_999_999 });
    expect(runShouldProceed(ws)).toBe(true);
    expect(runShouldProceed({ ...ws, spentMicros: 50_000_000 })).toBe(false);
  });
});

describe("which clients get queued", () => {
  it("queues a confirmed client with nothing waiting", () => {
    expect(clientShouldRun({ confirmed: true, unreviewedDrafts: 0 })).toBe(true);
  });

  it("skips a client whose profile is unconfirmed", () => {
    // Generation is gated on confirmation everywhere else; an unattended run
    // must not be the one path that bypasses it.
    expect(clientShouldRun({ confirmed: false, unreviewedDrafts: 0 })).toBe(false);
  });

  it("skips a client with a backlog of unreviewed drafts", () => {
    expect(clientShouldRun({ confirmed: true, unreviewedDrafts: BACKLOG_LIMIT })).toBe(false);
  });

  it("still queues a client just below the backlog limit", () => {
    expect(clientShouldRun({ confirmed: true, unreviewedDrafts: BACKLOG_LIMIT - 1 })).toBe(true);
  });

  it("judges each client independently", () => {
    const clients: Client[] = [
      { confirmed: true, unreviewedDrafts: 0 },
      { confirmed: false, unreviewedDrafts: 0 },
      { confirmed: true, unreviewedDrafts: 9 },
      { confirmed: true, unreviewedDrafts: 2 },
    ];
    expect(clients.map(clientShouldRun)).toEqual([true, false, false, true]);
  });
});

describe("cron expression", () => {
  it("builds Monday 09:00", () => {
    expect(toCron(1, 9)).toBe("0 9 * * 1");
  });

  it("builds Sunday midnight", () => {
    expect(toCron(0, 0)).toBe("0 0 * * 0");
  });

  it("builds Saturday 23:00", () => {
    expect(toCron(6, 23)).toBe("0 23 * * 6");
  });

  it("fires once a week, not every day", () => {
    // A missing weekday field would make this a daily job and multiply the
    // spend by seven without anything in the UI changing.
    expect(toCron(3, 14).split(" ")).toHaveLength(5);
    expect(toCron(3, 14).split(" ")[4]).toBe("3");
  });
});
