/* =========================================================================
   EVENT PORTAL + ADMIN PORTAL — MAIN SERVER SCRIPT
   =========================================================================
   ARCHITECTURE OVERVIEW
   ----------------------------------------------------------------------
   One spreadsheet (SPREADSHEET_ID) supports MULTIPLE events. Registration
   is always INITIATED at the top-level Event: it carries its own
   EventType, IsB2B and DietaryRequirements flags, and can be created and
   made Live entirely on its own — sub-events are optional (0-to-N).

   SUPPORTED EVENT TYPES
   - "B2B Pre-scheduled Meetings" — IsB2B-driven meeting-matching events
     (onboarding-defined RegistrationTypes, e.g. BuyerB2B/SupplierB2B).
   - "Curated Event" — formerly labelled "Excursion" in this codebase.
     Renamed throughout; supports ranked, per-option price/capacity (see
     EVENTTYPE-SPECIFIC REQUIREMENTS below), falling back to a single
     flat event-level Price/Places pair when no options are configured.
   - "Exhibition" — floor-plan / booth events (table builder logic is
     UNCHANGED by this revision).
   Additional onboarding-defined types may still exist (the type list is
   sourced dynamically from the ClientOnboarding tab), but the three above
   are the ones this codebase has first-class support for.

   EVENTTYPE HIERARCHY RULES
   - A standalone Event (no sub-events) uses its own EventType directly
     (e.g. "Curated Event", "Exhibition", or a standard onboarding-defined
     type). The common base form + that type's requirements apply
     directly to the event.
   - An Event WITH sub-events must have its top-level EventType set to
     the reserved value "Umbrella Event". Every sub-event under an
     Umbrella Event MUST itself carry a mandatory EventType, chosen from
     the dynamic options defined in the ClientOnboarding tab (this
     includes "Curated Event" and "Exhibition").
   - Registration flow for an Umbrella Event: the attendee fills the
     common base form ONCE, then opts into individual sub-events as
     cards/tiles. Each opted-in sub-event is processed according to its
     own EventType's rules below — there is no generic top-level
     registration record beyond the base attendee/company details.

   EVENTTYPE-SPECIFIC REQUIREMENTS (apply whether the EventType lives on
   a standalone top-level Event OR on a sub-event under an Umbrella Event)
   - "Curated Event" and "B2B Pre-scheduled Meetings": both REQUIRE at
     least one ranked option (each with its own Label — for B2B, the
     Registration Type selected from ClientOnboarding — Price, and
     Places/Capacity, including an explicit "Unlimited" state, see
     CAPACITY / UNLIMITED PLACES below), stored in TypeConfig. This is
     enforced server-side in normalizeTypeConfig_, which now throws if the
     list is empty for either type — there is NO flat event-level
     fallback for new/re-saved events of these two types. Attendees rank
     up to 3 preferred options; allocation is atomic (LockService) and
     falls back to a waiting list when every ranked option is full.
     DECISION (legacy data only): an event of either type saved BEFORE
     this requirement existed may still have an empty TypeConfig sitting
     in the sheet; entityUsesRankedAllocation_/getEntityLiveState/etc.
     still recognize that and fall back to the SIMPLE event-level
     Price + Places pair living directly on its own row for THAT
     unmigrated row only — see getCuratedEventOptionsLiveState_()
     (returns null when no options are configured, signalling "use the
     event-level fallback"). The moment such an event is next saved
     through the admin form, it must have at least one option added.
   - "Exhibition": booths/amenities/landmarks are laid out visually via
     the admin drag-and-drop Floor Plan Designer (AdminFloorPlan.html) and
     stored in the FloorPlanElements sheet — NOT TypeConfig (TypeConfig is
     fully retired for Exhibition, see normalizeTypeConfig_). Only "booth"
     elements are bookable; each can only be booked once. Attendees rank
     up to 3 preferred booths; the highest-ranked available booth is
     allocated atomically (LockService), same mechanism as Curated
     Event's ranked options (see allocateChoice_, shared by all three
     option-based types).
     Each bookable booth is optionally tagged with an Asset Type (a
     TypeConfig entry — see normalizeTypeConfig_/normalizeExhibitionAssetTypes_
     — e.g. "Premium Booth" vs. "Standard Booth", each with its own Price)
     via FloorPlanElements.AssetTypeId; a booth with no Asset Type falls
     back to the Exhibition's single flat event-level Price, same as
     before this feature existed.
   - Any other EventType (not Curated Event, B2B Pre-scheduled Meetings,
     or Exhibition): sub-events are still descriptive agenda items, but
     under an Umbrella Event they are individually opt-in (recorded in
     SubEventRegistrations) rather than merely shown as a schedule. These
     define a flat Price / Places value using the same event-level fields
     that Curated Event/B2B fall back to only for legacy, pre-options rows
     (see DECISION above).

   CURRENCY
   - A Currency lives ONLY on the top-level (parent) Event row. Every
     sub-event and every price/summary/receipt payload for that event
     inherits the parent's currency via getEventCurrency_(). Falls back
     to DEFAULT_CURRENCY if unset.

   CAPACITY / UNLIMITED PLACES
   - A "Places" value lives on any Event row (top-level or sub-event), AND
     on each individual Curated Event option (inside its TypeConfig
     entry). Blank/empty, or the sentinel string "Unlimited", means
     UNLIMITED capacity. A non-negative integer means a hard cap.
     Unlimited is NEVER conflated with zero — zero is a valid (always-
     full) capacity, distinct from unlimited. See parsePlaces_() /
     buildCapacityState_() / getEventCapacityState_() /
     getCuratedEventOptionsLiveState_().

   Allocation/opt-in records for sub-events (and for standalone
   Exhibition events themselves) live in the SubEventRegistrations sheet
   — see REQUIRED SHEET TABS below.

   Attendees land on Portal.html, enter their email, and pick a *live*
   Event from a tile grid (tabbed: "My Events" they're registered for vs.
   "All Live Events"). Everything they do after that (Event Details,
   Register, Dietary Requirements, B2B pages) is scoped to that eventId.

   Admins land on the same page, tick "I am an Admin", authenticate with
   email+password (validated against the Admins sheet), and are taken to
   AdminPortal.html where they can create/update events & (optional)
   sub-events and view a Dashboard (executive summary + per-event drill
   down).

   REQUIRED SHEET TABS (created automatically on first use if missing,
   except ClientOnboarding which you must pre-populate during client
   onboarding):

   1. Admins                 Email | PasswordHash | ResetToken | ResetTokenExpiry
   2. Events                 EventID | ParentEventID | EventName | Description |
                              EventDate | EventTime | Location | Website | Status |
                              EventType | IsB2B | DietaryRequirements |
                              CreatedDate | CreatedBy | DetailsPageUrl | Price |
                              TypeConfig | Currency | Places |
                              MaxOptionsPerAttendee | FloorPlanSize
                              (IsB2B/DietaryRequirements/DetailsPageUrl are only
                               ever populated for rows where ParentEventID is
                               blank — i.e. the top-level Event. Currency is ALSO
                               top-level-only (see CURRENCY above). Price and
                               Places, however, are populated on WHICHEVER row —
                               top-level or sub-event — actually needs them (e.g.
                               a Curated Event sub-event under an Umbrella Event).
                               EventType IS populated on sub-event rows too, but
                               ONLY when the parent's EventType is "Umbrella
                               Event" — see ARCHITECTURE OVERVIEW above.
                               TypeConfig is a JSON blob interpreted per-
                               EventType: "Curated Event" uses it for an
                               OPTIONAL array of ranked options — each
                               {id,label,price,places} (places: null =
                               Unlimited, else a non-negative integer) —
                               falling back to the flat Price/Places
                               columns above when the array is empty.
                               "Exhibition" uses it for an OPTIONAL array
                               of Asset Types — each {id,label,price} —
                               that bookable floor plan elements may
                               reference (FloorPlanElements.AssetTypeId)
                               for tiered pricing; its booths/amenities/
                               landmarks THEMSELVES still live in the
                               FloorPlanElements sheet instead (see the
                               admin Floor Plan Designer). It's populated
                               on whichever row — top-level or sub-event —
                               actually carries that EventType.
                               FloorPlanSize is Exhibition-only: one of
                               "small"/"medium"/"large" (see FLOORPLAN_SIZES/
                               getFloorPlanCanvasSize_), picking the fixed
                               canvas dimensions that event's Floor Plan
                               Designer and attendee-facing map render at.
                               Blank/unrecognized defaults to "small" — the
                               original 800x600 dimensions from before this
                               field existed.)
   3. ClientOnboarding       EventType | RegistrationType | IsB2B
                              (one row per Event Type + Registration Type pair,
                               pre-populated by you when onboarding the client.
                               "Umbrella Event" is a reserved built-in type and
                               should NOT be added here — every other type,
                               including "Curated Event"/"Exhibition"/"B2B
                               Pre-scheduled Meetings", is defined here as usual.
                               Legacy rows still labelled "Excursion" are
                               auto-normalized to "Curated Event" in-memory by
                               normalizeEventType_() for backward compatibility,
                               but should be relabelled in the sheet directly
                               when convenient.)
   4. RegistrationFormFields EventType | FieldName | FieldLabel | FieldType |
                              Options | Required | SortOrder
                              (optional — extra fields per event type beyond
                               the built-in base fields. FieldType is one of:
                               text, textarea, email, tel, date, select)
   5. Registrations          Timestamp | EventID | Work Email | Full Name |
                              Company Name | Company Description |
                              Membership Type | Membership Category | Domain |
                              Website | Registration Type | ExtraFields (JSON)
   6. Membership Details     Company Name | Company Description | Membership Type |
                              Membership Category | Domain | Website
                              (global company directory, shared across events,
                               keyed by email domain — unchanged from before)
   7. Meeting Preferences    Timestamp | EventID | Email | Company Name |
                              Full Name | Target Email
   8. DietaryRequirements    Timestamp | EventID | Email | Full Name |
                              Requirements | Notes
   9. SubEventRegistrations  Timestamp | EventID | SubEventID | Email | FullName |
                              EventType | OptionId | OptionLabel | Status | Rank
                              (One row per attendee per opted-in sub-event, OR
                               per attendee for a standalone Exhibition/Curated
                               Event top-level event — in that case SubEventID
                               equals EventID. For a PLAIN opt-in (any type with
                               no ranked options, including a Curated Event with
                               no TypeConfig options configured), OptionId/
                               OptionLabel/Rank are blank and Status is always
                               "Confirmed". For a RANKED allocation (Exhibition
                               booths, or a Curated Event WITH options
                               configured), OptionId/OptionLabel is the
                               allocated booth/option, Rank is the attendee's
                               preference rank that was actually granted, and
                               Status is "Confirmed" or "Waitlisted".)
   10. <EventID>_BuyerMeetings / <EventID>_SupplierMeetings
                              Per-event meeting schedules produced by your
                              external B2B matching tool (same column layout
                              as before: email, appointment, start, end,
                              table_number, status, meeting_type,
                              supplier_org/buyer_org, supplier_fullname/
                              buyer_fullname).

   ADMIN PASSWORDS
   ----------------------------------------------------------------------
   There is no self-serve "create admin" UI (not part of the brief). To
   add or reset an admin's password, run adminSetPassword_() once from the
   Apps Script editor (Run > adminSetPassword_ after editing the two
   constants below), or use the in-app "Forgot password" flow once an
   admin row with that email already exists in the Admins sheet.
   ========================================================================= */

// ---- CONFIG & BRANDING ------------------------------------------
const SPREADSHEET_ID = '1sizqVWWZzKv1JNn97h-G7z8LRPE79iqs2C_gJx7Nqag';

const MEMBERSHIP_SHEET_NAME       = 'Membership Details';
const REGISTRATIONS_SHEET_NAME    = 'Registrations';
const PREFERENCES_SHEET_NAME      = 'Meeting Preferences';
const ADMINS_SHEET_NAME           = 'Admins';
const EVENTS_SHEET_NAME           = 'Events';
const ONBOARDING_SHEET_NAME       = 'ClientOnboarding';
const FORM_FIELDS_SHEET_NAME      = 'RegistrationFormFields';
const DIETARY_SHEET_NAME          = 'DietaryRequirements';
const PROFILES_SHEET_NAME         = 'Profiles';
const SUBEVENT_REG_SHEET_NAME     = 'SubEventRegistrations';
const FLOORPLAN_SHEET_NAME        = 'FloorPlanElements';
const MILESTONES_SHEET_NAME       = 'Milestones';
const MILESTONE_COMPLETIONS_SHEET_NAME = 'MilestoneCompletions';
const ORDERS_SHEET_NAME           = 'Orders';
const BUDGET_LINES_SHEET_NAME     = 'BudgetLines';
const BUDGET_CATEGORIES_SHEET_NAME = 'BudgetCategories';

// Default Budget category seed rows (see getBudgetCategoriesSheet_) — admins
// can add/edit/remove categories directly in the BudgetCategories sheet
// afterwards, same trust model as RegistrationFormFields.
const BUDGET_DEFAULT_CATEGORIES = {
  cost:   ['Venue', 'Catering', 'Marketing', 'Speakers/Talent', 'AV/Production', 'Staffing', 'Other'],
  income: ['Ticket Sales', 'Sponsorship', 'Grants/Subsidies', 'Other']
};
const BUDGET_LINE_TYPE_COST   = 'cost';
const BUDGET_LINE_TYPE_INCOME = 'income';
const ORDER_STATUS_PAID       = 'paid';
const ORDER_STATUS_NOT_PAID   = 'not_paid';

// Milestone types (admin-defined tasks attached to an Event or sub-event —
// see MILESTONE ARCHITECTURE below). Extensible: adding a new type means
// adding one more entry to MILESTONE_TYPES and to the completeMilestone_
// dispatch table, nothing else in the read paths needs to change.
const MILESTONE_TYPE_CONFIRM_INFO = 'ConfirmInfo';
const MILESTONE_TYPE_FILE_UPLOAD  = 'FileUpload';
// SetPreferences: only valid on an entity (top-level event OR sub-event)
// whose OWN EventType is B2B Pre-scheduled Meetings — enforced in
// saveMilestonesForEntity_. Has no completeMilestone_ handler: unlike
// ConfirmInfo/FileUpload, "completing" it isn't a discrete submission —
// its status is derived dynamically from whether the attendee has
// submitted Meeting Preferences for that entity (see
// hasSubmittedPreferences_), since preference-setting already has its own
// persistence independent of milestone tracking.
const MILESTONE_TYPE_SET_PREFERENCES = 'SetPreferences';
const MILESTONE_TYPES = [MILESTONE_TYPE_CONFIRM_INFO, MILESTONE_TYPE_FILE_UPLOAD, MILESTONE_TYPE_SET_PREFERENCES];
// Fixed field set ConfirmInfo milestones confirm/snapshot — see
// completeConfirmInfoMilestone_. Not admin-configurable in v1.
const MILESTONE_CONFIRM_INFO_FIELDS = ['companyName', 'companyDescription', 'website', 'membershipCategory'];
const MILESTONE_UPLOAD_ROOT_FOLDER_NAME = 'Milestone Uploads';

// Reserved, built-in EventType values (not sourced from ClientOnboarding).
const EVENT_TYPE_UMBRELLA      = 'Umbrella Event';
const EVENT_TYPE_CURATED_EVENT = 'Curated Event';   // formerly "Excursion"
const EVENT_TYPE_EXHIBITION    = 'Exhibition';
const EVENT_TYPE_B2B_MEETINGS  = 'B2B Pre-scheduled Meetings';

// Legacy EventType labels that should be transparently treated as their
// modern equivalent wherever an EventType string is read from a sheet.
// Keeps old rows (created before this rename) working without a forced
// data migration.
const LEGACY_EVENT_TYPE_ALIASES = {
  'Excursion': EVENT_TYPE_CURATED_EVENT
};

// Currency / capacity ("Places") shared constants.
const DEFAULT_CURRENCY = 'USD';
const PLACES_UNLIMITED_LABEL = 'Unlimited';

// Admin Exhibition floor-plan builder — snap-to-grid step (shared between
// server-side validation and the AdminFloorPlan.html client so they never
// drift apart) and the 3 fixed canvas sizes an Exhibition can pick from
// (see FloorPlanSize on the Events sheet / getFloorPlanCanvasSize_).
// "small" keeps the ORIGINAL dimensions from before per-event sizing
// existed, so every event saved before this feature shipped keeps
// rendering at exactly the same scale (see normalizeFloorPlanSize_'s
// default for unset/legacy rows).
const FLOORPLAN_GRID_SIZE = 20;
const FLOORPLAN_SIZES = {
  small:  { width: 800,  height: 600 },
  medium: { width: 1400, height: 900 },
  large:  { width: 2000, height: 1300 }
};
const DEFAULT_FLOORPLAN_SIZE = 'small';

/** Normalizes a raw FloorPlanSize cell value to one of FLOORPLAN_SIZES' keys, defaulting to DEFAULT_FLOORPLAN_SIZE for blank/unrecognized values. */
function normalizeFloorPlanSize_(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return FLOORPLAN_SIZES[key] ? key : DEFAULT_FLOORPLAN_SIZE;
}

/** Resolves an Exhibition entity's own canvas { width, height } — see FLOORPLAN_SIZES. */
function getFloorPlanCanvasSize_(entity) {
  return FLOORPLAN_SIZES[normalizeFloorPlanSize_(entity && entity.floorPlanSize)];
}

// Fixed checklist shown on the Profile page and registration form. Not
// currently sheet-driven — edit this list directly if you need to add or
// remove an option.
const DIETARY_OPTIONS = [
  'Vegetarian', 'Vegan', 'Halal', 'Kosher', 'Gluten-Free', 'Dairy-Free', 'Nut Allergy'
];

const DASHBOARD_ACCESS_KEY = 'testEvent';
const ADMIN_SESSION_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const RESET_TOKEN_TTL_MINUTES = 60;

// Design tokens for the app's visual theme. Colors/font here are used
// across Portal.html, AdminPortal.html, Dashboard.html, and
// AdminResetPassword.html via CSS variables, so changing them here
// re-themes the whole app in one place.
const BRANDING = {
  logoUrl: 'https://raw.githubusercontent.com/svvevents/b2bMeetingMatching/main/Connexa_Logo.png',
  bannerUrl: 'https://raw.githubusercontent.com/svvevents/b2bMeetingMatching/main/banner-1900x600.jpg',
  primaryColor: '#1C7293',   // teal — primary actions, active nav states, links
  navyColor: '#1B2A4A',      // navy — sidebars, dark surfaces, headings
  accentColor: '#D98E04',    // gold — callouts, highlights, secondary accent
  categoryTagColor: '#6C4FA0', // purple — reserved for category/type tags (distinct from accent)
  mintColor: '#22D3C5',      // mint — hover/secondary accent
  pageBgColor: '#F4F6F8',    // light page background
  bannerBgColor: '#F4F6F8',
  fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  eventTitle: 'Event Portal',
  successColor: '#2E7D5B',
  warningColor: '#D98E04',
  errorColor: '#C0392B',
  mutedTextColor: '#5B6472'
};

const MEMBERSHIP_COLUMNS = [
  'Company Name', 'Company Description', 'Membership Type',
  'Membership Category', 'Domain', 'Website'
];

/* =========================================================================
   EXECUTION-LEVEL MEMOIZATION CACHE
   ----------------------------------------------------------------------
   Apps Script executions are stateless ACROSS requests, but within a
   single execution the same "raw sheet" getters were being called many
   times (directly, and indirectly via helper functions), each one
   re-reading the full sheet via getDataRange().getValues(). That's the
   dominant cost in a slow request — SpreadsheetApp calls are slow
   (roughly 0.5-2s each), and the old code had no way to know it had
   already read a given sheet earlier in the same run.

   This object is a plain in-memory cache that lives only for the
   lifetime of a single execution (it's re-initialized fresh on every
   new Apps Script run — there is no cross-request persistence here,
   intentionally, since this is NOT a substitute for CacheService).

   IMPORTANT: this cache must NEVER be consulted inside the
   LockService-protected sections of allocateChoice_ /
   recordPlainSubEventOptIn_ for the specific reads that decide
   allocation/capacity — those re-read raw sheet data directly so
   concurrent submissions can't both see a stale "available" slot. See
   the comments at those call sites.
   ========================================================================= */
const _rawDataCache_ = {
  events: null,
  subEventRegs: null,
  registrations: null,
  floorPlan: null,
  onboarding: null,
  extraFieldsByType: null, // keyed by normalized eventType
  confirmedSubEventCounts: null, // { subEventId: count } — see getConfirmedSubEventCountMap_
  registrationCounts: null,       // { eventId: count } — see getRegistrationCountMap_
  membership: null, // { headers: [...], rows: [...] } — see getMembershipRaw_
  profiles: null,   // { headers: [...], rows: [...] } — see getProfilesRaw_
  preferences: null, // { headers: [...], idx: {...}, rows: [...] } — see getPreferencesRaw_
  milestones: null,  // array of milestone def objects — see getMilestonesRaw_
  milestoneCompletions: null, // array of completion objects — see getMilestoneCompletionsRaw_
  orders: null,            // array of order objects — see getOrdersRaw_
  budgetLines: null,       // array of budget line objects — see getBudgetLinesRaw_
  budgetCategories: null   // array of {lineType, categoryName, sortOrder} — see getBudgetCategoriesRaw_
};

/**
 * Cached Spreadsheet handle — every get*Sheet_() helper used to call
 * SpreadsheetApp.openById(SPREADSHEET_ID) independently, meaning a single
 * execution that touched N different sheets paid the "open the file" cost
 * N separate times. openById is re-fetched fresh on every NEW execution
 * (this is a plain global, not CacheService — same intentional scope as
 * _rawDataCache_ above), but within one execution there's no reason to
 * open the same file more than once.
 */
let _ss_ = null;
function getSpreadsheet_() {
  if (!_ss_) _ss_ = SpreadsheetApp.openById(SPREADSHEET_ID);
  return _ss_;
}

/**
 * Cross-request cache for sheets that only change via an explicit admin
 * action (Events, ClientOnboarding, RegistrationFormFields,
 * FloorPlanElements). Apps Script executions are stateless per request —
 * _rawDataCache_ above only helps WITHIN one execution — so every attendee
 * click was re-paying the full sheet-read cost even when nothing had
 * changed since the last click. This wraps CacheService.getScriptCache()
 * so a value survives across requests for a short TTL, with graceful
 * degradation if the payload is too large for the 100KB-per-key cache
 * limit or JSON round-tripping otherwise fails.
 */
const CROSS_REQUEST_CACHE_SECONDS = 60;

function getCrossRequestCache_(key) {
  try {
    const raw = CacheService.getScriptCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function putCrossRequestCache_(key, value) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), CROSS_REQUEST_CACHE_SECONDS);
  } catch (e) {
    // Value too large for CacheService (100KB/key) or otherwise
    // unserializable — silently skip caching rather than fail the request.
  }
}

function invalidateCrossRequestCache_(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) { /* no-op */ }
}

/**
 * Mints a short, sufficiently-unique row ID in the same "<PREFIX>-<epoch>-
 * <rand3>" shape already used ad hoc for MilestoneID (see
 * saveMilestonesForEntity_). Centralized here since Budget introduces
 * several new ID'd entities (RegistrationID, OrderID, LineID) that all want
 * the same format.
 */
function mintId_(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.floor(100 + Math.random() * 900);
}

// ---- ROUTING & INITIAL RENDER ------------------------------------
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};

  // --- Admin password reset page ---
  if (params.admin === 'reset' && params.token && params.email) {
    const tpl = HtmlService.createTemplateFromFile('AdminResetPassword');
    tpl.branding = BRANDING;
    tpl.email = decodeURIComponent(params.email);
    tpl.token = params.token;
    return tpl.evaluate()
      .setTitle('Reset Admin Password')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Admin Exhibition floor-plan builder (requires a valid session
  // token, same as the main Admin Portal, plus an eventId to edit) ---
  if (params.admin === '1' && String(params.page).toLowerCase() === 'floorplan') {
    const adminEmail = params.token ? validateAdminToken_(params.token) : null;
    const tpl = HtmlService.createTemplateFromFile('AdminFloorPlan');
    tpl.branding = BRANDING;
    tpl.adminEmail = adminEmail || '';
    tpl.token = adminEmail ? params.token : '';
    tpl.eventId = params.eventId || '';
    tpl.portalUrl = getWebAppUrl_();
    return tpl.evaluate()
      .setTitle('Floor Plan Builder')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Admin portal (requires a valid session token from adminLogin) ---
  if (params.admin === '1') {
    const adminEmail = params.token ? validateAdminToken_(params.token) : null;
    const tpl = HtmlService.createTemplateFromFile('AdminPortal');
    tpl.branding = BRANDING;
    tpl.adminEmail = adminEmail || '';
    tpl.token = adminEmail ? params.token : '';
    tpl.portalUrl = getWebAppUrl_();
    return tpl.evaluate()
      .setTitle('Admin Portal')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Stakeholder dashboard (accessed via ?key=... or ?page=dashboard) ---
  if (params.key === DASHBOARD_ACCESS_KEY || String(params.page).toLowerCase() === 'dashboard') {
    const tpl = HtmlService.createTemplateFromFile('Dashboard');
    tpl.branding = BRANDING;
    return tpl.evaluate()
      .setTitle('Event Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Default: attendee-facing portal ---
  const tpl = HtmlService.createTemplateFromFile('Portal');
  tpl.branding = BRANDING;
  return tpl.evaluate()
    .setTitle('Event Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getWebAppUrl_() {
  try {
    return ScriptApp.getService().getUrl();
  } catch (e) {
    return '';
  }
}

/* =========================================================================
   ADMIN AUTHENTICATION
   ========================================================================= */

function hashPassword_(plain) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(plain), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function getAdminsSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(ADMINS_SHEET_NAME) || ss.insertSheet(ADMINS_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(['Email', 'PasswordHash', 'ResetToken', 'ResetTokenExpiry']);
  return s;
}

// Wrapper so adminSetPassword_ shows up in the Apps Script editor's
// function dropdown (functions ending in "_" are hidden from it).
function runAdminSetPassword() {
  adminSetPassword_();
}

/**
 * DEV UTILITY — run manually from the Apps Script editor to create or
 * reset an admin's password. Not exposed to the client.
 */
function adminSetPassword_() {
  const email = 'admin@svvevents.com';       // <-- edit before running
  const plainPassword = 'Pa$$W0rd';     // <-- edit before running

  const sheet = getAdminsSheet_();
  const data = sheet.getDataRange().getValues();
  const hash = hashPassword_(plainPassword);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      sheet.getRange(i + 1, 2).setValue(hash);
      sheet.getRange(i + 1, 3, 1, 2).setValue('');
      Logger.log('Password updated for ' + email);
      return;
    }
  }
  sheet.appendRow([email.trim().toLowerCase(), hash, '', '']);
  Logger.log('Admin created: ' + email);
}

function adminLogin(email, password) {
  email = (email || '').trim().toLowerCase();
  if (!email || !password) throw new Error('Please enter both email and password.');

  const sheet = getAdminsSheet_();
  const data = sheet.getDataRange().getValues();
  const hash = hashPassword_(password);

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      if (String(data[i][1]) === hash) {
        const token = Utilities.getUuid();
        CacheService.getScriptCache().put('admin_session_' + token, email, ADMIN_SESSION_TTL_SECONDS);
        return {
          success: true,
          token: token,
          redirectUrl: getWebAppUrl_() + '?admin=1&token=' + encodeURIComponent(token)
        };
      }
      throw new Error('Incorrect password.');
    }
  }
  throw new Error('No admin account found for that email address.');
}

function validateAdminToken_(token) {
  if (!token) return null;
  return CacheService.getScriptCache().get('admin_session_' + token);
}

/** Every admin-only server function should call this first. */
function requireAdmin_(token) {
  const email = validateAdminToken_(token);
  if (!email) throw new Error('Your admin session has expired. Please log in again.');
  return email;
}

function requestAdminPasswordReset(email) {
  email = (email || '').trim().toLowerCase();
  const sheet = getAdminsSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      const token = Utilities.getUuid();
      const expiry = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60000).toISOString();
      sheet.getRange(i + 1, 3).setValue(token);
      sheet.getRange(i + 1, 4).setValue(expiry);

      const resetUrl = getWebAppUrl_() + '?admin=reset&token=' + encodeURIComponent(token) +
        '&email=' + encodeURIComponent(email);

      MailApp.sendEmail({
        to: email,
        subject: 'Reset your Admin Portal password',
        htmlBody: '<p>Click the link below to reset your Admin Portal password. This link expires in ' +
          RESET_TOKEN_TTL_MINUTES + ' minutes.</p><p><a href="' + resetUrl + '">Reset Password</a></p>'
      });
      break;
    }
  }
  // Always return success (don't reveal whether the email exists)
  return { success: true, message: 'If an admin account exists for that email, a reset link has been sent.' };
}

function resetAdminPassword(email, token, newPassword) {
  email = (email || '').trim().toLowerCase();
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  const sheet = getAdminsSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      const storedToken = String(data[i][2] || '');
      const expiry = data[i][3] ? new Date(data[i][3]) : null;

      if (!storedToken || storedToken !== token) throw new Error('This reset link is invalid.');
      if (!expiry || expiry.getTime() < Date.now()) throw new Error('This reset link has expired. Please request a new one.');

      sheet.getRange(i + 1, 2).setValue(hashPassword_(newPassword));
      sheet.getRange(i + 1, 3, 1, 2).setValue('');
      return { success: true };
    }
  }
  throw new Error('No admin account found for that email address.');
}

/* =========================================================================
   EVENTS SHEET HELPERS
   ========================================================================= */

function getEventsSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(EVENTS_SHEET_NAME) || ss.insertSheet(EVENTS_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.appendRow(eventsHeaders_());
  } else {
    // Existing sheets created before TypeConfig was introduced won't have
    // that header cell — add it (and any other future column) without
    // touching existing columns/data. Gated behind ensureHeadersFresh_ so
    // this only actually re-reads the header row once per cache window.
    ensureHeadersFresh_(s, eventsHeaders_(), 'headers_checked_events');
  }
  return s;
}

/**
 * Additive, non-destructive schema migration: appends any header present in
 * expectedHeaders but missing from the sheet's current header row, at the
 * END of the row. Never reorders or removes existing columns, so rows
 * created before a schema change keep reading/writing correctly.
 */
function migrateSheetHeaders_(sheet, expectedHeaders) {
  const lastCol = sheet.getLastColumn();
  const currentHeaders = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  const missing = expectedHeaders.filter(h => currentHeaders.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
}

/**
 * Gates migrateSheetHeaders_ behind a short-lived CacheService flag so a
 * sheet's header row is only re-checked once per TTL window instead of on
 * EVERY read (which is what every get*Sheet_() caller used to do). Header
 * drift only happens right after a schema change ships; re-verifying it on
 * every attendee click for the rest of that sheet's life is pure overhead
 * for the 99.9% case where nothing changed since the last check. Reads
 * still work correctly even if a migration is "missed" for a few hours —
 * rowToEventObj_ and friends look up cells by header NAME, not position.
 */
function ensureHeadersFresh_(sheet, expectedHeaders, cacheKey) {
  const cache = CacheService.getScriptCache();
  if (cache.get(cacheKey)) return;
  migrateSheetHeaders_(sheet, expectedHeaders);
  try { cache.put(cacheKey, '1', 21600); } catch (e) { /* no-op — re-check next call */ }
}

function eventsHeaders_() {
  return ['EventID', 'ParentEventID', 'EventName', 'Description', 'EventDate', 'EventTime',
    'Location', 'Website', 'Status', 'EventType', 'IsB2B', 'DietaryRequirements', 'CreatedDate', 'CreatedBy',
    'DetailsPageUrl', 'Price', 'TypeConfig', 'Currency', 'Places', 'MaxOptionsPerAttendee', 'FloorPlanSize'];
}

/**
 * Maps a legacy EventType label to its modern equivalent. Currently only
 * "Excursion" -> "Curated Event". Anything else passes through unchanged.
 * Applied everywhere an EventType is read from a sheet so old rows keep
 * working without a forced data migration.
 */
function normalizeEventType_(rawType) {
  const type = String(rawType || '').trim();
  return LEGACY_EVENT_TYPE_ALIASES[type] || type;
}

/**
 * Parses a raw "Places" cell value into a normalized capacity value.
 * Returns null to mean UNLIMITED (blank cell, or the literal "Unlimited"
 * string, case-insensitive). Returns a non-negative integer otherwise.
 * IMPORTANT: unlimited is represented as null, NEVER as 0 — 0 is a valid,
 * distinct, always-full capacity.
 */
function parsePlaces_(raw) {
  const str = String(raw == null ? '' : raw).trim();
  if (str === '') return null;
  if (str.toLowerCase() === PLACES_UNLIMITED_LABEL.toLowerCase()) return null;
  const n = Number(str);
  if (!isFinite(n) || isNaN(n)) return null; // unrecognized value -> fail safe to unlimited
  return Math.max(0, Math.floor(n));
}

function rowToEventObj_(headers, row) {
  const obj = {};
  headers.forEach((h, idx) => { obj[h] = row[idx]; });
  let typeConfig = [];
  if (obj.TypeConfig) {
    try { typeConfig = JSON.parse(obj.TypeConfig); } catch (e) { typeConfig = []; }
  }
  const eventType = normalizeEventType_(obj.EventType);
  return {
    eventId: String(obj.EventID || ''),
    parentEventId: String(obj.ParentEventID || ''),
    eventName: String(obj.EventName || ''),
    description: String(obj.Description || ''),
    eventDate: obj.EventDate instanceof Date ? Utilities.formatDate(obj.EventDate, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(obj.EventDate || ''),
    eventTime: String(obj.EventTime || ''),
    location: String(obj.Location || ''),
    website: String(obj.Website || ''),
    status: String(obj.Status || 'Draft'),
    eventType: eventType,
    isB2B: obj.IsB2B === true || String(obj.IsB2B).toUpperCase() === 'TRUE',
    dietaryRequirements: obj.DietaryRequirements === true || String(obj.DietaryRequirements).toUpperCase() === 'TRUE',
    createdDate: obj.CreatedDate instanceof Date ? obj.CreatedDate.toISOString() : String(obj.CreatedDate || ''),
    createdBy: String(obj.CreatedBy || ''),
    detailsPageUrl: String(obj.DetailsPageUrl || ''),
    price: Number(obj.Price) || 0,
    typeConfig: Array.isArray(typeConfig) ? typeConfig : [],
    isUmbrella: eventType === EVENT_TYPE_UMBRELLA,
    // Own raw Currency cell — only meaningful/populated on top-level rows.
    // Use getEventCurrency_(entity) to resolve the EFFECTIVE currency for
    // any entity (top-level or sub-event).
    currencyRaw: String(obj.Currency || '').trim(),
    // Own raw Places cell, already parsed: null = unlimited, else integer.
    places: parsePlaces_(obj.Places),
    // Curated Event only: max options one attendee may select. null = unlimited (default), else a positive integer. Reuses parsePlaces_'s blank/"Unlimited" -> null semantics (see MaxOptionsPerAttendee note on createOrUpdateEvent).
    maxOptionsPerAttendee: parsePlaces_(obj.MaxOptionsPerAttendee),
    // Exhibition only: which of the 3 fixed FLOORPLAN_SIZES this entity's floor plan canvas uses. Defaults to "small" (the original, pre-this-feature dimensions) for every other EventType and for any row saved before this field existed.
    floorPlanSize: normalizeFloorPlanSize_(obj.FloorPlanSize)
  };
}

const EVENTS_CACHE_KEY_ = 'events_v1';

/**
 * Events only change when an admin explicitly saves one (createOrUpdateEvent)
 * — every attendee-facing read (login, tile grid, registration form) was
 * otherwise re-paying a full sheet read on every single click, since Apps
 * Script executions are stateless per request and _rawDataCache_ alone only
 * helps WITHIN one execution. Layering a short CacheService TTL on top
 * means the SECOND+ click within CROSS_REQUEST_CACHE_SECONDS, by ANY user,
 * skips the sheet read entirely. createOrUpdateEvent busts this cache key
 * the moment it writes (see there), so admin edits still show up promptly.
 */
function getAllEvents_() {
  if (_rawDataCache_.events) return _rawDataCache_.events;
  const cached = getCrossRequestCache_(EVENTS_CACHE_KEY_);
  if (cached) { _rawDataCache_.events = cached; return cached; }

  const sheet = getEventsSheet_();
  let out;
  if (sheet.getLastRow() <= 1) {
    out = [];
  } else {
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    out = [];
    for (let i = 1; i < data.length; i++) out.push(rowToEventObj_(headers, data[i]));
  }
  _rawDataCache_.events = out;
  putCrossRequestCache_(EVENTS_CACHE_KEY_, out);
  return out;
}

function getEventById_(eventId) {
  const events = getAllEvents_();
  return events.find(e => e.eventId === String(eventId)) || null;
}

/* =========================================================================
   SHARED HELPERS — currency, capacity, pricing, summary formatting.
   These are the single sources of truth other functions should call
   instead of re-deriving currency/capacity/price logic inline.
   ========================================================================= */

/**
 * Resolves the EFFECTIVE currency for any entity (top-level Event or
 * sub-event). Currency is defined ONLY on the top-level (parent) row and
 * is inherited by every sub-event underneath it. Falls back to
 * DEFAULT_CURRENCY if nothing is set.
 */
function getEventCurrency_(entity) {
  if (!entity) return DEFAULT_CURRENCY;
  if (!entity.parentEventId) return entity.currencyRaw || DEFAULT_CURRENCY;
  const parent = getEventById_(entity.parentEventId);
  return (parent && parent.currencyRaw) || DEFAULT_CURRENCY;
}

/**
 * Resolves the EFFECTIVE price for an entity. Price already lives
 * directly on whichever row (top-level or sub-event) needs it — this
 * helper exists so callers have one consistent access point (and a safe
 * default) instead of reading entity.price directly everywhere.
 */
function getEventPrice_(entity) {
  return (entity && Number(entity.price)) || 0;
}

/**
 * Counts CONFIRMED registrants against a given entity (top-level event or
 * sub-event), used to compute live capacity availability.
 * - Sub-events (parentEventId set), and standalone Exhibition events,
 *   track individual attendees in SubEventRegistrations (subEventId ===
 *   entity.eventId).
 * - A standalone, non-Umbrella top-level event (e.g. a standalone Curated
 *   Event, or a B2B Pre-scheduled Meetings event) tracks attendees
 *   directly in the Registrations sheet (eventId === entity.eventId).
 */
/**
 * Groups SubEventRegistrations' CONFIRMED rows by subEventId, once per
 * execution, so getConfirmedCountForEntity_ can do an O(1) lookup instead
 * of re-filtering the whole array for every event/sub-event (previously
 * an O(N) filter per event, i.e. O(N*M) total across a tree of M events —
 * see getAdminEventsTree / authenticateUserPortal / getUmbrellaChildren,
 * which each call this once per event in a .map()/.forEach()).
 */
function getConfirmedSubEventCountMap_() {
  if (_rawDataCache_.confirmedSubEventCounts) return _rawDataCache_.confirmedSubEventCounts;
  const map = {};
  getSubEventRegsRaw_().forEach(r => {
    if (r.status !== 'Confirmed') return;
    map[r.subEventId] = (map[r.subEventId] || 0) + 1;
  });
  _rawDataCache_.confirmedSubEventCounts = map;
  return map;
}

/**
 * Groups Registrations rows by eventId, once per execution — same
 * rationale as getConfirmedSubEventCountMap_ above, for standalone
 * (non-Umbrella, non-Exhibition) top-level events.
 */
function getRegistrationCountMap_() {
  if (_rawDataCache_.registrationCounts) return _rawDataCache_.registrationCounts;
  const map = {};
  getRegistrationsRaw_().forEach(r => {
    map[r.eventId] = (map[r.eventId] || 0) + 1;
  });
  _rawDataCache_.registrationCounts = map;
  return map;
}

function getConfirmedCountForEntity_(entity) {
  if (!entity) return 0;
  const isSubEvent = !!entity.parentEventId;
  const tracksViaSubEventRegs = isSubEvent || entity.eventType === EVENT_TYPE_EXHIBITION;
  if (tracksViaSubEventRegs) {
    return getConfirmedSubEventCountMap_()[entity.eventId] || 0;
  }
  if (entity.eventType === EVENT_TYPE_UMBRELLA) return 0; // no direct registration record
  return getRegistrationCountMap_()[entity.eventId] || 0;
}

/**
 * Shared math: given a normalized "places" value (null = unlimited) and a
 * confirmed count, builds the UI/summary-ready capacity state object:
 *   { unlimited: bool, capacity: number|null, confirmed: number,
 *     available: number|null, isFull: bool, label: string }
 * Used both for a whole event/sub-event's own Places AND for a single
 * Curated Event option's per-option Places (see
 * getCuratedEventOptionsLiveState_ below). Unlimited (places === null) is
 * NEVER treated as zero/full.
 */
function buildCapacityState_(places, confirmed) {
  if (places === null || places === undefined) {
    return { unlimited: true, capacity: null, confirmed: confirmed, available: null, isFull: false, label: PLACES_UNLIMITED_LABEL };
  }
  const available = Math.max(0, places - confirmed);
  return {
    unlimited: false,
    capacity: places,
    confirmed: confirmed,
    available: available,
    isFull: confirmed >= places,
    label: places + (places === 1 ? ' place' : ' places')
  };
}

/**
 * Returns the normalized, UI/summary-ready capacity state for an entity's
 * OWN Places field (the event-level fallback — see DECISION note at top
 * of file for when this applies to a Curated Event vs. its per-option
 * Places).
 */
function getEventCapacityState_(entity) {
  const confirmed = getConfirmedCountForEntity_(entity);
  return buildCapacityState_(entity ? entity.places : null, confirmed);
}

/**
 * Formats a price + currency pair consistently for summaries/receipts.
 * Zero/blank price renders as "Free" rather than "0.00 USD".
 */
function formatMoney_(amount, currency) {
  const n = Number(amount) || 0;
  if (n <= 0) return 'Free';
  return currency + ' ' + n.toFixed(2);
}

/* =========================================================================
   SUB-EVENT / TYPE-SPECIFIC REGISTRATION (Curated Event, Exhibition, and
   plain sub-event opt-ins under an Umbrella Event — also used directly for
   a STANDALONE top-level Curated Event/Exhibition event, in which case the
   "entity" is the event itself, i.e. subEventId === eventId).
   ========================================================================= */

// RegistrationID is a trailing, additive column (see registrationsHeaders_
// note above — same reasoning: Orders needs a stable FK back to whichever
// row generated it).
function subEventRegHeaders_() {
  return ['Timestamp', 'EventID', 'SubEventID', 'Email', 'FullName', 'EventType', 'OptionId', 'OptionLabel', 'Status', 'Rank', 'ExtraFields', 'CompanyName', 'RegistrationID'];
}

function getSubEventRegSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(SUBEVENT_REG_SHEET_NAME) || ss.insertSheet(SUBEVENT_REG_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.appendRow(subEventRegHeaders_());
  } else {
    ensureHeadersFresh_(s, subEventRegHeaders_(), 'headers_checked_subeventreg');
  }
  return s;
}

function getSubEventRegsRaw_() {
  if (_rawDataCache_.subEventRegs) return _rawDataCache_.subEventRegs;
  const sheet = getSubEventRegSheet_();
  if (sheet.getLastRow() <= 1) { _rawDataCache_.subEventRegs = []; return []; }
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    out.push({
      timestamp: row[0] instanceof Date ? row[0].toLocaleString() : String(row[0] || ''),
      eventId: String(row[1] || ''),
      subEventId: String(row[2] || ''),
      email: String(row[3] || '').trim().toLowerCase(),
      fullName: String(row[4] || ''),
      eventType: String(row[5] || ''),
      optionId: String(row[6] || ''),
      optionLabel: String(row[7] || ''),
      status: String(row[8] || ''),
      rank: row[9] === '' ? null : Number(row[9]),
      extraFields: (function() { try { return JSON.parse(row[10] || '{}') || {}; } catch (e) { return {}; } })(),
      companyName: String(row[11] || ''),
      registrationId: String(row[12] || '')
    });
  }
  _rawDataCache_.subEventRegs = out;
  return out;
}

/**
 * Complete live floor plan state for an Exhibition entity (top-level event
 * OR sub-event), sourced from the FloorPlanElements sheet (the admin
 * drag-and-drop floor plan builder) instead of the retired TypeConfig JSON
 * blob. Returns BOTH bookable booths (`tables`) and static/non-bookable
 * elements (`decor`) from a SINGLE pass over the entity's elements —
 * previously this required two separate functions
 * (getExhibitionLiveState_ + getFloorPlanDecorElements_), each filtering
 * the full FloorPlanElements read independently. Merged here per the
 * performance pass (see file header) so every caller gets both halves for
 * the cost of one filter/partition instead of two.
 *
 * Only elements with Type "booth" are bookable — each can only be booked
 * once. A booth tagged with an AssetTypeId (see FloorPlanElements schema
 * note above) prices at that Asset Type's own Price (from the Exhibition's
 * TypeConfig — see normalizeExhibitionAssetTypes_); any other booth falls
 * back to the Exhibition's single flat event-level Price (see
 * getEventPrice_/getEventCurrency_), exactly as every booth priced before
 * Asset Types existed.
 *
 * Returns { tables: [...], decor: [...] }.
 */
function getExhibitionCompleteState_(entity) {
  const allElements = getFloorPlanElementsRaw_().filter(r => r.eventId === entity.eventId);
  const regs = getSubEventRegsRaw_().filter(r => r.subEventId === entity.eventId && r.status === 'Confirmed');
  const bookingByBooth = {};
  regs.forEach(r => { bookingByBooth[r.optionId] = r; });

  const flatPrice = getEventPrice_(entity);
  const currency = getEventCurrency_(entity);
  const assetTypesById = {};
  (entity.typeConfig || []).forEach(function(a) { assetTypesById[a.id] = a; });

  const tables = [];
  const decor = [];

  allElements.forEach(el => {
    if (el.type === 'booth') {
      const booking = bookingByBooth[el.elementId];
      const assetType = el.assetTypeId ? assetTypesById[el.assetTypeId] : null;
      tables.push({
        elementId: el.elementId,
        label: el.label,
        x: el.x, y: el.y, width: el.width, height: el.height,
        cssClass: el.cssClass,
        assetTypeId: el.assetTypeId || '',
        assetTypeLabel: assetType ? assetType.label : '',
        price: assetType ? assetType.price : flatPrice,
        currency: currency,
        status: booking ? 'Booked' : 'Available',
        companyName: booking ? (booking.companyName || '') : '',
        attendeeName: booking ? booking.fullName : ''
      });
    } else {
      decor.push({ elementId: el.elementId, label: el.label, x: el.x, y: el.y, width: el.width, height: el.height, type: el.type, cssClass: el.cssClass });
    }
  });

  return { tables, decor };
}

/**
 * Live, ranked options for a Curated Event OR B2B Pre-scheduled Meetings
 * entity (top-level event OR sub-event), sourced from its TypeConfig.
 * Returns null when the entity has NO options configured at all — the
 * caller should then fall back to the entity's own flat Price/Places (see
 * DECISION note at top of file). Going forward, both types always have at
 * least one option (see normalizeTypeConfig_'s mandatory-options
 * validation); a null return only happens for a legacy event saved before
 * that requirement existed.
 * Each option's Places is its OWN independent capacity (never conflated
 * with 0/full — see buildCapacityState_). For B2B, each option's `label`
 * is the Registration Type chosen for that price/capacity tier.
 */
function getCuratedEventOptionsLiveState_(entity) {
  const options = entity.typeConfig || [];
  if (!options.length) return null;

  const regs = getSubEventRegsRaw_().filter(r => r.subEventId === entity.eventId && r.status === 'Confirmed');
  const countByOption = {};
  regs.forEach(r => { countByOption[r.optionId] = (countByOption[r.optionId] || 0) + 1; });

  const currency = getEventCurrency_(entity);
  return options.map(opt => ({
    id: opt.id,
    label: opt.label,
    price: opt.price || 0,
    currency: currency,
    capacity: buildCapacityState_(opt.places, countByOption[opt.id] || 0),
    description: opt.description || ''
  }));
}

/**
 * True when an entity uses RANKED allocation (allocateChoice_) rather than
 * a plain, single opt-in (recordPlainSubEventOptIn_): Exhibition always
 * does; a Curated Event or B2B Pre-scheduled Meetings does whenever it has
 * at least one TypeConfig option configured — which, going forward, is
 * always (see normalizeTypeConfig_, which now requires it for both types).
 * The `typeConfig.length` guard is kept so a LEGACY event saved before
 * that requirement existed (empty TypeConfig already in the sheet) still
 * falls back to plain/flat behavior instead of breaking.
 */
function entityUsesRankedAllocation_(entity) {
  if (!entity) return false;
  if (entity.eventType === EVENT_TYPE_EXHIBITION) return true;
  if (entity.eventType === EVENT_TYPE_CURATED_EVENT || entity.eventType === EVENT_TYPE_B2B_MEETINGS) {
    return !!(entity.typeConfig && entity.typeConfig.length);
  }
  return false;
}

/**
 * Server endpoint used by the attendee portal to fetch (and re-fetch, e.g.
 * after a booking) the live state of any entity — whether that's a
 * standalone top-level event or a sub-event under an Umbrella Event.
 * entityId is either eventId (standalone) or the sub-event's own EventID.
 *
 * - "Exhibition" returns its live floor plan: bookable booths (`tables`),
 *   static decor elements (`decor`), and the fixed canvas size so the
 *   attendee-facing map renders at the same scale/positions the admin
 *   laid it out in.
 * - "Curated Event" or "B2B Pre-scheduled Meetings" WITH options
 *   configured returns those ranked options (`options`) instead — each
 *   with its own price/capacity. Going forward, both types always have
 *   at least one option (see normalizeTypeConfig_); the flat fallback
 *   below only still applies to a legacy event saved before that was
 *   required.
 * - Everything else (including a legacy "Curated Event"/"B2B" with no
 *   options configured) returns its event-level capacity state (Places/
 *   Unlimited) via getEventCapacityState_(), plus its price/currency.
 */
function getEntityLiveState(entityId) {
  const entity = getEventById_(entityId);
  if (!entity) throw new Error('Event not found.');
  if (entity.eventType === EVENT_TYPE_EXHIBITION) {
    const state = getExhibitionCompleteState_(entity);
    const canvasSize = getFloorPlanCanvasSize_(entity);
    return {
      eventType: EVENT_TYPE_EXHIBITION,
      tables: state.tables,
      decor: state.decor,
      canvasWidth: canvasSize.width,
      canvasHeight: canvasSize.height
    };
  }
  if (entity.eventType === EVENT_TYPE_CURATED_EVENT || entity.eventType === EVENT_TYPE_B2B_MEETINGS) {
    const options = getCuratedEventOptionsLiveState_(entity);
    if (options) {
      return {
        eventType: entity.eventType,
        options: options,
        currency: getEventCurrency_(entity),
        maxOptionsPerAttendee: entity.eventType === EVENT_TYPE_CURATED_EVENT ? entity.maxOptionsPerAttendee : 1
      };
    }
  }
  return {
    eventType: entity.eventType,
    capacity: getEventCapacityState_(entity),
    price: getEventPrice_(entity),
    currency: getEventCurrency_(entity)
  };
}

/**
 * Returns the sub-events of an Umbrella Event, each annotated with its own
 * live state: Exhibition floor plan, ranked Curated Event options (when
 * configured), or flat capacity/price/currency otherwise. Used to render
 * the sub-event selection cards during registration.
 */
function getUmbrellaChildren(eventId) {
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');
  if (event.eventType !== EVENT_TYPE_UMBRELLA) return [];

  // The parent (event) is already the currency source of truth for every
  // sub-event below (see getEventCurrency_) — resolve it ONCE here instead
  // of letting each sub-event re-derive it via getEventCurrency_(e), which
  // would otherwise call getEventById_(e.parentEventId) -> getAllEvents_()
  // once per sub-event.
  const parentCurrency = event.currencyRaw || DEFAULT_CURRENCY;

  return getAllEvents_()
    .filter(e => e.parentEventId === eventId && e.status !== 'Draft')
    .sort((a, b) => (a.eventDate + a.eventTime).localeCompare(b.eventDate + b.eventTime))
    .map(e => {
      const base = {
        eventId: e.eventId, eventName: e.eventName, description: e.description,
        eventDate: e.eventDate, eventTime: e.eventTime, location: e.location, eventType: e.eventType,
        extraFields: getExtraFieldsForType_(e.eventType),
        currency: parentCurrency
      };
      if (e.eventType === EVENT_TYPE_EXHIBITION) {
        const state = getExhibitionCompleteState_(e);
        const canvasSize = getFloorPlanCanvasSize_(e);
        base.tables = state.tables;
        base.decor = state.decor;
        base.canvasWidth = canvasSize.width;
        base.canvasHeight = canvasSize.height;
        base.price = getEventPrice_(e); // flat, per-booth — see EVENTTYPE-SPECIFIC REQUIREMENTS
      } else if ((e.eventType === EVENT_TYPE_CURATED_EVENT || e.eventType === EVENT_TYPE_B2B_MEETINGS) && getCuratedEventOptionsLiveState_(e)) {
        base.options = getCuratedEventOptionsLiveState_(e);
        // B2B is always a single pick (see allocateChoice_'s maxAllowed); only Curated Event's cap is admin-configurable.
        base.maxOptionsPerAttendee = e.eventType === EVENT_TYPE_CURATED_EVENT ? e.maxOptionsPerAttendee : 1;
      } else {
        base.price = getEventPrice_(e);
        base.capacity = getEventCapacityState_(e);
      }
      return base;
    });
}

/**
 * Merged, single-round-trip read powering the "My Events" panel: for a
 * given attendee + top-level event they're registered for, returns the
 * event's own info, and either its sub-events (Umbrella — each one this
 * attendee is actually Confirmed/Waitlisted for, per SubEventRegistrations)
 * or its own milestones directly (standalone) — each annotated with this
 * attendee's per-milestone completion status. Same "collapse several round
 * trips into one" reasoning as getRegistrationFormDefinition.
 */
function getMilestonesForAttendee(email, eventId) {
  const em = (email || '').trim().toLowerCase();
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  const result = {
    eventId: event.eventId,
    eventName: event.eventName,
    description: event.description,
    eventDate: event.eventDate,
    location: event.location,
    detailsPageUrl: event.detailsPageUrl,
    isUmbrella: event.isUmbrella
  };

  if (event.isUmbrella) {
    // Group this attendee's own SubEventRegistrations rows by subEventId —
    // a Curated Event with multiple selected options writes one row per
    // option, so a sub-event can have several rows here.
    const myRegsBySubEvent = {};
    getSubEventRegsRaw_().forEach(r => {
      if (r.eventId !== eventId || r.email !== em || r.status === 'Withdrawn') return;
      (myRegsBySubEvent[r.subEventId] || (myRegsBySubEvent[r.subEventId] = [])).push(r);
    });

    result.subEvents = getAllEvents_()
      .filter(e => e.parentEventId === eventId && myRegsBySubEvent[e.eventId])
      .sort((a, b) => (a.eventDate + a.eventTime).localeCompare(b.eventDate + b.eventTime))
      .map(e => {
        const regs = myRegsBySubEvent[e.eventId];
        return {
          eventId: e.eventId,
          eventName: e.eventName,
          description: e.description,
          eventDate: e.eventDate,
          eventTime: e.eventTime,
          location: e.location,
          eventType: e.eventType,
          detailsPageUrl: e.detailsPageUrl,
          registrationStatus: regs.some(r => r.status === 'Confirmed') ? 'Confirmed' : 'Waitlisted',
          milestones: getMilestonesForEntity_(e.eventId, em)
        };
      });
  } else {
    result.milestones = getMilestonesForEntity_(eventId, em);
  }

  return result;
}

/**
 * True when this attendee has submitted at least one Meeting Preferences
 * row for the given B2B entity (top-level event OR sub-event — see
 * initializePreferencesSession/savePreferences, which are keyed by
 * whichever entity's own id is passed to them). Used to derive
 * SetPreferences milestone completion dynamically, since preference-
 * setting already has its own persistence independent of milestone
 * tracking — there is no MilestoneCompletions row for this type.
 */
function hasSubmittedPreferences_(entityId, email) {
  const pref = getPreferencesRaw_();
  const eIdx = pref.idx['eventid'];
  const emailIdx = pref.idx['email'];
  if (eIdx === undefined || emailIdx === undefined) return false;
  const em = (email || '').trim().toLowerCase();
  return pref.rows.some(row => String(row[eIdx]) === String(entityId) && String(row[emailIdx]).trim().toLowerCase() === em);
}

/**
 * Shared helper: one entity's (top-level event OR sub-event) milestone
 * definitions, each annotated with this attendee's own completion status.
 */
function getMilestonesForEntity_(entityId, email) {
  return getMilestonesRaw_()
    .filter(m => m.eventId === entityId)
    .map(m => {
      if (m.milestoneType === MILESTONE_TYPE_SET_PREFERENCES) {
        const done = hasSubmittedPreferences_(entityId, email);
        return {
          milestoneId: m.milestoneId, title: m.title, description: m.description,
          milestoneType: m.milestoneType, dueDate: m.dueDate, config: m.config,
          status: done ? 'Completed' : 'Pending', completedDate: null, submissionData: null
        };
      }
      const completion = findMilestoneCompletion_(m.milestoneId, email);
      return {
        milestoneId: m.milestoneId,
        title: m.title,
        description: m.description,
        milestoneType: m.milestoneType,
        dueDate: m.dueDate,
        config: m.config,
        status: completion ? 'Completed' : 'Pending',
        completedDate: completion ? completion.completedDate : null,
        submissionData: completion ? completion.submissionData : null
      };
    });
}

/**
 * ConfirmInfo milestone: snapshots a FIXED subset of company fields
 * (MILESTONE_CONFIRM_INFO_FIELDS — not admin-configurable in v1) into this
 * milestone's own completion record. Deliberately does NOT call
 * saveProfile or touch the shared Membership Details directory — this is
 * an event-scoped confirmation, not a global profile edit.
 */
function completeConfirmInfoMilestone_(milestone, email, payload) {
  const submission = {};
  MILESTONE_CONFIRM_INFO_FIELDS.forEach(key => { submission[key] = String((payload && payload[key]) || '').trim(); });
  recordMilestoneCompletion_(milestone.eventId, milestone.milestoneId, email, submission);
  return { status: 'ok', milestoneId: milestone.milestoneId, submissionData: submission };
}

/**
 * Finds (or creates, on first use) the Drive folder for one event's
 * milestone uploads: a single root "Milestone Uploads" folder, with one
 * subfolder per event named "<EventName> (<EventID>)" so it's both
 * human-readable and collision-proof. Deliberately minimal/default — this
 * is expected to be refined once detailed Drive requirements land.
 */
function getOrCreateEventUploadFolder_(eventId, eventName) {
  const rootFolders = DriveApp.getFoldersByName(MILESTONE_UPLOAD_ROOT_FOLDER_NAME);
  const rootFolder = rootFolders.hasNext() ? rootFolders.next() : DriveApp.createFolder(MILESTONE_UPLOAD_ROOT_FOLDER_NAME);

  const folderName = (eventName || eventId) + ' (' + eventId + ')';
  const eventFolders = rootFolder.getFoldersByName(folderName);
  return eventFolders.hasNext() ? eventFolders.next() : rootFolder.createFolder(folderName);
}

/**
 * FileUpload milestone: decodes a base64 file payload from the client and
 * validates it SERVER-SIDE against this milestone's own Config (never
 * trust the client-side check alone — same principle as
 * normalizeFloorPlanElement_'s server-side re-validation elsewhere in this
 * file), then saves it into a per-event Drive folder.
 * payload: { base64, fileName, mimeType }
 */
function completeFileUploadMilestone_(milestone, email, payload) {
  const base64 = payload && payload.base64;
  const fileName = String((payload && payload.fileName) || '').trim();
  const mimeType = String((payload && payload.mimeType) || 'application/octet-stream').trim();
  if (!base64 || !fileName) throw new Error('Please choose a file to upload.');

  const config = milestone.config || {};
  const maxSizeMB = config.maxSizeMB || 10;
  const acceptedTypes = String(config.acceptedTypes || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

  const extension = (fileName.split('.').pop() || '').toLowerCase();
  if (acceptedTypes.length && acceptedTypes.indexOf(extension) === -1) {
    throw new Error('"' + extension + '" files are not accepted for this milestone. Accepted: ' + acceptedTypes.join(', ') + '.');
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (e) {
    throw new Error('The uploaded file could not be read. Please try again.');
  }
  const sizeMB = bytes.length / (1024 * 1024);
  if (sizeMB > maxSizeMB) {
    throw new Error('File is too large (' + sizeMB.toFixed(1) + 'MB). Maximum is ' + maxSizeMB + 'MB.');
  }

  const event = getEventById_(milestone.eventId);
  const folder = getOrCreateEventUploadFolder_(milestone.eventId, event ? event.eventName : milestone.eventId);
  const blob = Utilities.newBlob(bytes, mimeType, email + '_' + milestone.title + '_' + new Date().getTime() + '.' + extension);
  const file = folder.createFile(blob);

  const submission = { driveFileId: file.getId(), fileName: fileName, driveUrl: file.getUrl(), mimeType: mimeType };
  recordMilestoneCompletion_(milestone.eventId, milestone.milestoneId, email, submission);
  return { status: 'ok', milestoneId: milestone.milestoneId, submissionData: submission };
}

/**
 * Dispatch table for completeMilestone — the extensibility point for a new
 * MilestoneType. Adding a third type means adding one more entry here
 * (plus its own admin-config UI and client-side action widget); nothing
 * else in the read paths needs to change.
 */
const MILESTONE_COMPLETION_HANDLERS_ = {
  [MILESTONE_TYPE_CONFIRM_INFO]: completeConfirmInfoMilestone_,
  [MILESTONE_TYPE_FILE_UPLOAD]: completeFileUploadMilestone_
};

/**
 * Attendee-facing single entry point for completing ANY milestone —
 * dispatches on the milestone's OWN stored MilestoneType (looked up
 * server-side from milestoneId, never trusted from the client payload) to
 * the matching handler above.
 * payload: { email, milestoneId, ...type-specific fields — see
 *            completeConfirmInfoMilestone_ / completeFileUploadMilestone_ }
 */
function completeMilestone(payload) {
  const email = ((payload && payload.email) || '').trim().toLowerCase();
  const milestoneId = (payload && payload.milestoneId) || '';
  if (!email || !milestoneId) throw new Error('Missing email or milestone.');

  const milestone = getMilestonesRaw_().find(m => m.milestoneId === milestoneId);
  if (!milestone) throw new Error('Milestone not found.');

  const handler = MILESTONE_COMPLETION_HANDLERS_[milestone.milestoneType];
  if (!handler) throw new Error('Unsupported milestone type: ' + milestone.milestoneType);

  return handler(milestone, email, payload);
}

/**
 * Atomically allocates a ranked choice — an Exhibition booth OR a B2B
 * Pre-scheduled Meetings option — to an attendee, wrapped in LockService to
 * prevent capacity race conditions. Tries each rankedId in order; the first
 * one with a free slot wins. If none have room, the attendee is placed on
 * the waiting list against their #1 choice. Shared by both types: Exhibition
 * booths (keyed by floor plan elementId, sharing one flat event-level
 * price) and B2B options (keyed by option id, each with its own
 * price/capacity) normalize to the same { id, label, price, isFull }
 * shape before allocation.
 *
 * NOTE: Curated Event does NOT use this function — see
 * allocateCuratedEventSelections_ below, which registers an attendee for
 * EVERY option they select (independently confirmed/waitlisted) rather
 * than picking a single "best available" winner from a ranked list.
 *
 * rankedIds: array of booth elementIds or B2B option ids, in preference
 * order (max 3 for Exhibition, max 1 for B2B Pre-scheduled Meetings —
 * enforced client-side, and re-checked here since a request could
 * otherwise bypass that).
 */
function allocateChoice_(topEventId, entity, rankedIds, email, fullName, displayLabel, extraFields) {
  if (!rankedIds || !rankedIds.length) throw new Error('Please select at least one preference for ' + entity.eventName + '.');
  const maxAllowed = entity.eventType === EVENT_TYPE_B2B_MEETINGS ? 1 : 3;
  if (rankedIds.length > maxAllowed) throw new Error('Please select at most ' + maxAllowed + ' option' + (maxAllowed === 1 ? '' : 's') + ' for ' + entity.eventName + '.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Re-read fresh, inside the lock, so concurrent submissions can't both
    // see the same "available" slot.
    let liveOptions;
    if (entity.eventType === EVENT_TYPE_EXHIBITION) {
      liveOptions = getExhibitionCompleteState_(entity).tables.map(o => ({ id: o.elementId, label: o.label, price: o.price, isFull: o.status !== 'Available' }));
    } else {
      const curatedOptions = getCuratedEventOptionsLiveState_(entity) || [];
      liveOptions = curatedOptions.map(o => ({ id: o.id, label: o.label, price: o.price, isFull: !o.capacity.unlimited && o.capacity.isFull }));
    }

    const byId = {};
    liveOptions.forEach(o => { byId[o.id] = o; });

    let allocated = null;
    let allocatedRank = null;
    for (let i = 0; i < rankedIds.length; i++) {
      const opt = byId[String(rankedIds[i])];
      if (!opt) continue;
      if (!opt.isFull) { allocated = opt; allocatedRank = i + 1; break; }
    }

    const status = allocated ? 'Confirmed' : 'Waitlisted';
    const fallback = byId[String(rankedIds[0])] || {};
    const winner = allocated || fallback;
    const optionId = allocated ? allocated.id : (fallback.id || String(rankedIds[0]));
    const optionLabel = allocated ? allocated.label : (fallback.label || '');
    const optionPrice = winner.price || 0;
    const optionCurrency = getEventCurrency_(entity);
    const registrationId = mintId_('SER');

    getSubEventRegSheet_().appendRow([
      new Date(), topEventId, entity.eventId, email, fullName, entity.eventType,
      optionId, optionLabel, status, allocated ? allocatedRank : 1, JSON.stringify(extraFields || {}), displayLabel || '',
      registrationId
    ]);
    // Invalidate: a batch registration can call allocateChoice_ multiple
    // times in a row (one per attendee) within the SAME execution. Without
    // this, a second attendee's "fresh" read at the top of this function
    // would actually hit the memoized cache from BEFORE this write and
    // could see the booth/option as still available, causing a
    // double-allocation. This keeps the "always fresh inside the lock"
    // guarantee intact even with memoization turned on elsewhere.
    _rawDataCache_.subEventRegs = null;
    _rawDataCache_.confirmedSubEventCounts = null; // derived from subEventRegs — same staleness risk

    // Budget: only a CONFIRMED allocation is a real payable item — a
    // Waitlisted attendee hasn't actually claimed a paid slot yet.
    if (status === 'Confirmed') {
      recordOrder_(topEventId, entity.eventId, registrationId, email, fullName, displayLabel || '',
        optionPrice, optionCurrency, entity.eventName + (optionLabel ? ' — ' + optionLabel : ''));
    }

    return { subEventId: entity.eventId, subEventName: entity.eventName, eventType: entity.eventType, status: status, optionId: optionId, optionLabel: optionLabel, optionPrice: optionPrice, optionCurrency: optionCurrency, rank: allocated ? allocatedRank : null };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Registers an attendee for MULTIPLE Curated Event options in one go —
 * unlike allocateChoice_'s ranked-fallback model, there is no "preference
 * order" here and no single winner: every option the attendee selected
 * becomes its OWN registration row, independently confirmed or waitlisted
 * against that option's own capacity. By default an attendee may select as
 * many options as exist; an admin can cap this per-event via
 * entity.maxOptionsPerAttendee (null = unlimited).
 *
 * optionIds: array of Curated Event option ids the attendee selected
 * (order irrelevant; duplicates are ignored).
 */
function allocateCuratedEventSelections_(topEventId, entity, optionIds, email, fullName, displayLabel, extraFields) {
  const ids = Array.from(new Set((optionIds || []).map(String)));
  if (!ids.length) throw new Error('Please select at least one option for ' + entity.eventName + '.');
  const maxAllowed = entity.maxOptionsPerAttendee;
  if (maxAllowed != null && ids.length > maxAllowed) {
    throw new Error('You can select at most ' + maxAllowed + ' option' + (maxAllowed === 1 ? '' : 's') + ' for ' + entity.eventName + '.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Re-read fresh, inside the lock, so concurrent submissions can't both
    // see the same "available" slot (same reasoning as allocateChoice_).
    const liveOptions = getCuratedEventOptionsLiveState_(entity) || [];
    const byId = {};
    liveOptions.forEach(o => { byId[o.id] = o; });

    const results = ids.map(id => {
      const opt = byId[id];
      const isFull = opt ? (!opt.capacity.unlimited && opt.capacity.isFull) : false;
      const status = (opt && !isFull) ? 'Confirmed' : 'Waitlisted';
      const optionLabel = opt ? opt.label : '';
      const optionPrice = opt ? (opt.price || 0) : 0;
      const optionCurrency = getEventCurrency_(entity);
      const registrationId = mintId_('SER');

      getSubEventRegSheet_().appendRow([
        new Date(), topEventId, entity.eventId, email, fullName, entity.eventType,
        id, optionLabel, status, '', JSON.stringify(extraFields || {}), displayLabel || '',
        registrationId
      ]);

      // Budget: only a CONFIRMED selection is a real payable item.
      if (status === 'Confirmed') {
        recordOrder_(topEventId, entity.eventId, registrationId, email, fullName, displayLabel || '',
          optionPrice, optionCurrency, entity.eventName + (optionLabel ? ' — ' + optionLabel : ''));
      }

      return { subEventId: entity.eventId, subEventName: entity.eventName, eventType: entity.eventType, status: status, optionId: id, optionLabel: optionLabel, optionPrice: optionPrice, optionCurrency: optionCurrency, rank: null };
    });

    // Invalidate: see allocateChoice_'s identical note — a batch
    // registration can call this multiple times in a row (one per
    // attendee) within the SAME execution, so the memoized cache must not
    // outlive these writes.
    _rawDataCache_.subEventRegs = null;
    _rawDataCache_.confirmedSubEventCounts = null;

    return results;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Records a simple (non-allocated) opt-in into a plain sub-event under an
 * Umbrella Event — this covers "Curated Event" sub-events that have NO
 * TypeConfig options configured (see DECISION note at top of file), which
 * carry a flat event-level price/capacity rather than per-option
 * allocation. Enforces capacity (if limited) before recording; throws if
 * the sub-event is full so the caller can surface a clear error.
 */
function recordPlainSubEventOptIn_(topEventId, subEvent, email, fullName, extraFields) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const capacityState = getEventCapacityState_(subEvent);
    if (!capacityState.unlimited && capacityState.isFull) {
      throw new Error('"' + subEvent.eventName + '" is full (' + capacityState.label + ').');
    }
    const optionPrice = getEventPrice_(subEvent);
    const optionCurrency = getEventCurrency_(subEvent);
    const registrationId = mintId_('SER');
    getSubEventRegSheet_().appendRow([new Date(), topEventId, subEvent.eventId, email, fullName, subEvent.eventType || '', '', '', 'Confirmed', '', JSON.stringify(extraFields || {}), '', registrationId]);
    _rawDataCache_.subEventRegs = null; // invalidate — see allocateChoice_ for why this matters within a batch loop
    _rawDataCache_.confirmedSubEventCounts = null; // derived from subEventRegs — same staleness risk

    // Budget: a non-zero-price plain opt-in is a payable item.
    recordOrder_(topEventId, subEvent.eventId, registrationId, email, fullName, '',
      optionPrice, optionCurrency, subEvent.eventName);

    return {
      subEventId: subEvent.eventId, subEventName: subEvent.eventName, eventType: subEvent.eventType,
      status: 'Confirmed', optionId: '', optionLabel: '', rank: null,
      optionPrice: optionPrice, optionCurrency: optionCurrency
    };
  } finally {
    lock.releaseLock();
  }
}

/* ---- ADMIN: My Events page ---- */
function getAdminEventsTree(token) {
  requireAdmin_(token);
  const events = getAllEvents_();
  const topLevel = events.filter(e => !e.parentEventId);
  const registrationCounts = getRegistrationCountMap_();

  // The flat event-level capacity badge is only meaningful when the
  // event ISN'T using Exhibition's floor plan or a Curated Event's/B2B's
  // per-option capacity — those show their own capacity per booth/option
  // in the admin allocation view instead.
  const usesEntityLevelCapacity = e => !(e.eventType === EVENT_TYPE_EXHIBITION ||
    ((e.eventType === EVENT_TYPE_CURATED_EVENT || e.eventType === EVENT_TYPE_B2B_MEETINGS) && e.typeConfig && e.typeConfig.length));

  // Plain milestone definitions (no per-attendee completion status — this
  // is the admin's edit view, not getMilestonesForEntity_'s attendee-
  // facing shape) for a given entity, ready for addMilestoneRow() to
  // repopulate when the admin reopens the Edit Event modal.
  const milestonesForEntity = entityId => getMilestonesRaw_()
    .filter(m => m.eventId === entityId)
    .map(m => ({ milestoneId: m.milestoneId, title: m.title, description: m.description, dueDate: m.dueDate, milestoneType: m.milestoneType, config: m.config }));

  return topLevel.map(parent => {
    const currency = getEventCurrency_(parent);
    const subEvents = events.filter(e => e.parentEventId === parent.eventId).map(e => Object.assign({}, e, {
      effectiveCurrency: currency,
      capacityState: usesEntityLevelCapacity(e) ? getEventCapacityState_(e) : null,
      milestones: milestonesForEntity(e.eventId)
    }));
    return Object.assign({}, parent, {
      totalRegistrations: registrationCounts[parent.eventId] || 0,
      effectiveCurrency: currency,
      capacityState: (parent.isUmbrella || !usesEntityLevelCapacity(parent)) ? null : getEventCapacityState_(parent),
      milestones: milestonesForEntity(parent.eventId),
      subEvents: subEvents
    });
  });
}

function getEventTypesAndRegTypes(token) {
  requireAdmin_(token);
  return getOnboardingData_();
}

/** Used by AdminPortal to populate the Event Type dropdown (top-level vs sub-event lists differ). */
function getEventTypeOptions(token) {
  requireAdmin_(token);
  return getEventTypeOptions_();
}

const ONBOARDING_CACHE_KEY_ = 'onboarding_v1';

/**
 * ClientOnboarding is only ever edited directly on the sheet (there's no
 * in-app UI for it), so a short cross-request TTL is a safe trade-off —
 * there's no write path in this file to pair an explicit invalidation
 * with, unlike getAllEvents_/getFloorPlanElementsRaw_ above.
 */
function getOnboardingData_() {
  if (_rawDataCache_.onboarding) return _rawDataCache_.onboarding;
  const cached = getCrossRequestCache_(ONBOARDING_CACHE_KEY_);
  if (cached) { _rawDataCache_.onboarding = cached; return cached; }

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(ONBOARDING_SHEET_NAME);
  const result = {}; // { eventType: { isB2B: bool, registrationTypes: [] } }

  if (!sheet || sheet.getLastRow() <= 1) {
    _rawDataCache_.onboarding = result;
    putCrossRequestCache_(ONBOARDING_CACHE_KEY_, result);
    return result;
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const typeIdx = headers.indexOf('eventtype') !== -1 ? headers.indexOf('eventtype') : headers.indexOf('event type');
  const regIdx = headers.indexOf('registrationtype') !== -1 ? headers.indexOf('registrationtype') : headers.indexOf('registration type');
  const b2bIdx = headers.indexOf('isb2b');

  for (let i = 1; i < data.length; i++) {
    const type = normalizeEventType_(data[i][typeIdx]);
    const regType = String(data[i][regIdx] || '').trim();
    const isB2B = b2bIdx !== -1 && (data[i][b2bIdx] === true || String(data[i][b2bIdx]).toUpperCase() === 'TRUE');
    if (!type) continue;
    if (!result[type]) result[type] = { isB2B: isB2B, registrationTypes: [] };
    if (isB2B) result[type].isB2B = true;
    if (regType && result[type].registrationTypes.indexOf(regType) === -1) result[type].registrationTypes.push(regType);
  }
  _rawDataCache_.onboarding = result;
  putCrossRequestCache_(ONBOARDING_CACHE_KEY_, result);
  return result;
}

/**
 * Full list of EventType options for the admin "Event Type" dropdown,
 * split by whether they're valid at the top level (includes the reserved
 * "Umbrella Event") or on a sub-event (onboarding-defined types only —
 * "Umbrella Event" is not a legal sub-event type).
 */
function getEventTypeOptions_() {
  const onboarding = getOnboardingData_();
  const dynamicTypes = Object.keys(onboarding);
  return {
    topLevelTypes: dynamicTypes.concat([EVENT_TYPE_UMBRELLA]),
    subEventTypes: dynamicTypes.slice()
  };
}

/**
 * Validates and normalizes the TypeConfig payload for a given EventType.
 * Returns a JSON string ready to store in the Events sheet.
 *
 *  - "Curated Event": an OPTIONAL array of ranked options — each
 *    { id, label, price, places }. `places` is normalized via
 *    parsePlaces_() to either null (Unlimited) or a non-negative integer
 *    — NEVER stored as 0-meaning-unlimited. An empty array is valid and
 *    means "no options configured" — the event falls back to its own
 *    flat Price/Places columns (see getCuratedEventOptionsLiveState_,
 *    which returns null in that case to signal the fallback).
 *  - "Exhibition": an OPTIONAL array of Asset Types — each { id, label,
 *    price } — used to tier-price bookable floor plan elements (a
 *    "Premium Booth" vs. a "Standard Booth", etc.). The booths/amenities/
 *    landmarks THEMSELVES still live in the FloorPlanElements sheet
 *    (admin Floor Plan Designer), not here — each bookable element merely
 *    references one of these Asset Type ids (FloorPlanElements.AssetTypeId)
 *    to pick up its price. An empty array is valid and means "no Asset
 *    Types configured" — every booth then falls back to the event's own
 *    flat Price (see getExhibitionCompleteState_), same fallback shape
 *    Curated Event uses when it has no options configured.
 *  - Everything else: always '[]'.
 */
/**
 * Builds & validates the TypeConfig JSON for an event.
 *
 * As of this update, "Curated Event" and "B2B Pre-scheduled Meetings" BOTH
 * require at least one option — each with its own Price and Places — and
 * no longer fall back to the flat event-level Price/Places when the list
 * is empty. This function is where that requirement is enforced
 * server-side (see createOrUpdateEvent, which calls this before writing
 * anything), so it can't be bypassed even if the admin form's client-side
 * check is skipped or stale.
 *
 * For "B2B Pre-scheduled Meetings" specifically, each option's `label` IS
 * the Registration Type (selected via dropdown on the admin form, sourced
 * from the ClientOnboarding sheet's RegistrationType column for that
 * EventType) rather than free text — so it's additionally validated
 * against that list here, the same source of truth the dropdown itself is
 * populated from.
 *
 * NOTE on existing data: an event saved BEFORE this change may still have
 * an empty TypeConfig in the sheet. That's left untouched by this
 * function (it only runs when the event is actively being created or
 * re-saved) — the rest of the codebase (see entityUsesRankedAllocation_,
 * getEntityLiveState, etc.) still knows how to gracefully fall back to
 * flat Price/Places for those legacy rows. The MOMENT such an event is
 * next saved through the admin form, though, this validation kicks in and
 * the admin will need to add at least one option to save it.
 */
function normalizeTypeConfig_(eventType, rawConfig) {
  if (eventType === EVENT_TYPE_EXHIBITION) return normalizeExhibitionAssetTypes_(rawConfig);

  const usesOptions = eventType === EVENT_TYPE_CURATED_EVENT || eventType === EVENT_TYPE_B2B_MEETINGS;
  if (!usesOptions) return '[]';

  const list = Array.isArray(rawConfig) ? rawConfig : [];
  const b2bOnboarding = eventType === EVENT_TYPE_B2B_MEETINGS ? getOnboardingData_()[EVENT_TYPE_B2B_MEETINGS] : null;
  const validRegTypes = b2bOnboarding ? b2bOnboarding.registrationTypes : null;

  const out = list.map((o, idx) => {
    const label = String((o && o.label) || '').trim();
    if (!label) {
      throw new Error(eventType === EVENT_TYPE_B2B_MEETINGS
        ? 'Every pricing option needs a Registration Type selected.'
        : 'Every Curated Event option needs a name.');
    }
    if (validRegTypes && validRegTypes.indexOf(label) === -1) {
      throw new Error('"' + label + '" is not a Registration Type configured for B2B Pre-scheduled Meetings in ClientOnboarding.');
    }
    const priceRaw = o && o.price;
    if (priceRaw === '' || priceRaw === null || priceRaw === undefined || isNaN(Number(priceRaw))) {
      throw new Error('Please enter a price for option "' + label + '".');
    }
    const price = Math.max(0, Number(priceRaw));
    const places = parsePlaces_(o && o.places); // null = Unlimited
    return {
      id: String((o && o.id) || '').trim() || ('opt' + (idx + 1)),
      label: label,
      price: price,
      places: places,
      description: String((o && o.description) || '').trim()
    };
  });

  if (!out.length) {
    throw new Error(eventType === EVENT_TYPE_B2B_MEETINGS
      ? 'At least one pricing option (with its own price and capacity) is required for a B2B Pre-scheduled Meetings event.'
      : 'At least one pricing option (with its own price and capacity) is required for a Curated Event.');
  }

  const seen = new Set();
  out.forEach(o => {
    if (seen.has(o.id)) throw new Error('Duplicate option ID: ' + o.id);
    seen.add(o.id);
  });

  return JSON.stringify(out);
}

/**
 * Exhibition's TypeConfig: an OPTIONAL array of Asset Types — each
 * { id, label, price } — that bookable floor plan elements (booths) can
 * reference by id (FloorPlanElements.AssetTypeId) to pick up a tiered
 * price instead of the event's single flat Price. Unlike Curated
 * Event/B2B options, this is NOT required — an Exhibition with no Asset
 * Types configured just prices every booth at the flat event-level Price,
 * exactly as before this feature existed (see getExhibitionCompleteState_).
 */
function normalizeExhibitionAssetTypes_(rawConfig) {
  const list = Array.isArray(rawConfig) ? rawConfig : [];

  const out = list.map((o, idx) => {
    const label = String((o && o.label) || '').trim();
    if (!label) throw new Error('Every Asset Type needs a label.');
    const priceRaw = o && o.price;
    if (priceRaw === '' || priceRaw === null || priceRaw === undefined || isNaN(Number(priceRaw))) {
      throw new Error('Please enter a price for Asset Type "' + label + '".');
    }
    const price = Math.max(0, Number(priceRaw));
    return {
      id: String((o && o.id) || '').trim() || ('asset' + (idx + 1)),
      label: label,
      price: price
    };
  });

  const seen = new Set();
  out.forEach(o => {
    if (seen.has(o.id)) throw new Error('Duplicate Asset Type ID: ' + o.id);
    seen.add(o.id);
  });

  return JSON.stringify(out);
}

/**
 * Maps each header name in the Events sheet's ACTUAL header row to its
 * real 1-based column number. This is the single source of truth
 * createOrUpdateEvent uses to know where to write each field.
 *
 * WHY THIS EXISTS: migrateSheetHeaders_ intentionally appends any missing
 * header at the sheet's current last column, and NEVER reorders existing
 * columns (see its own doc comment). That means a production sheet that
 * picked up e.g. Currency/TypeConfig/Places across several migrations
 * over time can easily have them sitting at DIFFERENT physical column
 * numbers than their position in the eventsHeaders_() array — a
 * brand-new sheet's columns happen to line up with that array only by
 * coincidence (because appendRow(eventsHeaders_()) wrote them in that
 * exact order on day one).
 *
 * Reads already handle this correctly: rowToEventObj_ builds `obj` by
 * header NAME (`headers.forEach((h, idx) => { obj[h] = row[idx]; })`),
 * so it always finds the right cell no matter its column position.
 * Writes previously used hardcoded column numbers (getRange(rowNum, 18)
 * for Currency, etc.) which silently assumed the canonical order — on
 * any sheet where that assumption doesn't hold, a "Currency" write could
 * land in the Places column, or a "Places" write into Currency, etc.,
 * which is exactly the failure mode behind currency/EventType not
 * persisting correctly. This map makes every write name-based instead,
 * eliminating that entire class of bug.
 */
function getEventsColumnIndex_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const map = {};
  headers.forEach((h, idx) => { map[h] = idx + 1; }); // 1-based, ready for getRange(row, map.X)
  eventsHeaders_().forEach(h => {
    if (!map[h]) throw new Error('Events sheet is missing expected column "' + h + '". Re-run setup or check the header row.');
  });
  return map;
}

/**
 * Create or update an Event or Sub-Event.
 *
 * Registration is always INITIATED at the top-level Event. A top-level
 * Event's own EventType is REQUIRED and drives everything: if it's
 * "Umbrella Event" the event must rely entirely on its sub-events (each of
 * which then carries its OWN mandatory EventType, drawn from
 * ClientOnboarding); otherwise the top-level EventType applies directly and
 * the event cannot carry sub-events. IsB2B / DietaryRequirements /
 * DetailsPageUrl remain top-level-only fields, as does Currency (see
 * CURRENCY note at top of file). Price and Places, however, are now
 * accepted on ANY row (top-level or sub-event) — e.g. a "Curated Event"
 * sub-event under an Umbrella Event can define its own price/capacity.
 * TypeConfig (Exhibition tables only, now) is populated on whichever row
 * — top-level or sub-event — actually carries that EventType.
 *
 * payload: { eventId (blank = new), parentEventId, eventName, description,
 *            eventDate, eventTime, location, website, status, eventType,
 *            dietaryRequirements, detailsPageUrl, price, places, currency
 *            (top-level only), typeConfig, maxOptionsPerAttendee (Curated
 *            Event only), milestones }
 * "places": '' / 'Unlimited' / a non-negative integer (see parsePlaces_).
 * "maxOptionsPerAttendee": '' (unlimited, default) or a positive integer —
 * caps how many Curated Event options one attendee may select; ignored
 * (stored blank) for every other EventType. Parsed the same way as
 * "places" (see parsePlaces_) since both are "blank = unlimited" counts.
 * "milestones": [{ milestoneId (blank = new), title, description, dueDate,
 *            milestoneType, config }] — applies to ANY row (top-level or
 *            sub-event), independent of EventType. Saved via
 *            saveMilestonesForEntity_ as a separate step once the event
 *            row itself is committed (see below) — a full replace of this
 *            entity's milestone list, same shape as TypeConfig's options.
 */
function createOrUpdateEvent(token, payload) {
  const adminEmail = requireAdmin_(token);
  if (!payload || !payload.eventName) throw new Error('Event Name is required.');

  const eventType = normalizeEventType_(payload.eventType);
  const isTopLevel = !payload.parentEventId;
  let isB2B = false;
  let parentEvent = null;

  if (isTopLevel) {
    if (!eventType) throw new Error('Please select an Event Type.');
    if (eventType !== EVENT_TYPE_UMBRELLA) {
      const onboarding = getOnboardingData_();
      isB2B = !!(onboarding[eventType] && onboarding[eventType].isB2B);
    }
  } else {
    parentEvent = getEventById_(payload.parentEventId);
    if (!parentEvent) throw new Error('Parent event not found.');
    if (parentEvent.eventType !== EVENT_TYPE_UMBRELLA) {
      throw new Error('Sub-events can only be added under an "Umbrella Event". Set the parent Event\'s Type to "Umbrella Event" first.');
    }
    if (!eventType) throw new Error('Please select an Event Type for this sub-event.');
    if (eventType === EVENT_TYPE_UMBRELLA) throw new Error('A sub-event cannot itself be an Umbrella Event.');
    const onboarding = getOnboardingData_();
    if (!onboarding[eventType]) throw new Error('"' + eventType + '" is not a configured Event Type. Choose one from ClientOnboarding.');
  }

  const typeConfigJson = eventType ? normalizeTypeConfig_(eventType, payload.typeConfig) : '[]';
  const priceValue = Math.max(0, Number(payload.price) || 0);
  const placesRaw = (payload.places === undefined || payload.places === null) ? '' : String(payload.places).trim();
  // Round-trip through parsePlaces_ so an invalid value fails safe to
  // "Unlimited" rather than silently becoming 0/full, then re-serialize.
  const parsedPlaces = parsePlaces_(placesRaw);
  const placesToStore = parsedPlaces === null ? '' : String(parsedPlaces);

  // Only meaningful for Curated Event; stored blank (unlimited) for every other type regardless of what the client sent.
  const maxOptsRaw = (payload.maxOptionsPerAttendee === undefined || payload.maxOptionsPerAttendee === null) ? '' : String(payload.maxOptionsPerAttendee).trim();
  const parsedMaxOpts = eventType === EVENT_TYPE_CURATED_EVENT ? parsePlaces_(maxOptsRaw) : null;
  const maxOptsToStore = parsedMaxOpts === null ? '' : String(parsedMaxOpts);

  // Only meaningful for Exhibition; stored blank for every other type regardless of what the client sent (see normalizeFloorPlanSize_'s default when read back).
  const floorPlanSizeToStore = eventType === EVENT_TYPE_EXHIBITION ? normalizeFloorPlanSize_(payload.floorPlanSize) : '';

  const sheet = getEventsSheet_();
  const col = getEventsColumnIndex_(sheet); // header-name -> real column number (see doc comment above)
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  let resultEventId;
  try {
    const data = sheet.getDataRange().getValues();

    if (payload.eventId) {
      // Update existing
      const eventIdCol = col.EventID - 1; // 0-based, for indexing into `data` rows
      let found = false;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][eventIdCol]) === String(payload.eventId)) {
          const rowNum = i + 1;

          // Guard: a top-level event that has sub-events cannot be
          // switched away from "Umbrella Event".
          if (isTopLevel && eventType !== EVENT_TYPE_UMBRELLA) {
            const hasSubEvents = getAllEvents_().some(e => e.parentEventId === String(payload.eventId));
            if (hasSubEvents) throw new Error('This event has sub-events, so its Event Type must remain "Umbrella Event". Remove the sub-events first if you want to change it.');
          }

          sheet.getRange(rowNum, col.EventName).setValue(payload.eventName || '');
          sheet.getRange(rowNum, col.Description).setValue(payload.description || '');
          sheet.getRange(rowNum, col.EventDate).setValue(payload.eventDate || '');
          sheet.getRange(rowNum, col.EventTime).setValue(payload.eventTime || '');
          sheet.getRange(rowNum, col.Location).setValue(payload.location || '');
          sheet.getRange(rowNum, col.Website).setValue(payload.website || '');
          sheet.getRange(rowNum, col.Status).setValue(payload.status || 'Draft');
          // EventType + TypeConfig apply to whichever row carries them —
          // top-level always, sub-event only under an Umbrella Event.
          sheet.getRange(rowNum, col.EventType).setValue(eventType || '');
          sheet.getRange(rowNum, col.TypeConfig).setValue(typeConfigJson);
          // Price/Places now apply on ANY row.
          sheet.getRange(rowNum, col.Price).setValue(priceValue);
          sheet.getRange(rowNum, col.Places).setValue(placesToStore);
          sheet.getRange(rowNum, col.MaxOptionsPerAttendee).setValue(maxOptsToStore);
          sheet.getRange(rowNum, col.FloorPlanSize).setValue(floorPlanSizeToStore);
          if (isTopLevel) {
            sheet.getRange(rowNum, col.IsB2B).setValue(isB2B);
            sheet.getRange(rowNum, col.DietaryRequirements).setValue(!!payload.dietaryRequirements);
            sheet.getRange(rowNum, col.DetailsPageUrl).setValue(payload.detailsPageUrl || '');
            sheet.getRange(rowNum, col.Currency).setValue(String(payload.currency || '').trim().toUpperCase());
          }
          _rawDataCache_.events = null; // invalidate: this execution's cached Events read is now stale
          invalidateCrossRequestCache_(EVENTS_CACHE_KEY_); // and the cross-request cache other executions may still be serving
          resultEventId = payload.eventId;
          found = true;
          break;
        }
      }
      if (!found) throw new Error('Event not found for update.');
    } else {
      // Create new — build the row by NAME, sized to the sheet's actual
      // column count, so a value only ever lands under its own header no
      // matter what order those headers ended up in (see
      // getEventsColumnIndex_ doc comment).
      const newId = 'EVT-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
      const valuesByName = {
        EventID: newId,
        ParentEventID: payload.parentEventId || '',
        EventName: payload.eventName || '',
        Description: payload.description || '',
        EventDate: payload.eventDate || '',
        EventTime: payload.eventTime || '',
        Location: payload.location || '',
        Website: payload.website || '',
        Status: payload.status || 'Draft',
        EventType: eventType || '',
        IsB2B: isTopLevel ? isB2B : false,
        DietaryRequirements: isTopLevel ? !!payload.dietaryRequirements : false,
        CreatedDate: new Date(),
        CreatedBy: adminEmail,
        DetailsPageUrl: isTopLevel ? (payload.detailsPageUrl || '') : '',
        Price: priceValue,
        TypeConfig: typeConfigJson,
        Currency: isTopLevel ? String(payload.currency || '').trim().toUpperCase() : '',
        Places: placesToStore,
        MaxOptionsPerAttendee: maxOptsToStore,
        FloorPlanSize: floorPlanSizeToStore
      };
      const lastCol = sheet.getLastColumn();
      const row = new Array(lastCol).fill('');
      Object.keys(valuesByName).forEach(name => { row[col[name] - 1] = valuesByName[name]; });
      sheet.appendRow(row);
      _rawDataCache_.events = null; // invalidate: this execution's cached Events read is now stale
      invalidateCrossRequestCache_(EVENTS_CACHE_KEY_); // and the cross-request cache other executions may still be serving
      resultEventId = newId;
    }
  } finally {
    lock.releaseLock();
  }

  // Milestones are saved as their own step, in their own lock, only after
  // the event row itself is safely committed and this lock is released —
  // see saveMilestonesForEntity_'s doc comment for why it isn't nested
  // inside the lock above.
  saveMilestonesForEntity_(resultEventId, payload.milestones, eventType);

  return { status: 'ok', eventId: resultEventId };
}

/* =========================================================================
   ADMIN DASHBOARD
   ========================================================================= */

function getExecutiveSummary(token) {
  requireAdmin_(token);
  const events = getAllEvents_();
  const topLevel = events.filter(e => !e.parentEventId);
  const subEvents = events.filter(e => e.parentEventId);
  const liveEvents = topLevel.filter(e => e.status === 'Live');
  const registrations = getRegistrationsRaw_();
  const companies = new Set(registrations.map(r => r.companyName.toLowerCase()).filter(Boolean));
  // Precomputed once (O(n)) instead of re-filtering the full registrations
  // array per top-level event below (was O(topLevel * registrations)) —
  // getAdminEventsTree already uses this same map for the same reason.
  const registrationCounts = getRegistrationCountMap_();

  return {
    totalEvents: topLevel.length,
    totalSubEvents: subEvents.length,
    liveEvents: liveEvents.length,
    totalRegistrations: registrations.length,
    totalCompanies: companies.size,
    events: topLevel.map(e => ({
      eventId: e.eventId,
      eventName: e.eventName,
      status: e.status,
      eventType: e.eventType,
      isB2B: e.isB2B,
      registrations: registrationCounts[e.eventId] || 0
    }))
  };
}

function getEventDashboardData(token, eventId) {
  requireAdmin_(token);
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  const registrations = getRegistrationsRaw_().filter(r => r.eventId === eventId);
  const companies = new Set(registrations.map(r => r.companyName.toLowerCase()).filter(Boolean));

  let daysUntil = 0;
  if (event.eventDate) {
    const d = new Date(event.eventDate);
    daysUntil = Math.max(0, Math.ceil((d - new Date()) / 86400000));
  }

  const byType = {};
  registrations.forEach(r => {
    const t = r.registrationType || 'Unspecified';
    byType[t] = (byType[t] || 0) + 1;
  });

  const last10 = registrations.slice(-10).reverse().map(r => ({
    timestamp: r.timestamp, fullName: r.fullName, companyName: r.companyName,
    email: r.email, registrationType: r.registrationType
  }));

  const base = {
    eventName: event.eventName,
    eventType: event.eventType,
    isB2B: event.isB2B,
    status: event.status,
    daysUntil: daysUntil,
    totalRegistrations: registrations.length,
    totalCompanies: companies.size,
    byRegistrationType: byType,
    last10: last10,
    milestones: getMilestoneCompletionSummary_(event)
  };

  if (event.isB2B) {
    base.preferences = getPreferencesDashboardData_(eventId, registrations);
  }
  return base;
}

/**
 * Admin-facing milestone completion report for one top-level event: for
 * every milestone defined on the event itself and on each of its
 * sub-events, returns completed/pending counts and a capped list of
 * pending attendees. "Eligible" for a milestone means registered for the
 * event (top-level milestones) or opted into that specific sub-event
 * (sub-event milestones) — Confirmed or Waitlisted both count, since a
 * milestone (e.g. an artwork upload) is typically still expected even if
 * someone's on a waiting list.
 */
function getMilestoneCompletionSummary_(event) {
  const eventId = event.eventId;
  const completedSet = new Set(getMilestoneCompletionsRaw_().map(c => c.milestoneId + '::' + c.email));

  function summarize(entityId, entityLabel, eligible) {
    return getMilestonesRaw_().filter(m => m.eventId === entityId).map(m => {
      // SetPreferences has no MilestoneCompletions row (see
      // hasSubmittedPreferences_'s doc comment) — completion is derived
      // from the Meeting Preferences sheet instead.
      const pending = m.milestoneType === MILESTONE_TYPE_SET_PREFERENCES
        ? eligible.filter(a => !hasSubmittedPreferences_(entityId, a.email))
        : eligible.filter(a => !completedSet.has(m.milestoneId + '::' + a.email));
      return {
        milestoneId: m.milestoneId,
        title: m.title,
        milestoneType: m.milestoneType,
        dueDate: m.dueDate,
        entityLabel: entityLabel,
        totalEligible: eligible.length,
        completedCount: eligible.length - pending.length,
        pending: pending.slice(0, 25).map(a => ({ fullName: a.fullName, email: a.email, companyName: a.companyName }))
      };
    });
  }

  const results = [];
  const topLevelAttendees = getRegistrationsRaw_()
    .filter(r => r.eventId === eventId)
    .map(r => ({ fullName: r.fullName, email: r.email, companyName: r.companyName }));
  results.push.apply(results, summarize(eventId, event.eventName, topLevelAttendees));

  if (event.isUmbrella) {
    // De-dupe by email: a Curated Event sub-event with multiple selected
    // options writes one SubEventRegistrations row per option, but an
    // attendee should only count once as "eligible" for that sub-event's
    // milestones.
    const subEventAttendeesById = {};
    getSubEventRegsRaw_().forEach(r => {
      if (r.eventId !== eventId || r.status === 'Withdrawn') return;
      const byEmail = subEventAttendeesById[r.subEventId] || (subEventAttendeesById[r.subEventId] = {});
      byEmail[r.email] = { fullName: r.fullName, email: r.email, companyName: r.companyName };
    });
    getAllEvents_().filter(e => e.parentEventId === eventId).forEach(sub => {
      const byEmail = subEventAttendeesById[sub.eventId] || {};
      const attendees = Object.keys(byEmail).map(email => byEmail[email]);
      results.push.apply(results, summarize(sub.eventId, sub.eventName, attendees));
    });
  }

  return results;
}

function getPreferencesDashboardData_(eventId, registrations) {
  const pref = getPreferencesRaw_();
  const eIdx = pref.idx['eventid'];
  const emailIdx = pref.idx['email'];

  // When eventId is blank we're in the combined "All Events" stakeholder
  // view — aggregate across every event's preference rows instead of
  // filtering to a single eventId.
  const submittedEmails = new Set();
  const countByEmail = {};
  if (eIdx !== undefined && emailIdx !== undefined) {
    pref.rows.forEach(row => {
      if (eventId && String(row[eIdx]) !== String(eventId)) return;
      const em = String(row[emailIdx]).trim().toLowerCase();
      submittedEmails.add(em);
      countByEmail[em] = (countByEmail[em] || 0) + 1;
    });
  }

  const totalAttendees = registrations.length;
  const submittedCount = registrations.filter(r => submittedEmails.has(r.email.toLowerCase())).length;

  const notSubmittedTop10 = registrations
    .filter(r => !submittedEmails.has(r.email.toLowerCase()))
    .slice(0, 10)
    .map(r => ({ fullName: r.fullName, email: r.email, companyName: r.companyName, registrationType: r.registrationType }));

  // Under-10%-threshold only makes sense within a single event's
  // registration-type pairing, so it's skipped entirely for the combined
  // "All Events" view (eventId blank).
  const underThresholdAttendees = [];
  const event = eventId ? getEventById_(eventId) : null;

  if (event) {
    const onboarding = getOnboardingData_();
    const regTypesForEvent = (onboarding[event.eventType] && onboarding[event.eventType].registrationTypes) || [];

    // Precomputed once (O(n)) instead of re-filtering the full
    // registrations array for every submitted attendee below (was
    // O(attendees * registrations) — quadratic in the registrant count).
    const countByRegType = {};
    registrations.forEach(r => { countByRegType[r.registrationType] = (countByRegType[r.registrationType] || 0) + 1; });

    registrations.forEach(r => {
      const email = r.email.toLowerCase();
      if (!submittedEmails.has(email)) return;
      const oppositeTypes = regTypesForEvent.filter(t => t !== r.registrationType);
      const totalEligible = oppositeTypes.reduce((sum, t) => sum + (countByRegType[t] || 0), 0);
      const requiredThreshold = Math.ceil(totalEligible * 0.10);
      const selectedCount = countByEmail[email] || 0;
      if (totalEligible > 0 && selectedCount < requiredThreshold) {
        underThresholdAttendees.push({
          fullName: r.fullName, email: r.email, companyName: r.companyName,
          selectedCount: selectedCount, requiredThreshold: requiredThreshold, totalEligible: totalEligible
        });
      }
    });
  }

  return {
    totalAttendees: totalAttendees,
    submittedCount: submittedCount,
    notSubmittedTop10: notSubmittedTop10,
    underThresholdAttendees: underThresholdAttendees
  };
}

/**
 * Admin view of live capacity/floor-plan state plus the waiting list for a
 * given entity (top-level event or sub-event). Exhibition returns its
 * floor plan (unchanged); everything else (including Curated Event)
 * returns its event-level capacity/price/currency state.
 */
function getSubEventAllocationSummary(token, subEventId) {
  requireAdmin_(token);
  const entity = getEventById_(subEventId);
  if (!entity) throw new Error('Event not found.');

  const waitlisted = getSubEventRegsRaw_().filter(r => r.subEventId === subEventId && r.status === 'Waitlisted');
  const result = { eventType: entity.eventType, waitlist: waitlisted };

  if (entity.eventType === EVENT_TYPE_EXHIBITION) {
    const state = getExhibitionCompleteState_(entity);
    const canvasSize = getFloorPlanCanvasSize_(entity);
    result.tables = state.tables;
    result.decor = state.decor;
    result.canvasWidth = canvasSize.width;
    result.canvasHeight = canvasSize.height;
    result.price = getEventPrice_(entity);
    result.currency = getEventCurrency_(entity);
  } else if ((entity.eventType === EVENT_TYPE_CURATED_EVENT || entity.eventType === EVENT_TYPE_B2B_MEETINGS) && getCuratedEventOptionsLiveState_(entity)) {
    result.options = getCuratedEventOptionsLiveState_(entity);
    result.currency = getEventCurrency_(entity);
  } else {
    result.capacity = getEventCapacityState_(entity);
    result.price = getEventPrice_(entity);
    result.currency = getEventCurrency_(entity);
  }
  return result;
}

/* =========================================================================
   ADMIN: EXHIBITION FLOOR PLAN BUILDER (AdminFloorPlan.html)
   ----------------------------------------------------------------------
   Elements are stored one-row-per-element in FloorPlanElements, keyed by
   EventID (the Exhibition entity — top-level event OR sub-event — being
   laid out). This is purely an ADMIN-side layout editor: it does not
   read from or write to TypeConfig, Registrations, or SubEventRegistrations,
   and does not affect registration/pricing/allocation logic in any way.
   Sheet: FloorPlanElements  ElementID | EventID | X | Y | Width | Height |
                             Type | Label | CSSClass | AssetTypeId |
                             UpdatedDate
   (AssetTypeId is blank for decor and for plain/legacy booths — it only
   links a "booth" element to one of the Exhibition's own TypeConfig Asset
   Types, for tiered pricing — see getExhibitionCompleteState_.)
   ========================================================================= */

function getFloorPlanSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(FLOORPLAN_SHEET_NAME) || ss.insertSheet(FLOORPLAN_SHEET_NAME);
  const headers = ['ElementID', 'EventID', 'X', 'Y', 'Width', 'Height', 'Type', 'Label', 'CSSClass', 'AssetTypeId', 'UpdatedDate'];
  if (s.getLastRow() === 0) {
    s.appendRow(headers);
  } else {
    ensureHeadersFresh_(s, headers, 'headers_checked_floorplan');
  }
  return s;
}

const FLOORPLAN_CACHE_KEY_ = 'floorplan_v1';

/**
 * FloorPlanElements only changes via the admin Floor Plan Designer
 * (saveFloorPlanLayout, which busts FLOORPLAN_CACHE_KEY_ below) — cached
 * cross-request for the same reason as getAllEvents_ above.
 */
function getFloorPlanElementsRaw_() {
  if (_rawDataCache_.floorPlan) return _rawDataCache_.floorPlan;
  const cached = getCrossRequestCache_(FLOORPLAN_CACHE_KEY_);
  if (cached) { _rawDataCache_.floorPlan = cached; return cached; }

  const sheet = getFloorPlanSheet_();
  if (sheet.getLastRow() <= 1) {
    _rawDataCache_.floorPlan = [];
    putCrossRequestCache_(FLOORPLAN_CACHE_KEY_, []);
    return [];
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const idx = {
    elementId: headers.indexOf('elementid'),
    eventId: headers.indexOf('eventid'),
    x: headers.indexOf('x'),
    y: headers.indexOf('y'),
    width: headers.indexOf('width'),
    height: headers.indexOf('height'),
    type: headers.indexOf('type'),
    label: headers.indexOf('label'),
    cssClass: headers.indexOf('cssclass'),
    assetTypeId: headers.indexOf('assettypeid')
  };
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    out.push({
      elementId: String(row[idx.elementId] || ''),
      eventId: String(row[idx.eventId] || ''),
      x: Number(row[idx.x]) || 0,
      y: Number(row[idx.y]) || 0,
      width: Number(row[idx.width]) || 0,
      height: Number(row[idx.height]) || 0,
      type: String(row[idx.type] || ''),
      label: String(row[idx.label] || ''),
      cssClass: String(row[idx.cssClass] || ''),
      assetTypeId: idx.assetTypeId !== -1 ? String(row[idx.assetTypeId] || '') : ''
    });
  }
  _rawDataCache_.floorPlan = out;
  putCrossRequestCache_(FLOORPLAN_CACHE_KEY_, out);
  return out;
}

/** Snaps a coordinate/length to the fixed FLOORPLAN_GRID_SIZE step. */
function snapToFloorPlanGrid_(n) {
  return Math.round((Number(n) || 0) / FLOORPLAN_GRID_SIZE) * FLOORPLAN_GRID_SIZE;
}

/**
 * Validates and normalizes ONE raw element payload from the client into a
 * safe, grid-snapped, canvas-bounded record. Never trusts client-supplied
 * geometry as-is — re-snaps to the 20px grid and clamps to the entity's
 * OWN canvas size (canvasWidth/canvasHeight — see getFloorPlanCanvasSize_;
 * Exhibitions can now pick Small/Medium/Large) server-side, since a client
 * could send anything.
 */
function normalizeFloorPlanElement_(raw, idx, canvasWidth, canvasHeight) {
  if (!raw || typeof raw !== 'object') throw new Error('Element #' + (idx + 1) + ' is invalid.');

  const type = String(raw.type || '').trim();
  const label = String(raw.label || '').trim();
  if (!type) throw new Error('Element #' + (idx + 1) + ' ("' + label + '") is missing a Type.');
  if (!label) throw new Error('Element #' + (idx + 1) + ' is missing a Label.');

  let width = snapToFloorPlanGrid_(Number(raw.width));
  let height = snapToFloorPlanGrid_(Number(raw.height));
  width = Math.max(FLOORPLAN_GRID_SIZE, Math.min(width, canvasWidth));
  height = Math.max(FLOORPLAN_GRID_SIZE, Math.min(height, canvasHeight));

  let x = snapToFloorPlanGrid_(Number(raw.x));
  let y = snapToFloorPlanGrid_(Number(raw.y));
  x = Math.max(0, Math.min(x, canvasWidth - width));
  y = Math.max(0, Math.min(y, canvasHeight - height));

  return {
    elementId: String(raw.elementId || '').trim() || ('EL-' + new Date().getTime() + '-' + idx + '-' + Math.floor(Math.random() * 1000)),
    x: x, y: y, width: width, height: height,
    type: type, label: label,
    cssClass: String(raw.cssClass || '').trim(),
    assetTypeId: String(raw.assetTypeId || '').trim()
  };
}

/**
 * Bulk-saves the ENTIRE floor plan layout for one Exhibition entity
 * (top-level event or sub-event) in a single call — replaces every
 * existing element for that eventId with the new set atomically.
 * Called as: google.script.run.saveFloorPlanLayout(token, eventId, elements)
 *
 * elements: [{ elementId (blank = new), x, y, width, height, type, label,
 *              cssClass, assetTypeId (optional — links a "booth" to one of
 *              the Exhibition's own TypeConfig Asset Types for tiered
 *              pricing; blank = flat event-level price) }, ...]
 * Returns { status: 'ok', savedCount }.
 */
function saveFloorPlanLayout(token, eventId, elements) {
  requireAdmin_(token);
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');
  if (event.eventType !== EVENT_TYPE_EXHIBITION) {
    throw new Error('Floor plan layouts are only supported for "Exhibition" events.');
  }
  if (!Array.isArray(elements)) throw new Error('No floor plan elements provided.');

  const canvasSize = getFloorPlanCanvasSize_(event);
  const normalized = elements.map(function(el, idx) { return normalizeFloorPlanElement_(el, idx, canvasSize.width, canvasSize.height); });

  const seenIds = {};
  normalized.forEach(function(el) {
    if (seenIds[el.elementId]) throw new Error('Duplicate element ID in payload: ' + el.elementId);
    seenIds[el.elementId] = true;
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = getFloorPlanSheet_();
    const lastCol = sheet.getLastColumn();
    const existingRowCount = Math.max(0, sheet.getLastRow() - 1);
    const existingRows = existingRowCount > 0 ? sheet.getRange(2, 1, existingRowCount, lastCol).getValues() : [];
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const eventIdCol = headers.indexOf('EventID');
    // Name-indexed, not positional — a header appended by migrateSheetHeaders_
    // (e.g. AssetTypeId on an older sheet) lands at whatever column is
    // currently last, which may not match a hardcoded literal order. See
    // getEventsColumnIndex_'s doc comment for the exact failure mode this
    // avoids.
    const colIdx = {};
    headers.forEach(function(h, i) { colIdx[h] = i; });

    // Bulk replace: keep every row belonging to OTHER events untouched,
    // drop this event's old rows entirely, and append the freshly
    // normalized set — a full atomic replace for this eventId.
    const keptRows = existingRows.filter(function(row) { return String(row[eventIdCol]) !== String(eventId); });
    const timestamp = new Date();
    const newRows = normalized.map(function(el) {
      const row = new Array(lastCol).fill('');
      row[colIdx['ElementID']] = el.elementId;
      row[colIdx['EventID']] = eventId;
      row[colIdx['X']] = el.x;
      row[colIdx['Y']] = el.y;
      row[colIdx['Width']] = el.width;
      row[colIdx['Height']] = el.height;
      row[colIdx['Type']] = el.type;
      row[colIdx['Label']] = el.label;
      row[colIdx['CSSClass']] = el.cssClass;
      if (colIdx['AssetTypeId'] !== undefined) row[colIdx['AssetTypeId']] = el.assetTypeId;
      row[colIdx['UpdatedDate']] = timestamp;
      return row;
    });
    const finalRows = keptRows.concat(newRows);

    if (existingRowCount > 0) sheet.getRange(2, 1, existingRowCount, lastCol).clearContent();
    if (finalRows.length) sheet.getRange(2, 1, finalRows.length, lastCol).setValues(finalRows);
    _rawDataCache_.floorPlan = null; // invalidate: this execution's cached FloorPlanElements read is now stale
    invalidateCrossRequestCache_(FLOORPLAN_CACHE_KEY_); // and the cross-request cache other executions may still be serving
  } finally {
    lock.releaseLock();
  }

  return { status: 'ok', savedCount: normalized.length };
}

/**
 * Loads the existing floor plan layout for one Exhibition entity, plus
 * the fixed canvas/grid dimensions the client should build against.
 * Called as: google.script.run.getFloorPlanLayout(token, eventId)
 */
function getFloorPlanLayout(token, eventId) {
  requireAdmin_(token);
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  const elements = getFloorPlanElementsRaw_()
    .filter(function(r) { return r.eventId === String(eventId); })
    .map(function(r) {
      return { elementId: r.elementId, x: r.x, y: r.y, width: r.width, height: r.height, type: r.type, label: r.label, cssClass: r.cssClass, assetTypeId: r.assetTypeId || '' };
    });
  const canvasSize = getFloorPlanCanvasSize_(event);

  return {
    eventId: event.eventId,
    eventName: event.eventName,
    eventType: event.eventType,
    canvasWidth: canvasSize.width,
    canvasHeight: canvasSize.height,
    gridSize: FLOORPLAN_GRID_SIZE,
    elements: elements,
    // Asset Types (from this event's own TypeConfig — see
    // normalizeExhibitionAssetTypes_) plus the flat fallback price/currency,
    // so the designer can offer them as tiered "+ Asset" options alongside
    // the generic flat-priced Booth.
    assetTypes: event.typeConfig || [],
    flatPrice: getEventPrice_(event),
    currency: getEventCurrency_(event)
  };
}

/** Used by AdminFloorPlan.html's event picker to list Exhibition entities (top-level or sub-event) that can have a floor plan. */
function getExhibitionEventOptions(token) {
  requireAdmin_(token);
  return getAllEvents_()
    .filter(function(e) { return e.eventType === EVENT_TYPE_EXHIBITION; })
    .map(function(e) { return { eventId: e.eventId, eventName: e.eventName, isSubEvent: !!e.parentEventId }; });
}

/* =========================================================================
   MILESTONES — admin-defined tasks attached to an Event OR a sub-event
   ----------------------------------------------------------------------
   A Milestone is a due-dated task an attendee must complete for a specific
   entity (top-level Event or sub-event) they're registered/opted into —
   e.g. "Upload your booth artwork" or "Confirm your company details".
   Definitions live in the Milestones sheet (admin-authored, one row per
   milestone); per-attendee completion lives in MilestoneCompletions (one
   row per attendee per milestone, written ONLY on completion — an absent
   row means Pending, same convention as DietaryRequirements/Preferences).

   MilestoneType drives what "completing" a milestone actually does — see
   completeMilestone below, which dispatches on it. Two exist today
   (ConfirmInfo, FileUpload); adding a third means adding one more entry to
   MILESTONE_TYPES and to that dispatch table, nothing else changes.

   Both sheets are cached the same way Events/Preferences already are:
   in-execution (_rawDataCache_) AND cross-request (CacheService, see
   CROSS_REQUEST_CACHE_SECONDS) — safe here because nothing
   capacity/allocation-critical ever reads either sheet, unlike
   Registrations/SubEventRegistrations (see the warning at the top of this
   file). Writes invalidate both layers.
   ========================================================================= */

function getMilestonesSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(MILESTONES_SHEET_NAME) || ss.insertSheet(MILESTONES_SHEET_NAME);
  const headers = ['MilestoneID', 'EventID', 'Title', 'Description', 'MilestoneType', 'DueDate', 'Config', 'SortOrder'];
  if (s.getLastRow() === 0) {
    s.appendRow(headers);
  } else {
    ensureHeadersFresh_(s, headers, 'headers_checked_milestones');
  }
  return s;
}

const MILESTONES_CACHE_KEY_ = 'milestones_v1';

function getMilestonesRaw_() {
  if (_rawDataCache_.milestones) return _rawDataCache_.milestones;
  const cached = getCrossRequestCache_(MILESTONES_CACHE_KEY_);
  if (cached) { _rawDataCache_.milestones = cached; return cached; }

  const sheet = getMilestonesSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      let config = {};
      try { config = JSON.parse(row[6]) || {}; } catch (e) { config = {}; }
      out.push({
        milestoneId: String(row[0] || ''),
        eventId: String(row[1] || ''),
        title: String(row[2] || ''),
        description: String(row[3] || ''),
        milestoneType: String(row[4] || ''),
        dueDate: row[5] instanceof Date ? Utilities.formatDate(row[5], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(row[5] || ''),
        config: config,
        sortOrder: Number(row[7]) || 0
      });
    }
    out.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  _rawDataCache_.milestones = out;
  putCrossRequestCache_(MILESTONES_CACHE_KEY_, out);
  return out;
}

/**
 * Bulk-saves the ENTIRE milestone list for one entity (top-level event or
 * sub-event) — replaces every existing Milestones row for that eventId
 * with the new set atomically, same bulk-replace-by-EventID shape as
 * saveFloorPlanLayout. Called as its own step, in its own lock, from
 * createOrUpdateEvent AFTER that function's own save/lock has already
 * completed (not nested inside it). `entityEventType` is the entity's OWN
 * (normalized) EventType — needed to enforce that a SetPreferences
 * milestone only ever lands on a B2B Pre-scheduled Meetings entity, even
 * if a stale/tampered client payload claims otherwise.
 */
function saveMilestonesForEntity_(eventId, milestones, entityEventType) {
  const list = Array.isArray(milestones) ? milestones : [];

  const normalized = list.map((m, idx) => {
    const title = String((m && m.title) || '').trim();
    if (!title) throw new Error('Every milestone needs a title.');
    const milestoneType = String((m && m.milestoneType) || '').trim();
    if (MILESTONE_TYPES.indexOf(milestoneType) === -1) {
      throw new Error('"' + milestoneType + '" is not a supported milestone type.');
    }
    if (milestoneType === MILESTONE_TYPE_SET_PREFERENCES && entityEventType !== EVENT_TYPE_B2B_MEETINGS) {
      throw new Error('"Set Preferences" milestones are only supported on a "B2B Pre-scheduled Meetings" event or sub-event.');
    }
    let config = (m && m.config) || {};
    if (milestoneType === MILESTONE_TYPE_FILE_UPLOAD) {
      const maxSizeMB = Number(config.maxSizeMB);
      config = {
        acceptedTypes: String(config.acceptedTypes || '').trim(),
        maxSizeMB: isFinite(maxSizeMB) && maxSizeMB > 0 ? maxSizeMB : 10
      };
    } else {
      config = {};
    }
    return {
      milestoneId: String((m && m.milestoneId) || '').trim() || ('MS-' + new Date().getTime() + '-' + idx + '-' + Math.floor(Math.random() * 1000)),
      eventId: eventId,
      title: title,
      description: String((m && m.description) || '').trim(),
      milestoneType: milestoneType,
      dueDate: String((m && m.dueDate) || '').trim(),
      config: config,
      sortOrder: idx
    };
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = getMilestonesSheet_();
    const lastCol = sheet.getLastColumn();
    const existingRowCount = Math.max(0, sheet.getLastRow() - 1);
    const existingRows = existingRowCount > 0 ? sheet.getRange(2, 1, existingRowCount, lastCol).getValues() : [];

    // Bulk replace: keep every row belonging to OTHER entities untouched,
    // drop this entity's old rows entirely, and append the freshly
    // normalized set — a full atomic replace for this eventId.
    const keptRows = existingRows.filter(row => String(row[1]) !== String(eventId));
    const newRows = normalized.map(m => [m.milestoneId, m.eventId, m.title, m.description, m.milestoneType, m.dueDate, JSON.stringify(m.config), m.sortOrder]);
    const finalRows = keptRows.concat(newRows);

    if (existingRowCount > 0) sheet.getRange(2, 1, existingRowCount, lastCol).clearContent();
    if (finalRows.length) sheet.getRange(2, 1, finalRows.length, lastCol).setValues(finalRows);

    _rawDataCache_.milestones = null;
    invalidateCrossRequestCache_(MILESTONES_CACHE_KEY_);
  } finally {
    lock.releaseLock();
  }
}

function getMilestoneCompletionsSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(MILESTONE_COMPLETIONS_SHEET_NAME) || ss.insertSheet(MILESTONE_COMPLETIONS_SHEET_NAME);
  const headers = ['Timestamp', 'EventID', 'MilestoneID', 'Email', 'Status', 'CompletedDate', 'SubmissionData'];
  if (s.getLastRow() === 0) {
    s.appendRow(headers);
  } else {
    ensureHeadersFresh_(s, headers, 'headers_checked_milestonecompletions');
  }
  return s;
}

const MILESTONE_COMPLETIONS_CACHE_KEY_ = 'milestone_completions_v1';

function getMilestoneCompletionsRaw_() {
  if (_rawDataCache_.milestoneCompletions) return _rawDataCache_.milestoneCompletions;
  const cached = getCrossRequestCache_(MILESTONE_COMPLETIONS_CACHE_KEY_);
  if (cached) { _rawDataCache_.milestoneCompletions = cached; return cached; }

  const sheet = getMilestoneCompletionsSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      let submissionData = {};
      try { submissionData = JSON.parse(row[6]) || {}; } catch (e) { submissionData = {}; }
      out.push({
        timestamp: row[0] instanceof Date ? row[0].toLocaleString() : String(row[0] || ''),
        eventId: String(row[1] || ''),
        milestoneId: String(row[2] || ''),
        email: String(row[3] || '').trim().toLowerCase(),
        status: String(row[4] || 'Completed'),
        completedDate: row[5] instanceof Date ? row[5].toLocaleString() : String(row[5] || ''),
        submissionData: submissionData
      });
    }
  }
  _rawDataCache_.milestoneCompletions = out;
  putCrossRequestCache_(MILESTONE_COMPLETIONS_CACHE_KEY_, out);
  return out;
}

/**
 * Finds this attendee's completion row for one milestone, if any (absence
 * means Pending — see architecture note above).
 */
function findMilestoneCompletion_(milestoneId, email) {
  const em = (email || '').trim().toLowerCase();
  return getMilestoneCompletionsRaw_().find(c => c.milestoneId === milestoneId && c.email === em) || null;
}

/**
 * Records (or overwrites, on resubmission) an attendee's completion of one
 * milestone. Wrapped in LockService purely to avoid a duplicate row on a
 * double-click/double-submit — there's no capacity race to protect here,
 * unlike allocateChoice_/recordPlainSubEventOptIn_.
 */
function recordMilestoneCompletion_(eventId, milestoneId, email, submissionData) {
  const em = (email || '').trim().toLowerCase();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getMilestoneCompletionsSheet_();
    const data = sheet.getLastRow() > 1 ? sheet.getDataRange().getValues() : [];
    const now = new Date();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][2]) === milestoneId && String(data[i][3]).trim().toLowerCase() === em) {
        sheet.getRange(i + 1, 1, 1, 7).setValues([[now, eventId, milestoneId, em, 'Completed', now, JSON.stringify(submissionData || {})]]);
        _rawDataCache_.milestoneCompletions = null;
        invalidateCrossRequestCache_(MILESTONE_COMPLETIONS_CACHE_KEY_);
        return;
      }
    }
    sheet.appendRow([now, eventId, milestoneId, em, 'Completed', now, JSON.stringify(submissionData || {})]);
    _rawDataCache_.milestoneCompletions = null;
    invalidateCrossRequestCache_(MILESTONE_COMPLETIONS_CACHE_KEY_);
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================================
   BUDGET FEATURE — Orders (auto income), BudgetLines (manual cost lines +
   optional income targets), BudgetCategories (admin-editable category
   list). One Budget per TOP-LEVEL event, even when it has sub-events —
   Orders.EventID and BudgetLines.EventID are always the top-level event's
   ID; SubEventID (when set) attributes an individual line/order to one of
   that event's sub-events for breakdown purposes only.

   Income is NEVER hand-entered: every non-zero-price registration/sub-
   event opt-in/allocation automatically creates a 'not_paid' Order via
   recordOrder_ (called from the existing registration/allocation write
   paths — see submitEventRegistration, submitEventRegistrationBatch,
   allocateChoice_, allocateCuratedEventSelections_,
   recordPlainSubEventOptIn_). An admin flips an Order to 'paid' as money
   comes in (updateOrderPaymentStatus_). Actual income is ALWAYS a live sum
   over Orders (see getBudgetSummary_) — never a cached running total, so
   it can never drift out of sync with the underlying Orders rows.

   Costs are entered manually as BudgetLines (LineType='cost'). An
   income-type BudgetLine (LineType='income') is a planned TARGET only —
   its ActualAmount is always forced to 0 server-side; the real actual for
   income always comes from Orders, never duplicated here.
   ========================================================================= */

function ordersHeaders_() {
  return ['OrderID', 'EventID', 'SubEventID', 'RegistrationID', 'Email', 'FullName', 'CompanyName',
    'Category', 'Description', 'Amount', 'Currency', 'PaymentStatus', 'PaymentMethod',
    'OrderDate', 'PaidDate', 'RecordedBy', 'Notes'];
}

function getOrdersSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(ORDERS_SHEET_NAME) || ss.insertSheet(ORDERS_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.appendRow(ordersHeaders_());
  } else {
    ensureHeadersFresh_(s, ordersHeaders_(), 'headers_checked_orders');
  }
  return s;
}

const ORDERS_CACHE_KEY_ = 'orders_v1';

function getOrdersRaw_() {
  if (_rawDataCache_.orders) return _rawDataCache_.orders;
  const cached = getCrossRequestCache_(ORDERS_CACHE_KEY_);
  if (cached) { _rawDataCache_.orders = cached; return cached; }

  const sheet = getOrdersSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      out.push({
        orderId: String(row[0] || ''),
        eventId: String(row[1] || ''),
        subEventId: String(row[2] || ''),
        registrationId: String(row[3] || ''),
        email: String(row[4] || ''),
        fullName: String(row[5] || ''),
        companyName: String(row[6] || ''),
        category: String(row[7] || ''),
        description: String(row[8] || ''),
        amount: Number(row[9]) || 0,
        currency: String(row[10] || ''),
        paymentStatus: String(row[11] || ORDER_STATUS_NOT_PAID),
        paymentMethod: String(row[12] || ''),
        orderDate: row[13] instanceof Date ? row[13].toLocaleString() : String(row[13] || ''),
        paidDate: row[14] instanceof Date ? row[14].toLocaleString() : String(row[14] || ''),
        recordedBy: String(row[15] || ''),
        notes: String(row[16] || '')
      });
    }
  }
  _rawDataCache_.orders = out;
  putCrossRequestCache_(ORDERS_CACHE_KEY_, out);
  return out;
}

/**
 * INTERNAL — never exposed via google.script.run. Auto-creates a
 * 'not_paid' Order whenever a registration/allocation with a non-zero
 * price completes; free (price <= 0) items create no Order. Always called
 * from inside the SAME LockService section that just wrote the triggering
 * Registrations/SubEventRegistrations row — this only appends (never
 * reads-then-writes a shared value), so it needs no lock of its own.
 */
function recordOrder_(eventId, subEventId, registrationId, email, fullName, companyName, amount, currency, description) {
  const amt = Number(amount) || 0;
  if (amt <= 0) return;

  getOrdersSheet_().appendRow([
    mintId_('ORD'), eventId, subEventId || '', registrationId || '', email || '', fullName || '', companyName || '',
    'Ticket Sales', description || '', amt, currency || DEFAULT_CURRENCY, ORDER_STATUS_NOT_PAID, '',
    new Date(), '', '', ''
  ]);
  _rawDataCache_.orders = null;
  invalidateCrossRequestCache_(ORDERS_CACHE_KEY_);
}

function budgetLinesHeaders_() {
  return ['LineID', 'EventID', 'SubEventID', 'LineType', 'Category', 'Label',
    'PlannedAmount', 'ActualAmount', 'Currency', 'Notes', 'CreatedDate', 'CreatedBy', 'SortOrder'];
}

function getBudgetLinesSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(BUDGET_LINES_SHEET_NAME) || ss.insertSheet(BUDGET_LINES_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.appendRow(budgetLinesHeaders_());
  } else {
    ensureHeadersFresh_(s, budgetLinesHeaders_(), 'headers_checked_budgetlines');
  }
  return s;
}

const BUDGET_LINES_CACHE_KEY_ = 'budgetlines_v1';

function getBudgetLinesRaw_() {
  if (_rawDataCache_.budgetLines) return _rawDataCache_.budgetLines;
  const cached = getCrossRequestCache_(BUDGET_LINES_CACHE_KEY_);
  if (cached) { _rawDataCache_.budgetLines = cached; return cached; }

  const sheet = getBudgetLinesSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      out.push({
        lineId: String(row[0] || ''),
        eventId: String(row[1] || ''),
        subEventId: String(row[2] || ''),
        lineType: String(row[3] || BUDGET_LINE_TYPE_COST),
        category: String(row[4] || ''),
        label: String(row[5] || ''),
        plannedAmount: Number(row[6]) || 0,
        actualAmount: Number(row[7]) || 0,
        currency: String(row[8] || ''),
        notes: String(row[9] || ''),
        createdDate: row[10] instanceof Date ? row[10].toLocaleString() : String(row[10] || ''),
        createdBy: String(row[11] || ''),
        sortOrder: Number(row[12]) || 0
      });
    }
    out.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  _rawDataCache_.budgetLines = out;
  putCrossRequestCache_(BUDGET_LINES_CACHE_KEY_, out);
  return out;
}

function budgetCategoriesHeaders_() {
  return ['LineType', 'CategoryName', 'SortOrder'];
}

function getBudgetCategoriesSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(BUDGET_CATEGORIES_SHEET_NAME) || ss.insertSheet(BUDGET_CATEGORIES_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.appendRow(budgetCategoriesHeaders_());
    // Seed sensible defaults — organizers can edit/add/remove rows directly
    // in the sheet afterwards, same trust model as RegistrationFormFields.
    const seedRows = [];
    BUDGET_DEFAULT_CATEGORIES.cost.forEach((name, idx) => seedRows.push([BUDGET_LINE_TYPE_COST, name, idx]));
    BUDGET_DEFAULT_CATEGORIES.income.forEach((name, idx) => seedRows.push([BUDGET_LINE_TYPE_INCOME, name, idx]));
    s.getRange(2, 1, seedRows.length, 3).setValues(seedRows);
  } else {
    ensureHeadersFresh_(s, budgetCategoriesHeaders_(), 'headers_checked_budgetcategories');
  }
  return s;
}

const BUDGET_CATEGORIES_CACHE_KEY_ = 'budgetcategories_v1';

function getBudgetCategoriesRaw_() {
  if (_rawDataCache_.budgetCategories) return _rawDataCache_.budgetCategories;
  const cached = getCrossRequestCache_(BUDGET_CATEGORIES_CACHE_KEY_);
  if (cached) { _rawDataCache_.budgetCategories = cached; return cached; }

  const sheet = getBudgetCategoriesSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const lineType = String(row[0] || '').trim();
      const categoryName = String(row[1] || '').trim();
      if (!lineType || !categoryName) continue;
      out.push({ lineType: lineType, categoryName: categoryName, sortOrder: Number(row[2]) || 0 });
    }
    out.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  _rawDataCache_.budgetCategories = out;
  putCrossRequestCache_(BUDGET_CATEGORIES_CACHE_KEY_, out);
  return out;
}

/**
 * Resolves a submitted category against the admin-editable list for that
 * LineType, falling back to 'Other' if it's blank, unrecognized, or was
 * later removed from the BudgetCategories sheet — keeps a stale client or
 * an edited category list from ever hard-failing a save.
 */
function resolveBudgetCategory_(lineType, rawCategory) {
  const valid = getBudgetCategoriesRaw_().filter(c => c.lineType === lineType).map(c => c.categoryName);
  const category = String(rawCategory || '').trim();
  return valid.indexOf(category) !== -1 ? category : 'Other';
}

/* ---- ADMIN: Budget tab (AdminPortal.html) ---- */

function getBudgetCategories(token) {
  requireAdmin_(token);
  return getBudgetCategoriesRaw_();
}

/**
 * Full Budget summary for one TOP-LEVEL event: KPI totals plus the line-
 * and order-level detail the Budget tab renders. Actual income is always
 * computed live from paid Orders — never a stored running total — so it
 * can never drift out of sync with the underlying rows.
 */
function getBudgetSummary(token, eventId) {
  requireAdmin_(token);
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  const subEventNameById = {};
  getAllEvents_().filter(e => e.parentEventId === eventId).forEach(e => { subEventNameById[e.eventId] = e.eventName; });

  const orders = getOrdersRaw_().filter(o => o.eventId === eventId);
  const lines = getBudgetLinesRaw_().filter(l => l.eventId === eventId);

  const actualIncome = orders.filter(o => o.paymentStatus === ORDER_STATUS_PAID).reduce((sum, o) => sum + o.amount, 0);
  const plannedIncome = lines.filter(l => l.lineType === BUDGET_LINE_TYPE_INCOME).reduce((sum, l) => sum + l.plannedAmount, 0);
  const plannedCost = lines.filter(l => l.lineType === BUDGET_LINE_TYPE_COST).reduce((sum, l) => sum + l.plannedAmount, 0);
  const actualCost = lines.filter(l => l.lineType === BUDGET_LINE_TYPE_COST).reduce((sum, l) => sum + l.actualAmount, 0);

  return {
    currency: getEventCurrency_(event),
    plannedIncome: plannedIncome,
    actualIncome: actualIncome,
    plannedCost: plannedCost,
    actualCost: actualCost,
    net: actualIncome - actualCost,
    subEvents: Object.keys(subEventNameById).map(id => ({ subEventId: id, subEventName: subEventNameById[id] })),
    lines: lines.map(l => ({
      lineId: l.lineId,
      lineType: l.lineType,
      category: l.category,
      label: l.label,
      subEventId: l.subEventId,
      subEventName: l.subEventId ? (subEventNameById[l.subEventId] || '') : '',
      planned: l.plannedAmount,
      actual: l.lineType === BUDGET_LINE_TYPE_INCOME ? 0 : l.actualAmount,
      currency: l.currency || getEventCurrency_(event),
      notes: l.notes
    })),
    orders: orders.map(o => ({
      orderId: o.orderId,
      email: o.email,
      fullName: o.fullName,
      companyName: o.companyName,
      category: o.category,
      description: o.description,
      amount: o.amount,
      currency: o.currency,
      paymentStatus: o.paymentStatus,
      paidDate: o.paidDate,
      orderDate: o.orderDate,
      subEventId: o.subEventId,
      subEventName: o.subEventId ? (subEventNameById[o.subEventId] || '') : ''
    }))
  };
}

/**
 * Creates or updates one BudgetLine — find-by-LineID-or-append, a per-row
 * upsert (unlike saveMilestonesForEntity_'s whole-list bulk-replace),
 * since lines are edited one at a time via the Add/Edit Line modal.
 * Income-type lines never carry a manually-entered ActualAmount — it's
 * always forced to 0 (see file header note on Orders vs BudgetLines).
 */
function saveBudgetLine(token, eventId, line) {
  const adminEmail = requireAdmin_(token);
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  const lineType = (line && line.lineType) === BUDGET_LINE_TYPE_INCOME ? BUDGET_LINE_TYPE_INCOME : BUDGET_LINE_TYPE_COST;
  const label = String((line && line.label) || '').trim();
  if (!label) throw new Error('Every budget line needs a label.');
  const category = resolveBudgetCategory_(lineType, line && line.category);

  const subEventId = String((line && line.subEventId) || '').trim();
  if (subEventId) {
    const subEvent = getEventById_(subEventId);
    if (!subEvent || subEvent.parentEventId !== eventId) throw new Error('That sub-event does not belong to this event.');
  }

  const plannedAmount = Math.max(0, Number(line && line.plannedAmount) || 0);
  const actualAmount = lineType === BUDGET_LINE_TYPE_INCOME ? 0 : Math.max(0, Number(line && line.actualAmount) || 0);
  const notes = String((line && line.notes) || '').trim();
  const currency = getEventCurrency_(event);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = getBudgetLinesSheet_();
    const existingLineId = String((line && line.lineId) || '').trim();
    const data = sheet.getLastRow() > 1 ? sheet.getDataRange().getValues() : [];

    if (existingLineId) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]) === existingLineId) {
          sheet.getRange(i + 1, 1, 1, 13).setValues([[
            existingLineId, eventId, subEventId, lineType, category, label,
            plannedAmount, actualAmount, currency, notes, data[i][10], data[i][11], data[i][12]
          ]]);
          _rawDataCache_.budgetLines = null;
          invalidateCrossRequestCache_(BUDGET_LINES_CACHE_KEY_);
          return { status: 'ok', lineId: existingLineId };
        }
      }
    }

    const lineId = mintId_('BL');
    sheet.appendRow([lineId, eventId, subEventId, lineType, category, label,
      plannedAmount, actualAmount, currency, notes, new Date(), adminEmail, data.length]);
    _rawDataCache_.budgetLines = null;
    invalidateCrossRequestCache_(BUDGET_LINES_CACHE_KEY_);
    return { status: 'ok', lineId: lineId };
  } finally {
    lock.releaseLock();
  }
}

function deleteBudgetLine(token, eventId, lineId) {
  requireAdmin_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = getBudgetLinesSheet_();
    const data = sheet.getLastRow() > 1 ? sheet.getDataRange().getValues() : [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(lineId) && String(data[i][1]) === String(eventId)) {
        sheet.deleteRow(i + 1);
        _rawDataCache_.budgetLines = null;
        invalidateCrossRequestCache_(BUDGET_LINES_CACHE_KEY_);
        return { status: 'ok' };
      }
    }
    throw new Error('Budget line not found.');
  } finally {
    lock.releaseLock();
  }
}

/** PaymentStatus is column 12, PaidDate is column 15 in ordersHeaders_(). */
function updateOrderPaymentStatus(token, orderId, newStatus) {
  requireAdmin_(token);
  const status = newStatus === ORDER_STATUS_PAID ? ORDER_STATUS_PAID : ORDER_STATUS_NOT_PAID;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = getOrdersSheet_();
    const data = sheet.getLastRow() > 1 ? sheet.getDataRange().getValues() : [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(orderId)) {
        sheet.getRange(i + 1, 12).setValue(status);
        sheet.getRange(i + 1, 15).setValue(status === ORDER_STATUS_PAID ? new Date() : '');
        _rawDataCache_.orders = null;
        invalidateCrossRequestCache_(ORDERS_CACHE_KEY_);
        return { status: 'ok' };
      }
    }
    throw new Error('Order not found.');
  } finally {
    lock.releaseLock();
  }
}

/** Used by the standalone Dashboard.html (accessed via ?key=...) to populate its event picker. */
function getDashboardEventOptions() {
  const events = getAllEvents_();
  const topLevel = events.filter(e => !e.parentEventId);
  return topLevel.map(e => ({ eventId: e.eventId, label: e.eventName, isB2B: e.isB2B }));
}

/* Legacy/standalone Dashboard.html support (single-event or all-events view) */
function getDashboardData(eventId) {
  const registrations = eventId ? getRegistrationsRaw_().filter(r => r.eventId === eventId) : getRegistrationsRaw_();
  const companies = new Set(registrations.map(r => r.companyName.toLowerCase()).filter(Boolean));
  const byType = {};
  registrations.forEach(r => {
    const t = r.registrationType || 'Unspecified';
    byType[t] = (byType[t] || 0) + 1;
  });
  const last10 = registrations.slice(-10).reverse().map(r => ({
    timestamp: r.timestamp, fullName: r.fullName, companyName: r.companyName,
    email: r.email, registrationType: r.registrationType
  }));
  return {
    totalRegistrations: registrations.length,
    totalCompanies: companies.size,
    byRegistrationType: byType,
    last10: last10
  };
}

function getPreferencesDashboardData(eventId) {
  const registrations = eventId ? getRegistrationsRaw_().filter(r => r.eventId === eventId) : getRegistrationsRaw_();
  return getPreferencesDashboardData_(eventId, registrations);
}

/* =========================================================================
   ATTENDEE PORTAL: LANDING / LIVE EVENT TILES
   ========================================================================= */

function authenticateUserPortal(email) {
  email = (email || '').trim().toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) throw new Error('Please enter a valid email address.');

  const events = getAllEvents_();
  const liveTopLevelEvents = events.filter(e => !e.parentEventId && e.status === 'Live');
  const registeredEventIds = new Set(
    getRegistrationsRaw_().filter(r => r.email.toLowerCase() === email).map(r => r.eventId)
  );

  const tiles = liveTopLevelEvents.map(e => {
    const currency = getEventCurrency_(e);
    const subEvents = events
      .filter(c => c.parentEventId === e.eventId)
      .sort((a, b) => (a.eventDate + a.eventTime).localeCompare(b.eventDate + b.eventTime))
      .map(c => ({
        eventName: c.eventName, description: c.description,
        eventDate: c.eventDate, eventTime: c.eventTime, location: c.location, eventType: c.eventType,
        price: getEventPrice_(c), currency: currency,
        capacity: c.eventType === EVENT_TYPE_EXHIBITION ? null : getEventCapacityState_(c)
      }));

    return {
      eventId: e.eventId,
      eventName: e.eventName,
      description: e.description,
      eventDate: e.eventDate,
      location: e.location,
      eventType: e.eventType,
      isUmbrella: e.isUmbrella,
      isB2B: e.isB2B,
      dietaryRequirements: e.dietaryRequirements,
      detailsPageUrl: e.detailsPageUrl,
      price: getEventPrice_(e),
      currency: currency,
      capacity: e.isUmbrella || e.eventType === EVENT_TYPE_EXHIBITION ? null : getEventCapacityState_(e),
      registered: registeredEventIds.has(e.eventId),
      subEvents: subEvents
    };
  });

  return {
    email: email,
    tiles: tiles,
    profile: lookupAttendeeInfo(email),
    businessTypeOptions: getBusinessTypeOptions_(),
    brandingTitle: BRANDING.eventTitle
  };
}

/* =========================================================================
   REGISTRATIONS SHEET HELPERS
   ========================================================================= */

/**
 * RegistrationID is a trailing, additive column (see Budget feature —
 * Orders rows need a stable FK back to the registration that generated
 * them). Existing rows created before this column existed simply have it
 * blank; reads look it up by header name, never by position.
 */
function registrationsHeaders_() {
  return ['Timestamp', 'EventID', 'Work Email', 'Full Name', ...MEMBERSHIP_COLUMNS, 'Registration Type',
    'ExtraFields', 'DietaryRequirements', 'DietaryOther', 'CompletedBy', 'RegistrationID'];
}

function getRegistrationsSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(REGISTRATIONS_SHEET_NAME) || ss.insertSheet(REGISTRATIONS_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.appendRow(registrationsHeaders_());
  } else {
    ensureHeadersFresh_(s, registrationsHeaders_(), 'headers_checked_registrations');
  }
  return s;
}

function getRegistrationsRaw_() {
  if (_rawDataCache_.registrations) return _rawDataCache_.registrations;
  const sheet = getRegistrationsSheet_();
  if (sheet.getLastRow() <= 1) { _rawDataCache_.registrations = []; return []; }
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const idx = {
    timestamp: headers.indexOf('timestamp'),
    eventId: headers.indexOf('eventid'),
    email: headers.indexOf('work email'),
    fullName: headers.indexOf('full name'),
    companyName: headers.indexOf('company name'),
    companyDescription: headers.indexOf('company description'),
    membershipType: headers.indexOf('membership type'),
    membershipCategory: headers.indexOf('membership category'),
    domain: headers.indexOf('domain'),
    website: headers.indexOf('website'),
    registrationType: headers.indexOf('registration type'),
    extraFields: headers.indexOf('extrafields'),
    dietaryRequirements: headers.indexOf('dietaryrequirements'),
    dietaryOther: headers.indexOf('dietaryother'),
    completedBy: headers.indexOf('completedby'),
    registrationId: headers.indexOf('registrationid')
  };

  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    out.push({
      rowNum: i + 1,
      timestamp: row[idx.timestamp] instanceof Date ? row[idx.timestamp].toLocaleString() : String(row[idx.timestamp] || ''),
      eventId: idx.eventId !== -1 ? String(row[idx.eventId] || '') : '',
      email: idx.email !== -1 ? String(row[idx.email] || '').trim() : '',
      fullName: idx.fullName !== -1 ? String(row[idx.fullName] || '') : '',
      companyName: idx.companyName !== -1 ? String(row[idx.companyName] || '') : '',
      companyDescription: idx.companyDescription !== -1 ? String(row[idx.companyDescription] || '') : '',
      membershipType: idx.membershipType !== -1 ? String(row[idx.membershipType] || '') : '',
      membershipCategory: idx.membershipCategory !== -1 ? String(row[idx.membershipCategory] || '') : '',
      domain: idx.domain !== -1 ? String(row[idx.domain] || '') : '',
      website: idx.website !== -1 ? String(row[idx.website] || '') : '',
      registrationType: idx.registrationType !== -1 ? String(row[idx.registrationType] || '') : '',
      extraFields: idx.extraFields !== -1 ? String(row[idx.extraFields] || '') : '',
      dietaryRequirements: idx.dietaryRequirements !== -1 ? String(row[idx.dietaryRequirements] || '') : '',
      dietaryOther: idx.dietaryOther !== -1 ? String(row[idx.dietaryOther] || '') : '',
      completedBy: idx.completedBy !== -1 ? String(row[idx.completedBy] || '') : '',
      registrationId: idx.registrationId !== -1 ? String(row[idx.registrationId] || '') : ''
    });
  }
  _rawDataCache_.registrations = out;
  return out;
}

/* =========================================================================
   PAGE: EVENT DETAILS (attendee-scoped, per eventId)
   ========================================================================= */

/**
 * "Event Details" drawer content for ANY entity (top-level event OR
 * sub-event) — previously this only worked correctly for a top-level
 * event, since it filtered Registrations (always top-level-keyed) for
 * registration/company counts; that analytics block isn't something the
 * drawer actually needs, so it's dropped here rather than fixed, and
 * getEntityLiveState (already entity-agnostic — see its own doc comment)
 * is merged in so the "no URL configured" fallback can show curated
 * options / capacity / floor plan tables per the event's own type, not
 * just a plain description. detailsPageUrl is only ever populated on a
 * TOP-LEVEL row (see CURRENCY/architecture notes at top of file), so a
 * sub-event naturally always falls through to that fallback.
 */
function getEventDetailsForAttendee(eventId) {
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  let daysUntil = 0;
  if (event.eventDate) {
    const d = new Date(event.eventDate);
    daysUntil = Math.max(0, Math.ceil((d - new Date()) / 86400000));
  }

  const subEvents = event.isUmbrella
    ? getAllEvents_()
        .filter(e => e.parentEventId === eventId && e.status !== 'Draft')
        .sort((a, b) => (a.eventDate + a.eventTime).localeCompare(b.eventDate + b.eventTime))
        .map(e => ({
          eventName: e.eventName, description: e.description, eventDate: e.eventDate,
          eventTime: e.eventTime, location: e.location, eventType: e.eventType
        }))
    : [];

  return Object.assign({
    eventId: event.eventId,
    eventName: event.eventName,
    description: event.description,
    eventDate: event.eventDate,
    eventTime: event.eventTime,
    location: event.location,
    website: event.website,
    detailsPageUrl: event.detailsPageUrl,
    daysUntil: daysUntil,
    subEvents: subEvents
  }, getEntityLiveState(eventId));
}

/* =========================================================================
   PAGE: REGISTER TO THE EVENT (dynamic form)
   ========================================================================= */

/** Looks up the RegistrationFormFields rows configured for a given EventType, sorted by SortOrder. */
const FORM_FIELDS_CACHE_KEY_ = 'formfields_v1';

function getExtraFieldsForType_(eventType) {
  const wantedType = normalizeEventType_(eventType);

  // Memoize the WHOLE sheet (grouped by type) on first call, rather than
  // caching per-type — this way, whichever event type is requested first
  // still only costs one getDataRange().getValues() for the entire
  // execution, no matter how many distinct event types get looked up
  // afterwards (e.g. once per sub-event in an Umbrella event). Also cached
  // cross-request (like getOnboardingData_) — RegistrationFormFields is
  // only ever edited directly on the sheet, so a short TTL with no
  // explicit invalidation path is an acceptable trade-off.
  if (!_rawDataCache_.extraFieldsByType) {
    const cachedByType = getCrossRequestCache_(FORM_FIELDS_CACHE_KEY_);
    if (cachedByType) { _rawDataCache_.extraFieldsByType = cachedByType; return cachedByType[wantedType] || []; }

    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(FORM_FIELDS_SHEET_NAME);
    const byType = {};
    if (sheet && sheet.getLastRow() > 1) {
      const data = sheet.getDataRange().getValues();
      const headers = data[0].map(h => String(h).trim().toLowerCase());
      const typeIdx = headers.indexOf('eventtype');
      const nameIdx = headers.indexOf('fieldname');
      const labelIdx = headers.indexOf('fieldlabel');
      const fieldTypeIdx = headers.indexOf('fieldtype');
      const optionsIdx = headers.indexOf('options');
      const requiredIdx = headers.indexOf('required');
      const sortIdx = headers.indexOf('sortorder');

      for (let i = 1; i < data.length; i++) {
        const type = normalizeEventType_(data[i][typeIdx]);
        if (!byType[type]) byType[type] = [];
        byType[type].push({
          fieldName: String(data[i][nameIdx] || '').trim(),
          fieldLabel: String(data[i][labelIdx] || '').trim(),
          fieldType: String(data[i][fieldTypeIdx] || 'text').trim().toLowerCase(),
          options: String(data[i][optionsIdx] || '').split('|').map(o => o.trim()).filter(Boolean),
          required: String(data[i][requiredIdx]).toUpperCase() === 'TRUE',
          sortOrder: Number(data[i][sortIdx]) || 0
        });
      }
      Object.keys(byType).forEach(type => byType[type].sort((a, b) => a.sortOrder - b.sortOrder));
    }
    _rawDataCache_.extraFieldsByType = byType;
    putCrossRequestCache_(FORM_FIELDS_CACHE_KEY_, byType);
  }

  return _rawDataCache_.extraFieldsByType[wantedType] || [];
}

/**
 * This is the primary "checkout / pre-confirmation" payload the attendee
 * portal reads before submitting a registration — price, currency, and
 * capacity MUST be carried here so the client never has to guess or
 * hardcode a currency symbol.
 *
 * `email` is OPTIONAL. When provided, this folds in the "already
 * registered" check (previously a separate checkAttendeeRegistration
 * round-trip) AND, for an Umbrella event, its sub-events (previously a
 * separate getUmbrellaChildren round-trip) into this SAME response.
 * This collapses what used to be up to 3 sequential
 * google.script.run calls (each with its own network round-trip on top
 * of whatever sheet reads it triggers) into 1. checkAttendeeRegistration
 * and getUmbrellaChildren are left in place, unchanged, for any other
 * caller that still wants them standalone.
 */
function getRegistrationFormDefinition(eventId, email) {
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  const onboarding = getOnboardingData_();
  const regTypes = (onboarding[event.eventType] && onboarding[event.eventType].registrationTypes) || [];
  const extraFields = getExtraFieldsForType_(event.eventType);

  const result = {
    eventName: event.eventName,
    eventType: event.eventType,
    isUmbrella: event.eventType === EVENT_TYPE_UMBRELLA,
    isB2B: event.isB2B,
    registrationTypes: regTypes,
    extraFields: extraFields,
    price: getEventPrice_(event),
    currency: getEventCurrency_(event),
    capacity: event.isUmbrella || event.eventType === EVENT_TYPE_EXHIBITION ? null : getEventCapacityState_(event)
  };

  // Standalone Exhibition (not under an Umbrella Event) embeds its own
  // live floor plan directly into the base registration form — there's
  // no separate sub-event selection step. Booths (`exhibitionTables`) come
  // from the admin's drag-and-drop Floor Plan Designer (FloorPlanElements
  // sheet); `exhibitionDecor` are the non-bookable amenities/landmarks
  // rendered alongside them for visual context, at the same canvas scale
  // the admin laid them out in. A standalone Curated Event or B2B
  // Pre-scheduled Meetings event WITH options configured embeds its
  // ranked options (`curatedEventOptions`) the same way; with none
  // configured (legacy events saved before options became mandatory for
  // these two types — see normalizeTypeConfig_), result.price/capacity
  // above are used instead (the flat event-level fallback).
  if (event.eventType === EVENT_TYPE_EXHIBITION) {
    const state = getExhibitionCompleteState_(event);
    const canvasSize = getFloorPlanCanvasSize_(event);
    result.exhibitionTables = state.tables;
    result.exhibitionDecor = state.decor;
    result.canvasWidth = canvasSize.width;
    result.canvasHeight = canvasSize.height;
  } else if (event.eventType === EVENT_TYPE_CURATED_EVENT || event.eventType === EVENT_TYPE_B2B_MEETINGS) {
    const options = getCuratedEventOptionsLiveState_(event);
    if (options) {
      result.curatedEventOptions = options;
      result.maxOptionsPerAttendee = event.eventType === EVENT_TYPE_CURATED_EVENT ? event.maxOptionsPerAttendee : 1;
    }
  }

  if (result.isUmbrella) {
    result.subEvents = getUmbrellaChildren(eventId);
  }

  if (email) {
    const check = checkAttendeeRegistration(email, eventId);
    result.alreadyRegistered = check.alreadyRegistered;
    result.registration = check.registration;
  }

  return result;
}

function checkAttendeeRegistration(email, eventId) {
  email = (email || '').trim().toLowerCase();
  const reg = getRegistrationsRaw_().find(r => r.eventId === eventId && r.email.toLowerCase() === email);
  return { alreadyRegistered: !!reg, registration: reg || null };
}

/**
 * Company auto-suggest (B2B events only) - looks up the global Membership
 * Details directory by email domain, same behaviour as before.
 */
function lookupCompanyByDomain(email) {
  email = (email || '').trim().toLowerCase();
  const domain = email.split('@')[1] || '';
  const raw = getMembershipRaw_();
  const domainColIdx = raw.idx['Domain'];

  if (domainColIdx !== undefined) {
    for (let i = 0; i < raw.rows.length; i++) {
      const row = raw.rows[i];
      if (String(row[domainColIdx] || '').trim().toLowerCase() === domain) {
        const data = {};
        raw.headers.forEach((h, idx) => { data[headerToKey_(h)] = row[idx]; });
        return { found: true, data: data };
      }
    }
  }
  return { found: false, data: { domain: domain } };
}

/**
 * Submits registration for a specific event. Handles both B2B (with
 * company lookup/creation in the global Membership Details directory)
 * and non-B2B events (simple attendee record) via a single payload.
 *
 * payload: { eventId, email, fullName, registrationType, companyData
 *            (only for B2B events), extraFields: {fieldName: value} }
 */
function submitEventRegistration(payload) {
  const event = getEventById_(payload.eventId);
  if (!event) throw new Error('Event not found.');

  const email = (payload.email || '').trim().toLowerCase();
  const fullName = (payload.fullName || '').trim();
  if (!email || !fullName) throw new Error('Full Name and Email are required.');

  // Fast-path check so an obviously-duplicate submission fails immediately
  // without waiting on the lock. This alone is NOT sufficient to prevent a
  // duplicate: two near-simultaneous submissions (a double-click, or two
  // open tabs) could both read "not yet registered" here before either has
  // written anything. The authoritative check that actually closes that
  // race is the one repeated INSIDE the lock, right before the write below.
  const existing = checkAttendeeRegistration(email, payload.eventId);
  if (existing.alreadyRegistered) throw new Error('This email address is already registered for this event.');

  if (!event.isUmbrella && event.eventType !== EVENT_TYPE_EXHIBITION) {
    const capacityState = getEventCapacityState_(event);
    if (!capacityState.unlimited && capacityState.isFull) {
      throw new Error('"' + event.eventName + '" is full (' + capacityState.label + ').');
    }
  }

  let companyRow = ['', '', '', '', '', ''];
  if (event.isB2B) {
    const c = payload.companyData || {};
    if (!c.companyName || !c.membershipType) throw new Error('Company Name and Membership Type are required for this event.');
    companyRow = MEMBERSHIP_COLUMNS.map(col => c[headerToKey_(col)] || '');

    // Upsert into the global Membership Details directory if new
    if (payload.wasNewCompany) {
      const membershipSheet = getMembershipSheet_();
      membershipSheet.appendRow(companyRow);
    }
  }

  const sheet = getRegistrationsSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // AUTHORITATIVE duplicate check: now that we hold the lock, force a
    // fresh read straight from the sheet (bypass the memoized cache) so we
    // see any row written by another execution that acquired this same
    // lock a moment earlier. This is the check that actually prevents two
    // concurrent submissions for the same email+event from both
    // succeeding — the pre-lock check above can only catch the common
    // case, not the race.
    _rawDataCache_.registrations = null;
    const alreadyRegistered = getRegistrationsRaw_().some(r => r.eventId === payload.eventId && r.email.toLowerCase() === email);
    if (alreadyRegistered) throw new Error('This email address is already registered for this event.');

    const registrationId = mintId_('REG');
    sheet.appendRow([
      new Date(), payload.eventId, email, fullName,
      ...companyRow,
      payload.registrationType || '',
      JSON.stringify(payload.extraFields || {}),
      '', '', '', // DietaryRequirements, DietaryOther, CompletedBy — not collected on this path
      registrationId
    ]);
    _rawDataCache_.registrations = null; // invalidate: this execution's cached Registrations read is now stale
    _rawDataCache_.registrationCounts = null; // derived from registrations — same staleness risk

    // Budget: a non-zero-price standalone event registration is a payable
    // item — auto-create a not_paid Order the organizer can later mark paid.
    recordOrder_(payload.eventId, '', registrationId, email, fullName, companyRow[0] || '',
      getEventPrice_(event), getEventCurrency_(event), event.eventName);
  } finally {
    lock.releaseLock();
  }
  return {
    status: 'ok',
    price: getEventPrice_(event),
    currency: getEventCurrency_(event)
  };
}

/**
 * Submits a BATCH of attendee registrations for a single event in one
 * transaction — used by the "Register Additional Attendee" / "Complete
 * Registration" cart flow. Writes one Registrations row per attendee, all
 * stamped with who completed the checkout (completedByEmail) and when.
 * Also upserts each attendee's Profile so the info is available next time.
 *
 * After the base rows are written, each attendee's sub-event selections
 * are processed: Exhibition entities are allocated atomically
 * (LockService, with waiting-list fallback); plain sub-events — which now
 * also includes "Curated Event" — are recorded as a simple opt-in against
 * that sub-event's own Price/Places. This also covers a STANDALONE
 * Exhibition event (event.eventType is Exhibition directly) — in that
 * case each attendee's single selection targets subEventId === eventId.
 * A standalone (non-Umbrella) event's own Places/capacity is enforced
 * directly against the Registrations sheet before any rows are written.
 *
 * attendees: [{ email, fullName, registrationType, dietaryRequirements: [],
 *               dietaryOther, companyData: {...} (B2B events only),
 *               wasNewCompany, extraFields: {...},
 *               subEventSelections: [{ subEventId, rankedOptionIds: [...],
 *                 extraFields: {...} } for an Exhibition entity, or
 *                 { subEventId, extraFields: {...} } for a plain sub-event
 *                 opt-in (including Curated Event) — extraFields here are
 *                 that SUB-EVENT's own RegistrationFormFields questions,
 *                 e.g. Gala Dinner's "Transfer required?"] }, ...]
 *
 * Returns { status: 'ok', registeredCount, currency, pricePerRegistrant,
 *           totalPrice, allocations: [{ email, subEventId, subEventName,
 *           status, optionId, optionLabel, optionPrice, optionCurrency,
 *           rank }, ...], registrationSummary: [ see
 *           buildAttendeeRegistrationSummary_() ] } — registrationSummary
 *           is the ready-to-render/ready-to-email receipt data structure.
 */
function submitEventRegistrationBatch(eventId, attendees, completedByEmail) {
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');
  if (!attendees || !attendees.length) throw new Error('No attendees to register.');

  const currency = getEventCurrency_(event);
  const completedBy = (completedByEmail || '').trim().toLowerCase();
  // Fast-path check so an obviously-duplicate batch fails immediately
  // without waiting on the lock. NOT sufficient alone to prevent a
  // duplicate — see the authoritative re-check inside the lock below.
  const existingRegisteredEmails = new Set(
    getRegistrationsRaw_().filter(r => r.eventId === eventId).map(r => r.email.toLowerCase())
  );

  // Enforce the standalone event's OWN capacity (if limited) up front.
  // Umbrella Events have no direct Registrations-based capacity concept
  // here (no registration record of its own). A standalone event using
  // RANKED allocation (Exhibition booths, or a Curated Event WITH options
  // configured) has its capacity enforced PER-OPTION instead, inside
  // allocateChoice_ — so it's excluded from this whole-event pre-check.
  // Everything else (e.g. a standalone "Curated Event" with no options,
  // or a "B2B Pre-scheduled Meetings" event) is checked this way.
  if (!event.isUmbrella && !entityUsesRankedAllocation_(event)) {
    const capacityState = getEventCapacityState_(event);
    if (!capacityState.unlimited) {
      const remaining = Math.max(0, capacityState.capacity - capacityState.confirmed);
      if (attendees.length > remaining) {
        throw new Error('Only ' + remaining + ' of ' + capacityState.label + ' remain for "' + event.eventName + '".');
      }
    }
  }

  const seenInBatch = new Set();
  const normalizedAttendees = [];

  attendees.forEach(a => {
    const email = (a.email || '').trim().toLowerCase();
    const fullName = (a.fullName || '').trim();
    if (!email || !fullName) throw new Error('Every attendee needs a Full Name and Email.');
    if (existingRegisteredEmails.has(email)) throw new Error(email + ' is already registered for this event.');
    if (seenInBatch.has(email)) throw new Error(email + ' appears more than once in this registration.');
    seenInBatch.add(email);

    // Company Details are always collected on the registration form now
    // (not just for events flagged IsB2B — see renderAttendeeFields in
    // Portal.html), so this is unconditional: every attendee's company
    // affiliation is captured, which is also what lets displayLabel
    // (below) resolve to the real company name instead of falling back to
    // the attendee's own name for non-B2B entities (e.g. Exhibition booths
    // under a plain Umbrella Event).
    let companyRow = ['', '', '', '', '', ''];
    const c = a.companyData || {};
    if (!c.companyName) throw new Error('Company Name is required for ' + email + '.');
    companyRow = MEMBERSHIP_COLUMNS.map(col => c[headerToKey_(col)] || '');
    if (a.wasNewCompany) {
      getMembershipSheet_().appendRow(companyRow);
    }

    normalizedAttendees.push({
      email: email, fullName: fullName, companyRow: companyRow,
      firstName: a.firstName || '', surname: a.surname || '', jobTitle: a.jobTitle || '',
      mobile: a.mobile || '', linkedIn: a.linkedIn || '',
      registrationType: a.registrationType || '',
      extraFields: a.extraFields || {},
      dietaryRequirements: a.dietaryRequirements || [],
      dietaryOther: a.dietaryOther || '',
      subEventSelections: a.subEventSelections || [],
      registrationId: mintId_('REG')
    });
  });

  const sheet = getRegistrationsSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  const timestamp = new Date();

  try {
    // AUTHORITATIVE duplicate check: now that we hold the lock, force a
    // fresh read straight from the sheet (bypass the memoized cache) so we
    // see any row written by another execution (e.g. this same attendee
    // double-clicking "Complete Registration", or two open tabs) that
    // acquired this same lock a moment earlier. The pre-lock check above
    // can only catch the common case, not this race.
    _rawDataCache_.registrations = null;
    const freshRegisteredEmails = new Set(
      getRegistrationsRaw_().filter(r => r.eventId === eventId).map(r => r.email.toLowerCase())
    );
    const nowDuplicate = normalizedAttendees.filter(a => freshRegisteredEmails.has(a.email));
    if (nowDuplicate.length) {
      throw new Error(nowDuplicate.map(a => a.email).join(', ') +
        (nowDuplicate.length > 1 ? ' are already registered' : ' is already registered') + ' for this event.');
    }

    const pricePerRegistrant_ = getEventPrice_(event); // top-level event's own price, if any (0 for most Umbrella events)
    normalizedAttendees.forEach(a => {
      sheet.appendRow([
        timestamp, eventId, a.email, a.fullName,
        ...a.companyRow,
        a.registrationType,
        JSON.stringify(a.extraFields),
        a.dietaryRequirements.join('|'),
        a.dietaryOther,
        completedBy,
        a.registrationId
      ]);
      // Budget: a non-zero-price top-level registration is a payable item —
      // auto-create a not_paid Order the organizer can later mark paid.
      recordOrder_(eventId, '', a.registrationId, a.email, a.fullName, a.companyRow[0] || '',
        pricePerRegistrant_, currency, event.eventName);
    });
    _rawDataCache_.registrations = null; // invalidate: this execution's cached Registrations read is now stale
    _rawDataCache_.registrationCounts = null; // derived from registrations — same staleness risk
  } finally {
    lock.releaseLock();
  }

  // Save/refresh each attendee's reusable Profile.
  normalizedAttendees.forEach(a => {
    const companyObj = {};
    MEMBERSHIP_COLUMNS.forEach((col, idx) => { companyObj[headerToKey_(col)] = a.companyRow[idx]; });
    saveProfile({
      email: a.email,
      fullName: a.fullName,
      firstName: a.firstName,
      surname: a.surname,
      jobTitle: a.jobTitle,
      mobile: a.mobile,
      linkedIn: a.linkedIn,
      dietaryRequirements: a.dietaryRequirements,
      dietaryOther: a.dietaryOther,
      companyName: companyObj.companyName,
      companyDescription: companyObj.companyDescription,
      membershipType: companyObj.membershipType,
      membershipCategory: companyObj.membershipCategory,
      domain: companyObj.domain || a.email.split('@')[1],
      website: companyObj.website
    });
  });

  // Process each attendee's sub-event selections. RANKED allocation
  // (Exhibition booths or B2B options) takes its own LockService lock
  // scoped to that entity, so different attendees choosing different
  // booths/options don't block each other, while two attendees racing for
  // the same one are serialized safely. A Curated Event WITH options
  // configured registers the attendee for EVERY option they selected (see
  // allocateCuratedEventSelections_) rather than picking one winner. PLAIN
  // opt-ins (a Curated Event with no options, or any other type) enforce
  // their own event-level Places/capacity inside recordPlainSubEventOptIn_.
  const allocationsByEmail = {};
  normalizedAttendees.forEach(a => {
    const companyObj = {};
    MEMBERSHIP_COLUMNS.forEach((col, idx) => { companyObj[headerToKey_(col)] = a.companyRow[idx]; });
    const displayLabel = companyObj.companyName || a.fullName;
    allocationsByEmail[a.email] = [];

    (a.subEventSelections || []).forEach(sel => {
      const subEntity = getEventById_(sel.subEventId);
      if (!subEntity) return;

      let results;
      if (subEntity.eventType === EVENT_TYPE_CURATED_EVENT && entityUsesRankedAllocation_(subEntity)) {
        results = allocateCuratedEventSelections_(eventId, subEntity, sel.rankedOptionIds || [], a.email, a.fullName, displayLabel, sel.extraFields || {});
      } else if (entityUsesRankedAllocation_(subEntity)) {
        results = [allocateChoice_(eventId, subEntity, sel.rankedOptionIds || [], a.email, a.fullName, displayLabel, sel.extraFields || {})];
      } else {
        results = [recordPlainSubEventOptIn_(eventId, subEntity, a.email, a.fullName, sel.extraFields || {})];
      }
      results.forEach(result => { allocationsByEmail[a.email].push(Object.assign({ email: a.email }, result)); });
    });
  });

  const allocations = [].concat.apply([], normalizedAttendees.map(a => allocationsByEmail[a.email]));

  const registrationSummary = normalizedAttendees.map(a => {
    const companyObj = {};
    MEMBERSHIP_COLUMNS.forEach((col, idx) => { companyObj[headerToKey_(col)] = a.companyRow[idx]; });
    return buildAttendeeRegistrationSummary_(event, a, companyObj.companyName || '', allocationsByEmail[a.email], currency);
  });

  const pricePerRegistrant = getEventPrice_(event);

  return {
    status: 'ok',
    registeredCount: normalizedAttendees.length,
    currency: currency,
    pricePerRegistrant: pricePerRegistrant,
    totalPrice: pricePerRegistrant * normalizedAttendees.length,
    allocations: allocations,
    registrationSummary: registrationSummary
  };
}

/**
 * Builds the reusable, structured registration-summary record for ONE
 * attendee — the single source of truth for confirmation-screen,
 * checkout-review, and confirmation-email/receipt data. Always includes
 * the attendee's full name and company name; lists every sub-event they
 * registered for (with its own price/currency where applicable); falls
 * back to a single "event-level registration only" entry when the
 * attendee has no sub-event selections at all.
 */
function buildAttendeeRegistrationSummary_(event, attendee, companyName, allocationsForAttendee, currency) {
  const eventCurrency = currency || getEventCurrency_(event);
  const subEvents = (allocationsForAttendee || []).map(a => ({
    subEventId: a.subEventId,
    subEventName: a.subEventName,
    eventType: a.eventType || '',
    status: a.status,
    optionLabel: a.optionLabel || '',
    rank: a.rank || null,
    price: Number(a.optionPrice) || 0,
    currency: a.optionCurrency || eventCurrency,
    priceDisplay: formatMoney_(a.optionPrice, a.optionCurrency || eventCurrency)
  }));

  const hasSubEvents = subEvents.length > 0;
  const eventPrice = getEventPrice_(event);

  return {
    email: attendee.email,
    fullName: attendee.fullName,
    companyName: companyName || '',
    eventId: event.eventId,
    eventName: event.eventName,
    currency: eventCurrency,
    hasSubEvents: hasSubEvents,
    subEvents: subEvents,
    // Populated only when there are no sub-events at all — the
    // event-level-only registration line described in the requirements.
    eventLevelRegistration: hasSubEvents ? null : {
      eventId: event.eventId,
      eventName: event.eventName,
      price: eventPrice,
      currency: eventCurrency,
      priceDisplay: formatMoney_(eventPrice, eventCurrency)
    }
  };
}

/* =========================================================================
   PAGE: DIETARY REQUIREMENTS (conditional per event)
   ========================================================================= */

function getDietarySheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(DIETARY_SHEET_NAME) || ss.insertSheet(DIETARY_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(['Timestamp', 'EventID', 'Email', 'Full Name', 'Requirements', 'Notes']);
  return s;
}

function getDietaryRequirements(eventId, email) {
  email = (email || '').trim().toLowerCase();
  const sheet = getDietarySheet_();
  if (sheet.getLastRow() <= 1) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(eventId) && String(data[i][2]).trim().toLowerCase() === email) {
      return { requirements: data[i][4], notes: data[i][5] };
    }
  }
  return null;
}

function submitDietaryRequirements(payload) {
  const eventId = payload.eventId;
  const email = (payload.email || '').trim().toLowerCase();
  const fullName = payload.fullName || '';
  const sheet = getDietarySheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]) === String(eventId) && String(data[i][2]).trim().toLowerCase() === email) {
        sheet.getRange(i + 1, 5).setValue(payload.requirements || '');
        sheet.getRange(i + 1, 6).setValue(payload.notes || '');
        return { status: 'ok' };
      }
    }
    sheet.appendRow([new Date(), eventId, email, fullName, payload.requirements || '', payload.notes || '']);
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================================
   PAGE: UPDATE COMPANY DETAILS — write side only now; the read side is
   getMyDetailsForAttendee (see MILESTONES section), which superseded the
   old top-level-only getAttendeeCompanyDetails.
   ========================================================================= */

function updateCompanyDetailsInRegistrations(eventId, payload) {
  const email = (payload.email || '').trim().toLowerCase();
  const newDesc = (payload.companyDescription || '').trim();
  const newWebsite = (payload.website || '').trim();

  const sheet = getRegistrationsSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim().toLowerCase());
    const emailIdx = headers.indexOf('work email');
    const eventIdx = headers.indexOf('eventid');
    const descIdx = headers.indexOf('company description');
    const websiteIdx = headers.indexOf('website');

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][eventIdx]) === String(eventId) && String(data[i][emailIdx]).trim().toLowerCase() === email) {
        if (descIdx !== -1) sheet.getRange(i + 1, descIdx + 1).setValue(newDesc);
        if (websiteIdx !== -1) sheet.getRange(i + 1, websiteIdx + 1).setValue(newWebsite);
        return { status: 'ok' };
      }
    }
    throw new Error('Record not found to update.');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Merged read for the "My Details" drawer: personal + registration info
 * from the TOP-LEVEL Registrations row (registration always happens once,
 * at the top level, regardless of which entity — top-level or sub-event —
 * "My Details" was opened for), plus that SPECIFIC entity's own
 * SubEventRegistrations.extraFields answers when entityId is a sub-event
 * (e.g. a Gala Dinner's "Transfer required?" question).
 */
function getMyDetailsForAttendee(entityId, email) {
  email = (email || '').trim().toLowerCase();
  const entity = getEventById_(entityId);
  if (!entity) throw new Error('Event not found.');
  const topEventId = entity.parentEventId || entity.eventId;

  const reg = getRegistrationsRaw_().find(r => r.eventId === topEventId && r.email.toLowerCase() === email);
  if (!reg) throw new Error('No registration details found for ' + email);

  let subEventExtraFields = null;
  if (entity.parentEventId) {
    const subReg = getSubEventRegsRaw_().find(r => r.subEventId === entityId && r.email === email && r.status !== 'Withdrawn');
    if (subReg) subEventExtraFields = subReg.extraFields;
  }

  return {
    fullName: reg.fullName,
    email: reg.email,
    registrationType: reg.registrationType,
    dietaryRequirements: reg.dietaryRequirements ? reg.dietaryRequirements.split('|').filter(Boolean) : [],
    dietaryOther: reg.dietaryOther,
    companyName: reg.companyName,
    membershipType: reg.membershipType,
    membershipCategory: reg.membershipCategory,
    domain: reg.domain,
    companyDescription: reg.companyDescription,
    website: reg.website,
    subEventExtraFields: subEventExtraFields
  };
}

/**
 * Write half of "My Details": the same fields
 * updateCompanyDetailsInRegistrations already edits (Company Description +
 * Website) — just resolves the TOP-LEVEL event id first so it works
 * whether entityId is that top-level event itself or one of its
 * sub-events (Registrations rows only ever exist at the top level).
 */
function updateMyDetailsForAttendee(entityId, payload) {
  const entity = getEventById_(entityId);
  if (!entity) throw new Error('Event not found.');
  const topEventId = entity.parentEventId || entity.eventId;
  return updateCompanyDetailsInRegistrations(topEventId, payload);
}

/**
 * Merged read for the "Update Registration" panel: the attendee's
 * read-only base registration info, the sub-events they've already
 * joined, and — for an Umbrella event — the sub-events still available to
 * join. availableSubEvents reuses getUmbrellaChildren's per-child shape
 * unchanged (options/tables/capacity/extraFields already computed), so
 * the SAME client-side rendering functions used during initial
 * registration (renderCuratedOptionsPanel etc.) work here without
 * modification. A standalone (non-Umbrella) event has nothing to add, so
 * availableSubEvents is always empty there — the panel just shows the
 * read-only summary.
 */
function getUpdateRegistrationData(eventId, email) {
  email = (email || '').trim().toLowerCase();
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  const check = checkAttendeeRegistration(email, eventId);
  if (!check.alreadyRegistered) throw new Error('No registration found for this email address.');
  const reg = check.registration;

  const registration = {
    fullName: reg.fullName,
    email: reg.email,
    registrationType: reg.registrationType,
    dietaryRequirements: reg.dietaryRequirements ? reg.dietaryRequirements.split('|').filter(Boolean) : [],
    dietaryOther: reg.dietaryOther,
    companyName: reg.companyName,
    companyDescription: reg.companyDescription,
    membershipType: reg.membershipType,
    membershipCategory: reg.membershipCategory,
    website: reg.website
  };

  let joinedSubEvents = [];
  let availableSubEvents = [];

  if (event.isUmbrella) {
    const myAllocations = getSubEventRegsRaw_().filter(r => r.eventId === eventId && r.email === email && r.status !== 'Withdrawn');
    const joinedIds = new Set(myAllocations.map(r => r.subEventId));
    const allChildren = getUmbrellaChildren(eventId);

    joinedSubEvents = allChildren.filter(c => joinedIds.has(c.eventId)).map(c => {
      const myRegsForChild = myAllocations.filter(r => r.subEventId === c.eventId);
      return {
        eventId: c.eventId, eventName: c.eventName, eventType: c.eventType,
        eventDate: c.eventDate, eventTime: c.eventTime, location: c.location,
        registrationStatus: myRegsForChild.some(r => r.status === 'Confirmed') ? 'Confirmed' : 'Waitlisted'
      };
    });
    availableSubEvents = allChildren.filter(c => !joinedIds.has(c.eventId));
  }

  return {
    eventId: event.eventId,
    eventName: event.eventName,
    isUmbrella: event.isUmbrella,
    registration: registration,
    joinedSubEvents: joinedSubEvents,
    availableSubEvents: availableSubEvents
  };
}

/**
 * Lets an ALREADY-registered attendee join additional sub-events under an
 * Umbrella event they hadn't opted into yet. submitEventRegistrationBatch
 * exists only for NEW registrations and explicitly rejects an
 * already-registered email, so this is a narrower, separate path — it
 * reuses the SAME atomic allocation primitives submitEventRegistrationBatch
 * already calls internally (allocateChoice_ / allocateCuratedEventSelections_
 * / recordPlainSubEventOptIn_, all unchanged) rather than duplicating their
 * capacity/locking logic.
 * selections: [{ subEventId, rankedOptionIds: [...] } for a ranked entity
 *              (Exhibition/Curated-with-options/B2B), or
 *              { subEventId, extraFields: {...} } for a plain opt-in].
 * Silently skips any selection for a subEventId already joined (rather
 * than erroring) so a stale client-side list can't double-allocate.
 */
function addSubEventSelectionsForAttendee(eventId, email, selections) {
  email = (email || '').trim().toLowerCase();
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  const check = checkAttendeeRegistration(email, eventId);
  if (!check.alreadyRegistered) throw new Error('You must be registered for this event before you can join additional sessions.');
  const reg = check.registration;

  const alreadyJoined = new Set(getSubEventRegsRaw_().filter(r => r.eventId === eventId && r.email === email && r.status !== 'Withdrawn').map(r => r.subEventId));
  const newSelections = (Array.isArray(selections) ? selections : []).filter(sel => sel && sel.subEventId && !alreadyJoined.has(String(sel.subEventId)));
  if (!newSelections.length) throw new Error('Please select at least one new session to join.');

  const displayLabel = reg.companyName || reg.fullName;
  const allocations = [];

  newSelections.forEach(sel => {
    const subEntity = getEventById_(sel.subEventId);
    if (!subEntity) return;

    let results;
    if (subEntity.eventType === EVENT_TYPE_CURATED_EVENT && entityUsesRankedAllocation_(subEntity)) {
      results = allocateCuratedEventSelections_(eventId, subEntity, sel.rankedOptionIds || [], email, reg.fullName, displayLabel, sel.extraFields || {});
    } else if (entityUsesRankedAllocation_(subEntity)) {
      results = [allocateChoice_(eventId, subEntity, sel.rankedOptionIds || [], email, reg.fullName, displayLabel, sel.extraFields || {})];
    } else {
      results = [recordPlainSubEventOptIn_(eventId, subEntity, email, reg.fullName, sel.extraFields || {})];
    }
    results.forEach(result => { allocations.push(Object.assign({ email: email }, result)); });
  });

  return { status: 'ok', allocations: allocations };
}

/**
 * Lets an already-registered attendee withdraw from a previously-joined
 * sub-event ("Leave session" in the My Events unified workspace) — the
 * missing counterpart to addSubEventSelectionsForAttendee. Marks every
 * SubEventRegistrations row for this subEventId + email as Withdrawn
 * rather than deleting it, so the Confirmed/Waitlisted history stays
 * auditable; getConfirmedSubEventCountMap_ only counts 'Confirmed' rows,
 * so this immediately frees the capacity slot for someone else. A
 * Curated Event attendee who selected multiple options for the same
 * sub-event has one row per option — all of them are withdrawn together,
 * since "leave this session" means leaving all of it, not one option.
 * Does NOT auto-promote the next waitlisted attendee — no such mechanism
 * exists anywhere else in this codebase either; that's a deliberate
 * follow-up, not an oversight here.
 */
function withdrawSubEventRegistration(eventId, subEventId, email) {
  email = (email || '').trim().toLowerCase();
  const sheet = getSubEventRegSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim().toLowerCase());
    const eventIdx = headers.indexOf('eventid');
    const subEventIdx = headers.indexOf('subeventid');
    const emailIdx = headers.indexOf('email');
    const statusIdx = headers.indexOf('status');

    let matched = 0;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][eventIdx]) === String(eventId) &&
          String(data[i][subEventIdx]) === String(subEventId) &&
          String(data[i][emailIdx]).trim().toLowerCase() === email) {
        sheet.getRange(i + 1, statusIdx + 1).setValue('Withdrawn');
        matched++;
      }
    }
    if (!matched) throw new Error('No registration found for this session.');

    _rawDataCache_.subEventRegs = null;
    _rawDataCache_.confirmedSubEventCounts = null; // derived from subEventRegs — same staleness risk
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================================
   PAGE: SET YOUR PREFERENCES (B2B events, scoped by eventId)
   ========================================================================= */

function getPreferencesSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(PREFERENCES_SHEET_NAME) || ss.insertSheet(PREFERENCES_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(['Timestamp', 'EventID', 'Email', 'Company Name', 'Full Name', 'Target Email']);
  return s;
}

const PREFERENCES_CACHE_KEY_ = 'preferences_v1';

/**
 * Cached read of the Meeting Preferences sheet. getPreferencesDashboardData_
 * (admin dashboard drill-down, and the standalone stakeholder Dashboard.html)
 * and initializePreferencesSession (attendee "Set Your Preferences" page)
 * each used to independently call sheet.getDataRange().getValues() with NO
 * memoization at all — not even in-execution. Safe to cache cross-request
 * too: unlike Registrations/SubEventRegistrations, nothing here is ever
 * read inside a LockService-protected capacity/allocation check —
 * savePreferences' lock only makes its own clear-and-rewrite atomic, it
 * doesn't gate any capacity decision. Returns { headers, idx, rows } (rows
 * excludes the header row; idx maps LOWERCASED header name -> column
 * index, matching how both callers already looked headers up).
 */
function getPreferencesRaw_() {
  if (_rawDataCache_.preferences) return _rawDataCache_.preferences;
  const cached = getCrossRequestCache_(PREFERENCES_CACHE_KEY_);
  if (cached) { _rawDataCache_.preferences = cached; return cached; }

  const sheet = getPreferencesSheet_();
  const values = sheet.getLastRow() > 1 ? sheet.getDataRange().getValues() : [];
  const headers = (values[0] || []).map(h => String(h).trim().toLowerCase());
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const result = { headers: headers, idx: idx, rows: values.slice(1) };
  _rawDataCache_.preferences = result;
  putCrossRequestCache_(PREFERENCES_CACHE_KEY_, result);
  return result;
}

/**
 * eventId here is the B2B entity's OWN id — a standalone top-level B2B
 * Pre-scheduled Meetings event, OR a B2B sub-event under an Umbrella (see
 * the SetPreferences milestone, which is the only current caller that can
 * pass a sub-event id — the "Set your Preferences" sidebar item still
 * passes the top-level event's own id exactly as before).
 *
 * IMPORTANT: every B2B Pre-scheduled Meetings entity REQUIRES at least one
 * ranked TypeConfig option (see normalizeTypeConfig_) — there is no flat
 * fallback for this type anymore. That means the base registration form's
 * flat "Registration Type" dropdown is ALWAYS suppressed for a B2B entity
 * (see b2bUsesRankedOptions in Portal.html), so the Registrations sheet's
 * own registrationType column is NEVER populated for a B2B attendee. Each
 * attendee's actual buyer/supplier tier is the label of their ALLOCATED
 * option, recorded in SubEventRegistrations instead (see allocateChoice_).
 * This resolves it from there — for BOTH a standalone top-level event
 * (subEventId === eventId in that case) and a sub-event alike — rather
 * than the always-blank flat field, which is a latent bug this fixes for
 * every current B2B event, not just newly-added sub-event support.
 */
function initializePreferencesSession(eventId, email) {
  email = (email || '').trim().toLowerCase();
  const entity = getEventById_(eventId);
  if (!entity) return { success: false, message: 'Event not found.' };

  const allocations = getSubEventRegsRaw_().filter(r => r.subEventId === eventId && (r.status === 'Confirmed' || r.status === 'Waitlisted'));
  const userAlloc = allocations.find(r => r.email === email);
  if (!userAlloc) return { success: false, message: 'Email not registered for this event.' };

  // Allocations carry companyName/fullName but not the richer company
  // profile (description, business type) — that still lives on the
  // TOP-LEVEL Registrations row for this email, so join back to it.
  const topEventId = entity.parentEventId || entity.eventId;
  const regByEmail = {};
  getRegistrationsRaw_().filter(r => r.eventId === topEventId).forEach(r => { regByEmail[r.email.toLowerCase()] = r; });

  const onboarding = getOnboardingData_();
  const regTypes = (onboarding[entity.eventType] && onboarding[entity.eventType].registrationTypes) || [];
  const oppositeTypes = regTypes.filter(t => t !== userAlloc.optionLabel);

  const availableCompanies = allocations
    .filter(r => oppositeTypes.indexOf(r.optionLabel) !== -1)
    .map((r, i) => {
      const regRow = regByEmail[r.email];
      return {
        id: r.email + '_' + i,
        companyName: (regRow && regRow.companyName) || r.companyName,
        membershipCategory: (regRow && regRow.membershipCategory) || 'N/A',
        fullName: r.fullName || (regRow && regRow.fullName) || '',
        targetEmail: r.email,
        description: (regRow && regRow.companyDescription) || 'No description provided.'
      };
    })
    .filter(c => c.companyName);

  const pref = getPreferencesRaw_();
  const eIdx = pref.idx['eventid'];
  const emailIdx = pref.idx['email'];
  const targetIdx = pref.idx['target email'];
  const selectedKeys = [];
  if (eIdx !== undefined && emailIdx !== undefined && targetIdx !== undefined) {
    pref.rows.forEach(row => {
      if (String(row[eIdx]) === String(eventId) && String(row[emailIdx]).trim().toLowerCase() === email) {
        selectedKeys.push(String(row[targetIdx]).trim());
      }
    });
  }

  const userFullName = userAlloc.fullName || (regByEmail[email] && regByEmail[email].fullName) || '';
  return {
    success: true,
    user: { email: userAlloc.email, fullName: userFullName, registrationType: userAlloc.optionLabel },
    targetRegistrationType: oppositeTypes.join(' / '),
    companies: availableCompanies,
    selectedCompanies: selectedKeys
  };
}

function savePreferences(eventId, payload) {
  const email = (payload.email || '').trim().toLowerCase();
  const prefSheet = getPreferencesSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const data = prefSheet.getDataRange().getValues();
    const rowsToKeep = [data[0] || ['Timestamp', 'EventID', 'Email', 'Company Name', 'Full Name', 'Target Email']];

    if (data.length > 1) {
      const headers = data[0].map(h => String(h).trim().toLowerCase());
      const eIdx = headers.indexOf('eventid');
      const emailIdx = headers.indexOf('email');
      for (let i = 1; i < data.length; i++) {
        if (!(String(data[i][eIdx]) === String(eventId) && String(data[i][emailIdx]).trim().toLowerCase() === email)) {
          rowsToKeep.push(data[i]);
        }
      }
    }

    const timestamp = new Date();
    (payload.selectedSelections || []).forEach(item => {
      rowsToKeep.push([timestamp, eventId, email, item.companyName, payload.fullName, item.targetEmail]);
    });

    prefSheet.clearContents();
    prefSheet.getRange(1, 1, rowsToKeep.length, rowsToKeep[0].length).setValues(rowsToKeep);
    _rawDataCache_.preferences = null; // invalidate: this execution's cached Preferences read is now stale
    invalidateCrossRequestCache_(PREFERENCES_CACHE_KEY_); // and the cross-request cache other executions may still be serving
  } finally {
    lock.releaseLock();
  }
  return { status: 'ok' };
}

/* =========================================================================
   PAGE: VIEW MY ITINERARY (B2B events, scoped by eventId)
   ========================================================================= */

function getMeetingSheet_(eventId, isBuyer) {
  const ss = getSpreadsheet_();
  const scopedName = eventId + (isBuyer ? '_BuyerMeetings' : '_SupplierMeetings');
  let sheet = ss.getSheetByName(scopedName);
  if (!sheet) {
    // Fall back to legacy single-event sheet names for backward compatibility
    sheet = ss.getSheetByName(isBuyer ? 'BuyerMeetings' : 'SupplierMeetings');
  }
  return sheet;
}

function getAttendeeItinerary(eventId, email) {
  email = (email || '').trim().toLowerCase();
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');
  // Registrations rows only ever exist at the TOP-LEVEL event (same
  // invariant updateMyDetailsForAttendee resolves for) — eventId here is
  // often a B2B sub-event's own id, which would never match a
  // Registrations row and made this always fail with "Registration
  // details not found", even for a genuinely registered attendee. The
  // sub-event's own id is still what's used below for getSubEventRegsRaw_
  // and getMeetingSheet_, which ARE scoped per sub-event.
  const topEventId = event.parentEventId || event.eventId;
  const registrations = getRegistrationsRaw_().filter(r => r.eventId === topEventId);
  const userRecord = registrations.find(r => r.email.toLowerCase() === email);
  if (!userRecord) throw new Error('Registration details not found for this email address.');

  const onboarding = getOnboardingData_();
  const regTypes = (onboarding[event.eventType] && onboarding[event.eventType].registrationTypes) || [];
  // Every B2B Pre-scheduled Meetings event requires ranked TypeConfig
  // options now (see normalizeTypeConfig_), so the base registration
  // form's flat Registration Type dropdown is always suppressed and
  // userRecord.registrationType is blank for a modern B2B attendee —
  // resolve the real tier from the attendee's allocated option instead
  // (same fix already applied to initializePreferencesSession).
  const allocation = getSubEventRegsRaw_().find(r => r.subEventId === eventId && r.email === email && (r.status === 'Confirmed' || r.status === 'Waitlisted'));
  const registrationType = (allocation && allocation.optionLabel) || userRecord.registrationType;
  const isBuyerSide = regTypes.length > 0 && regTypes[0] === registrationType;

  const mtgSheet = getMeetingSheet_(eventId, isBuyerSide);
  const meetings = [];

  if (mtgSheet && mtgSheet.getLastRow() > 1) {
    const mtgData = mtgSheet.getDataRange().getValues();
    const mtgHeaders = mtgData[0].map(h => String(h).trim().toLowerCase());

    const mEmailIdx = mtgHeaders.indexOf('email');
    const apptIdx = mtgHeaders.indexOf('appointment');
    const startIdx = mtgHeaders.indexOf('start');
    const endIdx = mtgHeaders.indexOf('end');
    const tableIdx = mtgHeaders.indexOf('table_number');
    const statusIdx = mtgHeaders.indexOf('status');
    const typeIdx = mtgHeaders.indexOf('meeting_type');
    const compHeaderKey = isBuyerSide ? 'supplier_org' : 'buyer_org';
    const nameHeaderKey = isBuyerSide ? 'supplier_fullname' : 'buyer_fullname';
    const compIdx = mtgHeaders.indexOf(compHeaderKey);
    const nameIdx = mtgHeaders.indexOf(nameHeaderKey);

    for (let i = 1; i < mtgData.length; i++) {
      const row = mtgData[i];
      const rowEmail = String(row[mEmailIdx] || '').trim().toLowerCase();
      if (rowEmail !== email) continue;

      const rawStart = row[startIdx];
      const formattedStart = rawStart instanceof Date ? Utilities.formatDate(rawStart, Session.getScriptTimeZone(), 'HH:mm') : String(rawStart || '');
      const rawEnd = row[endIdx];
      const formattedEnd = rawEnd instanceof Date ? Utilities.formatDate(rawEnd, Session.getScriptTimeZone(), 'HH:mm') : String(rawEnd || '');
      const rawAppt = apptIdx !== -1 ? String(row[apptIdx] || '').trim() : '';
      const isSpecialBlock = isNaN(Number(rawAppt)) || rawAppt === '';

      meetings.push({
        appointment: rawAppt || 'N/A',
        isSpecialBlock: isSpecialBlock,
        startTime: formattedStart || 'N/A',
        endTime: formattedEnd || 'N/A',
        tableNumber: tableIdx !== -1 ? String(row[tableIdx] || '') : '',
        status: statusIdx !== -1 ? String(row[statusIdx] || '') : '',
        companyName: compIdx !== -1 ? String(row[compIdx] || '') : '',
        fullName: nameIdx !== -1 ? String(row[nameIdx] || '') : '',
        meetingType: typeIdx !== -1 ? String(row[typeIdx] || '') : ''
      });
    }
  }

  meetings.sort((a, b) => (a.startTime || '00:00').localeCompare(b.startTime || '00:00'));

  return {
    userName: userRecord.fullName,
    userCompany: userRecord.companyName,
    registrationType: registrationType,
    meetings: meetings
  };
}

function emailItinerary(recipientEmail, itineraryData) {
  recipientEmail = (recipientEmail || '').trim();
  if (!recipientEmail) throw new Error('Please specify a recipient email address.');

  let tableHtml = `
    <h2 style="color:#1a73e8;">Meeting Itinerary for ${escapeHtml(itineraryData.userName)} (${escapeHtml(itineraryData.userCompany)})</h2>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse; width:100%; font-family:Arial, sans-serif; font-size:13px;">
      <thead>
        <tr style="background-color:#f1f3f4; text-align:left;">
          <th>Appt # / Event</th><th>Start Time</th><th>End Time</th><th>Table No.</th>
          <th>Status</th><th>Company Name</th><th>Full Name</th><th>Meeting Type</th>
        </tr>
      </thead>
      <tbody>
  `;

  let csvContent = 'Appointment,Start Time,End Time,Table Number,Status,Company Name,Full Name,Meeting Type\n';

  if (!itineraryData.meetings || itineraryData.meetings.length === 0) {
    tableHtml += `<tr><td colspan="8" style="text-align:center;">No scheduled meetings found.</td></tr>`;
  } else {
    itineraryData.meetings.forEach(m => {
      if (m.isSpecialBlock) {
        tableHtml += `
          <tr style="background-color:#f8f9fa;">
            <td colspan="8" style="text-align:center; font-weight:bold; color:#5f6368;">
              ${escapeHtml(m.startTime)} - ${escapeHtml(m.endTime)} &nbsp;|&nbsp; ${escapeHtml(m.appointment)} ${m.tableNumber ? ' (' + escapeHtml(m.tableNumber) + ')' : ''}
            </td>
          </tr>`;
        csvContent += `"${m.appointment}","${m.startTime}","${m.endTime}","${m.tableNumber}","","","",""\n`;
      } else {
        tableHtml += `
          <tr>
            <td>${escapeHtml(m.appointment)}</td>
            <td><strong>${escapeHtml(m.startTime)}</strong></td>
            <td><strong>${escapeHtml(m.endTime)}</strong></td>
            <td>${escapeHtml(m.tableNumber)}</td>
            <td>${escapeHtml(m.status)}</td>
            <td><strong>${escapeHtml(m.companyName)}</strong></td>
            <td>${escapeHtml(m.fullName)}</td>
            <td>${escapeHtml(m.meetingType)}</td>
          </tr>`;
        csvContent += `"${m.appointment}","${m.startTime}","${m.endTime}","${m.tableNumber}","${m.status}","${m.companyName}","${m.fullName}","${m.meetingType}"\n`;
      }
    });
  }

  tableHtml += `</tbody></table><p style="margin-top:20px; font-size:12px; color:#5f6368;">Sent via Event Portal</p>`;

  const sanitizedFileName = (itineraryData.userName || 'Attendee').replace(/[^a-zA-Z0-9]/g, '_');
  const attachmentBlob = Utilities.newBlob(csvContent, 'text/csv', `Meeting_Itinerary_${sanitizedFileName}.csv`);

  MailApp.sendEmail({
    to: recipientEmail,
    subject: `Meeting Itinerary - ${itineraryData.userName}`,
    htmlBody: tableHtml,
    attachments: [attachmentBlob]
  });

  return { status: 'ok' };
}

function getAttendeeModalDetails(partnerEmail) {
  partnerEmail = (partnerEmail || '').trim().toLowerCase();
  const reg = getRegistrationsRaw_().find(r => r.email.toLowerCase() === partnerEmail);
  if (!reg) {
    return { fullName: 'N/A', companyName: 'N/A', membershipCategory: 'N/A', companyDescription: 'Attendee details could not be retrieved from registration records.', website: '' };
  }
  return {
    fullName: reg.fullName || 'N/A',
    companyName: reg.companyName || 'N/A',
    membershipCategory: reg.membershipCategory || 'N/A',
    companyDescription: reg.companyDescription || 'No description provided.',
    website: reg.website || ''
  };
}

/* =========================================================================
   PROFILES — reusable personal + company identity per email, independent
   of any specific event. Used to prepopulate "My Profile" and every
   registration form (including additional attendees added during a batch
   registration).
   ========================================================================= */

const PROFILE_COLUMNS = [
  'Email', 'FirstName', 'Surname', 'FullName', 'JobTitle', 'Mobile', 'LinkedIn',
  'DietaryRequirements', 'DietaryOther', 'CompanyName', 'CompanyDescription',
  'MembershipType', 'MembershipCategory', 'Domain', 'Website', 'LastUpdated'
];

function getProfilesSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(PROFILES_SHEET_NAME) || ss.insertSheet(PROFILES_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.appendRow(PROFILE_COLUMNS);
    return s;
  }
  // Self-heal: a sheet created before FirstName/Surname/JobTitle/Mobile/
  // LinkedIn existed is missing those headers. Append whatever's missing
  // without touching existing columns/data. Gated behind
  // ensureHeadersFresh_ so this only actually re-reads the header row once
  // per cache window instead of on every single call.
  ensureHeadersFresh_(s, PROFILE_COLUMNS, 'headers_checked_profiles');
  return s;
}

/**
 * Cached read of the Profiles sheet, keyed once per execution. Previously
 * findProfileRow_ and saveProfile each independently called
 * sheet.getDataRange().getValues() (plus their own separate header-row
 * read via getProfileColIndex_) — this collapses both into a single read,
 * matching the _rawDataCache_ pattern already used for Events/
 * Registrations/etc. Returns { headers, idx, rows } (rows excludes the
 * header row; idx maps header name -> column index).
 */
function getProfilesRaw_() {
  if (_rawDataCache_.profiles) return _rawDataCache_.profiles;
  const sheet = getProfilesSheet_();
  const values = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [];
  const headers = (values[0] || []).map(String);
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const result = { headers: headers, idx: idx, rows: values.slice(1) };
  _rawDataCache_.profiles = result;
  return result;
}

function findProfileRow_(email) {
  const raw = getProfilesRaw_();
  if (!raw.rows.length) return null;
  const emailIdx = raw.idx['Email'];
  for (let i = 0; i < raw.rows.length; i++) {
    if (String(raw.rows[i][emailIdx]).trim().toLowerCase() === email) {
      return { rowNum: i + 2, values: raw.rows[i], idx: raw.idx };
    }
  }
  return null;
}

/**
 * Resolves the best-known identity for an email: an existing Profile row
 * if one exists, otherwise company fields looked up by domain from the
 * global Membership Details directory (personal fields left blank), or a
 * blank stub if neither is found.
 */
function lookupAttendeeInfo(email) {
  email = (email || '').trim().toLowerCase();
  const existing = findProfileRow_(email);

  let info;
  if (existing) {
    const v = existing.values, idx = existing.idx;
    const g = key => (idx[key] !== undefined ? String(v[idx[key]] || '') : '');
    info = {
      exists: true,
      email: email,
      firstName: g('FirstName'),
      surname: g('Surname'),
      fullName: g('FullName'),
      jobTitle: g('JobTitle'),
      mobile: g('Mobile'),
      linkedIn: g('LinkedIn'),
      dietaryRequirements: g('DietaryRequirements') ? g('DietaryRequirements').split('|').filter(Boolean) : [],
      dietaryOther: g('DietaryOther'),
      companyName: g('CompanyName'),
      companyDescription: g('CompanyDescription'),
      membershipType: g('MembershipType'),
      membershipCategory: g('MembershipCategory'),
      domain: g('Domain') || email.split('@')[1] || '',
      website: g('Website')
    };
  } else {
    // companyLookup.data keys come from whatever the Membership Details
    // header row actually says (via headerToKey_) — it was renamed from
    // "Membership Category" to "Business Type", so check both.
    const companyLookup = lookupCompanyByDomain(email);
    info = {
      exists: false,
      email: email,
      firstName: '',
      surname: '',
      fullName: '',
      jobTitle: '',
      mobile: '',
      linkedIn: '',
      dietaryRequirements: [],
      dietaryOther: '',
      companyName: companyLookup.found ? (companyLookup.data.companyName || '') : '',
      companyDescription: companyLookup.found ? (companyLookup.data.companyDescription || '') : '',
      membershipType: companyLookup.found ? (companyLookup.data.membershipType || '') : '',
      membershipCategory: companyLookup.found ? (companyLookup.data.businessType || companyLookup.data.membershipCategory || '') : '',
      domain: companyLookup.data.domain || email.split('@')[1] || '',
      website: companyLookup.found ? (companyLookup.data.website || '') : ''
    };
  }

  // Company Name / Business Type are shared per domain via the Membership
  // Details directory and owned by whoever first saved them there (tracked
  // in its "Created By" column). Show the directory's authoritative values
  // and lock those two fields for everyone at the domain except the owner.
  const directoryEntry = getCompanyDirectoryEntry_(info.domain);
  if (directoryEntry) {
    const dg = key => (directoryEntry.idx[key] !== undefined ? String(directoryEntry.values[directoryEntry.idx[key]] || '') : '');
    if (dg('Company Name')) info.companyName = dg('Company Name');
    if (dg('Business Type')) info.membershipCategory = dg('Business Type');
    const createdBy = dg('Created By').trim().toLowerCase();
    info.companyLocked = !(createdBy && createdBy === email);
  } else {
    info.companyLocked = false;
  }

  return info;
}

/**
 * Used by the Profile page. Same as lookupAttendeeInfo but also reports
 * whether personal information has already been saved (so the client can
 * decide whether to nudge the user to complete their profile).
 */
function getProfileForEmail(email) {
  return lookupAttendeeInfo(email);
}

/**
 * Create or update a Profile row.
 * payload: { email, firstName, surname, fullName, jobTitle, mobile,
 *            linkedIn, dietaryRequirements: [], dietaryOther, companyName,
 *            companyDescription, membershipType, membershipCategory,
 *            domain, website }
 */
function saveProfile(payload) {
  const email = (payload.email || '').trim().toLowerCase();
  if (!email) throw new Error('Email is required to save a profile.');

  const sheet = getProfilesSheet_();
  const idx = getProfilesRaw_().idx;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const existing = findProfileRow_(email);
    // firstName/surname/jobTitle/mobile/linkedIn only ever come from the My
    // Profile page. submitAttendeeRegistration() also calls saveProfile to
    // keep the reusable profile in sync with what was typed on the
    // registration form, but that form has no fields for these — preserve
    // whatever is already on file for them instead of blanking them out.
    const prevVal = key => (existing && existing.idx[key] !== undefined) ? existing.values[existing.idx[key]] : '';

    const rowValues = new Array(sheet.getLastColumn()).fill('');
    const set = (key, val) => { if (idx[key] !== undefined) rowValues[idx[key]] = val; };

    set('Email', email);
    set('FirstName', payload.firstName !== undefined ? payload.firstName : prevVal('FirstName'));
    set('Surname', payload.surname !== undefined ? payload.surname : prevVal('Surname'));
    set('FullName', payload.fullName || '');
    set('JobTitle', payload.jobTitle !== undefined ? payload.jobTitle : prevVal('JobTitle'));
    set('Mobile', payload.mobile !== undefined ? payload.mobile : prevVal('Mobile'));
    set('LinkedIn', payload.linkedIn !== undefined ? payload.linkedIn : prevVal('LinkedIn'));
    set('DietaryRequirements', (payload.dietaryRequirements || []).join('|'));
    set('DietaryOther', payload.dietaryOther || '');
    set('CompanyName', payload.companyName || '');
    set('CompanyDescription', payload.companyDescription || '');
    set('MembershipType', payload.membershipType || '');
    set('MembershipCategory', payload.membershipCategory || '');
    set('Domain', payload.domain || email.split('@')[1] || '');
    set('Website', payload.website || '');
    set('LastUpdated', new Date());

    if (existing) {
      sheet.getRange(existing.rowNum, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
    _rawDataCache_.profiles = null; // invalidate: this execution's cached Profiles read is now stale

    // Keep the shared Membership Details directory entry for this domain in
    // sync (no-ops if the domain already has an entry owned by someone
    // else — see upsertCompanyDirectoryEntry_).
    upsertCompanyDirectoryEntry_(email, payload.domain || email.split('@')[1] || '', payload);

    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================================
   INTERNAL UTILITY HELPERS
   ========================================================================= */

function getMembershipSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(MEMBERSHIP_SHEET_NAME) || ss.insertSheet(MEMBERSHIP_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(MEMBERSHIP_COLUMNS);
  return s;
}

/**
 * Cached read of the Membership Details directory, keyed once per
 * execution. lookupCompanyByDomain, getCompanyDirectoryEntry_, and
 * getBusinessTypeOptions_ each used to call sheet.getDataRange().getValues()
 * independently — a single authenticateUserPortal() call could fully
 * re-scan this sheet up to three times. Returns { headers, idx, rows }
 * (rows excludes the header row; idx maps header name -> column index,
 * exact case, matching how the rest of the file already keys off it).
 */
function getMembershipRaw_() {
  if (_rawDataCache_.membership) return _rawDataCache_.membership;
  const sheet = getMembershipSheet_();
  const values = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [];
  const headers = (values[0] || []).map(String);
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const result = { headers: headers, idx: idx, rows: values.slice(1) };
  _rawDataCache_.membership = result;
  return result;
}

/**
 * Distinct, sorted, non-blank values from the "Business Type" column of the
 * Membership Details directory — used to populate the My Profile page's
 * Business Type dropdown.
 */
function getBusinessTypeOptions_() {
  const raw = getMembershipRaw_();
  const lowerHeaders = raw.headers.map(h => String(h).trim().toLowerCase());
  const colIdx = lowerHeaders.indexOf('business type');
  if (colIdx === -1) return [];

  const seen = new Set();
  raw.rows.forEach(row => {
    const val = String(row[colIdx] || '').trim();
    if (val) seen.add(val);
  });
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/** Read-only lookup of a domain's row in the Membership Details directory, keyed by header name. */
function getCompanyDirectoryEntry_(domain) {
  domain = (domain || '').trim().toLowerCase();
  if (!domain) return null;

  const raw = getMembershipRaw_();
  if (raw.idx['Domain'] === undefined) return null;

  for (let i = 0; i < raw.rows.length; i++) {
    if (String(raw.rows[i][raw.idx['Domain']] || '').trim().toLowerCase() === domain) {
      return { rowNum: i + 2, idx: raw.idx, values: raw.rows[i] };
    }
  }
  return null;
}

/**
 * Creates or updates the domain's row in the Membership Details directory
 * with the Company Name / Business Type a profile save just supplied. The
 * "Created By" column (self-healed onto the sheet here if missing) tracks
 * who first established a domain's entry — only that person may update
 * Company Name / Business Type afterwards; everyone else at the domain sees
 * them read-only (see lookupAttendeeInfo's companyLocked). A pre-existing
 * row with no recorded creator is left untouched rather than silently
 * claimed by whoever happens to save next.
 */
function upsertCompanyDirectoryEntry_(email, domain, payload) {
  domain = (domain || '').trim().toLowerCase();
  if (!domain || !payload.companyName) return;

  const sheet = getMembershipSheet_();
  let raw = getMembershipRaw_();

  if (raw.idx['Created By'] === undefined) {
    sheet.getRange(1, raw.headers.length + 1).setValue('Created By');
    _rawDataCache_.membership = null; // header shape changed — force a fresh read below
    raw = getMembershipRaw_();
  }
  const idx = raw.idx;
  if (idx['Domain'] === undefined) return;

  let rowNum = -1;
  for (let i = 0; i < raw.rows.length; i++) {
    if (String(raw.rows[i][idx['Domain']] || '').trim().toLowerCase() === domain) { rowNum = i + 2; break; }
  }

  if (rowNum === -1) {
    const row = new Array(raw.headers.length).fill('');
    const set = (key, val) => { if (idx[key] !== undefined) row[idx[key]] = val; };
    set('Company Name', payload.companyName || '');
    set('Company Description', payload.companyDescription || '');
    set('Membership Type', payload.membershipType || '');
    set('Business Type', payload.membershipCategory || '');
    set('Domain', domain);
    set('Website', payload.website || '');
    set('Created By', email);
    sheet.appendRow(row);
    _rawDataCache_.membership = null; // invalidate: this execution's cached Membership read is now stale
    return;
  }

  const createdBy = String(raw.rows[rowNum - 2][idx['Created By']] || '').trim().toLowerCase();
  if (createdBy !== email) return; // not the owner (or an unclaimed legacy row) — leave the shared record alone

  if (idx['Company Name'] !== undefined) sheet.getRange(rowNum, idx['Company Name'] + 1).setValue(payload.companyName || '');
  if (idx['Business Type'] !== undefined) sheet.getRange(rowNum, idx['Business Type'] + 1).setValue(payload.membershipCategory || '');
  _rawDataCache_.membership = null; // invalidate: this execution's cached Membership read is now stale
}

function headerToKey_(header) {
  return header.split(' ').map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())).join('');
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Used by HtmlService templates for includes, if ever needed. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
