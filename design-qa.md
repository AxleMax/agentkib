# AgentKib UI QA

## Scope

- Release bundle: `target/release/bundle/macos/AgentKib.app`
- Runtime and viewport: macOS desktop, 1215–1216 × 768
- Themes: light and dark
- Locales exercised: Simplified Chinese UI with localized number and date formatting
- Source audit screenshots: `outputs/agentkib-ui-audit-2026-08-14/`
- Final implementation screenshots: `outputs/agentkib-ui-completion-2026-08-14/`

## Comparison history

1. Home: removed the empty Recent Activity card, let the recent-workspace list use the available height, made all summary metrics navigable, and split Token/commit values into a stable two-level layout.
2. Workspaces: changed rows into aligned Project, Source Agent, Assets, Last Active, Status, and overflow-action columns; added the filtered result count and retained the compact Home variant.
3. Assets: added counts to all five tabs, grouped duplicate catalog records, removed the redundant type column in single-type views, and collapsed visible Agents to two labels plus `+N`.
4. Agents: removed the duplicate installation status and fixed empty detail height; added recent workspaces and Home-asset type summaries.
5. Achievements: replaced the broken cascading month labels with a shared month/grid column system; verified Overview and Token render separate, relevant panels.
6. Settings: removed the duplicate section title and verified the light/dark/system selector remains a single horizontal segmented control.
7. Workspace detail: moved path, discovery source, and last scan into Overview; renamed project configuration semantics and collapsed undetected Agents under Other Agents.

## Visual checks

- Compared the original and final Home screenshots together at the same viewport; no empty right-hand activity panel remains and the achievement summary no longer truncates.
- Compared the original and final Achievements screenshots together; each month appears once on a common row and contribution cells align directly below it.
- Compared the original and final Agent screenshots together; the detail panel now grows naturally around real summary content.
- Compared the reported light-mode Agent screenshot with the rebuilt Agent page; Cursor now retains its black brand tile, Hermes retains its dark green tile, and the remaining Agent icons use distinct light-theme brand surfaces instead of one low-contrast gray background.
- Verified Workspaces, Assets, Agent, Achievements Overview, Achievements Token, Settings, Home, and Workspace Overview in the release app.
- Verified light-mode metadata, paths, tabs, separators, and controls remain legible; verified the same hierarchy in dark mode.
- Verified the title area, sidebar, tab roles, visible focus targets, 32px overflow buttons, and theme controls remain operable in the desktop accessibility tree.

## Automated checks

- `pnpm test -- --reporter=dot`: 40 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.
- `pnpm tauri build`: app and DMG bundles produced.

final result: passed
