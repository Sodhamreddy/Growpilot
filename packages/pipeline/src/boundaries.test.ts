import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Module boundaries, enforced rather than documented.
 *
 * The three product modules must depend on the shared foundations and never on
 * each other. A comment saying so lasts until the first time someone needs a
 * helper that already exists next door, and by then the coupling is load-bearing
 * and expensive to undo.
 *
 * The rule:
 *
 *     @ob/blog  ─┐
 *     @ob/social ├─→ @ob/pipeline → @ob/ai, @ob/db, @ob/core, …
 *     @ob/gmb   ─┘
 *
 * and nothing horizontal.
 */

const MODULES = ["blog", "social", "gmb"] as const;
const ROOT = join(process.cwd(), "packages");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
}

describe("module boundaries", () => {
  for (const mod of MODULES) {
    const others = MODULES.filter((m) => m !== mod);

    it(`@ob/${mod} does not import from the other product modules`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(join(ROOT, mod, "src"))) {
        for (const spec of importsOf(file)) {
          if (others.some((o) => spec === `@ob/${o}` || spec.startsWith(`@ob/${o}/`))) {
            offenders.push(`${file} imports ${spec}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("the shared package does not import from any product module", () => {
    // If this fails the dependency graph has a cycle: shared code cannot know
    // about the modules that build on it.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, "pipeline", "src"))) {
      for (const spec of importsOf(file)) {
        if (MODULES.some((m) => spec === `@ob/${m}` || spec.startsWith(`@ob/${m}/`))) {
          offenders.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every product module declares the shared package as a dependency", () => {
    for (const mod of MODULES) {
      const pkg = JSON.parse(readFileSync(join(ROOT, mod, "package.json"), "utf8"));
      expect(Object.keys(pkg.dependencies ?? {})).toContain("@ob/pipeline");
    }
  });

  it("no product module declares another as a dependency", () => {
    for (const mod of MODULES) {
      const pkg = JSON.parse(readFileSync(join(ROOT, mod, "package.json"), "utf8"));
      const deps = Object.keys(pkg.dependencies ?? {});
      for (const other of MODULES.filter((m) => m !== mod)) {
        expect(deps).not.toContain(`@ob/${other}`);
      }
    }
  });
});

describe("worker processors stay in their module's folder", () => {
  const PROCESSORS = join(process.cwd(), "apps", "worker", "src", "processors");

  it("a processor never imports from another module's folder", () => {
    const offenders: string[] = [];
    for (const folder of readdirSync(PROCESSORS)) {
      const dir = join(PROCESSORS, folder);
      if (!statSync(dir).isDirectory()) continue;

      for (const file of sourceFiles(dir)) {
        for (const spec of importsOf(file)) {
          // A relative import climbing into a sibling module's directory.
          const reachesAcross = [...MODULES, "shared"]
            .filter((m) => m !== folder)
            .some((m) => spec.includes(`../${m}/`));
          if (reachesAcross) offenders.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
