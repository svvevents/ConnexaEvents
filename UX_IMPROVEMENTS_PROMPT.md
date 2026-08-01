# Implementation Prompt: Apply Style Direction A + UX Review Recommendations

Paste this whole prompt into a Claude Code (or equivalent coding agent) session opened in this repository (`clasp_codelab_connexaevents`) to execute it.

---

## Context

This is the Connexa Events Apps Script app. Two review documents preceded this prompt:

1. **UX Review** — findings across the full attendee journey (login → checkout).
2. **Improvement Recommendations** — a proposed style direction ("Option A — Confident Navy") plus a specific fix for every finding.

This prompt consolidates both into one implementation brief, grounded in the actual source files:

| File | Role |
|---|---|
| `Code.js` | Server-side logic. Contains the `BRANDING` object (~line 284) — the single source of truth for the app's theme, injected into every HTML file's `:root` CSS block. |
| `Portal.html` | The entire attendee-facing journey: login/landing, My Events dashboard, My Profile, Register for an Event (event discovery), the registration form, the exhibition floor-plan booth picker, B2B pre-scheduled meeting selection, and the confirm/checkout step. All 8 screens from the UX review live here. |
| `AdminPortal.html` | Admin-side portal. Already a separate entry point from the attendee flow. |
| `AdminFloorPlan.html` | Admin tool for laying out exhibition floor plans (booth authoring). |
| `AdminResetPassword.html` | Admin password reset screen. |
| `Dashboard.html` | Additional admin-facing dashboard/reporting view. |

All five HTML files already read theme values from the same `BRANDING` object via CSS custom properties (`--primary-color`, `--navy-color`, `--accent-color`, `--mint-color`, `--bg-color`, `--banner-bg`, `--font-family`) — so re-theming the whole platform from one place is already architecturally supported. Use it; don't hardcode new colors inline.

**Goal:** apply Style Direction A consistently across every one of the files above, and implement every recommendation from the review, without regressing existing functionality (registration, payments summary, admin auth, floor-plan editing, etc.).

---

## Part 1 — Apply the Option A style system

### 1.1 Update the central token source

In `Code.js`, update the `BRANDING` object (currently ~line 284–295):

```js
const BRANDING = {
  logoUrl: 'https://raw.githubusercontent.com/svvevents/b2bMeetingMatching/main/Connexa_Logo.png',
  bannerUrl: 'https://raw.githubusercontent.com/svvevents/b2bMeetingMatching/main/banner-1900x600.jpg',
  primaryColor: '#1C7293',   // teal — buttons, links, active states (was #0E7490)
  navyColor: '#1B2A4A',      // navy — sidebars, dark surfaces, headings (was #0D1B2A)
  accentColor: '#D98E04',    // gold — callouts, highlights, secondary accent (was #6C47FF purple)
  mintColor: '#22D3C5',      // keep — hover/secondary accent, unchanged
  pageBgColor: '#F4F6F8',    // light page background (was #F3F6F9)
  bannerBgColor: '#F4F6F8',
  fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  eventTitle: 'Event Portal',
  // NEW semantic tokens — add these, they don't exist yet:
  successColor: '#2E7D5B',
  warningColor: '#D98E04',
  errorColor: '#C0392B',
  mutedTextColor: '#5B6472'
};
```

Keep `mintColor` and the font family — only the primary/navy/accent hues and the new semantic set are changing. `accentColor` intentionally moves from purple to gold to match Option A; if category tags (e.g. "B2B Matching") should keep a distinct purple instead of reusing accent, add a dedicated `categoryTagColor: '#6C4FA0'` token rather than repurposing `accentColor` for two unrelated meanings — check every current usage of `var(--accent-color)` before renaming and split them if they serve different semantic purposes.

### 1.2 Extend every `:root` block

In **each** of `Portal.html`, `AdminPortal.html`, `AdminFloorPlan.html`, `AdminResetPassword.html`, `Dashboard.html`, find the `:root { ... }` block (each currently reads `branding.primaryColor`, `branding.navyColor`, etc.) and add the new semantic variables:

```css
:root {
  --primary-color: <?!= branding.primaryColor ?>;
  --navy-color: <?!= branding.navyColor ?>;
  --accent-color: <?!= branding.accentColor ?>;
  --mint-color: <?!= branding.mintColor ?>;
  --bg-color: <?!= branding.pageBgColor ?>;
  --banner-bg: <?!= branding.bannerBgColor ?>;
  --font-family: <?!= branding.fontFamily ?>;
  --text-dark: var(--navy-color);
  --text-muted: #5B6472;
  --border-color: #dfe3ea;
  /* NEW */
  --success-color: <?!= branding.successColor ?>;
  --warning-color: <?!= branding.warningColor ?>;
  --error-color: <?!= branding.errorColor ?>;
}
```

### 1.3 Sweep every file for hardcoded colors that should be tokens

Search each HTML file for raw hex/rgba colors that duplicate a semantic meaning already covered by a token, and replace them:

- `#a50e0e`, `#fce8e6` (error red family) → `var(--error-color)` and a tint of it
- `#0b6b5a`, `#e3f7f2`, `rgba(34,211,197,...)` used for success/positive states → `var(--success-color)`
- `rgba(108,71,255, ...)` (old purple accent) → decide per usage: category/type tags keep a dedicated purple token (`--category-tag-color`); anything that was standing in for "accent/callout" moves to `var(--accent-color)` (now gold)
- Any one-off "notice" background (e.g. a lavender/purple confirmation banner in the checkout summary) → `var(--warning-color)` at ~10–15% opacity for the fill, full-strength for the border/text, matching the semantic-notice pattern used elsewhere
- `#f1f3f4`, `#eef1f5` type neutrals are fine to keep as literal grays (they're not brand colors), but consolidate to one or two values instead of several near-duplicates

Do this file-by-file, not just in `Portal.html` — the goal is one consistent semantic-color system across the attendee portal **and** the admin surfaces, since the review's "inconsistent visual system" finding applies platform-wide.

---

## Part 2 — Cross-cutting fixes (apply wherever the pattern occurs)

- **Placeholder vs. real data.** Anywhere a field is pre-filled from saved data (profile fields, registration form pre-fill), the filled state must be visually distinct from an empty field showing example text. Concretely: real values render in solid `var(--text-dark)`, normal (non-italic) weight, with a neutral border; genuinely empty fields show italic, `var(--text-muted)` example text prefixed with "e.g." and a lighter/dashed border. Do not rely on the browser's native `placeholder` attribute alone to convey "empty" — it's visually indistinguishable from populated text in the current styling. Apply this to every field currently using `placeholder="you@company.com"`, `placeholder="e.g. ..."` etc. in `Portal.html` (landing email input, registration email input at ~line 1848, and all profile fields).
- **Helper text, not placeholder-only labels.** Every input that currently relies solely on its `placeholder` attribute for guidance (e.g. `landingEmail` at line 399, `regAttEmail` at line 1848) needs a persistent `<small>`/caption element below it that doesn't disappear on focus/input.

---

## Part 3 — Screen-by-screen fixes (all inside `Portal.html` unless noted)

### Login & Access (landing screen, ~line 390–410)
1. Add persistent helper text under the email field ("Enter the email you registered with"), not placeholder-only.
2. Move the admin sign-in path out of the primary attendee flow: replace the inline "I am an Admin" checkbox (`isAdminCheckbox`, line 403) that reveals a password field on the same screen with a small, de-emphasized link ("Are you an event admin?") that routes to the existing separate `AdminPortal.html` entry point. Confirm `AdminPortal.html` already has its own authenticated login — if so, this is largely a routing/link change, not new auth logic.
3. Increase the visual weight of the Connexa wordmark/logo now that it's carrying more of the trust signal.
4. *(Not a code fix — flag separately, see Part 5.)* The Google Apps Script "created by / Report abuse" banner cannot be removed from HTML/CSS; it's injected by Google around any `script.google.com/macros/.../exec` URL.

### My Events Dashboard (empty state, ~line 908)
5. Replace the plain-text empty state (`You haven't registered for any events yet. Head to "Register for an Event" to get started.`) with a real, styled button that navigates directly to the registration/event-discovery view — don't make users find the nav item themselves.
6. Add a small "Explore events" preview strip (2–3 mini event cards) below the empty state so the page isn't mostly blank space for new users.
7. Reconcile the sidebar's dark navy with the header bar so the shell reads as one system, not two mismatched regions (this should mostly fall out of the Part 1 token work if both currently hardcode slightly different navy values — check for that).

### My Profile
8. Apply the "placeholder vs. real data" fix from Part 2 to every profile field.
9. Apply the same example-text convention to the Company Details section that's used in Personal Details — audit for any field using a different or missing pattern.
10. The "Other" dietary requirements free-text input should be `disabled` (and visually muted) until its checkbox is checked, then enabled on check.
11. Make the Save button a sticky footer bar pinned to the bottom of the profile panel/viewport rather than floating inline after the last field.

### Register for an Event (event discovery grid, ~line 1657)
12. Event titles must truncate with an ellipsis and reserve layout space so they never visually collide with the `reg-status` badge (`Not Registered` / `✓ Registered`, line 1657).
13. Give price its own bold, standalone text style — visually distinct from purely categorical tags (e.g. "B2B Matching"). Don't reuse the same pill/badge component for both.
14. Every event card should show a consistent set of fields; when date or location is missing, render an explicit "Date TBA" / "Location TBA" fallback instead of omitting the row (which currently produces uneven card heights).
15. Resolve the nested-click-target issue: either make the whole card clickable *or* keep a single explicit "Register" button as the sole interactive target — not both firing different actions.
16. Add a search input and/or filter controls above the event grid.

### Registration Form
17. Same placeholder-vs-real-data fix from Part 2 applies here — this is the highest-priority instance of it, since it's where the "reuse your profile" promise is made and currently unverifiable.
18. Add a live, sticky order-summary panel (session/booth line items + running total) that updates as selections are made, rather than only showing a total on the final confirm screen.
19. **Likely functional bug, not just styling:** the sub-option selection (e.g. BuyerB2B / SupplierB2B under "2 options to choose from") has no bound selected-state in the UI. Find the click handler for these option cards and confirm it actually (a) sets a selection variable/DOM state and (b) renders a visible selected style (filled border + checkmark, radio-button semantics since only one should be selectable). Test that submitting actually reflects the chosen option — this may be a state-binding bug beyond CSS.
20. When "Register" is clicked on an event card, scroll the newly expanded registration panel into view (`scrollIntoView({behavior: 'smooth', block: 'start'})` or equivalent) instead of leaving the user to find it below the fold.

### Exhibition Booth Map (`floorplan-*` classes, ~line 255–283)
21. Give every booth a unique label/code (e.g. `A1`, `A2`) in both the data model and the rendered tile — currently tiles appear to render generically. Check `Code.js` for how booth records are structured/fetched and whether a display code already exists but isn't rendered, or needs to be added.
22. When a user selects up to 3 preferred booths, show a numbered rank badge (①②③) on each selected booth reflecting order of preference, and make re-ordering possible (e.g. tap again to cycle rank, or drag).
23. Add spatial context to the floor plan — an entrance marker at minimum, zone labels if the underlying floor-plan data supports it (check `AdminFloorPlan.html` for what layout metadata admins already define, since it may already exist and just isn't surfaced to attendees).
24. Replace the `floorplan-legend` color states (`Available` / `Your pick` / `Booked`) — currently distinguished mostly by shades of blue — with visually distinct colors or patterns (e.g. neutral grey / brand teal / a hatched or red-bordered style for booked) and confirm sufficient contrast for colorblind users.

### B2B Pre-Scheduled Meetings
25. Same fix as item 19 — this is the same underlying sub-option-selection component, so fixing it once (with proper selected/unselected visual state) should resolve both the Registration Form and B2B screens together if they share a component.
26. Add a live "N spots left" badge to each meeting-type option, sourced from actual capacity data, so waitlist risk is visible before selecting rather than discovered after submission.
27. Replace the word "Unlimited" with plain-language capacity copy (e.g. "No cap on meeting requests") — confirm what it's actually describing (meeting slots vs. attendee capacity) before rewriting.

### Confirmation & Checkout
28. Update the confirmation notice banner to use `var(--warning-color)` (amber) instead of any one-off lavender/purple fill, matching the semantic-notice pattern established in Part 1.
29. State the billing mechanism explicitly in the confirmation copy — e.g. "An invoice for {amount} will be emailed to you within 24 hours," or whatever the actual mechanism is. Check `Code.js` for what happens server-side after "Confirm & Submit" to write copy that matches reality rather than inventing a payment flow that doesn't exist.
30. Add an inline remove (×) control next to each line item in the confirmation summary so a single wrong selection doesn't require "Back to Edit" for the whole form.
31. Do not regress the existing correct behavior where the summary only reflects completed selections, not abandoned/in-progress ones.

---

## Part 4 — Sweep the admin surfaces for the same consistency

The review only walked the attendee journey, but the token work in Part 1 touches every file. While in each admin file, also:

- Confirm `AdminPortal.html`, `AdminFloorPlan.html`, `AdminResetPassword.html`, and `Dashboard.html` all pick up the new `BRANDING` values correctly after the Part 1 changes (spot-check each `:root` block).
- Apply the same placeholder-vs-real-data convention (Part 2) to any admin forms that pre-fill saved data (e.g. editing an existing event, editing a company record).
- Apply the same error/success/warning token usage to any hardcoded status colors in these files.

---

## Part 5 — Out of code scope (flag, don't attempt)

- **The Google Apps Script "created by / Report abuse" trust banner.** This is Google's own chrome around any `script.google.com/macros/.../exec` URL and cannot be removed via HTML/CSS/JS changes in this repo. Fixing it requires an infrastructure/deployment change — hosting the app behind a custom domain (e.g. a reverse proxy or an embed via Google Sites) so end users never hit the raw `script.google.com` URL. Call this out explicitly as a follow-up outside this implementation pass rather than attempting a workaround in code.

---

## Verification checklist before calling this done

- [ ] `BRANDING` object updated in `Code.js`; no leftover references to the old purple `#6C47FF` accent unless intentionally kept as a separate category-tag token.
- [ ] All 5 HTML files' `:root` blocks include the new semantic tokens and render correctly (spot check each page).
- [ ] Grep each HTML file for raw hex colors (`#[0-9a-fA-F]{6}`) outside the `:root` block that duplicate a now-tokenized semantic meaning; replace remaining ones or confirm they're intentionally neutral grays.
- [ ] Every placeholder-only input now has persistent helper text.
- [ ] Real vs. placeholder data is visually distinguishable on Profile and Registration Form — verify by loading a profile with saved data and one without.
- [ ] B2B / session sub-option selection visibly shows a selected state and the selection actually persists through submission (test end-to-end, not just visually).
- [ ] Booth tiles show unique labels; selecting 3 booths shows visible rank order.
- [ ] Registration form shows a live total that updates as selections change.
- [ ] Confirmation screen's notice banner uses the warning token; billing copy is accurate to what actually happens server-side.
- [ ] No regressions in existing registration, payment-summary, or admin-auth flows — run through a full attendee registration end to end and a full admin login end to end after the change.
