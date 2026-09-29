# ALTREX CODE V4 UI and Brand Specification

The production entry is `renderer/src/v4/App.tsx`, mounted by `main.tsx`. It uses only the contract-v1 bridge for backend work. The earlier V3 components and their unchanged regression tests are retained as migration reference; they are not in the production import graph. The V4 sections below supersede the older V3 interaction notes further down this document.

## V4 workspace

Simple by default: project/session sidebar, compact project bar, conversation, and a bottom composer. Context tools open in a dismissible lower panel; wide windows use a side panel. The 224px sidebar collapses to a 62px rail. Narrow windows use the rail automatically. Inter and JetBrains Mono are bundled, with neutral charcoal surfaces and subdued green evidence indicators. Existing official logos are unchanged.

The composer offers Build, Ask, Local AI, and Multi-AI. Routing modes are Auto, Fast, Powerful, Free only, Local only, and Custom. Raw models, capabilities, endpoint configuration, and tournament candidate counts are optional advanced controls. Ctrl/Cmd+Enter sends; Enter creates a line break; IME composition does not submit. Ctrl/Cmd+K opens keyboard-navigable commands and Ctrl/Cmd+N starts a new session. Escape closes dialogs.

Project opening uses the native core command. History uses persisted task records, sessions and event replay. Selecting a task restores its conversation. Interrupted tasks explain the closure and never restart commands. Historical project paths must be reopened before executing new work. The renderer does not persist API keys or conversation content. Full original prompts are available during the current renderer session; after restart the v1 persisted task title (up to 200 characters) is the available user-message summary. This contract limitation is recorded in PRODUCT_PHASE.md.

## V4 truth and evidence

Task status, agent runs, streamed responses, fallbacks, changed paths, commands, checks, repair rounds, reviews and tournament ranking all come from contract events or persisted snapshots. A model saying "verified" cannot promote the task. Terminal state-change events alone cannot promote a task either: task.verified or an authoritative persisted VERIFIED snapshot is required. COMPLETED_UNVERIFIED remains visibly distinct with backend reasons.

Verification shows declared checks and unknown/unavailable checks explicitly. Parsed test counts appear only when the backend supplies them. Review independence is shown as provided. The app does not invent acceptance counts or structured plans when the backend does not emit them.

## V4 controls

- Approvals show the exact summary, classifier risk and reason; agent reasoning is explicitly attributed. Once/task/deny use permission.respond. Forbidden requests have no allow action.
- Changes use checkpoint.diff. Added/deleted lines retain line numbers and textual +/- markers. Matching prefix/suffix alignment is linear; changed middle blocks are shown as removed/added rather than claiming a minimal edit sequence. Large diffs page 300 lines at a time; lists initially mount 100 files. Later edits are flagged.
- Restore always loads checkpoint.preview, lists restores/deletions/preserved conflicts, and requires a deliberate Restore action. The safety checkpoint offers previewed undo. Unfinished checkpoints use scope=all with explicit warning.
- Terminal shows stdout, stderr, duration and exit status; commands can be cancelled, with task-owned commands stopping the owning task. Manual commands take an executable and explicit argv, never a shell string. Manual command/check events are app-wide because v1 global events contain no project identifier.
- Tests retain attempts and repair events, with expandable evidence. Problems collect classified failures, denials and review findings. The developer tab shows a bounded event inspector.
- Context provides repository search, proposed context provenance, declared checks, Git working-tree diff, and evidence/user memory. No fabricated full file tree is displayed.
- Settings separates Providers, AI & models, Permissions, and General. Health UNKNOWN is "Not checked", not "Connected". Keys are one-time password input and are cleared before the command resolves. Cloud consent identifies configured endpoints before a task can use them.

## V4 accessibility and performance

All controls have labels, focus indicators and keyboard access. Dialogs trap and restore focus. Panel tabs support arrow navigation. Status uses text/icons in addition to color, and reduced-motion preferences are respected. Long output is bounded, older conversation tasks are progressively mounted, histories load only when selected, and streaming updates are batched. The in-memory event window is capped at 20,000 with a partial-history notice; persisted task snapshots remain authoritative.

Production never installs FakeCore as a fallback. Only an explicit development URL `?demo=1` activates it, with a visible demo label. Production bundle verification checks that fixture markers and legacy bridge calls are absent.

## Historical V3 specification (migration reference)

## Official two-logo system

ALTREX has two supplied official marks. They are never substituted, recolored, redrawn, or assigned each other's roles.

### Logo A — product identity

Logo A is the rounded open frame containing the geometric A and integrated forward arrow. It identifies the ALTREX product and company.

Use it for the Windows executable, taskbar, shortcuts, Start Menu, installer metadata, startup splash, window identity, top-left sidebar brand, collapsed sidebar, About page, and product notifications. Normal navigation pairs the 20–24px mark with the short name `ALTREX`. The full name `ALTREX CODE` is reserved for startup, metadata, settings, installer, About, and marketing.

### Logo B — coding intelligence

Logo B is the supplied `</>` symbol. It identifies ALTREX coding intelligence.

Use it above the empty-home heading, and optionally as a subtle 18–22px assistant or overall working-state identity. It is never the executable or taskbar icon and is not repeated beside every agent operation.

Source and derived assets live only in `apps/desktop/assets/branding/`. The ICO contains 16, 24, 32, 48, 64, 128, and 256px frames. Raster source is retained because no official vector source was supplied; an invented SVG trace is prohibited.

## Visual language

Neutral charcoal, compact typography, restrained borders and the original marks. No decorative gradients, glow, fabricated activity or unsupported navigation.

Tokens live in `apps/desktop/src/renderer/src/styles.css`: app #161616, sidebar #1b1b1b, surface #222222, composer #272727, subtle border #2b2b2b, primary text #eeeeec, secondary text #b0b0ac. Inter is the UI font; JetBrains Mono is the code font. Controls use 6–8px radii; composer and dialogs use 12px. Motion is 150–180ms and respects reduced motion.

## Shell and navigation

A 240px sidebar collapses to a functional 56px icon rail. A 48px workspace bar contains actual project/branch context, conversation title, commands, settings, and task results only when results exist. The native Electron window frame remains intact.

Navigation provides New chat, Search, Open project, current project, stored current-project conversations, and Settings. Sections collapse independently and history scrolls. There is no hardcoded profile, fake project list, or roadmap navigation.

## Home and composer

The home contains Logo B, the heading `What should we build?`, and four compact Explore, Build, Review and Fix cards. Cards populate and focus the real composer.

The composer stays near the bottom, with a maximum width of 780px. Its project indicator opens the native folder picker. Its textarea grows to 200px, supports IME input and multiline text, and keeps controls visible. Add context opens the actual attachment/project menu. Ask and Agent connect to existing execution modes. The model popup searches actual configured/discovered models and exposes provider connection. Send becomes Stop during a running request.

- Enter: send; Shift+Enter: newline.
- Ctrl/Cmd+N: new chat, preserving history.
- Ctrl/Cmd+P or Ctrl/Cmd+Shift+P: search conversations and commands.
- Escape: close a menu or dialog.

## Conversation and results

User prompts use small right-aligned bubbles. Responses use a readable document layout. Working time and operational status accompany real activity events. Commands and changed paths appear as compact expandable rows. Code fences have language labels, copy actions and horizontal scrolling. Raw model HTML is never rendered.

The optional results panel lists only actual changed files and command output. It can be closed. No interactive file explorer or terminal control is shown because the desktop bridge does not expose those capabilities.

History preserves the original local conversation storage while adding project-scoped saved conversations. New chat does not erase prior history. Switching project never continues an unrelated conversation against another folder.

## Settings and accessibility

Settings groups the existing AI/provider, appearance and permissions information. Provider configuration continues to use native encrypted credentials. UI controls have accessible names, visible focus, hover and disabled states. Dialogs trap focus and restore it on close; menus support arrow keys, Escape and outside clicks. Scrollbars are thin and neutral. Streaming never forces a reader away from older messages.

Validate at 1920×1080, 1600×900, 1440×900 and 1366×768, with the sidebar both expanded and collapsed. Secondary results become an overlay on narrower windows. The composer and menus must remain inside the viewport.

See `UI_REBUILD.md` for the preservation map, implementation details and QA boundaries.
