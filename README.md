# ALTREX CODE V4

ALTREX CODE is a local-first desktop AI coding workspace for Windows (Electron + React + TypeScript). You open a project folder and describe what you want; ALTREX plans, edits files, runs your project's own checks, has the work reviewed, and tells you honestly whether the result was verified.

## Highlights

- **Many AI providers, one workspace**:
  - **crax-gpt** (free gateway, one key, many live models)
  - Google Gemini
  - NVIDIA NIM (hosted or self-hosted)
  - OpenRouter
  - Groq
  - OpenAI
  - Cerebras
  - SambaNova
  - Cloudflare Workers AI
  - **Ollama** (local)
  - any OpenAI-compatible endpoint (including ngrok tunnels)
  - **ChatGPT Codex**: use your ChatGPT subscription through the OpenAI Codex CLI, with no API key.
- **Smart routing**: Auto, Fast, Powerful, Free only, Local only and Custom modes, with automatic fallback when a provider fails. A small badge always shows the provider and model *actually* in use.
- **Evidence-based verification**: ALTREX runs your project's declared test, build, typecheck and lint scripts, then has an independent AI review the change.
  - A result is marked **Verified** only when real checks pass and the review approves.
  - Otherwise it says exactly what was not verified.
- **Safety by default**:
  - A checkpoint before every change, with one-click restore and undo.
  - Approval prompts for risky commands; forbidden commands (`git push`, shells, `rm -rf` style operations) are never run.
  - Read-only, Standard and Autonomous project permission profiles.
  - Cloud-code consent: project code is never sent to a cloud AI provider until you allow it.
- **Secrets stay safe**: API keys are encrypted with the operating system (Electron `safeStorage`). They are never shown again, logged, sent to the UI, or written into your project.

## Quick start (prebuilt Windows app)

1. Run `ALTREX-CODE-Setup-0.1.0-x64.exe` (installer), or `ALTREX-CODE-Portable-0.1.0-x64.exe` (no install).
2. Windows may show a SmartScreen warning because the executables are not code-signed: choose **More info → Run anyway**.
3. On first launch, the **Add a main AI provider** window appears. Pick one:
   - **crax-gpt**:
     1. Click **Open crax-gpt**.
     2. Sign in and create an API key.
     3. Paste it into ALTREX and click **Connect**.
   - **Gemini / NVIDIA / OpenRouter / Groq**: click **Get API key**, create a key on the official site, then **Add key** and paste it.
   - **Ollama (local)**: install Ollama, run `ollama pull qwen2.5-coder:7b-instruct`, then **Connect**.
   - **ChatGPT Codex**: install the OpenAI Codex CLI and sign in once (`codex login`), then choose **ChatGPT Codex** in the AI mode menu (Build tasks).
4. Click **Open project**, choose a folder, type a request and press **Ctrl + Enter**.

## Build from source

Requirements:
- Windows 10 or 11 (x64)
- **Node.js 22 or newer**
- **pnpm 11** (`corepack enable`, or `npm i -g pnpm`)
- Git

```powershell
pnpm install          # installs dependencies and the Electron runtime
pnpm dev              # run the desktop app in development mode
pnpm typecheck        # TypeScript checks for all packages
pnpm test             # full automated test suite (no real API keys needed)
pnpm build            # production bundles
pnpm dist:win         # Windows installer + portable EXE into release/
pnpm --filter @altrex/desktop verify:release   # verify the packaged app
```

For renderer-only UI work in a browser (with a scripted demo core): `pnpm dev:web`, then open the page with `?demo=1`.

## Project structure

```text
apps/desktop/          Electron app: main process (host, providers, IPC), preload bridge, React UI (src/renderer/src/v4)
packages/contracts/    Versioned UI <-> core contract (zod schemas, events, commands, FakeCore for UI development)
packages/core/         Pure Node core: model gateway, router, task engine, verification, tools, security, checkpoints
docs/                  Architecture, security model, provider spec, test strategy, release notes
```

Useful documents:
- `docs/V4_ARCHITECTURE.md`: overall design
- `docs/SECURITY_MODEL.md`: permissions, approvals, secrets, consent
- `docs/PROVIDER_SPEC.md`: providers, health and routing; includes the crax-gpt preset
- `docs/TEST_STRATEGY.md`: test levels and the end-to-end scenario suite
- `docs/WINDOWS_RELEASE.md`: packaging and release checks
- `packages/contracts/README.md`: every command and event available to the UI

## Troubleshooting

| Problem | What to do |
|---|---|
| "ALTREX could not connect to the provider" in **Free only** | Free only may pick local Ollama. Start Ollama, or switch the AI mode to **Auto**. |
| "Allow cloud AI" appears | Expected: ALTREX asks before sending project code to a cloud provider. Allow it, or use **Local only**. |
| A command waits for approval | Risky commands need your answer in the approval dialog (Allow once / Allow for this task / Deny). |
| Task shows "Completed, unverified" | The project has no test script, a check could not run, or no reviewer model was available. The reason is shown in the task. |
| Provider shows "Invalid credentials" | Create a new key on the provider's site and reconnect it in **Settings → Providers**. |

## Notes

- The automated tests use local fake AI servers; they never call real providers or spend API quota.
- Executables built from this source are unsigned unless you add your own code-signing certificate.
