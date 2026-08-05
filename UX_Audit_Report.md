# Connexa Events — UX Audit Report

Scope: pure user-experience review of all 11 platform modules — terminology consistency, wording clarity, button-label consistency, workflow friction, action feedback, loading indicators, dialog consistency, and accessibility. This is **not** a correctness/security review (see the separate `QA_Audit_Report.md` for that) and it recommends **no new functionality** — every item below is an improvement to something that already exists. No code has been changed; this is the explain-first pass per the project's QA/RC workflow. Findings are read-only observations from `Code.js`, `Portal.html`, `AdminPortal.html`, `AdminFloorPlan.html`, `Dashboard.html`, `AdminResetPassword.html`, `Unsubscribe.html`, and `EmailLayoutDefault.html`/`EmailLayoutPlain.html`.

Severity legend: **Critical** (blocks a core workflow) · **High** (real friction/confusion/inaccessibility a normal user will hit) · **Medium** (real issue, narrower trigger or lower impact) · **Low** (minor/cosmetic/edge-case) · **Enhancement** (pure polish, introduces no new functionality).

---

## Cross-cutting issues (appear independently in nearly every module)

These five patterns were each found repeatedly, in isolation, by separate passes over the attendee portal, the admin portal, and the smaller admin surfaces — meaning they're platform-wide conventions (or gaps), not one-off mistakes. Worth treating as a single fix each rather than module-by-module.

**A. [High] No loading/disabled state on most "save/send/generate" buttons — double-submit risk**
Only a handful of actions (landing OTP send/verify, checkout submit, floor-plan "Save Layout", milestone join/upload) disable their button and show busy text ("Saving…", "Sending…") while a `google.script.run` call is pending. Most do not: `Save Profile` (Portal.html:1114-1163), `Send Reset Link` (Portal.html:849-867), `Save Event` (AdminPortal.html:1405-1412), `Save Budget Line` (AdminPortal.html:1855-1875), `Generate SQL` (AdminPortal.html:2004-2036), and — most consequential — **Send Campaign** (AdminPortal.html:2397-2417), where a double-click could send a live email campaign twice. "Open Floor Plan" (AdminFloorPlan.html:196) and "Refresh" (Dashboard.html:131) have the same gap.

**B. [High] Custom interactive controls aren't keyboard-reachable**
Across all three admin/attendee surfaces, secondary actions are built as `<span>`/`<div>` with only an `onclick` handler — no `tabindex`, `role="button"`, or Enter/Space key handling. Examples: the attendee login screen's "Forgot password?", "Resend code", "Log Out" (Portal.html:533-586); cart "Remove" controls (Portal.html:2729, 2925); the admin sidebar nav, Communications sub-tabs, expandable event-card headers, and filter chips (AdminPortal.html:211-214, 258-261, 878-914, 312-313). A keyboard-only user cannot operate these at all. Related: no modal or drawer anywhere in the app closes on Escape (Portal.html, confirmed no `keydown` handlers exist); AdminFloorPlan's canvas has no keyboard equivalent for drag-placement/resize/select (lines 739-791).

**C. [High] Form labels not programmatically associated with their inputs**
The large majority of `<label>` elements across the app have no `for`/`id` pairing with their input — registration form (Portal.html:2134-2205), My Profile (Portal.html:617-654), the Event/Budget/Template modals (AdminPortal.html:454-474, 745-748), and the Generate Seats modal and password-reset form (AdminFloorPlan.html:240-253, AdminResetPassword.html:41-43). Screen readers can't reliably announce which label goes with which field. The pattern *is* done correctly in a few places (dietary checkboxes, landing email field, Dashboard's event picker), showing it's a known convention that's just inconsistently applied.

**D. [Medium] Two different success/failure feedback idioms coexist on the same screens**
Some actions use the app's own styled inline banner (colored success/error `<div>`, consistent across the Event/Budget Line/Template/Comm Settings modals); others fall back to a bare browser `alert()` with no success state at all (Mark Paid/Unpaid, Archive Template, Pause/Resume/Cancel Campaign, "Leave session", automation-row saves). A user gets a different "did it work?" signal depending on which button they happened to click.

**E. [Medium] Native `confirm()`/`alert()` dialogs break the app's own modal styling**
Everywhere else the app uses a custom `.modal-overlay`/`.modal-box`, but a few of the highest-stakes actions still use the browser's unstyled native dialog: Budget Line delete (AdminPortal.html:1797), and — most notably — **sending a live campaign** (AdminPortal.html:2401, "Send to N recipients?", no template name or audience shown) and "Leave session" (Portal.html:1373). These are visually jarring and, for the campaign send, thinner confirmation than the action's risk warrants.

---

## Module 1: Authentication & Access

1. **[Medium]** Admin password-reset flow is inconsistent about revealing account existence: `requestAdminPasswordReset` (Code.js:726-747) deliberately always returns the same generic "If an admin account exists…" message to avoid email enumeration, but `resetAdminPassword` (Code.js:749-772) throws a specific "No admin account found for that email address." — a different disclosure philosophy one step later in the same flow.
2. **[Medium]** `AdminResetPassword.html`'s "New Password"/"Confirm New Password" placeholder states "At least 8 characters," but nothing client-side enforces it before submitting (lines 42, 54-64) — a too-short password only gets rejected after a round trip to the server.
3. **[Low]** Password-reset success message ("...you can now close this tab and log in.", line 70) gives no actual link back to login, unlike the equivalent "session expired" screens elsewhere in the app which do link onward.
4. **[Medium]** On the attendee login screen, clicking "Resend code" (Portal.html:934-944) is a deliberate no-op with zero confirmation it worked — the attendee can't tell whether to wait or click again.
5. **[High]** "Forgot password?", "Resend code", "Use a different email", "Back to attendee login", and "Log Out" are all unlabeled, non-focusable `<span>` elements (Portal.html:533-586) — unreachable by keyboard (see Cross-cutting B).
6. **[Low]** The verification-code input lacks the `aria-describedby` link to its "expires in 10 minutes" help text that the email-step input has one screen earlier (Portal.html:529-530 vs 538-539) — same flow, inconsistent accessibility treatment between its two steps.

## Module 2: Event Management (Admin)

1. **[High]** Every event card's price badge is hardcoded to append "/registrant" (AdminPortal.html:892), even for Exhibition events, whose price is explicitly "per booth" (line 1106) — an Exhibition card can misleadingly read "USD 50.00/registrant."
2. **[Medium]** Price display is inconsistent between the parent event card (unit suffix shown, line 892) and the sub-event row (bare number, no unit, line 938).
3. **[Medium]** Configuring an Exhibition's Floor Plan requires save → close → reopen → renavigate: the Floor Plan Designer button is disabled pre-save with a hint to "save this event first" (line 524), and clicking it anyway alerts the same instruction (lines 1124-1128).
4. **[Low]** Required-field convention is inconsistent within one modal: most required fields carry a trailing `*` (e.g. "Event Name *"), but the Curated Event/B2B "at least one option required" rule is only stated in hint prose, not the same `*` marker (lines 455, 491, 546-563).
5. **[Low]** The "Details Page URL" field's placeholder references a "tile" (line 597), a term from the attendee-facing portal not otherwise explained in the admin UI.
6. **[Enhancement]** Milestone type dropdown reads "Confirm/update info" (lines 1308-1316) where the rest of the platform calls this milestone "Confirm Info" — a minor wording variant.
7. **[Medium]** "Save Event" has no disabled/loading state while the save call is in flight (lines 1405-1412) — see Cross-cutting A.

## Module 3: Attendee Portal — Registration Flow

1. **[High]** Checkout copy contradicts itself: the pre-submit note says "submitting does not charge you automatically... the organizer will follow up separately" (Portal.html:2937-2940), but the very next screen's success banner says "total billed: X" (line 2974) — "billed" reads as already-charged.
2. **[Medium]** The finalize action is labeled three different ways across three consecutive screens: form button "Complete Registration" → review heading "Confirm Registration" → actual submit "Confirm & Submit" (lines 2103, 2884, 2944). Clicking "Complete Registration" doesn't complete anything — it opens a review screen.
3. **[Medium]** An event tile's action button always reads "Register," even once already registered (badged "✓ Registered," lines 1942/1954/2095) — the attendee only discovers the click now means "register a colleague" after opening the form.
4. **[Medium]** Attendees already added to the registration cart can only be removed, not edited (lines 2719-2746) — fixing a typo means deleting and re-entering the whole entry.
5. **[Medium]** "Business Type" and "Membership Type *" appear together with no help text distinguishing them (lines 2187-2191).
6. **[Medium]** The post-checkout confirmation panel — which can include allocation-error/waitlist details the attendee needs to read — auto-collapses on a fixed 4-second timer with no way to keep it open or dismiss it manually (lines 2981-2997).
7. **[High]** Nearly every registration-form field label lacks `for`/`id` association (lines 2134-2205) — see Cross-cutting C.
8. **[Medium]** Cart "Remove" controls are non-focusable `<span>`s (lines 2729, 2925) — see Cross-cutting B.

## Module 4: Exhibition / Floor Plan Designer

1. **[High]** When a seat/booth grid doesn't fit the canvas, the error only gives raw pixel dimensions ("needs 820×620px but canvas is only 800×600px") and tells the admin to "pick a larger Canvas Size on the event's edit form" (line 493) — it never names which of Small/Medium/Large is currently selected, which one would fit, or links to the edit form. The admin must leave the builder, hunt for the setting, guess, and come back.
2. **[High]** No keyboard-accessible way to place, resize, or select canvas elements (lines 739-791, 661-663) — drag/click only, no `tabindex` or arrow-key nudge once an element exists.
3. **[Medium]** Vocabulary mismatch inside one module: elements are typed `booth` and added from a "+ Assets" menu, but the bulk-placement tool that creates the same elements is called "Generate Seats" with theatre-seating help text ("Orchestra," "Balcony," lines 208-238) — confusing in a *booth*-based Exhibition context.
4. **[Low]** The "⊞ Generate Seats" button opens a modal whose submit button just says "Generate" (line 258) — same action, label drops a word.
5. **[Medium]** The Remove ("×") button relies only on a `title` tooltip for its accessible name (lines 138-142, 652) — likely announced as "×" by screen readers.
6. **[Medium]** Generate Seats modal labels aren't `for`/`id`-paired with their inputs (lines 240-253) — see Cross-cutting C.
7. **[Medium]** "Open Floor Plan" has no loading state, unlike "Save Layout" a few lines away (line 196 vs 801-803) — see Cross-cutting A.
8. **[Low]** Copy/Paste's disabled reasoning is communicated only via hover `title` tooltips (lines 216-217) — invisible to touch/keyboard users.
9. **[Low]** Deleting an element is immediate with no confirmation or undo (lines 657-660), unlike the app's own `confirm()` pattern used for comparable destructive actions elsewhere.
10. **[Medium]** Right after "Save Layout" finishes, the canvas is immediately cleared and repopulated by a second async call with no spinner (lines 814-818) — can read as the save having failed or elements vanishing.

## Module 5: Ranked Allocation Engine

The core allocation logic (`allocateChoice_`, Code.js:1660-1723) is well-structured and returns a clear `Confirmed`/`Waitlisted` status per attendee; no allocation-engine-specific UX defect was found in the server logic itself. The only user-facing consequence worth flagging here is covered under Module 3 (the auto-collapsing confirmation panel, finding #6) and Module 7 (milestone "Due"/"Pending" badges not distinguishing overdue, below) — both are about how the *result* of an allocation/deadline is surfaced, not the engine itself.

## Module 6: B2B Matching

1. **[Medium]** The admin sidebar nav item is labeled "🔗 Matching Engine Export" (AdminPortal.html:214), while the feature is called "B2B Pre-scheduled Meetings"/"B2B" everywhere else (event type name, card tag, dropdown suffix) — nothing in the nav label signals "this is where B2B lives."
2. **[Low]** Generating and downloading the SQL export is two separate clicks ("Generate SQL" then "Download .sql," lines 423-436) for one task.
3. **[Medium]** "Generate SQL" has no loading/disabled state (line 423) — see Cross-cutting A.
4. **[Medium]** The Preferences drawer opens titled with just the entity name (Portal.html:3077-3081), unlike every other drawer in the app ("My Details — X," "My Itinerary — X") which prefixes what the drawer is — a user doesn't know it's the Preferences screen until scrolling to the inner heading.
5. **[Low]** Two separate modals show essentially the same company-profile information with different layouts depending on where they're opened from (Portal.html:713-736).
6. **[Low]** The task is framed as "select the companies you would like to meet with," but the running counter calls the same selections "meetings" ("0 meetings selected," lines 3098/3276-3277/3339) — a mismatch between the action and what's being counted.
7. **[Low]** Three different labels for "save this form" across three related screens: "Save Profile," "Save Preferences," "Save changes" (lines 658, 3099, 3179).
8. **[Medium]** "Export to Excel" (line 3411) actually downloads a `.csv` file, not an `.xlsx` workbook (lines 3503-3517) — attendees expecting Excel format may be confused.
9. **[Low]** Two itinerary actions fall back to a bare `alert()` on failure (lines 3505, 3520, 3498) instead of the drawer's own inline-message pattern used one function later.

## Module 7: Milestones

1. **[Medium]** Milestone setup only lives inside the Event/Sub-Event modal, while completion tracking is surfaced in the Dashboard, and reminders are configured in a third place (Automated Emails) — no cross-links between the three, so an admin has to know to look in three separate places (AdminPortal.html:619-627, 1519-1521, 2178-2186).
2. **[Low]** Removing an in-progress milestone row uses the same unlabeled "×," no-confirmation pattern whether or not attendees have already been tracked against it (lines 1296-1343) — no visual distinction between the two cases.
3. **[Medium]** A milestone badge shows only "Due <date>" or "Pending" (Portal.html:1617/1828) — no distinct treatment for overdue vs. not-yet-due; a past-due milestone looks identical to one due next month.
4. **[Medium]** "Leave session" is the only confirmation in the entire attendee app that uses the native, unstyled `confirm()` (Portal.html:1373) — see Cross-cutting E.
5. **[Medium]** Within the same Sessions panel, "Leave session"'s failure uses `alert()` while "Join Selected Sessions"'s failure uses the app's inline message pattern (lines 1378 vs 1501) — two error styles in one panel.
6. **[Medium]** The file-upload `<input type="file">` has no associated label or `aria-label` (line 1841) — a screen-reader user hears no accessible name for what's being requested.

## Module 8: Budget

1. **[Medium]** "Mark Paid"/"Mark Unpaid" (a financial-status toggle) requires no confirmation and gives no success feedback beyond a silent table re-render, while deleting a $0 placeholder line *does* require a confirm dialog (lines 1789-1802) — the confirmation weighting is inverted relative to actual financial risk.
2. **[Medium]** Neither Mark Paid/Unpaid nor Delete Line shows a success message — only failures trigger an `alert()` — see Cross-cutting D.
3. **[Medium]** Budget Line deletion uses the native `confirm()` (line 1797) instead of the app's own modal styling used for every other dialog — see Cross-cutting E.
4. **[Medium]** "Save Line" has no loading/disabled state (lines 1855-1875) — see Cross-cutting A.
5. **[Low]** Since Budget moved into "My Events," the Dashboard's now-read-only Budget summary tile has no visual cue (label, greyed styling) marking it read-only — an admin could reasonably try to edit it there before discovering otherwise via the "Manage Budget →" link (lines 1637-1720).

## Module 9: Admin Dashboard

1. **[High]** Switching from a B2B event (on the Preferences tab) to a non-B2B event hides the Preferences tab button but never re-runs `switchTab` — the hidden button keeps its `.active` state, no tab looks selected, and the visible panel is stale, unrefreshed Preferences content (lines 152-164) — reads as broken.
2. **[Low]** KPI number tiles show a bare "-" while loading (lines 108-119), unlike the section panels below them which explicitly say "Loading…" — easy to misread as "no data."
3. **[Low]** "Refresh" has no loading/disabled state, and two overlapping `google.script.run` calls can be fired by repeat clicks (line 131).
4. **[Low]** No back/exit link to the Admin Portal or admin identity display, unlike AdminFloorPlan.html and Unsubscribe.html which both provide one.

## Module 10: Communications

1. **[Medium]** The template "Archive" button (line 1973) is worded as a reversible archive ("It will no longer be selectable for new sends"), but its handler is `deleteCommTemplateAction`/`deleteCommTemplate`, and there's no "Archived" filter/view to find it again afterward — unclear to the admin whether this is really reversible.
2. **[Medium]** The "New Campaign" wizard is numbered "1. Pick a template / 2. Audience / 3. Preview & send," but the audience-scoping controls ("Send to," sub-event picker) sit inside the "1." card rather than the "2. Audience" card (lines 274-364) — blurs the step boundaries.
3. **[Medium]** The "Sub-event status" audience filter defaults to Confirmed-only, Waitlisted excluded, with no explanatory text (lines 310-314) — a campaign can silently skip waitlisted attendees unless the admin notices and toggles it.
4. **[High]** The Automated Emails modal auto-saves on every dropdown change with no explicit Save button and no success feedback (only a failure `alert()`, lines 2160-2201) — every other modal in the app requires an explicit Save and shows a success/error banner; this one is silent on success.
5. **[Medium]** "Send a test to" has no placeholder/format hint, and the code treats the whole field as a single recipient — entering comma-separated addresses expecting a broadcast test silently sends to one malformed value instead (lines 345-346, 2385-2395).
6. **[High]** Sending a live campaign — the single most consequential action in the app — is gated only by a native `confirm()` showing just a recipient count, no template name or audience description (lines 2397-2417) — see Cross-cutting E.
7. **[High]** "Send Campaign" has no loading/disabled state (line 359) — combined with #6's thin confirmation, a fast double-click risks a duplicate send — see Cross-cutting A.
8. **[Medium]** Pause/Resume/Cancel campaign actions show no success feedback at all — only the status tag changing after a silent list reload (lines 2456-2458).
9. **[Medium]** Four distinct campaign statuses (Draft, Queued, AwaitingQuota, Paused) all render with identical styling, and Running/Completed also share identical styling (lines 2421-2441) — a Paused campaign is visually indistinguishable from a never-started Draft at a glance.
10. **[Low]** The email preview `<iframe>` has no `title` attribute (line 2362) — accessibility gap for screen readers.
11. **[Low]** Template save offers only "Save as Draft"/"Save & Activate," no plain "Save" that preserves current status — editing an already-Active template risks re-triggering activation semantics unintentionally.
12. **[Low]** The permanently-disabled "Itinerary Ready" automation row sits visually mixed in among live, working trigger rows (lines 2129-2191) with no distinct treatment to signal "this one will never be enabled" versus a bug.
13. **[Low]** Confirm-dialog wording style is inconsistent: some state the consequence ("...will not be sent to"), some don't ("Send to N recipients?") — no consistent template for how much context a destructive-action prompt gives.
14. **[Medium]** `Unsubscribe.html`'s "Invalid Link" state (lines 37-39) is a dead end — the "Return to Event Portal" link only exists on the valid-link branch; the invalid branch says only "contact us directly" with no actual contact link or address.
15. **[Medium]** The unsubscribe `scope` parameter is passed to the backend but never explained to the reader (line 51) — copy says only "stop receiving these emails," so an attendee can't tell if they're opting out of this one event's mail or everything.
16. **[Low]** The Confirm button on Unsubscribe.html disables with no "in progress" text (lines 55-57), unlike the Floor Plan's "Saving…" pattern elsewhere.
17. **[Medium]** Both email layout templates render their footer, including the unsubscribe link, at 11px (EmailLayoutDefault.html:31/35, EmailLayoutPlain.html:18/22) — smaller than typical minimums for legible/tappable mobile email text.
18. **[Low]** The unsubscribe link relies on color alone with no underline to signal it's a link (same lines) — risk of blending into surrounding footer text in clients that override link color.

## Module 11: Profiles

1. **[High]** Every field in My Profile (Name, Job Title, Mobile, LinkedIn, Company fields, etc.) has an unassociated `<label>` (Portal.html:617-654) — see Cross-cutting C.
2. **[High]** "Save Profile" has no disabled/loading state during the save call (lines 1114-1163, button at 658) — a user can click repeatedly and fire duplicate saves — see Cross-cutting A.
3. **[Low]** Locked-field indication is inconsistent: My Details drawer prefixes the label with a 🔒 emoji plus text, while My Profile and the registration form use text only for the identical "locked, ask a colleague" state (lines 3168-3176 vs 645/2182).
4. **[Low]** The disabled "Other" dietary text field uses the same placeholder styling as a genuinely-empty-but-editable field — hard to tell "non-interactive" apart from "empty, please fill in" at a glance (line 634).
5. **[Low]** The only save feedback is a text message written into `#profileMsg` with no auto-scroll to it (lines 612, 1153-1155) — on the mobile layout especially, a user scrolled away from that spot may not notice it appeared.

---

## Summary

| Severity | Count (approx.) |
|---|---|
| High | 15 |
| Medium | 46 |
| Low | 30 |
| Enhancement | 1 |

**Highest-priority items** (High severity, broadest impact):
- Cross-cutting A/B/C — missing loading states, keyboard-inaccessible controls, and unassociated form labels — each recur in nearly every module and would each be a single, contained fix pattern applied broadly.
- Communications: no loading state + thin native-confirm on **Send Campaign** (double-send risk on the highest-stakes action in the app).
- Communications: silent auto-save with no success feedback in Automated Emails.
- Registration flow: "not charged" vs. "total billed" wording contradiction at checkout.
- Admin Dashboard: stale/no-longer-refreshed Preferences tab when switching to a non-B2B event.
- Floor Plan: canvas-size-mismatch error doesn't say which size is selected or would fit.
- Event Management: Exhibition price mislabeled "/registrant" instead of "/booth."

No fixes have been applied. Per the current QA/RC workflow, this report is the explain-first step — let me know which findings (or which whole modules) you'd like addressed, and at what severity threshold, before any changes are made.
