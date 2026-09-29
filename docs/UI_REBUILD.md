# Frontend rebuild — September 2026

## Inspection and preservation map

The repository is a pnpm workspace with one React 19/TypeScript desktop application. Electron Vite builds `src/main/index.ts`, `src/preload/index.ts`, and `src/renderer/src/main.tsx`. There is one renderer view, with conditional conversation, provider, command and settings surfaces; no router or external state library.

- Presentation: `App.tsx`, `styles.css`, `AltrexBrand.tsx`, `product.ts`. The existing App also owns request and provider state; extract that into `useAltrex.ts` before replacing presentation.
- Persistence: `local-conversation.ts` validates the current localStorage conversation. Preserve its storage key and migrate without discarding the existing conversation. Electron persists the most recently selected project and encrypted provider connection separately.
- Desktop boundary: `shared/desktop-api.ts` and `preload/index.ts` expose a typed, frozen allowlist. `main/index.ts` validates sender, request and trusted workspace before forwarding actions. Preserve these boundaries.
- Agent and business logic: `provider-service.ts`, providers, model router, Codex agent, coding agent, attachment service, repository context, project tool broker and command runner. Preserve routing, streaming, fallback, cancellation, encrypted credentials, bounded attachments and project access.
- Existing events: started, delta, activity, files-changed, command-result, completed, cancelled and error. The UI must use these actual events; never synthesize successful tool results.
- Files and terminal: agents can inspect/edit files and run commands. There is no renderer API for browsing/editing files or an interactive PTY. Show actual changed paths and expandable command output; omit fabricated explorer/terminal actions.
- Branding: retain both original raster marks and their roles. No new font, icon, animation or backend dependencies are required.

## Replacement structure

`useAltrex` retains desktop orchestration. Components own shell/navigation, home, composer/model selector, messages/activity, contextual results and settings. Shared primitives provide focus-managed dialogs, menus and buttons. Stored local conversations supply real history; navigation cannot silently change the trusted project.

The current request supersedes the old UI_SPEC layout (starters below the composer, placeholder roadmap navigation and profile). The new UI uses a neutral #161616 canvas, 240px/56px navigation, compact four-card home and a bottom composer with 780px maximum width. Unsupported roadmap controls are removed.

## Delivered changes

- Replaced the monolithic presentation and entire old stylesheet with the new shell and component design system. Removed old ComposerSelect, ProductNotice, text-only quick prompts, roadmap navigation, hardcoded profile and the old command/settings layouts.
- Retained all original desktop API methods, channel names, provider adapters, routing and tool permissions. The only agent presentation change suppresses reasoning-summary forwarding; real command/file/status events remain.
- Added project-scoped local conversation history, migration of the existing conversation, recovery of interrupted responses, and persistent sidebar collapse. A new chat keeps previous conversations. Changing project clears the active context while retaining its history.
- Added selectable provider models with search, working attachment and project menus, code fences with copy buttons, expandable real command/file results, elapsed working time, a closeable results panel, and search across commands and current-project conversations.
- Dialogs contain keyboard focus and restore it on close. Menus handle Escape, outside clicks and arrow navigation. Streaming scroll follows only when the reader is near the bottom.

## Verification and boundaries

TypeScript checking, production build and Electron smoke launch pass. The smoke launch verifies the original splash/icon and secure preload bridge. Automated renderer integration uses a test-only DesktopApi fixture to verify sending, continuation, cancellation, events, provider forms, model selection, project switching, attachments and history recovery. Existing backend tests execute real file writes and development commands in isolated fixtures.

Visual review covers 1920×1080 and 1366×768, the collapsed sidebar, model and attachment menus, settings, and multiline input. Additional geometry checks at 1600×900 and 1440×900 confirm the 780px composer and starter cards stay inside the viewport without page overflow. The final preview reports no console errors.

No live external-provider generation was used during QA. Provider availability/authentication still depends on the user's configured account. Interactive file browsing/editing and a PTY terminal were absent from the original application and remain absent; agent filesystem operations and command execution are preserved. Code blocks use the existing monospace font without syntax highlighting, which the original renderer did not support. No Multi-AI UI or engine was added.
