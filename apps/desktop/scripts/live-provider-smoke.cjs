const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { mkdirSync } = require("node:fs");
const { spawn } = require("node:child_process");
if (process.env.ALTREX_LIVE_SMOKE !== "1")
  throw new Error(
    "Set ALTREX_LIVE_SMOKE=1 only after authorizing controlled live provider requests.",
  );
const viteRequire = createRequire(require.resolve("vite/package.json"));
const esbuild = viteRequire("esbuild");
const output = resolve(__dirname, "../out/qa/live-provider-smoke.mjs");
mkdirSync(resolve(__dirname, "../out/qa"), { recursive: true });
esbuild.buildSync({
  entryPoints: [resolve(__dirname, "live-provider-smoke.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  target: "node22",
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [output], {
  stdio: "inherit",
  windowsHide: true,
  env,
});
child.on("exit", (code) => process.exit(code ?? 1));
