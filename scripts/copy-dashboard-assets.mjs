// Copies the dashboard's static files next to the compiled server (tsc does not copy non-TS files).
import { cpSync, rmSync } from "node:fs";

const from = new URL("../src/dashboard/static/", import.meta.url);
const to = new URL("../dist/dashboard/static/", import.meta.url);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
