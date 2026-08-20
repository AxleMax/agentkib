# Design QA

- References:
  - `/var/folders/sn/js11_0t91mg_bf1m2fr_38780000gn/T/codex-clipboard-efe05524-5964-4f03-a2ce-ba2ecf470bd1.png`
  - `/var/folders/sn/js11_0t91mg_bf1m2fr_38780000gn/T/codex-clipboard-69d7f413-a62a-4409-a94c-9f926f27bb3c.png`
- Browser implementations:
  - `/tmp/agentkib-ui-final-home.png`
  - `/tmp/agentkib-ui-final-assets.png`
- Comparisons:
  - `/tmp/agentkib-ui-comparison-home.png`
  - `/tmp/agentkib-ui-comparison-assets.png`
- Native debug Bundle:
  - `/tmp/agentkib-debug-home.png`
  - `/tmp/agentkib-debug-assets-skills.png`
  - `/tmp/agentkib-debug-assets-dark.png`
- Viewport: 1360 × 860 CSS pixels for browser comparisons
- State: light theme; native Bundle uses the real local workspace and asset data

## Findings

- Home: the three-column summary strip is fully visible and recent workspace rows are content-sized; names, paths, metadata, and the final row are no longer clipped.
- Activity: long audit detail is constrained to the activity column and exposed through the element title instead of expanding the card.
- Assets: table entries are continuous rows without per-row rounded cards. Names, paths, workspace names, and Agent badges remain inside their columns.
- Navigation tabs: exactly one tab owns `data-active`; the selected state is transparent with one 2px underline. Mouse focus no longer adds a second ring or border.
- Segmented controls and provider cards keep their separate filled or bordered selected states.
- Accessibility: current sidebar destinations expose `aria-current="page"`; asset filters and handoff selectors have accessible names.
- Dark theme: the asset table, filters, badges, and single underline keep distinct contrast without reintroducing selected cards.

## Comparison history

1. The first implementation removed the selected tab card but a focused line tab still inherited Base UI's ring, which recreated a second selected layer.
2. The line variant now suppresses that ring and uses its underline as the focus/selection indicator; keyboard selection continues to follow Base UI state.
3. The browser comparison confirmed the structural fix at the reference viewport. The native debug Bundle then confirmed the same layout with real workspace, activity, and asset rows.

## Environment note

The browser-only preview uses AgentKib's Tauri-less empty-data fallback and reports the expected native bridge error. Native-data layout was therefore verified separately in the macOS debug Bundle.

## Result

passed
