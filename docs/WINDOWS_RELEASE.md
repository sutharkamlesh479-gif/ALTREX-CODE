# Windows distribution

Run `pnpm dist:win` from the repository root on Windows to build both x64 executables in `release/`:

- `ALTREX-CODE-Setup-0.1.0-x64.exe`: recommended installer, with an installation folder choice, desktop shortcut, Start menu entry, and uninstaller.
- `ALTREX-CODE-Portable-0.1.0-x64.exe`: runs without installation; settings are still saved in the current user's application data directory.

Only compiled application files and production dependencies are packaged. Developer credentials, conversations, projects, `.local-ai` runtimes, and downloaded models are not included. Builds do not upload or publish anything.

## Subscriber setup

1. Use 64-bit Windows 10 or Windows 11. Install ALTREX or run the portable EXE.
2. Open Settings → Providers and connect your provider account. For local AI, start Ollama and install a model externally, then connect it in ALTREX. The V4 contract does not yet expose runtime installation or an attachment picker.
3. Open a project folder and send a task. Install the development tools required by that project (for example Node.js and a package manager for JavaScript projects, and Git for Git workflows).

The installer includes the desktop application runtime. AI accounts, paid usage, model downloads, and project development tools are separate. The optional Codex integration requires the subscriber's own runtime and sign-in. No subscription billing or subscriber access enforcement is added by this installer.

Installed builds keep their local AI files under the app's user data directory, rather than the installation directory or shortcut working directory. Existing `ALTREX_LOCAL_AI_HOME` and `ALTREX_LOCAL_MODEL_DIR` environment overrides remain supported.

## Release checks

Run `pnpm typecheck`, `pnpm test`, `pnpm dist:win`, and `pnpm --filter @altrex/desktop verify:release`. The release verifier checks the archive contents and writes `release/SHA256SUMS.txt`. Launch the packaged executable with `ALTREX_SMOKE_TEST=1` to validate startup and the secure preload bridge with temporary application data. Set `ALTREX_SMOKE_REPORT` to an absolute output filename to retain a JSON result, including when the portable launcher does not forward console output. Test installation and uninstall on a clean Windows machine before a wider rollout.

V4 smoke also asserts that the React workspace and composer mounted within the viewport. `ALTREX_SMOKE_SCREENSHOT` captures the painted window. `ALTREX_DEVICE_SCALE_FACTOR=1.25` or `1.5` exercises Windows scaling. QA scripts under `out/qa` are excluded from distribution. Live-provider validation is opt-in and separate from mock regression results; see `docs/qa/live-providers.json` and the product QA report.

The initial build is unsigned unless a signing identity is configured in the build environment. Windows may display an unknown-publisher or SmartScreen warning. A trusted Windows code-signing identity must be supplied separately; do not describe an unsigned build as signed or verified by Microsoft.

Packaging reference: [electron-builder NSIS documentation](https://www.electron.build/v26/docs/nsis/).
