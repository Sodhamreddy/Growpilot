import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const python = process.platform === "win32"
  ? resolve(root, "services/crawler/.venv/Scripts/python.exe")
  : resolve(root, "services/crawler/.venv/bin/python");
const app = resolve(root, "services/crawler/app.py");

/*
 * Not set up: skip, do not fail.
 *
 * The crawler is optional (see its README): without it only JavaScript-heavy
 * sites fail to crawl. `pnpm dev` runs it under --kill-others-on-fail, so a
 * non-zero exit here used to stop the web app and worker as well, for a
 * service nothing else needs to start.
 */
if (!existsSync(python)) {
  console.warn(
    "Browser crawler not set up, so it is skipped. Web app and worker run normally; " +
    "only JavaScript-heavy sites will not crawl. To enable it, follow services/crawler/README.md once.",
  );
  process.exit(0);
}

const child = spawn(python, [app], { cwd: root, stdio: "inherit", env: process.env });
child.on("error", (error) => {
  console.error("Could not start the browser crawler:", error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
