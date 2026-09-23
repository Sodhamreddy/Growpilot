import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const python = process.platform === "win32"
  ? resolve(root, "services/crawler/.venv/Scripts/python.exe")
  : resolve(root, "services/crawler/.venv/bin/python");
const app = resolve(root, "services/crawler/app.py");

if (!existsSync(python)) {
  console.error("Crawler environment is missing. Follow services/crawler/README.md once, then rerun pnpm dev.");
  process.exit(1);
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
