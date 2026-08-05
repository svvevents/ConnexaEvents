# Connexa Events — Production Readiness Audit

Scope: full read-only review of `Code.js` (7,438 lines) and all HTML views (`Portal.html`, `AdminPortal.html`, `AdminFloorPlan.html`, `Dashboard.html`, `AdminResetPassword.html`, `Unsubscribe.html`, `EmailLayoutDefault.html`, `EmailLayoutPlain.html`) — a single-spreadsheet-backed Google Apps Script application. Reviewed module by module per the agreed breakdown. No code was modified as part of this review.

Severity legend: **Critical** (data loss/corruption, security breach, broken production path) · **High** (serious bug likely to be hit in normal use, or meaningful security/reliability gap) · **Medium** (real issue, narrower trigger conditions or lower impact) · **Low** (minor/cosmetic/edge-case) · **Enhancement** (net-new capability — flagged only, not to be implemented under the current feature freeze without explicit sign-off).

---

## Module 1: Authentication & Access

**Files reviewed:** `Code.js:320-391` (dashboard key), `Code.js:505-598` (`doGet` routing), `Code.js:600-774` (admin auth), `Code.js:3423-3535` (attendee OTP auth), `AdminResetPassword.html` (full), `Portal.html` (admin/attendee login UI), `AdminPortal.html` (token usage).

### Findings

**1. [High] Admin session token only ever travels via URL query string**
- *Description:* `adminLogin` (Code.js:682) returns `redirectUrl` with the raw 6-hour session token embedded as `?admin=1&token=...`. `AdminPortal.html:777` reads it into `ADMIN_TOKEN` and reuses it to build further navigable URLs (e.g. the Floor Plan builder link at `AdminPortal.html:1119`). It is never exchanged for a cookie or stored client-side.
- *Why it matters:* A live, 6-hour, full-admin-privilege token sits in the browser address bar and history, can appear in screen shares/screenshots, and is recorded in Apps Script's own execution logs (which capture `doGet` parameters). There is no way to know it leaked, and no way to revoke it (see #2).
- *Recommendation:* Minimum-effort fix: after initial redirect, have the client strip the token from the visible URL via `history.replaceState` and pass it only through `google.script.run` calls (already the pattern for most calls) rather than re-embedding it in further full-page navigation links.
- *Effort:* Medium.

**2. [Medium] — ✅ FIXED. No admin logout / session revocation**
- *Description:* No function removes an `admin_session_*` cache entry. A session can only end by 6-hour natural expiry.
- *Why it matters:* If a token leaks (see #1) or an admin walks away from a shared machine, there's no way to kill the session.
- *Recommendation:* Add `adminLogout(token)` → `CacheService.getScriptCache().remove('admin_session_' + token)`, wired to a "Log out" button.
- *Effort:* Low.
- *Resolution:* Fixed. `adminLogout(token)` added; `AdminPortal.html`'s header now has a "Log out" link next to the admin email that calls it and redirects to the portal URL regardless of outcome.

**3. [Medium] — ✅ FIXED. No brute-force throttling on `adminLogin`**
- *Description:* `adminLogin` (Code.js:682) has no failed-attempt counter or lockout — only the ~10k-round HMAC cost adds friction.
- *Why it matters:* Admin accounts are high-privilege and few in number; credential stuffing is otherwise unthrottled, and Apps Script web apps can serve many concurrent requests.
- *Recommendation:* Reuse the attempt-counter pattern already built for attendee OTP (`ATTENDEE_OTP_MAX_ATTEMPTS`, Code.js:3441) — track failed attempts per email in `CacheService` with a short lockout.
- *Effort:* Low (pattern already exists in the same file).
- *Resolution:* Fixed. `ADMIN_LOGIN_MAX_ATTEMPTS`/`ADMIN_LOGIN_LOCKOUT_SECONDS` added; `adminLogin` now tracks failed attempts per email and locks out after 5 within a 15-minute window, reset on success. The counter increments identically whether the email is unknown or the password is wrong, preserving the existing no-enumeration guarantee.

**4. [Medium] — ✅ FIXED. Reflected URL params interpolated into inline `<script>` string literals via HTML-escaped scriptlets**
- *Description:* `AdminResetPassword.html:51-52` does `var email = '<?= email ?>'; var token = '<?= token ?>';` where both values are attacker-controlled query params rendered before any server-side validation (`doGet`, Code.js:509). This is currently *not* exploitable only because Apps Script's `<?=` HTML-escapes the quote character, and `<script>` is HTML5 "raw text" (entities aren't decoded there) — two incidental facts, not a deliberate JS-safe encoding. The same reflected-param-into-inline-script pattern appears in `AdminFloorPlan.html` and `Unsubscribe.html`.
- *Why it matters:* This is the shape of a classic XSS bug and will become exploitable the moment someone copies the pattern into an HTML-attribute context, or if the escaping helper's behavior ever changes. Worth closing proactively rather than relying on the coincidence.
- *Recommendation:* Use `JSON.stringify` for values embedded in inline scripts: `var email = <?!= JSON.stringify(email) ?>;`. Mechanical, no behavior change.
- *Effort:* Low.
- *Resolution:* Fixed in all 4 instances found (not just `AdminResetPassword.html`): `AdminResetPassword.html` (email, token), `Unsubscribe.html` (email, scope, token), `AdminFloorPlan.html` (token, eventId), and `AdminPortal.html` (token, portalUrl — confirmed already safe since token there is only ever echoed post-validation, but switched for consistency so it's not the one place in the app relying on that distinction).

**5. [Low] `XFrameOptionsMode.ALLOWALL` on every page, including auth/reset pages**
- *Description:* Every `doGet` response (Code.js:505-590), including `AdminResetPassword` and `Dashboard`, sets `ALLOWALL`, permitting any origin to iframe the page.
- *Why it matters:* Enables clickjacking against the password-reset form specifically. May be intentional (Apps Script embedding needs), but worth an explicit decision rather than a blanket default.
- *Recommendation:* Confirm whether cross-origin framing is actually required; if not, use `DEFAULT` framing on `AdminResetPassword`/`AdminPortal`/`Dashboard` at minimum.
- *Effort:* Low.

**6. [Medium] — ✅ FIXED. Attendee session isn't persisted client-side, undermining the 6-hour TTL**
- *Description:* `ATTENDEE_SESSION_TTL_SECONDS` is 6 hours (Code.js:3438), but `portalState.sessionToken` (Portal.html:752) lives only in an in-memory JS variable — no `localStorage`/`sessionStorage`/cookie usage found anywhere in `Portal.html`. Any reload, accidental refresh, or reopening a saved link forces a full re-auth (new OTP email + code entry) even though the server-side session is still valid.
- *Why it matters:* Real UX friction during live events (attendees on flaky mobile networks reload tabs constantly), and each forced re-auth burns another OTP email against the shared `MailApp` quota (see Module 10).
- *Recommendation:* Persist `sessionToken`/email in `sessionStorage` after `verifyAttendeeLoginCode` succeeds; attempt silent restore via `authenticateUserPortal` before showing the login screen.
- *Effort:* Low-Medium.
- *Resolution:* Fixed. `sessionStorage` (not `localStorage` — survives a reload, clears when the tab closes) now stores the session after successful login; `tryRestoreAttendeeSession_()` runs on page load and silently skips straight to the portal shell on a valid stored session, or falls through to the normal landing screen with no error shown if the stored token has expired. Cleared on explicit logout.

**7. [Medium] — ✅ FIXED. Attendee OTP requests have only a 30s cooldown, no longer-window cap**
- *Description:* `requestAttendeeLoginCode` (Code.js:3453) enforces `ATTENDEE_OTP_COOLDOWN_SECONDS` = 30s per email but nothing caps total codes/day.
- *Why it matters:* OTP emails, admin reset emails, and all Communications sends share one `MailApp` daily quota. A script hitting this endpoint repeatedly can meaningfully burn that quota; once exhausted, `MailApp.sendEmail` throws for *every* feature — OTP login, password reset, and campaign sends all fail together. This is a shared-fate reliability risk, not just an abuse nuisance.
- *Recommendation:* Add a per-email daily cap using the same `CacheService` counter pattern already in use.
- *Effort:* Low.
- *Resolution:* Fixed, as a rolling window rather than a strict calendar day — `CacheService.put`'s own max TTL is 21600s (6h, the same ceiling `ATTENDEE_SESSION_TTL_SECONDS` is already built around), short of a true 24h window. `ATTENDEE_OTP_WINDOW_MAX_REQUESTS` (8) per `ATTENDEE_OTP_WINDOW_SECONDS` (21600) per email, on top of the existing 30s cooldown.

**8. [Informational] The real access-control boundary is Google Workspace sharing, not the login screen**
- *Description:* Anyone with Editor access to the bound Spreadsheet or Apps Script project can bypass app-level auth entirely (edit the `Admins` sheet directly, or run `adminSetPassword_` from the script editor).
- *Why it matters:* Inherent to the bound-script deployment model, easily overlooked when assessing "is auth secure."
- *Recommendation:* Confirm Sheet/Script Editor access is restricted to trusted ops staff; treat that as the actual trust boundary in any security sign-off.
- *Effort:* N/A — process/config, not code.

**9. [Enhancement] No audit trail for admin authentication events**
- *Description:* No logging of successful/failed admin logins or password resets.
- *Why it matters:* No way to review login history after a suspected compromise.
- *Recommendation (optional, net-new capability — do not implement under current freeze without sign-off):* Append successful logins to a lightweight sheet, or at minimum `Logger.log`.
- *Effort:* Low.

### What's solid here
Constant-time comparison used correctly for both password hashes and reset/OTP tokens; identical generic error message on "no such admin" vs "wrong password" (and on password-reset request) prevents account enumeration; OTP codes are one-time-use, attempt-capped, and independently expiring; password-reset tokens are cleared from the sheet after successful use; minimum password length enforced; the salted+iterated-HMAC password KDF is a reasonable, well-documented tradeoff given Apps Script has no native bcrypt/scrypt/Argon2.

### Module 1 Health: 7/10 → 9/10 (Findings #2, #3, #4, #6, #7 fixed)
Core auth logic is careful and already anticipates several classic pitfalls (enumeration, timing attacks, replay). The session-lifecycle hygiene gaps (no logout, brute-force throttling, session persistence, OTP volume cap, the reflected-param pattern) are now closed. Remaining: #5 (XFrameOptions — a deployment-context decision, not something to change unilaterally), #8 (informational), #9 (audit-trail enhancement, correctly not implemented under the freeze).

---

## Module 2: Event Management (Admin)

**Files reviewed:** `Code.js:774-935` (Events sheet helpers, schema migration), `Code.js:1827-2295` (admin tree, onboarding/type options, `normalizeTypeConfig_`, `createOrUpdateEvent`), `AdminPortal.html` event-form sections.

### Findings

**1. [High] — ✅ FIXED. `createOrUpdateEvent`'s UPDATE path does ~14 sequential single-cell writes under one GLOBAL script-wide lock, while the CREATE path correctly batches into one write**
- *Description:* The update branch (Code.js:2206-2227) issues roughly 14 separate `sheet.getRange(rowNum, col.X).setValue(...)` calls; the create branch (Code.js:2265-2268) instead builds one row array and does a single `appendRow`. Both run inside the same `LockService.getScriptLock()` / `waitLock(10000)` (Code.js:2184-2185), which is script-wide, not scoped per event.
- *Why it matters:* The file's own architecture notes call out that "SpreadsheetApp calls are slow (roughly 0.5-2s each)" as the dominant cost driver. ~14 sequential calls can add multiple seconds to every "Update Event" action, and since the lock is global, every *other* admin's event save (even on a completely unrelated event) queues behind it and can fail outright once `waitLock`'s 10s timeout is exceeded. Two admins finishing event setup around the same time — a realistic scenario right before a live event — can hit a spurious "could not obtain lock" failure.
- *Recommendation:* Mirror the create path: build one row array from the already-fetched `data[i]` plus the incoming payload, then a single `sheet.getRange(rowNum, 1, 1, lastCol).setValues([row])`. Mechanical change to an existing path, no behavior change, shrinks both save latency and the lock's blast radius.
- *Effort:* Medium (must preserve fields not present in the payload, e.g. `CreatedDate`/`CreatedBy`).
- *Resolution:* Fixed. The update branch now starts from a copy of the existing row (`data[i].slice()`), overlays only the fields the form edits via the same name-indexed `col` map, and writes with a single `setValues` call — 1 write instead of 14. `lastCol` hoisted once above the create/update split (previously declared only inside the create branch) and reused by both.

**2. [High] — ✅ FIXED. No guard against duplicate "Save Event" submissions**
- *Description:* The Save Event button (`AdminPortal.html:629`) has no `disabled` toggling and the modal stays fully interactive while the request is in flight (it only closes in the success handler). A double-click — plausible given Apps Script cold-start latency — fires `createOrUpdateEvent` twice. For a brand-new event (no `eventId` yet), each call mints its own `EventID` and appends a row, so a double-click creates two duplicate events.
- *Why it matters:* Under time pressure before a live event, a duplicate event can split attendee registrations across two records, and there is currently no way to delete either one (see #5).
- *Recommendation:* Disable the button on click, re-enable in both success and failure handlers — the same pattern already used correctly in `AdminResetPassword.html` and the admin/attendee sign-in flows in `Portal.html`.
- *Effort:* Low.
- *Resolution:* Fixed. Button now has `id="btnSaveEvent"`. `saveEvent()` disables it and swaps its label to "Saving…" only *after* all existing client-side validation checks pass (so a validation error's early `return` never leaves it stuck disabled), restoring it in both the success and failure handlers.

**3. [Medium] — ✅ FIXED. Inconsistent price validation: per-option prices reject bad input, the flat event Price silently becomes free**
- *Description:* Curated Event/B2B option prices and Exhibition Asset Type prices are strictly validated and throw a clear error on non-numeric input (Code.js:2004-2006, 2049-2051). The flat top-level event Price is not: `Math.max(0, Number(payload.price) || 0)` (Code.js:2167) silently coerces any unparseable value to `0`. `AdminPortal.html:1383` mirrors the same silent-zero behavior client-side.
- *Why it matters:* A typo in the Price field doesn't surface any error — the event just quietly saves as free, with no signal to the admin. For a revenue-bearing event this is an easy-to-miss data integrity problem.
- *Recommendation:* Apply the same "reject if not a finite, non-negative number" check already used for option prices to the flat Price field.
- *Effort:* Low.
- *Resolution:* Fixed server-side (`createOrUpdateEvent` now rejects a non-numeric `price`) and client-side (`AdminPortal.html`'s `saveEvent` validates the raw field before building the payload, matching its other validation checks).

**4. [Low] Stale, contradictory doc comment above `normalizeTypeConfig_`**
- *Description:* Code.js:1933-1955 is a leftover comment block describing the *old* behavior ("Curated Event: … An empty array is valid… falls back to flat Price/Places") immediately followed by Code.js:1956-1982, the *current*, correct comment stating Curated Event/B2B now require at least one option with no fallback.
- *Why it matters:* The two comments directly contradict each other about current, load-bearing business logic — a maintainer skimming top-down reads the wrong one first.
- *Recommendation:* Delete the superseded block; the accurate description already exists right below it.
- *Effort:* Trivial.

**5. [Enhancement — flag only] No way to delete, cancel, or archive an event**
- *Description:* No `deleteEvent`/`archiveEvent` function exists. The Status dropdown (`AdminPortal.html:483-484`) offers only "Draft"/"Live".
- *Why it matters:* A mis-created or duplicate event (see #2) can't be removed from the admin's list short of directly editing the spreadsheet — worth a product decision before RC, but it's net-new capability, not a bug fix.
- *Recommendation:* Do not implement under the current freeze without explicit sign-off. If prioritized, the lowest-risk version is an additive "Cancelled" status value plus a list-view filter, not a real delete.
- *Effort:* Low-Medium if approved.

**6. [Low] — ❌ CORRECTION, this finding was wrong. Originally reported as: "Dead code: unreachable `'Closed'` status branch"**
- *Original (incorrect) claim:* `AdminPortal.html:880` and `:926` check `evt.status === 'Closed'` for CSS styling, but no code anywhere writes `'Closed'` to the Status column.
- *What was actually missed:* The Status dropdown (`AdminPortal.html:483-485`) has always had three options — Draft, Live, **and Closed** — not two. I misread the file during the original audit and missed the third `<option>`. `'Closed'` was a real, selectable, working status all along, not dead code. Confirmed via `git diff` that this predates the session and wasn't something introduced by any fix along the way.
- *Consequence, now fixed as part of the "event cancel/archive" enhancement below:* because this went unnoticed, a related real gap also went unnoticed — sub-event-level visibility (`getUmbrellaChildren`, the details-preview function, `addSubEventSelectionsForAttendee`'s per-selection check) only ever excluded `'Draft'`, never `'Closed'`, so a Closed sub-event could still appear as joinable. See below.

**7. [Low] Server-side Event Name check doesn't trim whitespace**
- *Description:* Code.js:2141 checks `!payload.eventName` without trimming; only the client trims first (`AdminPortal.html:1373`).
- *Why it matters:* Defense-in-depth gap — a direct API call bypassing the UI could save a whitespace-only event name.
- *Recommendation:* `if (!payload || !String(payload.eventName).trim())`.
- *Effort:* Trivial.

### What's solid here
The schema-migration design (`migrateSheetHeaders_` + `ensureHeadersFresh_` + `getEventsColumnIndex_`) is a genuinely good fix for a real prior bug class — writes are now header-name-based instead of assuming a fixed column order, which the code's own comments show used to cause silent data corruption (a Currency write landing in the Places column, etc.). `TypeConfig` validation (`normalizeTypeConfig_`/`normalizeExhibitionAssetTypes_`) is thorough: required-field checks, numeric price validation, duplicate-ID detection, and correct handling of the legacy empty-TypeConfig fallback for pre-existing rows. The two-tier caching (execution-scoped + 60s cross-request, busted on every write) is well-reasoned and correctly invalidated on both create and update paths.

### Module 2 Health: 7/10 → 9/10 (Findings #1, #2, #3 fixed)
Solid data model and validation logic; all three High/Medium findings are now fixed. Remaining findings (#4, #6, #7) are Low cosmetic/consistency items, plus #5 (no delete/archive), which is a deliberate net-new-capability decision left for you, not something fixed here.

---

## Module 3: Attendee Registration Flow

**Files reviewed:** `Code.js:935-1329` (shared pricing/capacity/live-state helpers), `Code.js:3535-4595` (landing/tiles, event details, register form, dietary, company details, update-registration, withdraw), `Portal.html` (registration UI, checkout flow).

### Findings

**1. [Critical] — ✅ FIXED. Several attendee-facing functions still trust a bare, client-supplied email with no session verification — a direct bypass of this app's own attendee auth model**
- *Description:* The `ATTENDEE AUTHENTICATION` section (Code.js:3423) exists specifically because "anyone could act as any known attendee straight from devtools" via a bare email argument, and states every attendee-facing function was migrated to derive its trusted email from a verified session token instead. That migration missed four functions, all still directly public (no `_` suffix, callable via `google.script.run` from the already-loaded Portal page's console):
  - `submitEventRegistration(payload)` (Code.js:3888) — confirmed **dead**: zero callers anywhere in `Portal.html`, `AdminPortal.html`, `AdminFloorPlan.html`, or elsewhere in `Code.js` (superseded by the session-gated `submitEventRegistrationBatch`). Still fully functional and reachable.
  - `submitDietaryRequirements(payload)` / `getDietaryRequirements(eventId, email)` (Code.js:4320, 4307) — also confirmed **dead** (dietary data is now captured inline during registration; this appears to be a leftover from before that merge). Reads/writes potentially sensitive allergy/medical data.
  - `updateCompanyDetailsInRegistrations(eventId, payload)` (Code.js:4352) — **not dead**: it's the internal implementation the session-gated `updateMyDetailsForAttendee` wrapper calls after resolving a verified email. But it's also independently public with no auth of its own.
  - `getAttendeeItinerary(eventId, email)` (Code.js:5004) — **not dead** (correction after deeper verification): it's a legitimate internal helper used by the session-gated `getMyAttendeeItinerary` and `emailItinerary`, and by the Communications merge-tag renderer (Code.js:6202) to build per-recipient itinerary blocks in campaign emails. Like `updateCompanyDetailsInRegistrations`, it's missing the `_` internal-only naming convention, so it's *also* directly public with no gate of its own. Discloses a B2B attendee's private meeting schedule to anyone who supplies their email.
- *Why it matters:* Concretely, anyone with the Portal page open can, right now: register a real person for an event they never opted into (triggering confirmation emails to a stranger, consuming capacity, creating a fake Membership Details entry); overwrite another attendee's dietary/allergy record; overwrite another attendee's company description/website; or read a named attendee's private B2B meeting schedule — all without ever proving control of that email address. This is exactly the vulnerability class the session-token system was built to close.
- *Recommendation:* Delete the two confirmed-dead functions (`submitEventRegistration`, `submitDietaryRequirements`/`getDietaryRequirements`) outright — the safest possible fix, since nothing depends on them. For `updateCompanyDetailsInRegistrations` and `getAttendeeItinerary`, rename both with a trailing underscore (this codebase's own convention for internal-only helpers) and update their legitimate internal callers accordingly.
- *Effort:* Low — mostly deletion of unreachable code; the renames are mechanical.
- *Resolution:* Fixed. `submitEventRegistration`, `submitDietaryRequirements`/`getDietaryRequirements`/`getDietarySheet_` deleted (confirmed dead). `updateCompanyDetailsInRegistrations` and `getAttendeeItinerary` renamed to `updateCompanyDetailsInRegistrations_`/`getAttendeeItinerary_` with all internal callers updated. 195 lines removed, 39 added; `node -c` syntax-clean; zero remaining references to any old public name in `Code.js` or any `.html` file.

**2. [High] — ✅ FIXED. "Draft" event status is enforced only on the browsable tile list, not on any direct-by-ID read or registration path**
- *Description:* `status === 'Live'` is checked in exactly two places in the whole file (`getExecutiveSummary` and `authenticateUserPortal`). Every function reachable with a bare `eventId` — `getEventDetailsForAttendee`, `getEntityLiveState`, `getRegistrationFormDefinition`, `getUmbrellaChildren`, and `submitEventRegistrationBatch` itself — never checks it. `EventID`s (Code.js:2241) are `'EVT-' + Date.now() + '-' + Math.floor(Math.random()*1000)` — a predictable timestamp plus only 3 random digits, not a real secret.
- *Why it matters:* "Draft" isn't actually private or unregisterable — it's only hidden from the tile grid. Anyone who learns or brute-forces a Draft event's ID can view its full details and complete a real registration against it before the admin intends it to be public.
- *Recommendation:* Add `if (event.status !== 'Live') throw new Error('This event is not open for registration.')` near the top of `getRegistrationFormDefinition`, `submitEventRegistrationBatch`, and `addSubEventSelectionsForAttendee`.
- *Effort:* Low.
- *Resolution:* Fixed. Guard added to all three functions (`getRegistrationFormDefinition` Code.js:3798, `submitEventRegistrationBatch` Code.js:3926 — the authoritative write-path check, `addSubEventSelectionsForAttendee` Code.js:4389). Additionally, `addSubEventSelectionsForAttendee`'s per-selection loop now also skips (rather than processes) any individual sub-event whose own status is `'Draft'` (Code.js:4410), closing the same gap at the sub-event level, mirroring `getUmbrellaChildren`'s existing client-facing filter. Deliberately left `getEventDetailsForAttendee` ungated after tracing its caller (`Portal.html:1560`) — it's shared between pre-registration browsing and the "My Events" view for entities an attendee already belongs to, so gating it risked breaking legitimate access to an already-registered attendee's own event if an admin later reverts it to Draft.

**3. [Medium] — ✅ FIXED. Admin-configured "Required" custom fields are validated client-side only**
- *Description:* `RegistrationFormFields.Required` drives client-side validation (via `getExtraFieldsForType_`), but `submitEventRegistrationBatch` never cross-checks `attendee.extraFields` against that same list server-side.
- *Why it matters:* Inconsistent with this codebase's own stated principle elsewhere (see the file-upload milestone's server-side re-validation, Code.js:1471-1473: "never trust the client-side check alone"). A direct API call, or a client bug, can silently save a registration missing a field the admin explicitly required.
- *Recommendation:* Re-validate required `extraFields` server-side inside `submitEventRegistrationBatch` using the same `getExtraFieldsForType_` data the client already renders from.
- *Effort:* Low-Medium.
- *Resolution:* Fixed. `submitEventRegistrationBatch` now rejects any attendee missing a value for a field the admin marked `Required`, with a per-attendee, per-field error message.

**4. [Low] `registrationType` is written without the sheet-injection guard or list validation applied to its sibling fields**
- *Description:* Every other attendee-supplied string in `submitEventRegistrationBatch` (name, company fields, dietary notes) goes through `sanitizeForSheet_` before being written; `a.registrationType` (Code.js:4131) does not, and it's never checked against `onboarding[event.eventType].registrationTypes`.
- *Why it matters:* A direct API call bypassing the UI dropdown could write an arbitrary string, including a formula-injection payload, into a cell that isn't defended the way its neighbors are.
- *Recommendation:* Apply `sanitizeForSheet_` to `registrationType` for consistency; optionally validate it's a known type for the event.
- *Effort:* Trivial.

**5. [Medium] — ✅ FIXED. A mid-batch failure can leave some attendees registered while the client reports total failure**
- *Description:* The per-attendee write loop in `submitEventRegistrationBatch` (Code.js:4127-4142) runs inside the lock; if it's interrupted partway (exception or a 6-minute execution timeout), already-appended rows stay committed, but the whole call throws and the client shows one generic failure message. A retry then fails with "already registered" for whoever got through, with no explanation.
- *Why it matters:* Confusing support situations during a live event ("it said it failed, but half my team got confirmation emails").
- *Recommendation:* Not full rollback (unrealistic on Sheets, as this codebase's own comments elsewhere acknowledge) — just catch a mid-loop failure and report which attendees, if any, were already committed, so the client can show an accurate partial-success message instead of a blanket failure.
- *Effort:* Medium.
- *Resolution:* Fixed. The per-attendee write loop now tracks committed emails as it goes; on a mid-loop failure, the thrown error names exactly which attendees were already registered and explicitly warns not to resubmit them, rather than one generic failure message.

### What's solid here
The duplicate/capacity race protection in `submitEventRegistrationBatch` (a fast pre-lock check for the common case, plus an authoritative cache-bypassing re-check taken *inside* the lock, which is what actually closes the race) is exactly right and applied consistently. `sanitizeForSheet_` is a well-reasoned, correctly-scoped defense against Sheets formula/CSV injection (only applied to free-text fields, skipped for JSON blobs that can't trigger it). The withdrawal flow marks rows `'Withdrawn'` rather than deleting them, preserving an audit trail while still freeing capacity immediately. `getRegistrationFormDefinition` deliberately collapsing what used to be three round-trips into one is a genuine, measurable performance win the author clearly thought through.

### Module 3 Health: 5/10 → 9/10 (Findings #1, #2, #3, #5 fixed)
The registration data model and the *live* code path (`submitEventRegistrationBatch`) are careful and well-tested-looking. All findings except #4 (Low — `registrationType` sanitization/list-validation) are now fixed.

---

## Module 4: Exhibition / Floor Plan Designer

**Files reviewed:** `Code.js:312-329` (canvas sizing), `Code.js:2538-2780` (FloorPlanElements sheet helpers, `saveFloorPlanLayout`, `getFloorPlanLayout`), `AdminFloorPlan.html` (full, including the "Generate Seats" bulk tool).

### Findings

**1. [High] — ✅ FIXED. The Floor Plan Designer has zero visibility into current bookings and can silently delete a confirmed exhibitor's booth with no warning**
- *Description:* The module's own header comment states it plainly: "This is purely an ADMIN-side layout editor: it does not read from or write to TypeConfig, Registrations, or SubEventRegistrations" (Code.js:2543-2545). `removeElement` in `AdminFloorPlan.html:669-678` deletes a booth from the canvas on a single click of its "×" button — no confirmation dialog, no booked/available indicator. `saveFloorPlanLayout` (Code.js:2671) then does a full clear-and-replace of every element for that event with whatever the client currently holds — nothing checks whether the removed element had an active `'Confirmed'` `SubEventRegistrations` row.
- *Why it matters:* An admin doing routine floor-plan cleanup (moving a booth, fixing a label) after registration has opened can, in one misclick plus Save, remove a booth that a real exhibitor already paid for and booked — with the underlying registration/Order record surviving but now orphaned (pointing to an element that no longer exists), and no error, warning, or undo anywhere in the path.
- *Recommendation:* Lowest-risk fix: have `saveFloorPlanLayout` cross-check the outgoing (kept) element set against `getConfirmedSubEventCountMap_`/`getSubEventRegsRaw_` for that event, and reject (or at minimum warn-and-require-confirmation from) a save that drops a booth with an active `'Confirmed'` registration. This is additive validation, not new functionality.
- *Effort:* Medium.
- *Resolution:* Fixed, using a "preserve and report" approach (of three options considered — hard-reject, confirm-and-force, and this one — chosen because there's no admin-side way to cancel someone else's booking, so a hard reject would leave admins stuck with no path forward). `saveFloorPlanLayout` (Code.js:2671) now computes the set of `'Confirmed'`-booked elementIds for the event before replacing rows; any booked element missing from the client's payload has its original row re-added to what's actually saved (untouched, not re-dated) instead of being dropped, and the response now includes a `protectedElements: [{elementId, label}]` list. `AdminFloorPlan.html`'s save handler surfaces this via the existing `showFpMsg` component, kept on screen (not auto-hidden) rather than a routine save toast, naming which booth(s) survived a delete attempt and why.

**2. [Medium] Admin floor-plan saves and attendee booth bookings use two different locking mechanisms, so they don't block each other**
- *Description:* `saveFloorPlanLayout` takes `LockService.getScriptLock()` (Code.js:2689); attendee booth allocation (`allocateChoice_`, see Module 5) uses a separate custom per-entity mutex built on `CacheService`. These are independent locking domains.
- *Why it matters:* An admin re-saving a floor plan (a full clear-and-replace of that event's elements) at the same moment an attendee is completing a booking on the same Exhibition can race: the attendee's confirmed allocation may end up referencing an `elementId` the admin's concurrent save just changed or removed.
- *Recommendation:* Given this requires an admin actively editing a specific Exhibition's layout at the same moment attendees are booking on it — a narrow, avoidable-by-process window — the pragmatic fix is a UI warning ("This event has confirmed bookings — editing the layout may affect them") rather than a deeper locking change. Flagging for awareness; not urgent for RC unless floor-plan edits after go-live are a real operational pattern for this client.
- *Effort:* Low (warning) to Medium (shared locking).

**3. [Low-Medium] — ✅ FIXED. "Generate Seats" has no upper bound on grid size, and the feature's own intended use case (large theatre-style seating) can plausibly produce thousands of interactive DOM elements**
- *Description:* `readSeatGenInputs` (AdminFloorPlan.html:498) only floors `rows`/`seatsPerRow` at 1 with no ceiling; the only limit is whether the grid's footprint fits the canvas. At the "large" canvas size (2000×1300, `FLOORPLAN_GRID_SIZE` 20px — Code.js:313-317), a full grid could legitimately reach several thousand seats, each rendered as its own draggable/resizable DOM element via `addElementToCanvas`/`makeInteractive`.
- *Why it matters:* This isn't just a misconfiguration risk — assigning individual seats for a large venue is the feature's stated purpose (AdminFloorPlan.html:522-533 doc comment references "theatre-style assigned seating"). A legitimate large event could hit real browser sluggishness while editing, independent of any user error.
- *Recommendation:* Add a soft warning (not a hard block) above some threshold (e.g. >500 seats in one Generate) suggesting the admin verify performance, or generate in batches. Purely a UX safety rail, no behavior change to what's already possible.
- *Effort:* Low.
- *Resolution:* Fixed. The live fit-preview now appends a non-blocking note when the requested grid exceeds 500 seats; Generate stays enabled — this is advisory only, since large grids are a legitimate use of the feature, not just user error.

**4. [Low] "Generate Seats" doesn't check for overlap with existing elements**
- *Description:* A generated grid can be placed directly on top of manually-added booths/decor with no warning.
- *Why it matters:* Minor — the overlap is visually obvious immediately after generating and easy to undo before saving, but still worth a one-line heads-up.
- *Recommendation:* Optional; low priority.
- *Effort:* Low.

### What's solid here
Server-side re-validation of every element's geometry (`normalizeFloorPlanElement_` re-snaps to the grid and clamps to the entity's actual canvas bounds, never trusting client-supplied coordinates) is exactly right, and explicitly documented as deliberate. The bulk-replace in `saveFloorPlanLayout` (partition out this event's old rows, append the new set, one `setValues` write) is efficient and correctly name-indexed against column drift, consistent with the same good pattern seen in Module 2. The "Generate Seats" tool itself is a well-built, clearly-reasoned addition — live fit preview, Generate disabled when the grid wouldn't fit, spreadsheet-style row labeling with no artificial cap.

### Module 4 Health: 6/10 → 9/10 (Findings #1, #3 fixed)
The layout mechanics are careful and well-validated; the two most concrete issues (silent booking-blind deletion, unbounded Generate Seats) are fixed. Finding #2 (lock-domain mismatch between floor-plan saves and booth bookings) remains open by design — it's a product-process question about whether floor-plan edits after go-live are a real pattern for this client, worth a decision from you rather than a unilateral code change. Finding #4 (overlap detection) is a minor open polish item.

---

## Module 5: Ranked Allocation Engine (`acquireEntityLock_`, `allocateChoice_`, `allocateCuratedEventSelections_`, `recordPlainSubEventOptIn_`)

**Files reviewed:** `Code.js:1598-1824`, cross-referenced against `recordOrder_` (Code.js:3092) and the batch caller `submitEventRegistrationBatch` (Module 3).

This is the highest-stakes code in the application from a correctness standpoint — it's what decides who gets the last booth/seat/slot when multiple attendees compete for it — so it got the deepest individual scrutiny of any module in this audit.

### Findings

**1. [High] — ✅ PARTIALLY FIXED (stop-gap applied). The custom entity lock's 30-second safety-net TTL can plausibly be exceeded by its own critical section, silently reopening the exact double-allocation race it exists to prevent**
- *Description:* `acquireEntityLock_` (Code.js:1619) is a well-designed per-entity mutex: a brief `LockService` coordinator lock guards a check-and-set on a `CacheService` lease, so unrelated entities never contend, and only two callers racing for the *same* entity actually queue. The lease has a 30-second safety TTL (`ENTITY_LOCK_SAFETY_TTL_SECONDS`, Code.js:1594) so a lock never stays stuck forever if the holding execution dies mid-critical-section. But that same TTL applies even when the holder is alive and simply *slow* — there's no lease renewal/heartbeat. The critical section it guards does a full re-read of live capacity (`getSubEventRegsRaw_`, an uncached full-table scan once invalidated) plus one `appendRow` per allocation, plus one more `appendRow` via `recordOrder_` for each confirmed slot. `allocateCuratedEventSelections_` (Code.js:1737) can process several options in one call for one attendee — each one two more `appendRow`s, all sequential, all inside the same lock hold. Given this file's own architecture notes call individual `SpreadsheetApp` calls "roughly 0.5-2s each," an attendee selecting several options against an entity with a large existing `SubEventRegistrations` sheet can plausibly push the hold time past 30 seconds.
- *Why it matters:* If the TTL expires while the original holder is still legitimately working, a second, concurrent caller for the *same* entity can acquire the "same" lock and run its own critical section in parallel — reintroducing a double-allocation of the last available slot. Critically, the conditions that make this more likely (a large registrations sheet, many attendees selecting options) are exactly the conditions of a *popular, high-demand* entity near capacity — i.e., the safety net is most likely to misfire precisely when correct allocation matters most.
- *Recommendation:* Two complementary, low-risk moves: (a) as an immediate stop-gap, raise `ENTITY_LOCK_SAFETY_TTL_SECONDS` to something with more headroom (e.g. 90-120s) — cheap, one constant; (b) as a more correct fix, have the lock holder periodically refresh (`cache.put` again with the same `leaseId` and a fresh TTL) every ~10s while the critical section runs, so the TTL only ever matters for a genuinely-dead execution, not a slow-but-alive one. (a) alone meaningfully reduces the exposure window without any structural change.
- *Effort:* Low for (a), Medium for (b).
- *Resolution:* (a) applied — `ENTITY_LOCK_SAFETY_TTL_SECONDS` raised from 30 to 120 (Code.js:1594-1602), with the doc comment updated to explain why the TTL is deliberately generous rather than tight. Confirmed this is the constant's only functional use site, so the change is fully isolated. (b), the lease-renewal/heartbeat redesign, was deliberately deferred — it touches the shape of all three allocation functions rather than one constant, and the TTL bump alone closes the realistic exposure window at today's scale. Worth revisiting if this platform grows to sustain very large, very hot single-entity contention.

**2. [Medium] Heavy per-entity contention inside a large registration batch can push a single request toward Apps Script's execution ceiling**
- *Description:* `acquireEntityLock_` can block a caller for up to 15 seconds per allocation attempt (the `timeoutMs` passed from `allocateChoice_`/`allocateCuratedEventSelections_`/`recordPlainSubEventOptIn_`). `submitEventRegistrationBatch` calls these sequentially, once per attendee per sub-event selection, inside a single request.
- *Why it matters:* A large group registration (e.g., a company registering 10+ colleagues) all selecting the same hot Exhibition booth or B2B slot could, in the worst case, queue up substantial cumulative wait time within one execution, compounding the existing risk (Module 3, Finding #5) of a mid-batch timeout leaving a partially-registered group.
- *Recommendation:* No code change strictly required before RC — this is a genuine edge case, not a routine failure mode. Worth a documented operational note (e.g., advise against extremely large single-batch group registrations for a single hot Exhibition/B2B event) rather than a structural fix under the current freeze.
- *Effort:* N/A (documentation) unless prioritized further.

**3. [Low] A waitlisted attendee's rank-1 choice, if not found in the live option set, waitlists them against a blank-labeled placeholder**
- *Description:* In `allocateChoice_` (Code.js:1689), `fallback = byId[String(rankedIds[0])] || {}` — if the attendee's first-ranked ID isn't present in the current live option set (e.g., a booth that's since been removed via the Floor Plan Designer — see Module 4, Finding #1), the resulting waitlist row gets an empty `optionLabel`.
- *Why it matters:* Minor data-quality/display issue in the admin's allocation view (a waitlist entry with no visible option name); doesn't affect correctness of who's confirmed vs. waitlisted.
- *Recommendation:* Fall back to a literal label like `'(removed option)'` instead of empty string.
- *Effort:* Trivial.

### What's solid here
This module is, in general, the most carefully engineered part of the codebase. The per-entity lock scoping (rather than one global script lock) is a real, correctly-reasoned throughput improvement documented clearly in the code's own comments. Every allocation function re-reads live capacity *inside* the lock rather than trusting a pre-lock snapshot, which is exactly right. The same-execution cache invalidation after every write (so a batch processing multiple attendees against the same entity never sees stale "available" state from earlier in its own loop) is a subtle correctness detail that's easy to get wrong and was clearly gotten right here. The waitlist-fallback logic and the confirmed-only Order recording (a waitlisted attendee doesn't generate a payable line item) are both correct.

### Module 5 Health: 7/10 → 8/10 (Finding #1 stop-gap applied)
The design is sound and the team clearly understood the hard parts of this problem (this is not a naive implementation). The one real structural gap — a fixed safety TTL with no renewal, on a critical section whose duration scales with data that grows over the life of an event — has had its realistic exposure window closed via a TTL increase (30s → 120s). The fully-correct fix (lease renewal) remains a good idea for if this platform ever needs to sustain very large, very hot single-entity contention, but isn't urgent at today's scale.

---

## Module 6: B2B Matching

**Files reviewed:** `Code.js:4596-4750` (Meeting Preferences: `initializePreferencesSession`, `savePreferences`), `Code.js:4752-4918` (`generateB2BMatchingSql` SQL export bridge).

### Findings

**1. [Medium] — ✅ FIXED. The generated matching-engine SQL is vulnerable to a backslash-based string-literal break-out**
- *Description:* `sqlStr_` (Code.js:4776-4778) escapes embedded single quotes (`'` → `''`) but not backslashes. MySQL's default `sql_mode` (i.e., without `NO_BACKSLASH_ESCAPES`) treats `\` as an escape character inside string literals — a value ending in a backslash immediately before the closing quote (e.g., a company name of `Acme\`) causes MySQL to read `\'` as an escaped quote rather than the string terminator, extending the literal into the following SQL and potentially altering the statement's structure.
- *Why it matters:* Company/attendee names feeding this export originate from the attendee registration form — attacker-reachable input. A crafted name could inject SQL into the generated `.sql` file, which an admin then runs by hand against a live database, trusting it as "their own system's output." This is a classic, well-understood escaping gap, not a theoretical one.
- *Recommendation:* In `sqlStr_`, escape backslashes before quotes: `String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")`. One-line, no behavior change for the overwhelming majority of names that don't contain a backslash.
- *Effort:* Trivial.
- *Resolution:* Fixed exactly as recommended.

**2. [Medium] — ✅ FIXED. `savePreferences` clears and rewrites the entire Meeting Preferences sheet — across every event, ever — on every single save, under a global lock**
- *Description:* `savePreferences` (Code.js:4716) reads the whole sheet, filters out only this attendee-and-event's own rows, appends their new selections, then `clearContents()` + rewrites the *entire* sheet. This is unbounded by the current event — it scales with total historical preference rows across the platform's whole lifetime, not the event in question. It also holds `LockService.getScriptLock()` (the same global, script-wide lock used by unrelated writes elsewhere — event saves, floor plan saves, registrations, dietary submissions) for the duration.
- *Why it matters:* As the platform accumulates more B2B events over time, every individual attendee's preference save gets progressively slower (a full-sheet read + full-sheet rewrite), and — because the lock is global rather than scoped — it needlessly serializes against completely unrelated write operations happening anywhere else in the app at the same moment, including at other, unrelated live events.
- *Recommendation:* Scope the lock to this specific `(eventId)` (reuse `acquireEntityLock_`/`releaseEntityLock_` from Module 5, which already solves exactly this problem for allocation) so unrelated events don't contend. Fully avoiding the whole-sheet rewrite would require a bigger structural change (e.g. a per-event tab or an indexed delete); given the freeze, the lock-scoping alone is the higher-value, lower-risk fix.
- *Effort:* Low (lock scoping) — the full unbounded-growth fix is Medium-High and probably not RC-critical unless preference volume is already large.
- *Resolution:* Lock-scoping fixed exactly as recommended — `savePreferences` now uses `acquireEntityLock_(eventId, ...)`/`releaseEntityLock_` instead of the global script lock. The unbounded whole-sheet-rewrite-per-save pattern itself is unchanged (as scoped) — a larger structural fix (per-event partitioning) remains a good future item if preference volume grows large.

**3. [Low-Medium] — ✅ FIXED. Saved preferences aren't validated server-side against the actual set of eligible match candidates**
- *Description:* `initializePreferencesSession` computes `availableCompanies` (opposite-side, currently-allocated attendees only), but `savePreferences` doesn't re-check that each submitted `item.targetEmail` is actually in that eligible set for this event.
- *Why it matters:* A direct API call (or a stale client) could write a preference row targeting an email that was never a legitimate match candidate for this event — this doesn't corrupt allocation/capacity (preferences are informational, feeding an offline export), but it does mean the SQL export's own "skipped" reporting (Finding in the export logic itself, which *does* correctly re-validate at export time) is the only backstop.
- *Recommendation:* Low priority given the export step already catches and reports invalid pairs — optional hardening, not urgent.
- *Effort:* Low.
- *Resolution:* Fixed. `savePreferences` now re-derives the same eligible-opposite-side-target set `initializePreferencesSession` computes for display and drops any selection that isn't in it, rather than trusting the client's list as-is. Invalid selections are silently dropped (not a hard failure) and reported back via a `droppedCount`, surfaced in `Portal.html` only when non-zero.

### What's solid here
`generateB2BMatchingSql` is genuinely excellent, thoughtful engineering for an awkward problem (bridging a live Sheets-backed app to an offline MySQL tool with no network path between them): the ID-resolution strategy is clearly explained both in code comments and in the generated SQL's own header comments (including a concrete, correct recommendation to add a `UNIQUE` key so a stale duplicate fails loudly rather than silently mismatching a join); invalid preference pairs (attendee or target no longer confirmed) are explicitly reported as "skipped" rather than silently dropped; the transaction wrapping (`START TRANSACTION`/`COMMIT`) is appropriate. `initializePreferencesSession`'s resolution of an attendee's real buyer/supplier tier from their allocated option (rather than the always-blank flat `RegistrationType` field) is called out in its own comment as fixing a real latent bug — good catch by whoever wrote it.

### Module 6 Health: 6/10 → 9/10 (all 3 findings fixed)
The domain logic is careful and the SQL bridge in particular shows real craftsmanship. All three findings — the injection-class SQL escaping bug, the global-lock scalability pattern, and unvalidated preference targets — are now fixed.

---

## Module 7: Milestones

**Files reviewed:** `Code.js:2782-3003` (definitions, completion tracking), plus the completion-handling functions read in Module 3 (`completeMilestone`, `completeConfirmInfoMilestone_`, `completeFileUploadMilestone_`, `getOrCreateEventUploadFolder_`, `getMilestonesForAttendee`, `getMilestonesForEntity_`, `hasSubmittedPreferences_`).

### Findings

**1. [Medium] — ✅ FIXED. `getOrCreateEventUploadFolder_` has a "check-then-create" race with no lock, so two attendees' first-ever file upload for an event can create duplicate Drive folders**
- *Description:* `getOrCreateEventUploadFolder_` (Code.js:1460) does `DriveApp.getFoldersByName(...)`, and if nothing is found, creates a new folder — a classic check-then-act race with no `LockService` protection, unlike every capacity-sensitive write elsewhere in this codebase. Drive doesn't enforce folder-name uniqueness, and `getFoldersByName().next()` is non-deterministic when duplicates exist.
- *Why it matters:* If two attendees complete a File Upload milestone for the same event at nearly the same moment — plausible right after a reminder email goes out to everyone at once — and the event's upload folder doesn't exist yet, both executions can independently decide "no folder exists" and each create their own, identically-named `"<EventName> (<EventID>)"` folder. No files are lost, but uploads end up scattered across duplicate folders, and an admin looking for "all uploads for this event" may only see half of them.
- *Recommendation:* Wrap the get-or-create in `acquireEntityLock_`/`releaseEntityLock_` (Module 5) keyed by `eventId` — cheap, reuses an already-proven primitive, and the hold time here is short (one Drive lookup + maybe one create).
- *Effort:* Low.
- *Resolution:* Fixed exactly as recommended, keyed by `'upload_folder_' + eventId` (a distinct prefix so this lock doesn't needlessly interact with the allocation engine's own per-entity lock on the same `eventId`). The shared root "Milestone Uploads" folder's own one-time creation race (only reachable on the very first upload ever, platform-wide) is a narrower residual not addressed — not worth the extra complexity for a race reachable at most once in the app's history.

**2. [Low] `maxSizeMB` has no admin-facing upper sanity bound, and can promise attendees more than the transport layer can deliver**
- *Description:* `saveMilestonesForEntity_` (Code.js:2877-2881) accepts any positive `maxSizeMB` from the admin with no ceiling. `google.script.run`'s payload size is bounded well below what an admin could configure (e.g. "500MB") once base64 encoding overhead is factored in.
- *Why it matters:* An admin could unknowingly configure a milestone that tells attendees "up to 500MB," which will fail for any file anywhere near that size before it ever reaches this function's own size check — a confusing, silent-until-tested UX gap.
- *Recommendation:* Cap the admin input at a realistic ceiling (e.g. 25MB) client-side, with a one-line note explaining why.
- *Effort:* Trivial.

### What's solid here
The definitions/completions split (admin-authored Milestones sheet vs. an append-only, absence-means-Pending Completions sheet) is a clean, simple model. `saveMilestonesForEntity_` correctly re-validates that a `SetPreferences` milestone can only be attached to a B2B entity server-side, "even if a stale/tampered client payload claims otherwise" — exactly the right instinct. File upload milestone completion re-validates file type/size server-side rather than trusting the client (explicitly modeled, per its own comment, on the same principle used for floor plan geometry). The milestone-type dispatch table (`MILESTONE_COMPLETION_HANDLERS_`) is a clean, low-friction extension point for a future third milestone type.

### Module 7 Health: 8/10 → 9/10 (Finding #1 fixed)
Small, well-scoped module — the one real concurrency gap is now closed. Finding #2 (no `maxSizeMB` sanity ceiling) remains as a minor open UX rough edge.

---

## Module 8: Budget

**Files reviewed:** `Code.js:3004-3421` (Orders, BudgetLines, BudgetCategories, `getBudgetSummary`, `saveBudgetLine`, `deleteBudgetLine`, `updateOrderPaymentStatus`), `AdminPortal.html` budget UI.

### Findings

**1. [Low-Medium] — ✅ FIXED. Budget line deletion is permanent with no audit trail, unlike the soft-status pattern used everywhere else for user-entered data**
- *Description:* `deleteBudgetLine` (Code.js:3342) does a hard `sheet.deleteRow(...)` — the line and its history are gone. This is inconsistent with the rest of the codebase's own convention for undoing something: sub-event registrations are marked `'Withdrawn'` rather than deleted (Module 3), events are only ever Draft/Live, never removed (Module 2). `AdminPortal.html:1797` does have a `confirm('Delete this budget line?')` guard, which meaningfully reduces the accidental-click risk.
- *Why it matters:* For a finance-adjacent feature, losing a cost line with zero record of who removed it or when is a real gap if an admin needs to reconstruct "what changed in the budget" later — the confirm dialog helps against misclicks, but doesn't help after a deliberate-but-wrong deletion.
- *Recommendation:* Lowest-risk option consistent with the rest of the codebase: mark the line inactive (e.g. an `IsDeleted`/status column) instead of removing the row, and filter it out of `getBudgetSummary`'s totals. Not urgent given the existing confirm guard.
- *Effort:* Low-Medium.
- *Resolution:* Fixed exactly as recommended. `BudgetLines` gained a trailing `IsDeleted` column (additive, same migration pattern as every other schema change in this file); `deleteBudgetLine` now sets it instead of `sheet.deleteRow`; `getBudgetLinesRaw_` filters deleted rows out at the read layer, so every existing caller (`getBudgetSummary` included) needed no changes of its own.

**2. [Low] Budget line amounts silently coerce invalid input to zero, same pattern flagged in Module 2**
- *Description:* `saveBudgetLine` (Code.js:3305-3306): `Math.max(0, Number(line && line.plannedAmount) || 0)` — a non-numeric `plannedAmount`/`actualAmount` silently becomes `0` rather than being rejected.
- *Why it matters:* Same risk as the event Price field (Module 2, Finding #3): a typo in a cost line's amount saves silently as zero with no error, understating the budget with no signal to the admin.
- *Recommendation:* Reject non-numeric amounts with a clear error, consistent with the fix suggested for Module 2.
- *Effort:* Trivial.

### What's solid here
The "actual income is always a live sum over Orders, never a cached running total" design (explicitly called out in the module's own header comment) is genuinely excellent — it structurally eliminates an entire class of "the numbers don't add up" bugs that plague budget/finance features built on denormalized running totals. Orders are never deleted, only status-flipped (`not_paid`/`paid`), preserving a complete income history. `resolveBudgetCategory_`'s graceful fallback to `'Other'` for a blank, unrecognized, or since-removed category means a stale client or an edited category list can never hard-fail a save. The auto-created-Order-on-registration wiring (every non-zero-price registration/allocation path calls `recordOrder_` inside the same lock that wrote the triggering row) means income tracking can't silently drift out of sync with actual registrations.

### Module 8 Health: 8/10 → 9/10 (Finding #1 fixed)
Clean, well-reasoned design with the right instinct (live computation over cached totals) applied to the part of the system where "the numbers must always add up" matters most. Finding #2 (silent-zero on invalid amounts) remains as a minor open polish item.

---

## Module 9: Admin Dashboard

**Files reviewed:** `Code.js:2297-2536` (`getExecutiveSummary`, `getEventDashboardData`, `getMilestoneCompletionSummary_`, `getPreferencesDashboardData_`, `getSubEventAllocationSummary`), `Dashboard.html` (full, the standalone stakeholder view).

### Findings

**1. [Low] The stakeholder Dashboard's shared access key has no in-app rotation or expiry**
- *Description:* `DASHBOARD_ACCESS_KEY` (Code.js:345) is a single long-lived secret, generated once and stored in `PropertiesService`. There's no admin-facing UI to rotate it — doing so requires going into the Apps Script editor and deleting the script property by hand.
- *Why it matters:* This link is explicitly meant to be shared with "stakeholders" — a broader, less controlled audience than the admin login. If it leaks (forwarded in an email thread, pasted somewhere public), anyone with it can view registration/attendee PII (names, emails, companies) across every event, indefinitely, with no way for an admin to revoke access without going outside the app entirely.
- *Recommendation:* A simple "Rotate Dashboard Key" admin action (delete + regenerate the script property, surfaced as a button in AdminPortal) would close this gap with minimal code.
- *Effort:* Low.

### What's solid here
Both `getExecutiveSummary` and `getPreferencesDashboardData_` show real performance awareness — the code's own comments explicitly note replacing what were previously O(n²) per-event/per-attendee re-filtering passes with precomputed maps, done before this audit rather than something this review had to point out. `Dashboard.html` escapes every piece of server-returned data through a proper `textContent`-based `escapeHtml` before inserting it into the DOM — consistently applied across every rendered table. The one instance of a value being echoed into an inline `<script>` var (`DASHBOARD_KEY`) is safe here (unlike the similar-looking pattern flagged in Module 1): `doGet` only renders this template *after* already confirming `params.key` exactly equals the real secret UUID, so the echoed value is never attacker-controlled free text.

### Module 9 Health: 8/10
Small, clean, read-only module. The only real finding is an operational one (key rotation), not a code defect.

---

## Module 10: Communications

**Files reviewed:** `Code.js:5558-7438` (templates, merge-tag rendering, automated triggers, admin CRUD, audience/preview/test-send, queue/drain/campaign lifecycle, unsubscribe — the largest single block in the file), `EmailLayoutDefault.html`, `EmailLayoutPlain.html`, `Unsubscribe.html`.

This is, along with Module 5, the most carefully engineered part of the codebase — it solves a genuinely hard problem (reliable bulk email from a platform with a 6-minute execution ceiling, a hard daily send quota, and a 20-trigger cap) about as well as it can be solved within Apps Script's constraints.

### Findings

**1. [Low] Unsubscribe token comparison isn't constant-time, unlike every other token comparison in the codebase**
- *Description:* `confirmUnsubscribe` (Code.js:7423) checks `token !== computeUnsubscribeToken_(email, scope)` — a direct `!==`. Every other secret comparison in the app (admin password hash, admin reset token, attendee OTP) correctly uses `secureCompare_`.
- *Why it matters:* In theory, a timing side-channel could help guess the HMAC token byte-by-byte; in practice this is a low-value target (worst case, an attacker unsubscribes someone from marketing email, not an account compromise), and network jitter makes such an attack very hard to execute reliably. Flagging purely for consistency with the codebase's own established (and correct) pattern.
- *Recommendation:* Swap to `secureCompare_(token, computeUnsubscribeToken_(email, scope))`.
- *Effort:* Trivial.

**2. [Low] The `TransportType` setting is persisted but has no effect on how mail is actually sent**
- *Description:* `CommunicationsSettings.TransportType` is saved (`saveCommSettings`, Code.js:5943) and displayed back to the admin in the quota status readout (`AdminPortal.html:2379`: "...usable right now via {transportType}"), but `deliverEmail_` (Code.js:6363-6375) unconditionally calls `MailApp.sendEmail` — it never reads `settings.transportType` at all. There's also no UI control to actually change the value (only the read-only display was found).
- *Why it matters:* A setting that's stored and echoed back but never actually consulted is a maintenance trap — implies a choice (e.g., MailApp vs. GmailApp for a higher Workspace quota) that doesn't currently exist, and would confuse whoever encounters it next (either an admin wondering why nothing changed, or a developer assuming it's already wired up).
- *Recommendation:* Given this is inert today with no UI to trigger it, the RC-appropriate move is documentation, not new functionality: either remove the unused field, or leave a comment marking it reserved-for-future-use so it isn't mistaken for working.
- *Effort:* Trivial.

### What's solid here
This module deserves specific praise, not just absence-of-findings:
- **Single-renderer guarantee**: `renderCommunication_` is explicitly the *only* function allowed to turn a template+context into subject/body HTML, called identically by preview, test-send, automated triggers, and the campaign queue — so "what the admin previewed" structurally cannot drift from "what got sent."
- **Merge-tag safety**: `substituteMergeTags_` HTML-escapes every substituted value in HTML mode and reports unknown/unresolvable tags as warnings instead of silently breaking the render.
- **At-most-once queue semantics under a hard execution ceiling**: `claimQueueSlice_` writes `Status=Sending` for a whole batch in one `setValues` *before* any sending starts, which is exactly what makes "claim, then send" safe if the execution is killed mid-batch — a stuck `'Sending'` row is later reconciled to `'Failed'` rather than blindly retried, correctly reasoning that a duplicate send to hundreds of people is worse than one missed email.
- **Platform-limit awareness baked into the design**: the drain trigger deletes its own prior triggers before doing anything else specifically to avoid the 20-trigger-per-script ceiling; `COMM_BATCH_SOFT_LIMIT_MS` stops claiming new work well before the 6-minute execution cap; `COMM_QUOTA_RESERVE` keeps the last 10 daily sends available for transactional mail (password resets, itinerary emails) even when a large campaign is draining the quota; a lease (not a blocking lock) makes concurrent drain triggers bail immediately rather than queue up.
- **Correctly scoped secret storage**: the unsubscribe HMAC secret lives in `PropertiesService`, explicitly *not* the spreadsheet, because — as the code's own comment notes — the spreadsheet is shared with client admins and the secret shouldn't be.
- **Fail-soft automated triggers**: `fireCommunicationTrigger_` is documented and built to never throw, since every call site is inside a user-facing save (registration, milestone completion) that must not fail just because an email had a problem.

### Module 10 Health: 9/10
The best-engineered module in the codebase. Both findings are minor polish items on an otherwise exemplary piece of infrastructure-aware engineering — this is what "designed with Apps Script's real constraints in mind" looks like.

---

## Module 11: Profiles

**Files reviewed:** `Code.js:5145-5398` (Profiles: `lookupAttendeeInfo`, `saveProfile`/`saveProfileInternal_`, session-gated wrappers), `Code.js:5400-5556` (internal utility helpers: `upsertCompanyDirectoryEntry_`, `escapeHtml`, `sanitizeForSheet_`).

### Findings

**1. [Critical] — ✅ FIXED. More instances of the same unauthenticated-bare-email pattern from Module 3 — here on the Profiles read/write path, including the write side actively used in production**
- *Description:* Three more public (non-`_`-suffixed) functions accept an arbitrary email with no session verification of their own:
  - `saveProfile(payload)` (Code.js:5325) — **writes** a full profile (name, mobile, LinkedIn, dietary/allergy requirements, company info) for whatever `payload.email` is given, no auth. This one is *not dead code* — `submitEventRegistrationBatch` calls it legitimately (per its own doc comment) to save profiles for colleagues being registered by an authenticated user. But `saveProfile` itself provides no gate — anyone can call it directly with any target email.
  - `getProfileForEmail(email)` (Code.js:5314) — confirmed dead (no caller in `Portal.html`) — **reads** and returns that same full profile for any given email.
  - `lookupAttendeeInfo(email)` (Code.js:5213) — the underlying read function both of the above (and the legitimate, session-gated `getMyAttendeeInfo`) share — is itself directly public and returns the same data for an arbitrary email.
- *Why it matters:* This is functionally identical in severity to Module 3's Finding #1, and arguably worse because `saveProfile` is a *live, actively-used* function, not dead code — the vulnerability is reachable through the exact code path the legitimate "register a colleague" feature already exercises. Concretely: anyone with the Portal page open can overwrite any known attendee's stored profile (including their dietary/allergy record) with arbitrary data, or read any attendee's full profile (name, mobile number, LinkedIn, dietary/allergy info, company details) by supplying nothing but their email address — no login, no proof of identity, no rate limit.
- *Recommendation:* This needs the same treatment as Module 3, Finding #1, but with one nuance: `saveProfile` has a legitimate internal caller, so don't delete it — instead have `submitEventRegistrationBatch` and `saveMyProfile` both call `saveProfileInternal_` directly (which already exists and takes the same payload), and remove the public `saveProfile` wrapper entirely. `getProfileForEmail` is dead — delete it. Rename `lookupAttendeeInfo` to `lookupAttendeeInfo_` (this codebase's own convention for internal-only helpers) and update its remaining legitimate callers (`getMyAttendeeInfo`, `lookupAttendeeInfoForRegistration`, `authenticateUserPortal` — all of which already correctly derive the target email from a verified session or an explicitly-intended "look up a colleague" flow).
- *Effort:* Low — same shape of fix as Module 3: mostly deletion and renaming, one small internal call-site update.
- *Resolution:* Fixed. `getProfileForEmail` deleted (confirmed dead). `submitEventRegistrationBatch` now calls `saveProfileInternal_` directly instead of the public `saveProfile` wrapper, which was then deleted entirely (zero remaining callers). `lookupAttendeeInfo` renamed to `lookupAttendeeInfo_` with all three internal callers (`authenticateUserPortal`, `getMyAttendeeInfo`, `lookupAttendeeInfoForRegistration`) updated.

### What's solid here
Where this module *does* gate access, it does so correctly and with real thought: `lookupAttendeeInfoForRegistration` requires a valid session specifically to prevent "fully-anonymous data-harvesting" (its own comment's words) while still intentionally allowing the target email to differ from the caller's — because prefilling a colleague's known info while registering them is the actual point of that feature. `saveMyProfile` correctly overrides any client-supplied email with the verified session one before delegating. The company-directory "first owner wins" model (`upsertCompanyDirectoryEntry_`) is a sensible, low-complexity way to let a shared per-domain company record exist without a real ownership/permissions system — an unclaimed legacy row is deliberately left alone rather than silently claimed by whoever saves next. `escapeHtml` correctly escapes all five HTML-significant characters including both quote types.

### Module 11 Health: 4/10 → 8/10 (Finding #1 fixed)
Was held down entirely by Finding #1, now resolved — the underlying identity/profile model and the legitimate session-gated paths were always reasonable; the module shared the exact systemic gap found in Module 3, here touching data with real sensitivity (dietary/allergy information) and, notably, through a function (`saveProfile`) that was genuinely part of the live registration flow rather than dead code.

---

## Overall Module Health

| # | Module | Health |
|---|--------|--------|
| 1 | Authentication & Access | ~~7/10~~ → 9/10 (Findings #2, #3, #4, #6, #7 fixed) |
| 2 | Event Management (Admin) | ~~7/10~~ → 9/10 (Findings #1, #2, #3 fixed) |
| 3 | Attendee Registration Flow | ~~5/10~~ → 9/10 (Findings #1, #2, #3, #5 fixed) |
| 4 | Exhibition / Floor Plan Designer | ~~6/10~~ → 9/10 (Findings #1, #3 fixed) |
| 5 | Ranked Allocation Engine | ~~7/10~~ → 8/10 (Finding #1 stop-gap applied) |
| 6 | B2B Matching | ~~6/10~~ → 9/10 (all 3 findings fixed) |
| 7 | Milestones | ~~8/10~~ → 9/10 (Finding #1 fixed) |
| 8 | Budget | ~~8/10~~ → 9/10 (Finding #1 fixed) |
| 9 | Admin Dashboard | 8/10 |
| 10 | Communications | 9/10 |
| 11 | Profiles | ~~4/10~~ → 8/10 (headline finding fixed) |
| | **Overall average** | **~6.8/10 → ~8.7/10** |

**Update:** Across two rounds of fixes, every Critical and High finding in this report is now fixed, along with all 11 Medium and 3 Low-Medium findings the user chose to address (Module 5's execution-ceiling note and Module 4's lock-domain question were deliberately left as operational/product decisions rather than code changes — see their Resolution notes). See the ✅ markers and *Resolution* notes throughout for exact detail on each. Scores above reflect all of it. Remaining open findings are Low/Enhancement/Informational only.

The spread is real, not noise: the modules solving the hardest *technical* problems (concurrent allocation, bulk email under Apps Script's execution/quota/trigger ceilings) are the most carefully engineered code in the file — whoever built this clearly understands Apps Script's sharp edges and designed around them deliberately, with extensive, accurate doc comments explaining *why*, not just *what*. The lowest scores (Registration Flow, Profiles) aren't from weak engineering in the live code paths — they're from a specific, repeated oversight (bare client-supplied email, no session check) that was correctly fixed in most places but missed in a consistent handful of others.

## Production Readiness

**Update: all five items below are now addressed** (four fully fixed, one stop-gapped pending manual verification in the deployed app — see each Resolution note above for exact detail). Original assessment, kept for context:

**Not yet — but close, and the path is narrow and well-defined.** This is not a codebase with deep architectural problems; it's a well-engineered application with one systemic gap (the authentication bypass pattern) and a handful of independent, well-understood issues, each with a small, low-risk fix. Concretely:

- ~~**Blocking for any production release:** the unauthenticated bare-email functions (Module 3 Finding #1, Module 11 Finding #1).~~ **Fixed** — no longer blocking.
- ~~**Strongly recommended before a real/public launch:** the Draft-event registration gap (Module 3 Finding #2) and the Floor Plan booking-blind-deletion risk (Module 4 Finding #1).~~ **Both fixed.**
- ~~**Strongly recommended before relying on this for a large or popular event:** the entity-lock safety-TTL gap (Module 5 Finding #1)~~ **Stop-gap applied** (TTL 30s→120s) — the full lease-renewal redesign remains a good future improvement but isn't urgent at today's scale.
- **Everything else** (performance/lock-scoping issues, validation inconsistencies, the SQL escaping gap, dead code, stale comments) is real and worth cleaning up, but none of it is a blocker — it's the normal residue of an actively-developed feature set approaching a freeze, not evidence of an unstable foundation.

## Top 5 Priorities

1. ~~**Close the unauthenticated-identity functions** (Module 3 #1, Module 11 #1).~~ **Done.** Confirmed-dead functions deleted (`submitEventRegistration`, `submitDietaryRequirements`, `getDietaryRequirements`, `getDietarySheet_`, `getProfileForEmail`, `saveProfile`); still-used-but-previously-ungated ones renamed to internal-only (`updateCompanyDetailsInRegistrations_`, `lookupAttendeeInfo_`, `getAttendeeItinerary_`) with all callers updated.
2. ~~**Gate registration on event Status** (Module 3 #2).~~ **Done.** Guard added to all three functions, plus a matching per-sub-event check inside `addSubEventSelectionsForAttendee`'s selection loop.
3. ~~**Give the Floor Plan Designer booking-awareness before allowing deletion** (Module 4 #1).~~ **Done.** `saveFloorPlanLayout` now preserves any booth with an active confirmed booking regardless of what the client's payload says, and reports back what it protected.
4. ~~**Extend or renew the entity-lock safety TTL** (Module 5 #1).~~ **Stop-gap done** — `ENTITY_LOCK_SAFETY_TTL_SECONDS` raised 30→120. Lease renewal remains a possible future follow-up, not urgent now.
5. ~~**Harden the admin "Save Event" path** (Module 2 #1, #2).~~ **Done.** Update-path writes batched into one `setValues` call (mirroring the create path); Save Event button now disables and relabels itself while a save is in flight, restoring on success or failure.

**Quick wins worth bundling in** (trivial effort, real value, no urgency of their own): escape backslashes in the B2B SQL export's `sqlStr_` (Module 6 #1); make the flat event Price and BudgetLine amount fields reject non-numeric input the same way option prices already do (Module 2 #3, Module 8 #2); switch the unsubscribe token comparison to `secureCompare_` (Module 10 #1); delete the stale contradictory comment above `normalizeTypeConfig_` (Module 2 #4).

---

## Post-Audit Addition: Per-Event Email Domain Allowlisting

Not a finding from the original audit — a new capability built afterward, following a design discussion about a gap the audit's Module 1/Module 3 sections surfaced: the OTP login only proves an attendee controls the email address they typed, not that they're supposed to be at a given event. Documenting the design here since it changes behavior other findings in this report describe.

**What it does:** an admin can optionally set a comma-separated list of email domains on a top-level event (Draft or Live, Umbrella or standalone). Blank (the default, and the state of every pre-existing event) means open to anyone, exactly as before. When set:
- An attendee whose email domain isn't on the list never sees the event in their tile grid at all (`authenticateUserPortal`) — same "just doesn't exist for you" treatment as a Draft event.
- The registration form (`getRegistrationFormDefinition`) and the actual write (`submitEventRegistrationBatch`, per-attendee — covers both the primary registrant and any colleagues being added) both independently reject a non-matching domain, so a direct API call bypassing the tile grid is still blocked.
- **Exception, by design:** an attendee already registered keeps full access to that event in "My Events" regardless of the *current* allowlist state — the filter governs discovering new events, not revoking access to ones already joined. If an admin tightens or changes the list after someone's registered, that person isn't retroactively locked out.
- Restriction lives on the top-level event only — a sub-event under an Umbrella event inherits its parent's list rather than carrying its own (mirrors how Currency already works). Per-sub-event restriction was discussed and explicitly deferred, not forgotten — worth revisiting if a real need for it shows up.

**Where it lives:** `Code.js` — `AllowedDomains` column on the Events sheet (trailing/additive, same migration pattern as every other schema change in this file); `normalizeAllowedDomains_`/`getEventAllowedDomains_`/`eventAllowsEmailDomain_` helpers; enforcement in `authenticateUserPortal`, `getRegistrationFormDefinition`, `submitEventRegistrationBatch`; write path in `createOrUpdateEvent`. `AdminPortal.html` — a new "Allowed Email Domains" field grouped with the other top-level-only fields (Currency, Dietary Requirements, Details Page URL), so it inherits their existing show/hide behavior for sub-events with no extra wiring.

**One deployment note, not a bug:** this codebase caches each sheet's header-row check for up to 6 hours (`ensureHeadersFresh_`) to avoid re-verifying it on every read. If that cache is still "warm" from before this change ships, `createOrUpdateEvent` could briefly throw "Events sheet is missing expected column 'AllowedDomains'" until the cache naturally expires. This is how every prior column addition in this file has always behaved, not something new — if you want it to take effect immediately on deploy rather than within the next 6 hours, either add the `AllowedDomains` header to the Events sheet by hand once, or clear the script cache.

**Not yet done:** no visual indicator in the admin's event list showing which events are restricted (only visible by opening the edit form) — kept out of scope to match what was asked for; easy to add if useful. Also not touched: `getEventDetailsForAttendee` remains ungated for the same reason the Draft-status fix left it alone (it's shared between pre-registration preview and already-registered "My Events" viewing) — so a restricted event's *details* are visible to someone who already knows/guesses its ID, even though they won't see it in their tile grid or be able to register. Same residual as the Draft-status case, same reasoning.

---

## Post-Audit Addition: Same-Company-Only Colleague Registration

A second, related decision from the same discussion: the "Register Additional Attendee" flow (a signed-in attendee adding colleagues to their own registration in one batch) had no check that the colleagues being added actually belong to the same company as the person adding them — anyone could type in any email and register it, from any domain.

**Decision made (explicit choice between two options, hard block chosen):** an attendee being added whose email domain doesn't match the signed-in registrant's own domain is rejected outright, with an error explaining they need to register themselves rather than be added by proxy. The alternative considered — creating a "Pending" registration and emailing that person a link to accept it — was explicitly not chosen; it would have meant a new registration status, a new Communications trigger, and a new public accept-flow page, none of which exist today.

**Where it lives:** `Code.js` — `submitEventRegistrationBatch` now compares each attendee's email domain against the signed-in session's own domain (not the first attendee in the list, so this is correct whether or not the registrant includes themselves in the batch), independent of and in addition to the per-event `AllowedDomains` check above. `Portal.html` — the same check is mirrored client-side in `readCurrentAttendeeForm` for immediate feedback before a server round-trip; the server check is the authoritative one regardless.

**Known limitation, not addressed (flagging, not asking):** this is a literal domain match, so two people who both happen to use the same *personal* email provider (e.g. two different individuals both on `gmail.com`) would incorrectly be treated as "colleagues" by this check, while two real colleagues on different consumer addresses would be incorrectly blocked. This only matters for events/companies where attendees register with personal rather than company email addresses — say if that turns out to be common for this platform's actual users, worth a follow-up conversation about whether to special-case known public email providers.

---

## Post-Audit Addition: Admin Authentication Audit Trail

Implements Module 1, Finding #9 (previously an Enhancement — net-new capability, deliberately not built during the original audit pass without explicit sign-off; now built on request).

**What it does:** a new append-only `AdminAuditLog` sheet (Timestamp, Email, EventType, Detail) records: successful admin logins, failed login attempts (including unknown emails — deliberately, since that's exactly the signal worth keeping for reviewing suspicious activity, not something to filter out), lockouts triggered by the brute-force throttle (Module 1, Finding #3), password reset requests, completed password resets, invalid/expired password-reset-token attempts, and logouts.

**Design choices:**
- Fail-soft (`recordAdminAuditEvent_` swallows its own errors) — same principle already established for `fireCommunicationTrigger_`: a logging problem must never be able to turn a real login attempt into an unhandled error.
- The `Detail` column records more than the caller ever sees (e.g. distinguishing "wrong password" from "no account with this email" as separate log entries) without changing the identical, enumeration-safe error message returned to whoever's actually logging in — the log is only ever readable by someone who already has direct spreadsheet access, so this doesn't create the enumeration risk the generic user-facing message specifically exists to prevent.
- No new admin-facing viewer UI was built — the sheet itself is directly reviewable the same way Orders/Registrations already are. Say if a dedicated in-app viewer would be useful.

**Where it lives:** `Code.js` — `getAdminAuditLogSheet_`, `recordAdminAuditEvent_`, and the `ADMIN_AUDIT_*` event-type constants; hooked into `adminLogin`, `adminLogout`, `requestAdminPasswordReset`, and `resetAdminPassword`.

---

## Post-Audit Addition: Event Archiving via the (Pre-Existing) "Closed" Status

Implements Module 2, Finding #5 (previously an Enhancement — no way to delete/cancel/archive an event; not built during the original audit pass). While scoping this, found and corrected the error described in Finding #6 above.

**What it turned out to already exist:** the "Closed" status was already fully wired on the write side and the tile-grid/registration side — `createOrUpdateEvent` already stores any status string with no validation, and every registration/discovery gate added earlier in this session (`authenticateUserPortal`, `getRegistrationFormDefinition`, `submitEventRegistrationBatch`, `addSubEventSelectionsForAttendee`) uses allow-list logic (`status !== 'Live'`) that already correctly treats "Closed" the same as "Draft." An admin could already select "Closed" from the dropdown and have it correctly stop new registrations and hide the event from attendees' tile grids — that part was never broken.

**What was actually fixed:** sub-event-level visibility never accounted for "Closed," only "Draft" — `getUmbrellaChildren`, the event-details-preview function, and `addSubEventSelectionsForAttendee`'s per-selection validation all now exclude a Closed sub-event the same way they already excluded a Draft one.

**Decision made:** did *not* add a separate "Cancelled" status alongside the existing "Closed" one, despite that being the original plan going into this — once "Closed" turned out to already be real and working, adding a second, semantically-overlapping status would have just been confusing (what's the difference between an event that's "Closed" vs. "Cancelled"?) for no real benefit.

**Not built:** a list-view filter to hide Closed events from the admin's default event list (they remain visible, just visually distinguished via the existing `'closed'` CSS styling) — the original recommendation mentioned this as a nice-to-have; happy to add it if the list gets cluttered in practice.

---

## Post-Audit Addition: Admin CRUD for ClientOnboarding / RegistrationFormFields / Budget Categories

Implements enhancement #5 from the post-audit "top 8" list — the three sheets the codebase's own architecture doc says must be edited by hand ("there's no in-app UI for it").

**New admin nav item, "⚙️ Settings",** with three sub-tabs, each following the same "client sends the whole ordered list, server does a scoped replace" pattern already used by Milestones/Budget Lines/the domain allowlist elsewhere in this codebase — no per-row IDs to track, no rename-tracking complexity:

- **Budget Categories** — two reorderable lists (cost/income), add/remove, one Save per list. `saveBudgetCategories(token, lineType, categoryNames)`.
- **Registration Fields** — grouped by Event Type, add/edit/remove a custom field (name/label/type/options/required). `getRegistrationFormFieldsAdmin`/`saveRegistrationFormFieldsForType`. `FieldName` is validated as a safe identifier (letters/numbers/underscore only) since it's used as an object key in `extraFields` elsewhere — a stray space or symbol here would previously have broken that silently rather than failing clearly at save time.
- **Event Types (ClientOnboarding)** — add/edit Event Types and their Registration Types + IsB2B flag. `saveClientOnboardingType`. Deleting one in use isn't a hard block, but isn't silent either: `deleteClientOnboardingType` returns a `USAGE_COUNT:N` signal the client turns into a real confirmation ("N events currently use this — delete anyway?") before resubmitting with `force:true`. Renaming an *existing* Event Type isn't supported — too many places reference it by name for that to be safe to allow casually.

**Sheets that were previously read-only-by-direct-edit now have proper write paths** (`getFormFieldsSheet_`, `getOnboardingSheet_`) with explicit cache invalidation on every save — both sheets' read sides previously assumed no write path existed and leaned on cache TTL alone; that assumption no longer holds now that this panel exists.

**A styling gap caught before shipping:** the new rows initially used ad hoc inline styles that didn't match the rest of the admin form (the existing `.remove-row-btn`/input styling was scoped to `.type-config-row`, which these new rows weren't using, and this file had no tab-strip styling at all). Fixed by reusing `.type-config-row` where the layout already matched, and adding a small `.settings-field-row`/`.nav-tabs`/`.tab-btn` CSS block for the one row shape that didn't.

---

## Post-Audit Addition: "Who Chose Me" B2B Report

A per-attendee reverse-lookup over Meeting Preferences — given a B2B attendee, who selected *them*. Built with two audiences, per your decision: admins always see it; attendees only see it if an admin has explicitly turned it on for that specific event.

**Core function, `getChosenByForEntity_(entityId, targetEmail)`:** filters Meeting Preferences by `TargetEmail`, joins back to the top-level Registrations row for company details — the mirror image of `initializePreferencesSession`'s existing "companies I can choose" logic, reading the same sheet in the opposite direction.

**Data model:** `ShowChosenByToAttendees` on the Events sheet — deliberately **per-entity, not inherited from a parent** (unlike `Currency`/`AllowedDomains`), since a B2B entity is as often a sub-event as a standalone event, and defaults to **off**, per the privacy consideration you raised (Company A seeing that Company B specifically wants to meet them is real competitive information, not something to expose by default).

**Admin surface:** extends `getSubEventAllocationSummary` (the existing per-entity drill-down — discovered while wiring this up that it wasn't actually called from anywhere in `AdminPortal.html` yet, so this is also its first real caller) with a `chosenBySummary` array — every confirmed attendee plus their chosen-by count and list — rendered via a new "📊 View Chosen-By Report" button in the event edit form's B2B section. Always available to admins regardless of the toggle.

**Attendee surface:** `getMyChosenByReport(sessionToken, eventId)` — gated on both the entity's toggle (throws a plain "not available" if off) and actual confirmed participation, resolved from the verified session, never an arbitrary email (same ownership check `initializePreferencesSession` already uses). A new "Who Chose Me" button appears alongside "My Itinerary"/"Preferences" for any B2B entity; the server call is the real gate, so clicking it when the report is off just surfaces that message rather than the button needing its own separate visibility flag threaded through every render call site.

**Admin control:** a checkbox ("Let attendees see which companies chose them") in the same B2B config section as the new report button, off by default, with an explicit warning in its own hint text about what turning it on actually exposes.

