# Browser input and keyboard verification

Updated 2026-10-07. This document describes the browser checks and the manual release work still needed. Recorded pass results belong in [verification](verification.md); test definitions alone are not evidence that a check passed.

## Automated conditions

`tests/e2e/accessibility.spec.ts` uses the production web build, real Better Auth sessions, independent Chromium contexts, and the local PostgreSQL backend. It belongs in the account Playwright configuration as the `accessibility` project. Run it after preparing the test database and building current assets; do not run another account or fixture suite concurrently.

The composition scenario uses Chromium's native `Input.imeSetComposition` and `Input.insertText` paths. It checks trusted composition-start/update and beforeinput events, an observed composition-end event, candidate updates and cancellation, Japanese and Korean conversion, a combining accent and an emoji sequence. Chromium reports the CDP-triggered composition-end event as untrusted; this is not proof of actual operating-system IME behavior. Offline export and reload retain the exact pending batch identities/bytes. Reconnection produces one durable receipt per pending identity, synchronizes with another authenticated collaborator, and retains that collaborator's text during a later local undo.

The keyboard scenarios use 320 × 700 viewports with light and dark system appearance. They check the visible skip link, title-to-body navigation, selection-preserving keyboard formatting, a visible focus outline, native popover navigation/dismissal, modal Tab wrapping and Escape focus restoration. The recovery dialog fits the viewport and editing resumes after dismissal. They use a desktop browser's keyboard; viewport sizing does not establish mobile keyboard behavior.

The contrast scenario reads the rendered foreground and effective background colors of normal, hovered and selected small labels in both themes. It requires at least 4.5:1 for these text labels, including hover states, using [W3C's contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). It also checks the custom focus outline against adjacent colors at 3:1 using [non-text contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Disabled controls and decorative status dots are not treated as ordinary text labels. This focused audit does not cover every rendered state or establish WCAG conformance.

The rendered light save-status hover failed at 4.384403784:1 with muted `#707070` on `#f1f1f1`. Changing the light muted token to `#686868` yields 4.933473593:1 for that pair. Toolbar hover and selected states already use the primary ink color; their theoretical muted-on-active color pair is not a rendered failure. Backgrounds, dimensions and focus colors are unchanged.

Reduced-motion preference is exercised through the browser's media emulation and checked against actual zero transition durations. Reflow is checked at 640 CSS pixels after a 1280-pixel viewport. This changes available layout width; it does not enlarge text or activate native browser zoom. [W3C's resize-text guidance](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) remains the basis for the separate manual 200% browser/text enlargement check.

Existing fixture/account/sharing tests cover clipboard, split/merge, checklist keyboard activation, collaborative undo, labelled controls, and other dialog focus boundaries. Keep those results separate from these additional scenarios.

## Manual release checks still required

Before describing a platform as fully verified, record its browser/version, operating system, input method or assistive technology, exact release build and outcome:

- Use an actual operating-system Japanese or Korean IME to update candidates, convert, cancel, continue typing, select/replace text and edit a heading/checklist. Repeat during peer edits and an offline reconnect. Confirm committed text, caret placement and undo.
- Use an actual supported phone/tablet and its keyboard to edit title/body/checklists, select, paste and compose text. Check the writing surface and dialogs while the keyboard is open, with orientation changes and increased text size.
- Use a screen reader to enter the note list/editor, identify title and multiline body, discover formatting/checklist state, navigate a menu/dialog, hear failure/recovery states, and return to writing without a focus trap.
- Check increased browser zoom and text size, keyboard-only navigation and contrast in both themes. Record any limitations instead of inferring conformance from labels or computed styles.
- Run the chosen browser support matrix on the final build. Chromium checks do not prove Safari, Firefox or WebKit behavior.

The supported-platform declaration and these manual results remain release decisions/evidence to record. These tests do not claim WCAG conformance, a screen-reader audit, operating-system IME coverage, or physical mobile-device support.
