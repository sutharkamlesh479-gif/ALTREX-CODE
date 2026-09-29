# V4 product phase

Baseline: `phase-11-complete`, `52d4337`. Primary authority: CODEX_HANDOFF.md and the actual contract schemas (older design documents contain superseded plans).

## Frontend audit

Keep the supplied two-logo system, bundled Inter/JetBrains fonts, safe React message rendering, accessible dialog primitives, and restrained charcoal palette. The V3 chat hook, local-only conversation model, model picker, provider dialog and results drawer cannot represent V4 persisted tasks or evidence. The production entry point will move to a modular contract-v1 workspace; legacy components remain regression fixtures during migration and are excluded from the production import graph.

Missing flows: measured provider health, routing modes, approvals, persisted tasks/sessions, interrupted recovery, evidence/repair/review, terminal cancellation, checkpoint preview/restore/undo, repository context, tournament ranking and optional diagnostics.

## Milestones

1. Contract workspace, replay/history, conversations and event-based task presentation.
2. Providers, permissions, files/diffs, terminal/checks, checkpoints, advanced context and diagnostics.
3. FakeCore integration coverage, accessibility/responsiveness, complete regression/build/runtime/package QA and release evidence.

No backend or contract rewrite is planned. All operations use `window.altrexCore`; browser demos explicitly opt in during development. Production cannot fall back to simulated data.

### Minimal host QA addition

The baseline Electron smoke checks preload bridges but never checks whether React mounted. Extend only the existing smoke branch in main/index.ts with a V4 shell/composer assertion, viewport bounds and optional screenshot output. This is necessary to validate the packaged frontend and display scaling; normal host behavior and every public contract remain unchanged.

## Contract boundaries

- No standalone checkpoint-create command, attachment picker, local-runtime installer/start command, file-tree/read command, or structured plan/acceptance event exists in v1. Expose available search/context and automatic checkpoints; explain these limits rather than inventing actions.
- Project opening uses the native picker; project.list contains opened/recent projects. Historical project paths must be reopened before execution.
- Provider connection permits one-time key input. Health UNKNOWN is never Connected; null model capabilities are Unknown.
- Tournament has real producers in Phase 9; older README prose saying otherwise is stale. Comparison uses emitted candidate checks/ranking only.
- Read-only, Standard and Autonomous follow implemented policy. Autonomous allows HIGH; FORBIDDEN is always denied.
- Live provider validation requires available credentials, separate evidence and small controlled calls. Mock results do not establish live compatibility.
