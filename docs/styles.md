# Style organization

Selected and implemented locally on 2026-10-07 for the current React editor. `apps/web/src/styles.css` is an ordered import entry point. `theme.css` owns shared light/dark colors, borders, focus, selection and radius tokens; layout gutters remain in the base/responsive rules.

The focused plain CSS files under `apps/web/src/styles` own existing component classes:

| File | Responsibility |
| --- | --- |
| `base.css` | Global typography, element defaults, focus, shell and skip link |
| `header.css` | Header, note navigation, menu and icon controls |
| `save-status.css` | Device/server save details and recovery controls |
| `editor.css` | Writing area, title/body typography and formatting controls |
| `notices.css` | Offline/failure/loading states and recovery actions |
| `responsive.css` | Shared breakpoints and reduced motion |
| `accounts.css` | Sign-in, note list and guarded departure dialogs |
| `collaboration.css` | Sharing/invitations, members, participants and cursors |
| `tasks.css` | Flat checklists, checkbox focus and narrow formatting controls |
| `recovery.css` | Recovery file controls and filename wrapping |

The original extraction retained every existing selector, declaration and cascade position; subsequent recovery and keyboard-focus changes add focused rules in their owning files. Keep component selectors in their owning file; use the shared theme variables instead of adding an independent palette. Cross-component breakpoint overrides belong in `responsive.css`; the existing local collaboration/task breakpoints remain with their rules. Do not introduce extra wrapper elements solely to style them.

CSS Modules would be useful if component-local name collisions become a concrete problem. SCSS would add a compiler without a current mixin/nesting need. Utility/framework conversion would change leaf markup and introduce another styling system without solving a demonstrated limitation in this app. Focused CSS reuses Vite's existing import pipeline and adds no dependency. Revisit that choice when actual complexity warrants it.

At the `15d4f3a` refactor checkpoint, the extracted source reassembled exactly to the previous stylesheet and production CSS was byte-for-byte identical. Later recovery controls, formatting focus and a measured contrast correction change their specific rules/tokens; the original comparison is historical evidence. The [verification record](verification.md) records fresh responsive/theme/keyboard checks and synthetic visual inspection. This source organization is distinct from the broader native-input and screen-reader release gates.
