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

// Communications feature — see the "COMMUNICATIONS FEATURE" section near
// the end of this file for the full engine. Sheet names declared here
// alongside every other sheet constant, same convention as everywhere else.
const COMM_TEMPLATES_SHEET_NAME    = 'CommunicationTemplates';
const COMM_CAMPAIGNS_SHEET_NAME    = 'CommunicationsCampaigns';
const COMM_QUEUE_SHEET_NAME        = 'CommunicationsQueue';
const COMM_LOG_SHEET_NAME          = 'CommunicationsLog';
const COMM_OPTOUT_SHEET_NAME       = 'CommunicationsOptOut';
const COMM_SETTINGS_SHEET_NAME     = 'CommunicationsSettings';
const COMM_AUTOMATIONS_SHEET_NAME  = 'CommunicationsAutomations';

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

/**
 * Lazily-generated per-deployment key for the standalone stakeholder
 * Dashboard.html (unauthenticated beyond this shared key). Stored in
 * PropertiesService — NOT the spreadsheet, which is shared with client
 * admins — mirroring getCommHmacSecret_'s pattern. Replaces a formerly
 * hardcoded 'testEvent' constant that was committed to source.
 */
function getDashboardAccessKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('DASHBOARD_ACCESS_KEY');
  if (!key) {
    key = Utilities.getUuid();
    props.setProperty('DASHBOARD_ACCESS_KEY', key);
  }
  return key;
}

/** Every Dashboard.html-facing server function must call this first. */
function requireDashboardKey_(key) {
  if (!key || key !== getDashboardAccessKey_()) {
    throw new Error('Invalid or missing dashboard access key.');
  }
}
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
  budgetCategories: null,  // array of {lineType, categoryName, sortOrder} — see getBudgetCategoriesRaw_
  commTemplates: null,     // see getCommTemplatesRaw_
  commCampaigns: null,     // see getCommCampaignsRaw_
  commAutomations: null,   // see getCommAutomationsRaw_
  commOptOut: null,        // see getCommOptOutRaw_
  commLog: null            // see getCommLogRaw_ — execution-scoped only, see note there
  // CommunicationsQueue is deliberately NOT cached here (or cross-request)
  // — it drives at-most-once send claims and must always read the live
  // sheet. CommunicationsLog gets an execution-scoped-only cache (see
  // getCommLogRaw_) since it's an audit trail that must reflect the live
  // sheet across requests; it is never put in CacheService.
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

function putCrossRequestCache_(key, value, ttlSeconds) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), ttlSeconds || CROSS_REQUEST_CACHE_SECONDS);
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

  // --- Stakeholder dashboard (accessed via ?key=...; the key IS the only
  // auth this page has, so it must be present and correct regardless of
  // whether ?page=dashboard is also set — it is never a bypass route). ---
  if (params.key && params.key === getDashboardAccessKey_()) {
    const tpl = HtmlService.createTemplateFromFile('Dashboard');
    tpl.branding = BRANDING;
    tpl.dashboardKey = params.key;
    return tpl.evaluate()
      .setTitle('Event Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Unsubscribe confirmation page (from a Communications email footer
  // link). Deliberately does NOT write the opt-out here on GET — mail
  // scanners and Gmail's link prefetcher fetch every URL in an email
  // before a human sees it, so auto-unsubscribing on page load would
  // silently opt out people who never clicked anything. The write only
  // happens from confirmUnsubscribe(), called via google.script.run after
  // an explicit button click in Unsubscribe.html. ---
  if (String(params.page).toLowerCase() === 'unsubscribe') {
    const tpl = HtmlService.createTemplateFromFile('Unsubscribe');
    tpl.branding = BRANDING;
    tpl.email = decodeURIComponent(params.e || '');
    tpl.scope = decodeURIComponent(params.s || 'Global');
    tpl.token = params.t || '';
    tpl.portalUrl = getWebAppUrl_();
    return tpl.evaluate()
      .setTitle('Unsubscribe')
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

// Rounds for the password KDF below — a deliberate work-factor tradeoff:
// enough to make offline brute-forcing meaningfully slower, low enough to
// keep a single admin login well under a second in Apps Script.
const PASSWORD_HASH_STRETCH_ROUNDS_ = 10000;

/**
 * Salted, stretched password hash — "<salt>$<hex digest>". Apps Script has
 * no native bcrypt/scrypt/Argon2, so this builds a simple KDF out of
 * Utilities.computeHmacSha256Signature (the same primitive already used
 * soundly elsewhere in this file for the unsubscribe token, see
 * computeUnsubscribeToken_), iterated PASSWORD_HASH_STRETCH_ROUNDS_ times.
 * Replaces a prior unsalted single-round SHA-256 scheme that was bulk
 * rainbow-table-crackable if the Admins sheet were ever exposed.
 *
 * Pass no salt to hash a new/changed password (one is generated); pass the
 * stored salt to re-derive a hash for verification.
 */
function hashPassword_(plain, salt) {
  salt = salt || Utilities.getUuid();
  let out = String(plain) + salt;
  for (let i = 0; i < PASSWORD_HASH_STRETCH_ROUNDS_; i++) {
    out = Utilities.computeHmacSha256Signature(out, salt)
      .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  }
  return salt + '$' + out;
}

/** Constant-time string comparison, used for password hashes and reset tokens so response timing can't leak a partial match. */
function secureCompare_(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
 *
 * You MUST edit the email below before running. A random, one-time
 * password is generated and logged (View > Logs) rather than hardcoded
 * in source, so nothing guessable ever sits in version control — copy it
 * from the log and change it immediately via the normal login/reset flow.
 */
function adminSetPassword_() {
  const email = 'admin@svvevents.com';       // <-- edit before running

  const plainPassword = Utilities.getUuid();
  const sheet = getAdminsSheet_();
  const data = sheet.getDataRange().getValues();
  const hash = hashPassword_(plainPassword);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      sheet.getRange(i + 1, 2).setValue(hash);
      sheet.getRange(i + 1, 3, 1, 2).setValue('');
      Logger.log('Password updated for ' + email + '. One-time password: ' + plainPassword);
      return;
    }
  }
  sheet.appendRow([email.trim().toLowerCase(), hash, '', '']);
  Logger.log('Admin created: ' + email + '. One-time password: ' + plainPassword);
}

function adminLogin(email, password) {
  email = (email || '').trim().toLowerCase();
  if (!email || !password) throw new Error('Please enter both email and password.');

  const sheet = getAdminsSheet_();
  const data = sheet.getDataRange().getValues();

  // Same generic error for "no such admin" and "wrong password" — a
  // distinct message for each would let a caller enumerate valid admin
  // emails one guess at a time.
  const INVALID_CREDENTIALS_ERROR = 'Invalid email or password.';

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      const stored = String(data[i][1] || '');
      const sepIdx = stored.indexOf('$');
      const salt = sepIdx > -1 ? stored.slice(0, sepIdx) : '';
      if (salt && secureCompare_(stored, hashPassword_(password, salt))) {
        const token = Utilities.getUuid();
        CacheService.getScriptCache().put('admin_session_' + token, email, ADMIN_SESSION_TTL_SECONDS);
        return {
          success: true,
          token: token,
          redirectUrl: getWebAppUrl_() + '?admin=1&token=' + encodeURIComponent(token)
        };
      }
      throw new Error(INVALID_CREDENTIALS_ERROR);
    }
  }
  throw new Error(INVALID_CREDENTIALS_ERROR);
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

      sendAdminPasswordResetEmail_(email, resetUrl);
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

      if (!storedToken || !secureCompare_(storedToken, token)) throw new Error('This reset link is invalid.');
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
function getMilestonesForAttendee(sessionToken, eventId) {
  const em = requireAttendeeSession_(sessionToken);
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
function completeMilestone(sessionToken, payload) {
  const email = requireAttendeeSession_(sessionToken);
  const milestoneId = (payload && payload.milestoneId) || '';
  if (!email || !milestoneId) throw new Error('Missing email or milestone.');

  const milestone = getMilestonesRaw_().find(m => m.milestoneId === milestoneId);
  if (!milestone) throw new Error('Milestone not found.');

  const handler = MILESTONE_COMPLETION_HANDLERS_[milestone.milestoneType];
  if (!handler) throw new Error('Unsupported milestone type: ' + milestone.milestoneType);

  const result = handler(milestone, email, payload);

  // AllMilestonesCompleted fires once, right after the LAST remaining
  // milestone for this entity is completed for this attendee — the
  // log-based dedupe inside fireCommunicationTrigger_ is what keeps this
  // check from re-firing an email every time a milestone is completed
  // after the entity is already fully done.
  if (haveAllMilestonesCompleted_(milestone.eventId, email)) {
    // milestone.eventId is whichever entity the milestone was configured
    // on — a TOP-LEVEL event id OR a sub-event's own id (milestones apply
    // to either, per the MILESTONE ARCHITECTURE note). Automation bindings
    // are always keyed by (top-level EventID, SubEventID-or-blank) — see
    // saveCommAutomationBinding — so a sub-event milestone has to resolve
    // its TRUE top-level id here, or findActiveAutomations_ would look for
    // a binding under the wrong EventID and silently never match.
    const milestoneEntity = getEventById_(milestone.eventId);
    const topId = milestoneEntity ? (milestoneEntity.parentEventId || milestoneEntity.eventId) : milestone.eventId;
    const subId = (milestoneEntity && milestoneEntity.parentEventId) ? milestoneEntity.eventId : '';
    fireCommunicationTrigger_(COMM_TRIGGER_ALL_MILESTONES_DONE, topId, subId, email, {
      dedupeIdentity: COMM_TRIGGER_ALL_MILESTONES_DONE + '::' + milestone.eventId + '::' + email
    });
  }

  return result;
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
// How long an entity's own lock's CacheService entry survives if a
// release is ever missed (e.g. the execution holding it is killed
// mid-critical-section) — a safety net bounding how long a leaked lock
// can block others, not the normal hold time.
const ENTITY_LOCK_SAFETY_TTL_SECONDS = 30;
const ENTITY_LOCK_COORDINATOR_WAIT_MS = 1000;
const ENTITY_LOCK_POLL_INTERVAL_MS = 200;

/**
 * A true per-entity BLOCKING mutex, built on the same coordinator-
 * script-lock + CacheService-lease shape already proven by
 * acquireDrainLease_/releaseDrainLease_ (see the COMMUNICATIONS QUEUE
 * DRAIN section) — the difference is this one WAITS and retries until the
 * entity-specific lease is free (or timeoutMs elapses) instead of failing
 * fast, since allocation genuinely needs "wait your turn for THIS
 * entity," not "skip if someone else is already working."
 *
 * Every allocation function used to call LockService.getScriptLock()
 * directly — a single, deployment-wide lock, so an Exhibition booth
 * allocation for one event and an unrelated B2B allocation for a
 * completely different event serialized behind each other for no reason.
 * This scopes the actual wait to one entityId at a time: the coordinator
 * script lock below is held only for the few milliseconds it takes to
 * check-and-set a CacheService flag, never for the full allocation
 * critical section (which re-reads live capacity state and writes a
 * sheet row), so unrelated entities barely contend with each other at
 * all — only two callers racing for the SAME entity actually queue behind
 * one another, which is the only case that ever needed serializing.
 */
function acquireEntityLock_(entityId, timeoutMs) {
  const cacheKey = 'entity_lock_' + entityId;
  const cache = CacheService.getScriptCache();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const coordinatorLock = LockService.getScriptLock();
    if (coordinatorLock.tryLock(ENTITY_LOCK_COORDINATOR_WAIT_MS)) {
      try {
        if (!cache.get(cacheKey)) {
          const leaseId = Utilities.getUuid();
          cache.put(cacheKey, leaseId, ENTITY_LOCK_SAFETY_TTL_SECONDS);
          return leaseId;
        }
      } finally {
        coordinatorLock.releaseLock();
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('This item is busy right now — please try again in a moment.');
    }
    Utilities.sleep(ENTITY_LOCK_POLL_INTERVAL_MS);
  }
}

function releaseEntityLock_(entityId, leaseId) {
  const cacheKey = 'entity_lock_' + entityId;
  const cache = CacheService.getScriptCache();
  const coordinatorLock = LockService.getScriptLock();
  // If the coordinator lock can't be grabbed here (extremely unlikely —
  // it's only ever held for milliseconds at a time), the lease's own
  // ENTITY_LOCK_SAFETY_TTL_SECONDS is the fallback that still frees it
  // shortly after, same safety net acquireDrainLease_'s lease relies on.
  if (coordinatorLock.tryLock(ENTITY_LOCK_COORDINATOR_WAIT_MS)) {
    try {
      if (cache.get(cacheKey) === leaseId) cache.remove(cacheKey);
    } finally {
      coordinatorLock.releaseLock();
    }
  }
}

function allocateChoice_(topEventId, entity, rankedIds, email, fullName, displayLabel, extraFields) {
  if (!rankedIds || !rankedIds.length) throw new Error('Please select at least one preference for ' + entity.eventName + '.');
  const maxAllowed = entity.eventType === EVENT_TYPE_B2B_MEETINGS ? 1 : 3;
  if (rankedIds.length > maxAllowed) throw new Error('Please select at most ' + maxAllowed + ' option' + (maxAllowed === 1 ? '' : 's') + ' for ' + entity.eventName + '.');

  const leaseId = acquireEntityLock_(entity.eventId, 15000);
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
    releaseEntityLock_(entity.eventId, leaseId);
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

  const leaseId = acquireEntityLock_(entity.eventId, 15000);
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
    releaseEntityLock_(entity.eventId, leaseId);
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
  const leaseId = acquireEntityLock_(subEvent.eventId, 15000);
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
    releaseEntityLock_(subEvent.eventId, leaseId);
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
  // inside the lock above. Sheets has no cross-write transaction/rollback
  // to make this genuinely atomic either way, so the real mitigation here
  // is making a mid-process failure UNAMBIGUOUS to the admin rather than
  // pretending it can't happen: if the milestone save throws, the event
  // row is already durably saved (never lost), but the admin needs to
  // know their milestone edits specifically did NOT take, or they might
  // assume the whole save failed and re-submit a duplicate event.
  try {
    saveMilestonesForEntity_(resultEventId, payload.milestones, eventType);
  } catch (e) {
    throw new Error('The event itself was saved successfully, but its milestones failed to save: ' +
      e.message + ' Reopen "' + (payload.eventName || 'this event') + '" and save again to retry just the milestones.');
  }

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
function getDashboardEventOptions(key) {
  requireDashboardKey_(key);
  const events = getAllEvents_();
  const topLevel = events.filter(e => !e.parentEventId);
  return topLevel.map(e => ({ eventId: e.eventId, label: e.eventName, isB2B: e.isB2B }));
}

/* Legacy/standalone Dashboard.html support (single-event or all-events view) */
function getDashboardData(key, eventId) {
  requireDashboardKey_(key);
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

function getPreferencesDashboardData(key, eventId) {
  requireDashboardKey_(key);
  const registrations = eventId ? getRegistrationsRaw_().filter(r => r.eventId === eventId) : getRegistrationsRaw_();
  return getPreferencesDashboardData_(eventId, registrations);
}

/* =========================================================================
   ATTENDEE AUTHENTICATION
   ----------------------------------------------------------------------
   Every attendee-facing function used to trust a bare, client-supplied
   email string with no proof the caller actually controlled that mailbox
   — anyone could act as any known attendee straight from devtools. This
   adds a lightweight email one-time-code login: requestAttendeeLoginCode
   sends a 6-digit code to the address, verifyAttendeeLoginCode exchanges a
   correct code for an opaque session token (same CacheService-backed
   pattern already used for the admin session — see
   validateAdminToken_/requireAdmin_), and every attendee-facing function
   below now derives its trusted email from that token via
   requireAttendeeSession_ instead of accepting one as a bare argument.
   ========================================================================= */

const ATTENDEE_SESSION_TTL_SECONDS = 6 * 60 * 60; // 6 hours — CacheService's own max TTL
const ATTENDEE_OTP_TTL_SECONDS = 10 * 60;         // a code expires 10 minutes after it's sent
const ATTENDEE_OTP_COOLDOWN_SECONDS = 30;         // minimum gap between two code requests for the same email
const ATTENDEE_OTP_MAX_ATTEMPTS = 5;              // wrong-code attempts before a code is invalidated

function attendeeOtpCacheKey_(email) { return 'attendee_otp_' + email; }
function attendeeOtpCooldownKey_(email) { return 'attendee_otp_cooldown_' + email; }

/**
 * Sends a 6-digit sign-in code to `email`. Always succeeds the same way
 * regardless of whether the address is registered for anything —
 * enumerating registered attendees is not this function's business, and a
 * different response for "known" vs "unknown" emails would let it be used
 * to do exactly that (same reasoning as requestAdminPasswordReset).
 */
function requestAttendeeLoginCode(email) {
  email = (email || '').trim().toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) throw new Error('Please enter a valid email address.');

  const cache = CacheService.getScriptCache();
  if (cache.get(attendeeOtpCooldownKey_(email))) {
    throw new Error('A code was already sent. Please wait a moment before requesting another.');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  cache.put(attendeeOtpCacheKey_(email), JSON.stringify({
    code: code, attempts: 0, expiresAt: Date.now() + ATTENDEE_OTP_TTL_SECONDS * 1000
  }), ATTENDEE_OTP_TTL_SECONDS);
  cache.put(attendeeOtpCooldownKey_(email), '1', ATTENDEE_OTP_COOLDOWN_SECONDS);

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Your sign-in code — ' + BRANDING.eventTitle,
      htmlBody: '<p>Your sign-in code is:</p>' +
        '<p style="font-size:28px; font-weight:700; letter-spacing:4px;">' + escapeHtml(code) + '</p>' +
        '<p style="color:#5f6472; font-size:13px;">This code expires in ' + Math.round(ATTENDEE_OTP_TTL_SECONDS / 60) +
        ' minutes. If you didn\'t request this, you can safely ignore this email.</p>'
    });
  } catch (e) {
    throw new Error('Could not send a sign-in code right now. Please try again shortly.');
  }
  return { success: true };
}

/**
 * Exchanges a correct, unexpired code for a session token. Same
 * opaque-token-in-CacheService pattern as the admin session (see
 * validateAdminToken_) — the token itself carries no information, it's
 * just a lookup key, so there's nothing to forge.
 */
function verifyAttendeeLoginCode(email, code) {
  email = (email || '').trim().toLowerCase();
  code = String(code || '').trim();
  const cache = CacheService.getScriptCache();
  const raw = cache.get(attendeeOtpCacheKey_(email));
  if (!raw) throw new Error('This code has expired. Please request a new one.');

  let entry;
  try { entry = JSON.parse(raw); } catch (e) { throw new Error('This code has expired. Please request a new one.'); }
  if (Date.now() > entry.expiresAt) {
    cache.remove(attendeeOtpCacheKey_(email));
    throw new Error('This code has expired. Please request a new one.');
  }
  if (!secureCompare_(entry.code, code)) {
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts >= ATTENDEE_OTP_MAX_ATTEMPTS) {
      cache.remove(attendeeOtpCacheKey_(email));
      throw new Error('Too many incorrect attempts. Please request a new code.');
    }
    cache.put(attendeeOtpCacheKey_(email), JSON.stringify(entry), ATTENDEE_OTP_TTL_SECONDS);
    throw new Error('Incorrect code. Please try again.');
  }

  cache.remove(attendeeOtpCacheKey_(email)); // one-time use
  const token = Utilities.getUuid();
  cache.put('attendee_session_' + token, email, ATTENDEE_SESSION_TTL_SECONDS);
  return { success: true, sessionToken: token, email: email };
}

function validateAttendeeSessionToken_(token) {
  if (!token) return null;
  return CacheService.getScriptCache().get('attendee_session_' + token);
}

/**
 * Every attendee-facing server function must call this first, and use
 * ONLY the email it returns — never a client-supplied one — for anything
 * read or written on the caller's own behalf.
 */
function requireAttendeeSession_(token) {
  const email = validateAttendeeSessionToken_(token);
  if (!email) throw new Error('Your session has expired. Please sign in again.');
  return email;
}

/* =========================================================================
   ATTENDEE PORTAL: LANDING / LIVE EVENT TILES
   ========================================================================= */

function authenticateUserPortal(sessionToken) {
  const email = requireAttendeeSession_(sessionToken);

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
function getRegistrationFormDefinition(sessionToken, eventId) {
  const email = requireAttendeeSession_(sessionToken);
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

  // Fired AFTER the lock is released and the row is durably written —
  // fireCommunicationTrigger_ never throws, so this can never turn a
  // successful registration into a failed one.
  fireCommunicationTrigger_(COMM_TRIGGER_REGISTRATION_COMPLETE, payload.eventId, '', email, { dedupeIdentity: COMM_TRIGGER_REGISTRATION_COMPLETE + '::' + payload.eventId + '::' + registrationId });

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
function submitEventRegistrationBatch(sessionToken, eventId, attendees) {
  const completedBy = requireAttendeeSession_(sessionToken);
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');
  if (!attendees || !attendees.length) throw new Error('No attendees to register.');

  const currency = getEventCurrency_(event);
  // Fast-path check so an obviously-duplicate batch fails immediately
  // without waiting on the lock. NOT sufficient alone to prevent a
  // duplicate — see the authoritative re-check inside the lock below.
  const existingRegisteredEmails = new Set(
    getRegistrationsRaw_().filter(r => r.eventId === eventId).map(r => r.email.toLowerCase())
  );

  // Fast-path capacity check so an obviously-over-capacity batch fails
  // immediately without waiting on the lock. NOT sufficient alone to
  // prevent two concurrent batches from jointly overshooting a limited
  // standalone event's capacity — see the authoritative re-check inside
  // the lock below, which is what actually prevents the race. Umbrella
  // Events have no direct Registrations-based capacity concept here (no
  // registration record of its own). A standalone event using RANKED
  // allocation (Exhibition booths, or a Curated Event WITH options
  // configured) has its capacity enforced PER-OPTION instead, inside
  // allocateChoice_ — so it's excluded from this whole-event check both
  // here and in the authoritative re-check. Everything else (e.g. a
  // standalone "Curated Event" with no options, or a "B2B Pre-scheduled
  // Meetings" event) is checked this way.
  const usesWholeEventCapacityCheck = !event.isUmbrella && !entityUsesRankedAllocation_(event);
  if (usesWholeEventCapacityCheck) {
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
    const fullName = sanitizeForSheet_((a.fullName || '').trim());
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
    // sanitizeForSheet_ guards every column here against formula/CSV
    // injection (see its doc comment) — safe to apply blanket-wide even to
    // the non-free-text columns since it's a no-op unless a value starts
    // with =, +, -, or @.
    companyRow = MEMBERSHIP_COLUMNS.map(col => sanitizeForSheet_(c[headerToKey_(col)] || ''));
    if (a.wasNewCompany) {
      getMembershipSheet_().appendRow(companyRow);
    }

    normalizedAttendees.push({
      email: email, fullName: fullName, companyRow: companyRow,
      firstName: sanitizeForSheet_(a.firstName || ''), surname: sanitizeForSheet_(a.surname || ''), jobTitle: sanitizeForSheet_(a.jobTitle || ''),
      mobile: sanitizeForSheet_(a.mobile || ''), linkedIn: sanitizeForSheet_(a.linkedIn || ''),
      registrationType: a.registrationType || '',
      extraFields: a.extraFields || {},
      dietaryRequirements: a.dietaryRequirements || [],
      dietaryOther: sanitizeForSheet_(a.dietaryOther || ''),
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
    _rawDataCache_.registrationCounts = null; // derived from registrations — must be fresh too for the capacity re-check below
    const freshRegisteredEmails = new Set(
      getRegistrationsRaw_().filter(r => r.eventId === eventId).map(r => r.email.toLowerCase())
    );
    const nowDuplicate = normalizedAttendees.filter(a => freshRegisteredEmails.has(a.email));
    if (nowDuplicate.length) {
      throw new Error(nowDuplicate.map(a => a.email).join(', ') +
        (nowDuplicate.length > 1 ? ' are already registered' : ' is already registered') + ' for this event.');
    }

    // AUTHORITATIVE capacity re-check — same reasoning as the duplicate
    // re-check above: two concurrent batch submissions could both pass
    // the pre-lock capacity check believing there's room, then both reach
    // here. Only a fresh read taken INSIDE the lock (registrationCounts
    // was just invalidated above) can catch that; this is what actually
    // closes the race, not the pre-lock check.
    if (usesWholeEventCapacityCheck) {
      const freshCapacityState = getEventCapacityState_(event);
      if (!freshCapacityState.unlimited) {
        const remaining = Math.max(0, freshCapacityState.capacity - freshCapacityState.confirmed);
        if (attendees.length > remaining) {
          throw new Error('Only ' + remaining + ' of ' + freshCapacityState.label + ' remain for "' + event.eventName + '".');
        }
      }
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
  const allocationErrors = [];
  normalizedAttendees.forEach(a => {
    const companyObj = {};
    MEMBERSHIP_COLUMNS.forEach((col, idx) => { companyObj[headerToKey_(col)] = a.companyRow[idx]; });
    const displayLabel = companyObj.companyName || a.fullName;
    allocationsByEmail[a.email] = [];

    (a.subEventSelections || []).forEach(sel => {
      const subEntity = getEventById_(sel.subEventId);
      if (!subEntity) return;

      // The attendee's base registration is already durably committed by
      // this point (the lock above was released before this loop even
      // started), so a failure here (a LockService timeout under load, or
      // a capacity race lost after the client's own check) must NOT blow
      // up the whole batch response and hide which attendees actually got
      // registered — collect it and keep going, rather than letting one
      // exception obscure a half-processed batch after the expensive,
      // irreversible writes already happened.
      try {
        let results;
        if (subEntity.eventType === EVENT_TYPE_CURATED_EVENT && entityUsesRankedAllocation_(subEntity)) {
          results = allocateCuratedEventSelections_(eventId, subEntity, sel.rankedOptionIds || [], a.email, a.fullName, displayLabel, sel.extraFields || {});
        } else if (entityUsesRankedAllocation_(subEntity)) {
          results = [allocateChoice_(eventId, subEntity, sel.rankedOptionIds || [], a.email, a.fullName, displayLabel, sel.extraFields || {})];
        } else {
          results = [recordPlainSubEventOptIn_(eventId, subEntity, a.email, a.fullName, sel.extraFields || {})];
        }
        results.forEach(result => { allocationsByEmail[a.email].push(Object.assign({ email: a.email }, result)); });
      } catch (e) {
        allocationErrors.push({ email: a.email, fullName: a.fullName, subEventId: sel.subEventId, subEventName: subEntity.eventName, error: e.message });
      }
    });
  });

  const allocations = [].concat.apply([], normalizedAttendees.map(a => allocationsByEmail[a.email]));

  const registrationSummary = normalizedAttendees.map(a => {
    const companyObj = {};
    MEMBERSHIP_COLUMNS.forEach((col, idx) => { companyObj[headerToKey_(col)] = a.companyRow[idx]; });
    return buildAttendeeRegistrationSummary_(event, a, companyObj.companyName || '', allocationsByEmail[a.email], currency);
  });

  const pricePerRegistrant = getEventPrice_(event);

  // One RegistrationComplete trigger per attendee in the batch, after
  // every row is durably written — see the note at submitEventRegistration.
  normalizedAttendees.forEach(a => {
    fireCommunicationTrigger_(COMM_TRIGGER_REGISTRATION_COMPLETE, eventId, '', a.email, { dedupeIdentity: COMM_TRIGGER_REGISTRATION_COMPLETE + '::' + eventId + '::' + a.registrationId });
  });

  return {
    status: 'ok',
    registeredCount: normalizedAttendees.length,
    currency: currency,
    pricePerRegistrant: pricePerRegistrant,
    totalPrice: pricePerRegistrant * normalizedAttendees.length,
    allocations: allocations,
    registrationSummary: registrationSummary,
    // Every attendee above IS registered — this only lists sub-event/booth
    // selections that failed to allocate after that (see the try/catch
    // above), so the client can show "registered, but N sessions need
    // manual follow-up" instead of silently dropping the failure.
    allocationErrors: allocationErrors
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
  const fullName = sanitizeForSheet_(payload.fullName || '');
  const requirements = sanitizeForSheet_(payload.requirements || '');
  const notes = sanitizeForSheet_(payload.notes || '');
  const sheet = getDietarySheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]) === String(eventId) && String(data[i][2]).trim().toLowerCase() === email) {
        sheet.getRange(i + 1, 5).setValue(requirements);
        sheet.getRange(i + 1, 6).setValue(notes);
        return { status: 'ok' };
      }
    }
    sheet.appendRow([new Date(), eventId, email, fullName, requirements, notes]);
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
  const newDesc = sanitizeForSheet_((payload.companyDescription || '').trim());
  const newWebsite = sanitizeForSheet_((payload.website || '').trim());

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
function getMyDetailsForAttendee(sessionToken, entityId) {
  const email = requireAttendeeSession_(sessionToken);
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
function updateMyDetailsForAttendee(sessionToken, entityId, payload) {
  const email = requireAttendeeSession_(sessionToken);
  const entity = getEventById_(entityId);
  if (!entity) throw new Error('Event not found.');
  const topEventId = entity.parentEventId || entity.eventId;
  return updateCompanyDetailsInRegistrations(topEventId, Object.assign({}, payload, { email: email }));
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
function getUpdateRegistrationData(sessionToken, eventId) {
  const email = requireAttendeeSession_(sessionToken);
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
function addSubEventSelectionsForAttendee(sessionToken, eventId, selections) {
  const email = requireAttendeeSession_(sessionToken);
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
function withdrawSubEventRegistration(sessionToken, eventId, subEventId) {
  const email = requireAttendeeSession_(sessionToken);
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
function initializePreferencesSession(sessionToken, eventId) {
  const email = requireAttendeeSession_(sessionToken);
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

function savePreferences(sessionToken, eventId, payload) {
  const email = requireAttendeeSession_(sessionToken);
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
      rowsToKeep.push([timestamp, eventId, email, sanitizeForSheet_(item.companyName), sanitizeForSheet_(payload.fullName), item.targetEmail]);
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
   B2B MATCHING-ENGINE SQL BRIDGE (admin-only, one-off export)
   ----------------------------------------------------------------------
   The offline local-MySQL matching engine (attendees + preferences tables)
   has no network path to this Sheet-backed app, so there's no live sync —
   an admin instead downloads a generated .sql file of INSERT statements
   from AdminPortal.html and runs it by hand against their MySQL instance.
   See generateB2BMatchingSql for the full ID-resolution strategy.
   ========================================================================= */

/**
 * Splits a Sheets "Full Name" into { firstName, lastName } on the first
 * space. Lossy for multi-word first names — the admin can hand-edit the
 * generated SQL's attendees INSERT before running it.
 */
function splitFullName_(fullName) {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, spaceIdx), lastName: trimmed.slice(spaceIdx + 1).trim() };
}

/** ANSI-safe SQL string literal — doubles embedded single quotes. */
function sqlStr_(v) {
  return "'" + String(v == null ? '' : v).replace(/'/g, "''") + "'";
}

/**
 * Builds a downloadable .sql script that populates the offline matching
 * engine's `attendees` + `preferences` tables from this entity's (top-level
 * B2B event OR B2B sub-event) CONFIRMED SubEventRegistrations and Meeting
 * Preferences rows. Waitlisted attendees are excluded entirely.
 *
 * ID STRATEGY: attendees.ID is left to MySQL AUTO_INCREMENT — this script
 * never pre-computes IDs. The preferences block is instead generated as
 * INSERT...SELECT statements that resolve Attendee_ID/Preference_AttID by
 * joining on Email against the attendees rows the FIRST statement in this
 * same script just inserted. That only produces a correct 1-row match if
 * Email is unique in the attendees table at the moment it runs — the
 * generated header comment calls this out explicitly (recommends a
 * TRUNCATE + a UNIQUE key on attendees.Email so a stale duplicate fails
 * loudly instead of silently mismatching a join).
 *
 * PreferenceType is deliberately left out of the preferences INSERT so
 * MySQL applies its own column default — Sheets has no equivalent concept
 * to source it from today.
 */
function generateB2BMatchingSql(token, entityId) {
  const adminEmail = requireAdmin_(token);
  const entity = getEventById_(entityId);
  if (!entity) throw new Error('Event not found.');
  if (entity.eventType !== EVENT_TYPE_B2B_MEETINGS) {
    throw new Error('"' + entity.eventName + '" is not a B2B Pre-scheduled Meetings event or sub-event.');
  }

  // Confirmed allocations for this entity, joined back to the top-level
  // Registrations row for Organization/MembershipCategory — same join
  // initializePreferencesSession already does (Registrations' own
  // RegistrationType is blank for a modern B2B attendee; the allocated
  // OptionLabel IS the resolved Buyer/Supplier tier).
  const allocations = getSubEventRegsRaw_().filter(r => r.subEventId === entityId && r.status === 'Confirmed');
  if (!allocations.length) throw new Error('No confirmed attendees found for "' + entity.eventName + '".');

  const topEventId = entity.parentEventId || entity.eventId;
  const regByEmail = {};
  getRegistrationsRaw_().filter(r => r.eventId === topEventId).forEach(r => { regByEmail[r.email.toLowerCase()] = r; });

  const attendeesByEmail = {}; // dedupe: last Confirmed allocation per email wins
  allocations.forEach(a => {
    const regRow = regByEmail[a.email];
    const name = splitFullName_(a.fullName || (regRow && regRow.fullName) || '');
    attendeesByEmail[a.email] = {
      email: a.email,
      firstName: name.firstName,
      lastName: name.lastName,
      organization: (regRow && regRow.companyName) || a.companyName || '',
      membershipCategory: (regRow && regRow.membershipCategory) || '',
      registrationType: a.optionLabel || ''
    };
  });
  const attendees = Object.keys(attendeesByEmail).map(e => attendeesByEmail[e]);
  const confirmedEmails = new Set(Object.keys(attendeesByEmail));

  // Meeting Preferences rows for this entity, kept only when BOTH sides
  // are still a confirmed attendee above — everything else is reported
  // back as "skipped" instead of silently vanishing.
  const pref = getPreferencesRaw_();
  const eIdx = pref.idx['eventid'], emailIdx = pref.idx['email'], targetIdx = pref.idx['target email'];
  const pairs = [];
  const skipped = [];
  if (eIdx !== undefined && emailIdx !== undefined && targetIdx !== undefined) {
    pref.rows.forEach(row => {
      if (String(row[eIdx]) !== String(entityId)) return;
      const attendeeEmail = String(row[emailIdx] || '').trim().toLowerCase();
      const targetEmail = String(row[targetIdx] || '').trim().toLowerCase();
      if (!attendeeEmail || !targetEmail) return;
      if (confirmedEmails.has(attendeeEmail) && confirmedEmails.has(targetEmail)) {
        pairs.push({ attendeeEmail: attendeeEmail, targetEmail: targetEmail });
      } else {
        const reason = !confirmedEmails.has(attendeeEmail)
          ? attendeeEmail + ' is not a confirmed attendee'
          : targetEmail + ' (target) is not a confirmed attendee';
        skipped.push(attendeeEmail + ' -> ' + targetEmail + ': ' + reason);
      }
    });
  }

  // ---- Compose SQL ----
  const now = new Date();
  const lines = [];
  lines.push('-- B2B Matching Engine import for "' + entity.eventName + '" (EventID ' + entityId + ')');
  lines.push('-- Generated ' + now.toISOString() + ' by ' + adminEmail);
  lines.push('-- Attendees: ' + attendees.length + '  |  Preferences: ' + pairs.length + '  |  Skipped: ' + skipped.length);
  lines.push('--');
  lines.push('-- IMPORTANT: the Preferences block below resolves Attendee_ID/Preference_AttID');
  lines.push('-- by joining on Email against the attendees rows THIS SAME SCRIPT inserts first,');
  lines.push('-- so it only produces a correct match if Email is unique in the attendees table');
  lines.push('-- when it runs. Recommended: run this against a table holding just one event at');
  lines.push('-- a time (uncomment the TRUNCATE pair below), and add a UNIQUE key on');
  lines.push('-- attendees.Email so a stale duplicate fails loudly instead of silently');
  lines.push('-- mismatching a join:');
  lines.push('--   ALTER TABLE attendees MODIFY Email VARCHAR(320);');
  lines.push('--   ALTER TABLE attendees ADD UNIQUE KEY idx_att_email (Email);');
  lines.push('-- TRUNCATE TABLE preferences;');
  lines.push('-- TRUNCATE TABLE attendees;');
  lines.push('');
  lines.push('START TRANSACTION;');
  lines.push('');
  lines.push('INSERT INTO attendees (FirstName, LastName, Organization, MembershipCategory, RegistrationType, Email) VALUES');
  lines.push(attendees.map(a =>
    '  (' + [a.firstName, a.lastName, a.organization, a.membershipCategory, a.registrationType, a.email].map(sqlStr_).join(', ') + ')'
  ).join(',\n') + ';');

  if (pairs.length) {
    lines.push('');
    lines.push('-- Preferences (resolved by Email against the attendees rows inserted above)');
    pairs.forEach(pair => {
      lines.push(
        'INSERT IGNORE INTO preferences (Attendee_ID, Attendee_Org, Attendee_FullName, Preference_AttID, Preference_Org, Preference_FirstName, Preference_LastName) ' +
        "SELECT a.ID, a.Organization, CONCAT_WS(' ', a.FirstName, a.LastName), p.ID, p.Organization, p.FirstName, p.LastName " +
        'FROM attendees a JOIN attendees p ON p.Email = ' + sqlStr_(pair.targetEmail) + ' WHERE a.Email = ' + sqlStr_(pair.attendeeEmail) + ';'
      );
    });
  }

  lines.push('');
  lines.push('COMMIT;');

  if (skipped.length) {
    lines.push('');
    lines.push('-- SKIPPED preference rows (attendee or target no longer a confirmed attendee):');
    skipped.forEach(s => lines.push('--   ' + s));
  }

  const slug = entity.eventName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'event';
  const stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
  return {
    sql: lines.join('\n'),
    filename: 'b2b_matching_' + slug + '_' + stamp + '.sql',
    entityName: entity.eventName,
    attendeeCount: attendees.length,
    preferenceCount: pairs.length,
    skippedCount: skipped.length,
    skipped: skipped
  };
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

// Longer than CROSS_REQUEST_CACHE_SECONDS (60s) — these sheets are
// populated by an external B2B matching tool, not written anywhere in
// this codebase, so they change at most a few times per event lifecycle;
// a 10-minute window is safe and still reflects a re-import within
// minutes.
const MEETING_SHEET_CACHE_SECONDS = 600;

/**
 * Cached read of one Buyer/Supplier meeting sheet — { headers (lowercased
 * strings), rows (raw values, header row excluded) }. Every Date cell is
 * normalized to an ISO string up front: getCrossRequestCache_/
 * putCrossRequestCache_ round-trip through JSON, which would otherwise
 * silently turn a Date into a plain ISO string on a cache HIT while a
 * cache MISS still returns a real Date object — normalizing here once
 * keeps both paths identical so callers never need to care which one they
 * got (see formatMeetingTime_, the one place that cares about the
 * distinction between "was a Date" and "was always plain text").
 * Was previously a bare, uncached sheet.getDataRange().getValues() called
 * fresh on every itinerary view and every campaign-audience "has meetings"
 * check — for a 500-attendee B2B event that was 500+ full-sheet reads/day
 * of data that barely ever changes.
 */
function getMeetingSheetRaw_(eventId, isBuyer) {
  const cacheKeySuffix = eventId + '_' + (isBuyer ? 'buyer' : 'supplier');
  if (!_rawDataCache_.meetingSheets) _rawDataCache_.meetingSheets = {};
  if (_rawDataCache_.meetingSheets[cacheKeySuffix]) return _rawDataCache_.meetingSheets[cacheKeySuffix];

  const rawCacheKey = 'meetingSheet_' + cacheKeySuffix;
  const cached = getCrossRequestCache_(rawCacheKey);
  if (cached) {
    _rawDataCache_.meetingSheets[cacheKeySuffix] = cached;
    return cached;
  }

  const sheet = getMeetingSheet_(eventId, isBuyer);
  let out;
  if (!sheet || sheet.getLastRow() <= 1) {
    out = { headers: [], rows: [] };
  } else {
    const data = sheet.getDataRange().getValues();
    out = {
      headers: data[0].map(h => String(h).trim().toLowerCase()),
      rows: data.slice(1).map(row => row.map(cell => cell instanceof Date ? cell.toISOString() : cell))
    };
  }
  _rawDataCache_.meetingSheets[cacheKeySuffix] = out;
  putCrossRequestCache_(rawCacheKey, out, MEETING_SHEET_CACHE_SECONDS);
  return out;
}

/**
 * Formats a meeting start/end cell for display. Mirrors the original
 * inline `instanceof Date` check exactly for a same-execution, never-
 * cached read; additionally recognizes the ISO-string shape
 * getMeetingSheetRaw_ normalizes a Date into after a cache round-trip
 * (matched narrowly via the date-time-shaped regex so a plain text value
 * that happens to be parseable by `new Date()`, e.g. a bare "14:30", is
 * never mistaken for one — see getMeetingSheetRaw_'s doc comment).
 */
function formatMeetingTime_(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (raw instanceof Date) return Utilities.formatDate(raw, Session.getScriptTimeZone(), 'HH:mm');
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(raw);
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

  const mtgRaw = getMeetingSheetRaw_(eventId, isBuyerSide);
  const meetings = [];

  if (mtgRaw.rows.length) {
    const mtgHeaders = mtgRaw.headers;
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

    for (let i = 0; i < mtgRaw.rows.length; i++) {
      const row = mtgRaw.rows[i];
      const rowEmail = String(row[mEmailIdx] || '').trim().toLowerCase();
      if (rowEmail !== email) continue;

      const formattedStart = formatMeetingTime_(row[startIdx]);
      const formattedEnd = formatMeetingTime_(row[endIdx]);
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

/**
 * Client-exposed wrapper for getAttendeeItinerary — that function itself
 * stays a plain (eventId, email) helper because it's also called
 * internally with a caller-supplied email (emailItinerary below, the
 * per-recipient itinerary merge-tag block in outgoing campaign emails, and
 * the "has meetings" campaign audience filter). This wrapper is what
 * Portal.html's "My Itinerary" page actually calls, deriving the trusted
 * email from the session token rather than accepting one as an argument.
 */
function getMyAttendeeItinerary(sessionToken, eventId) {
  const email = requireAttendeeSession_(sessionToken);
  return getAttendeeItinerary(eventId, email);
}

/**
 * Emails the caller's OWN itinerary to their OWN registered address —
 * deliberately derives the recipient from the verified session rather
 * than accepting one as a client-supplied argument. Previously this
 * function accepted an arbitrary recipientEmail AND an arbitrary
 * itineraryData object straight from the browser with no ownership check,
 * which meant any anonymous visitor to this ANYONE_ANONYMOUS web app could
 * make it send arbitrary text to an arbitrary address from the deploying
 * account's mailbox — a spam/quota-drain relay. getAttendeeItinerary
 * derives the itinerary content server-side AND is itself the ownership
 * check: it throws unless a real Registrations row exists for that
 * eventId+email, so there is no path to sending to/about someone who isn't
 * actually registered.
 */
function emailItinerary(sessionToken, eventId) {
  const email = requireAttendeeSession_(sessionToken);

  const itineraryData = getAttendeeItinerary(eventId, email); // throws if not registered — this IS the ownership check

  const tableHtml = renderItineraryTableHtml_(itineraryData);
  const attachmentBlob = buildItineraryCsvAttachment_(itineraryData);

  MailApp.sendEmail({
    to: email,
    subject: `Meeting Itinerary - ${itineraryData.userName}`,
    htmlBody: tableHtml + `<p style="margin-top:20px; font-size:12px; color:#5f6368;">Sent via Event Portal</p>`,
    attachments: [attachmentBlob]
  });

  return { status: 'ok' };
}

function getAttendeeModalDetails(sessionToken, partnerEmail) {
  requireAttendeeSession_(sessionToken); // proves the caller is a signed-in attendee; partnerEmail is the intentional lookup target, not the caller's own identity
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
 * Client-exposed wrapper for lookupAttendeeInfo — lookupAttendeeInfo
 * itself stays a plain (email) function because it's also called
 * internally with a caller-supplied email (e.g. authenticateUserPortal
 * resolving the logged-in attendee's own profile after the session is
 * already verified). This wrapper is what the Portal.html "My Details"
 * modal actually calls, deriving the trusted email from the session
 * token itself rather than accepting one as an argument.
 */
function getMyAttendeeInfo(sessionToken) {
  const email = requireAttendeeSession_(sessionToken);
  return lookupAttendeeInfo(email);
}

/**
 * Prefill lookup used while adding an attendee (often a colleague, not the
 * caller) to a registration form — requires a valid session (proof the
 * caller is a signed-in portal user, closing the fully-anonymous data-
 * harvesting path) but the target email is intentionally arbitrary, not
 * the caller's own, since prefilling a colleague's known company/profile
 * info while registering them is the whole point of this call.
 */
function lookupAttendeeInfoForRegistration(sessionToken, email) {
  requireAttendeeSession_(sessionToken);
  return lookupAttendeeInfo(email);
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
  return saveProfileInternal_(payload);
}

/**
 * Client-exposed wrapper for the "My Profile" page — verifies the session
 * and overrides whatever payload.email the client sent with the verified
 * one before delegating. saveProfile(payload) itself stays callable with
 * a caller-supplied email because submitEventRegistrationBatch uses it
 * internally to save a Profile row for EVERY attendee in a batch (who may
 * be colleagues the logged-in user is registering, not themselves), which
 * is a legitimate use this session model doesn't need to (and shouldn't)
 * restrict.
 */
function saveMyProfile(sessionToken, payload) {
  const email = requireAttendeeSession_(sessionToken);
  return saveProfileInternal_(Object.assign({}, payload, { email: email }));
}

function saveProfileInternal_(payload) {
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
    const set = (key, val) => { if (idx[key] !== undefined) rowValues[idx[key]] = typeof val === 'string' ? sanitizeForSheet_(val) : val; };

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
    const set = (key, val) => { if (idx[key] !== undefined) row[idx[key]] = typeof val === 'string' ? sanitizeForSheet_(val) : val; };
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

  if (idx['Company Name'] !== undefined) sheet.getRange(rowNum, idx['Company Name'] + 1).setValue(sanitizeForSheet_(payload.companyName || ''));
  if (idx['Business Type'] !== undefined) sheet.getRange(rowNum, idx['Business Type'] + 1).setValue(sanitizeForSheet_(payload.membershipCategory || ''));
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

/**
 * Defends against formula/CSV injection: Sheets (like Excel) treats a cell
 * value starting with =, +, -, or @ as a live formula the moment a human
 * opens it in the Sheets UI — not just literal text — so an attacker-
 * controlled Full Name / Company Description / dietary note etc. could
 * otherwise become e.g. an =HYPERLINK(...) or =IMPORTXML(...) call running
 * inside an admin's own trusted spreadsheet. Prefixing a leading
 * apostrophe is the same escape Sheets' own UI uses to force plain text,
 * and Apps Script's setValue/appendRow honor it exactly the same way.
 * Only applied to free-text fields an attendee directly controls — not to
 * admin-authored content (admins already have direct edit access to the
 * underlying sheet) or to JSON-serialized fields (a JSON string always
 * starts with { or [, so it can't trigger this class of injection).
 */
function sanitizeForSheet_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Used by HtmlService templates for includes, if ever needed. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* =========================================================================
   COMMUNICATIONS FEATURE
   ----------------------------------------------------------------------
   Email template design + sending: reusable templates, audience-targeted
   admin-initiated campaigns, and automated single-recipient triggers tied
   to specific attendee actions (registration, milestones) or system events
   (admin password reset).

   Architecture: developer-authored HtmlService layout files
   (EmailLayoutDefault.html / EmailLayoutPlain.html) supply the branded
   chrome; a user-authored BODY FRAGMENT (CommunicationTemplates.BodyHtml)
   is merge-tag-substituted and injected into the layout AS DATA, never
   evaluated as template code — see renderEmailLayout_ for why that
   distinction matters (evaluating user-authored text via
   HtmlService.createTemplate() would be arbitrary code execution against
   this account's Drive/Gmail).

   ONE renderer, always: renderCommunication_() is the only function
   allowed to turn a template + context into subject/body HTML. Preview,
   test-send, automated triggers, and the campaign queue all call it with
   the same context-building logic, so what an admin previews is
   guaranteed to be what gets sent.

   New sheets (same lazy-create + ensureHeadersFresh_ pattern as every
   other sheet in this file):
     CommunicationTemplates    — reusable template definitions
     CommunicationsCampaigns   — audience-targeted, admin-initiated sends
     CommunicationsQueue       — per-recipient send state for a campaign
     CommunicationsLog         — append-only per-recipient audit trail
     CommunicationsOptOut      — unsubscribe suppression list
     CommunicationsSettings    — single operator-config row
     CommunicationsAutomations — trigger-type -> template bindings
   ========================================================================= */

// ---- Constants ----------------------------------------------------------

const COMM_CATEGORY_TRANSACTIONAL = 'Transactional';
const COMM_CATEGORY_ANNOUNCEMENT  = 'Announcement';
const COMM_CATEGORY_MARKETING     = 'Marketing';
const COMM_CATEGORIES = [COMM_CATEGORY_TRANSACTIONAL, COMM_CATEGORY_ANNOUNCEMENT, COMM_CATEGORY_MARKETING];

const COMM_BODY_MODE_FRAGMENT = 'Fragment';
const COMM_BODY_MODE_FULLHTML = 'FullHtml';

const COMM_SCOPE_EVENT  = 'Event';
const COMM_SCOPE_SYSTEM = 'System';

// v1 trigger types. Adding a new one later is: one more entry here, one
// more hook call site — same extensibility shape as
// MILESTONE_TYPES/MILESTONE_COMPLETION_HANDLERS_ above.
const COMM_TRIGGER_REGISTRATION_COMPLETE = 'RegistrationComplete';
const COMM_TRIGGER_ADMIN_PASSWORD_RESET  = 'AdminPasswordReset';
const COMM_TRIGGER_ALL_MILESTONES_DONE   = 'AllMilestonesCompleted';
const COMM_TRIGGER_MILESTONE_DEADLINE    = 'MilestoneDeadlineReminder';
const COMM_TRIGGER_TYPES = [COMM_TRIGGER_REGISTRATION_COMPLETE, COMM_TRIGGER_ADMIN_PASSWORD_RESET, COMM_TRIGGER_ALL_MILESTONES_DONE, COMM_TRIGGER_MILESTONE_DEADLINE];

const COMM_CAMPAIGN_STATUS_DRAFT     = 'Draft';
const COMM_CAMPAIGN_STATUS_QUEUED    = 'Queued';
const COMM_CAMPAIGN_STATUS_RUNNING   = 'Running';
const COMM_CAMPAIGN_STATUS_AWAITING  = 'AwaitingQuota';
const COMM_CAMPAIGN_STATUS_PAUSED    = 'Paused';
const COMM_CAMPAIGN_STATUS_COMPLETED = 'Completed';
const COMM_CAMPAIGN_STATUS_CANCELLED = 'Cancelled';
const COMM_CAMPAIGN_STATUS_FAILED    = 'Failed';

const COMM_QUEUE_STATUS_PENDING   = 'Pending';
const COMM_QUEUE_STATUS_SENDING   = 'Sending';
const COMM_QUEUE_STATUS_SENT      = 'Sent';
const COMM_QUEUE_STATUS_FAILED    = 'Failed';
const COMM_QUEUE_STATUS_CANCELLED = 'Cancelled';

const COMM_LOG_STATUS_SENT    = 'Sent';
const COMM_LOG_STATUS_FAILED  = 'Failed';
const COMM_LOG_STATUS_SKIPPED = 'Skipped';

// Queue/quota tuning — see drainCommunicationsQueue_ for how each is used.
const COMM_QUOTA_RESERVE = 10;                    // campaign sending never touches the day's last N sends — keeps admin password reset / itinerary emails always able to send
const COMM_BATCH_SOFT_LIMIT_MS = 4.5 * 60 * 1000; // stop claiming new sends this far into one drain execution (GAS trigger executions cap at 6 min)
const COMM_STATUS_FLUSH_EVERY = 25;               // flush queue/log writes to the sheet every N sends, not just at the end
const COMM_DRAIN_LEASE_KEY = 'comm_drain_lease_v1';
const COMM_DRAIN_LEASE_TTL_SECONDS = 360;
const COMM_STUCK_CLAIM_MINUTES = 15;
const COMM_DRAIN_TRIGGER_HANDLER = 'drainCommunicationsQueue_';
const COMM_REMINDER_TRIGGER_HANDLER = 'sendMilestoneDeadlineReminders_';

const COMM_TEMPLATES_HEADERS_    = ['TemplateID', 'Name', 'Category', 'LayoutId', 'BodyMode', 'Subject', 'PreheaderText', 'BodyHtml', 'EventID', 'Status', 'Version', 'UpdatedBy', 'UpdatedAt'];
const COMM_CAMPAIGNS_HEADERS_    = ['CampaignID', 'Name', 'TemplateID', 'EventID', 'AudienceSpec', 'Status', 'TotalRecipients', 'SentCount', 'FailedCount', 'CreatedBy', 'CreatedAt', 'StartedAt', 'CompletedAt', 'LastError'];
const COMM_QUEUE_HEADERS_        = ['QueueID', 'CampaignID', 'Email', 'FullName', 'Status', 'Attempts', 'QueuedAt', 'ClaimedAt', 'SentAt', 'Error'];
const COMM_LOG_HEADERS_          = ['LogID', 'Timestamp', 'CampaignID', 'TemplateID', 'TemplateName', 'EventID', 'SubEventID', 'RecipientEmail', 'RecipientName', 'Subject', 'Category', 'Status', 'ErrorMessage', 'SentBy'];
const COMM_OPTOUT_HEADERS_       = ['Email', 'Scope', 'OptedOutAt', 'Source', 'Note'];
const COMM_SETTINGS_HEADERS_     = ['FromName', 'ReplyTo', 'FooterOrgName', 'FooterPostalAddress', 'FooterText', 'DailySendCap', 'TransportType', 'AdminPasswordResetTemplateId'];
const COMM_AUTOMATIONS_HEADERS_  = ['AutomationID', 'Scope', 'EventID', 'SubEventID', 'TriggerType', 'MilestoneID', 'ReminderDaysBefore', 'TemplateID', 'Status', 'CreatedBy', 'CreatedAt'];

// ---- Sheet accessors: CommunicationTemplates -----------------------------

function getCommTemplatesSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(COMM_TEMPLATES_SHEET_NAME) || ss.insertSheet(COMM_TEMPLATES_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(COMM_TEMPLATES_HEADERS_);
  else ensureHeadersFresh_(s, COMM_TEMPLATES_HEADERS_, 'headers_checked_commtemplates');
  return s;
}

const COMM_TEMPLATES_CACHE_KEY_ = 'comm_templates_v1';

function getCommTemplatesRaw_() {
  if (_rawDataCache_.commTemplates) return _rawDataCache_.commTemplates;
  const cached = getCrossRequestCache_(COMM_TEMPLATES_CACHE_KEY_);
  if (cached) { _rawDataCache_.commTemplates = cached; return cached; }

  const sheet = getCommTemplatesSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      out.push({
        templateId: String(row[0] || ''),
        name: String(row[1] || ''),
        category: String(row[2] || COMM_CATEGORY_TRANSACTIONAL),
        layoutId: String(row[3] || 'Default'),
        bodyMode: String(row[4] || COMM_BODY_MODE_FRAGMENT),
        subject: String(row[5] || ''),
        preheaderText: String(row[6] || ''),
        bodyHtml: String(row[7] || ''),
        eventId: String(row[8] || ''),
        status: String(row[9] || 'Draft'),
        version: Number(row[10]) || 1,
        updatedBy: String(row[11] || ''),
        updatedAt: row[12] instanceof Date ? row[12].toISOString() : String(row[12] || '')
      });
    }
  }
  _rawDataCache_.commTemplates = out;
  putCrossRequestCache_(COMM_TEMPLATES_CACHE_KEY_, out);
  return out;
}

function getCommTemplateById_(templateId) {
  return getCommTemplatesRaw_().find(t => t.templateId === String(templateId)) || null;
}

function invalidateCommTemplatesCache_() {
  _rawDataCache_.commTemplates = null;
  invalidateCrossRequestCache_(COMM_TEMPLATES_CACHE_KEY_);
}

// ---- Sheet accessors: CommunicationsCampaigns ----------------------------

function getCommCampaignsSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(COMM_CAMPAIGNS_SHEET_NAME) || ss.insertSheet(COMM_CAMPAIGNS_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(COMM_CAMPAIGNS_HEADERS_);
  else ensureHeadersFresh_(s, COMM_CAMPAIGNS_HEADERS_, 'headers_checked_commcampaigns');
  return s;
}

function commCampaignRowToObj_(row) {
  let audienceSpec = {};
  try { audienceSpec = JSON.parse(row[4]) || {}; } catch (e) { audienceSpec = {}; }
  return {
    campaignId: String(row[0] || ''),
    name: String(row[1] || ''),
    templateId: String(row[2] || ''),
    eventId: String(row[3] || ''),
    audienceSpec: audienceSpec,
    status: String(row[5] || COMM_CAMPAIGN_STATUS_DRAFT),
    totalRecipients: Number(row[6]) || 0,
    sentCount: Number(row[7]) || 0,
    failedCount: Number(row[8]) || 0,
    createdBy: String(row[9] || ''),
    createdAt: row[10] instanceof Date ? row[10].toISOString() : String(row[10] || ''),
    startedAt: row[11] instanceof Date ? row[11].toISOString() : String(row[11] || ''),
    completedAt: row[12] instanceof Date ? row[12].toISOString() : String(row[12] || ''),
    lastError: String(row[13] || '')
  };
}

// Deliberately NOT cross-request cached — campaign status is polled by the
// progress UI and must always reflect the latest drain execution's writes.
function getCommCampaignsRaw_() {
  const sheet = getCommCampaignsSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) out.push(commCampaignRowToObj_(data[i]));
  }
  return out;
}

function getCommCampaignById_(campaignId) {
  return getCommCampaignsRaw_().find(c => c.campaignId === String(campaignId)) || null;
}

function findCommCampaignRowNum_(sheet, campaignId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(campaignId)) return i + 2;
  }
  return -1;
}

/** Patches specific fields of one campaign row in place — used throughout the drain loop instead of a full bulk-replace, since campaigns are read/written far more often than templates/automations. */
function updateCommCampaign_(campaignId, patch) {
  const sheet = getCommCampaignsSheet_();
  const rowNum = findCommCampaignRowNum_(sheet, campaignId);
  if (rowNum === -1) return;
  const current = commCampaignRowToObj_(sheet.getRange(rowNum, 1, 1, COMM_CAMPAIGNS_HEADERS_.length).getValues()[0]);
  const merged = Object.assign({}, current, patch);
  sheet.getRange(rowNum, 1, 1, COMM_CAMPAIGNS_HEADERS_.length).setValues([[
    merged.campaignId, merged.name, merged.templateId, merged.eventId, JSON.stringify(merged.audienceSpec || {}),
    merged.status, merged.totalRecipients, merged.sentCount, merged.failedCount, merged.createdBy,
    merged.createdAt, merged.startedAt, merged.completedAt, merged.lastError
  ]]);
}

// ---- Sheet accessors: CommunicationsQueue --------------------------------

function getCommQueueSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(COMM_QUEUE_SHEET_NAME) || ss.insertSheet(COMM_QUEUE_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(COMM_QUEUE_HEADERS_);
  else ensureHeadersFresh_(s, COMM_QUEUE_HEADERS_, 'headers_checked_commqueue');
  return s;
}

// ---- Sheet accessors: CommunicationsLog ----------------------------------

function getCommLogSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(COMM_LOG_SHEET_NAME) || ss.insertSheet(COMM_LOG_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(COMM_LOG_HEADERS_);
  else ensureHeadersFresh_(s, COMM_LOG_HEADERS_, 'headers_checked_commlog');
  return s;
}

/**
 * Appends one or more CommunicationsLog rows in a single write. Every send
 * attempt in this feature — campaign, automation, or test send — goes
 * through this, so CommunicationsLog is the one place to look for "did
 * this actually go out" regardless of which path sent it.
 */
function appendCommLogRows_(entries) {
  if (!entries || !entries.length) return;
  const sheet = getCommLogSheet_();
  const rows = entries.map(e => [
    mintId_('CLOG'), new Date(), e.campaignId || '', e.templateId || '', e.templateName || '',
    e.eventId || '', e.subEventId || '', e.recipientEmail || '', e.recipientName || '',
    e.subject || '', e.category || '', e.status, e.errorMessage || '', e.sentBy || ''
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, COMM_LOG_HEADERS_.length).setValues(rows);
  // Invalidate: this execution's cached CommunicationsLog read is now stale
  // — without this, a hasCommLogSentIdentity_ check later in the same
  // execution wouldn't see the row just appended above.
  _rawDataCache_.commLog = null;
}

/**
 * Full CommunicationsLog read, cached for the lifetime of this execution
 * only. Unlike most get*Raw_() helpers in this file, this is deliberately
 * NOT put in CacheService (see the note by _rawDataCache_ above) — the log
 * is an audit trail that must reflect the live sheet across requests.
 * Execution-scoped memoization is still worthwhile because
 * hasCommLogSentIdentity_ is called once per attendee from
 * fireCommunicationTrigger_ and once per (candidate x milestone) pair from
 * sendMilestoneDeadlineReminders_'s innermost loop — a full getValues() on
 * every call there is the dominant cost of that daily scan.
 */
function getCommLogRaw_() {
  if (_rawDataCache_.commLog) return _rawDataCache_.commLog;
  const sheet = getCommLogSheet_();
  if (sheet.getLastRow() <= 1) { _rawDataCache_.commLog = []; return []; }
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, COMM_LOG_HEADERS_.length).getValues();
  _rawDataCache_.commLog = data;
  return data;
}

/**
 * Checks CommunicationsLog for a prior Sent row matching this trigger
 * "identity" — the log-based dedupe mechanism used by AllMilestonesCompleted
 * and MilestoneDeadlineReminder instead of separate state tracking (see the
 * COMMUNICATIONS FEATURE header). identity is a free-form string the caller
 * builds to be unique per (trigger, entity, recipient[, window]) — e.g.
 * 'AllMilestonesCompleted::EVT-123::person@co.com' or
 * 'MilestoneDeadlineReminder::MS-1::person@co.com'. Stored in the log's
 * CampaignID column with a 'trigger:' prefix so it never collides with a
 * real CampaignID.
 */
function hasCommLogSentIdentity_(identity) {
  const marker = 'trigger:' + identity;
  const data = getCommLogRaw_();
  if (!data.length) return false;
  const campaignIdIdx = COMM_LOG_HEADERS_.indexOf('CampaignID');
  const statusIdx = COMM_LOG_HEADERS_.indexOf('Status');
  return data.some(row => String(row[campaignIdIdx]) === marker && String(row[statusIdx]) === COMM_LOG_STATUS_SENT);
}

// ---- Sheet accessors: CommunicationsOptOut -------------------------------

function getCommOptOutSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(COMM_OPTOUT_SHEET_NAME) || ss.insertSheet(COMM_OPTOUT_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(COMM_OPTOUT_HEADERS_);
  else ensureHeadersFresh_(s, COMM_OPTOUT_HEADERS_, 'headers_checked_commoptout');
  return s;
}

const COMM_OPTOUT_CACHE_KEY_ = 'comm_optout_v1';

function getCommOptOutRaw_() {
  if (_rawDataCache_.commOptOut) return _rawDataCache_.commOptOut;
  const cached = getCrossRequestCache_(COMM_OPTOUT_CACHE_KEY_);
  if (cached) { _rawDataCache_.commOptOut = cached; return cached; }

  const sheet = getCommOptOutSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      out.push({
        email: String(row[0] || '').trim().toLowerCase(),
        scope: String(row[1] || 'Global'), // 'Global' or a specific EventID
        optedOutAt: row[2] instanceof Date ? row[2].toISOString() : String(row[2] || ''),
        source: String(row[3] || ''),
        note: String(row[4] || '')
      });
    }
  }
  _rawDataCache_.commOptOut = out;
  putCrossRequestCache_(COMM_OPTOUT_CACHE_KEY_, out);
  return out;
}

function isOptedOut_(email, eventId) {
  const em = (email || '').trim().toLowerCase();
  return getCommOptOutRaw_().some(o => o.email === em && (o.scope === 'Global' || o.scope === String(eventId)));
}

// ---- Sheet accessors: CommunicationsSettings -----------------------------

function getCommSettingsSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(COMM_SETTINGS_SHEET_NAME) || ss.insertSheet(COMM_SETTINGS_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.appendRow(COMM_SETTINGS_HEADERS_);
    s.appendRow(['Event Portal', '', BRANDING.eventTitle, '', '', 90, 'MailApp', '']);
  } else {
    ensureHeadersFresh_(s, COMM_SETTINGS_HEADERS_, 'headers_checked_commsettings');
  }
  return s;
}

/** Single-row operator config — see COMM_SETTINGS_HEADERS_. Always returns an object even before any admin has saved settings (sensible defaults). */
function getCommSettings_() {
  const sheet = getCommSettingsSheet_();
  if (sheet.getLastRow() < 2) {
    return { fromName: 'Event Portal', replyTo: '', footerOrgName: BRANDING.eventTitle, footerPostalAddress: '', footerText: '', dailySendCap: 90, transportType: 'MailApp', adminPasswordResetTemplateId: '' };
  }
  const row = sheet.getRange(2, 1, 1, COMM_SETTINGS_HEADERS_.length).getValues()[0];
  return {
    fromName: String(row[0] || 'Event Portal'),
    replyTo: String(row[1] || ''),
    footerOrgName: String(row[2] || BRANDING.eventTitle),
    footerPostalAddress: String(row[3] || ''),
    footerText: String(row[4] || ''),
    dailySendCap: Number(row[5]) || 90,
    transportType: String(row[6] || 'MailApp'),
    adminPasswordResetTemplateId: String(row[7] || '')
  };
}

function saveCommSettings(token, settings) {
  requireAdmin_(token);
  const sheet = getCommSettingsSheet_();
  const s = settings || {};
  const row = [
    String(s.fromName || 'Event Portal').trim(),
    String(s.replyTo || '').trim(),
    String(s.footerOrgName || BRANDING.eventTitle).trim(),
    String(s.footerPostalAddress || '').trim(),
    String(s.footerText || '').trim(),
    Math.max(0, Number(s.dailySendCap) || 90),
    String(s.transportType || 'MailApp').trim(),
    String(s.adminPasswordResetTemplateId || '').trim()
  ];
  if (sheet.getLastRow() < 2) sheet.appendRow(row);
  else sheet.getRange(2, 1, 1, COMM_SETTINGS_HEADERS_.length).setValues([row]);
  return { status: 'ok' };
}

// ---- Sheet accessors: CommunicationsAutomations --------------------------

function getCommAutomationsSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(COMM_AUTOMATIONS_SHEET_NAME) || ss.insertSheet(COMM_AUTOMATIONS_SHEET_NAME);
  if (s.getLastRow() === 0) s.appendRow(COMM_AUTOMATIONS_HEADERS_);
  else ensureHeadersFresh_(s, COMM_AUTOMATIONS_HEADERS_, 'headers_checked_commautomations');
  return s;
}

const COMM_AUTOMATIONS_CACHE_KEY_ = 'comm_automations_v1';

function getCommAutomationsRaw_() {
  if (_rawDataCache_.commAutomations) return _rawDataCache_.commAutomations;
  const cached = getCrossRequestCache_(COMM_AUTOMATIONS_CACHE_KEY_);
  if (cached) { _rawDataCache_.commAutomations = cached; return cached; }

  const sheet = getCommAutomationsSheet_();
  const out = [];
  if (sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      out.push({
        automationId: String(row[0] || ''),
        scope: String(row[1] || COMM_SCOPE_EVENT),
        eventId: String(row[2] || ''),
        subEventId: String(row[3] || ''),
        triggerType: String(row[4] || ''),
        milestoneId: String(row[5] || ''),
        reminderDaysBefore: row[6] === '' || row[6] == null ? null : Number(row[6]),
        templateId: String(row[7] || ''),
        status: String(row[8] || 'Active'),
        createdBy: String(row[9] || ''),
        createdAt: row[10] instanceof Date ? row[10].toISOString() : String(row[10] || '')
      });
    }
  }
  _rawDataCache_.commAutomations = out;
  putCrossRequestCache_(COMM_AUTOMATIONS_CACHE_KEY_, out);
  return out;
}

function invalidateCommAutomationsCache_() {
  _rawDataCache_.commAutomations = null;
  invalidateCrossRequestCache_(COMM_AUTOMATIONS_CACHE_KEY_);
}

/**
 * Every Active automation matching this trigger for this event/sub-event
 * (or Scope=System for AdminPasswordReset), and — for MilestoneCompleted-
 * shaped triggers — this specific milestoneId. An entity can have more
 * than one Active binding for the same TriggerType (e.g. bound both at
 * the sub-event AND its parent event) — all matches fire.
 */
function findActiveAutomations_(triggerType, eventId, subEventId) {
  return getCommAutomationsRaw_().filter(a => {
    if (a.status !== 'Active' || a.triggerType !== triggerType) return false;
    if (a.scope === COMM_SCOPE_SYSTEM) return true;
    if (a.eventId !== String(eventId)) return false;
    if (a.subEventId && a.subEventId !== String(subEventId || '')) return false;
    return true;
  });
}

// ---- Merge tag engine -----------------------------------------------

// {{namespace.field}} — double braces, dot-namespaced, whitespace-tolerant.
const COMM_MERGE_TAG_RE_ = /\{\{\s*([a-zA-Z][\w]*(?:\.[\w]+)*)\s*\}\}/g;

/**
 * Server-rendered HTML components a template can drop in with a
 * {{block.xxx}} tag — e.g. {{block.itineraryTable}} expands to a complete
 * table, not a single value. Deliberately NOT a template language (no
 * {{#each}}/{{#if}}) — these are fixed components, each backed by a real
 * function, extensible the same way MILESTONE_COMPLETION_HANDLERS_ is:
 * add a renderer here, nothing else changes.
 */
const COMM_BLOCK_RENDERERS_ = {
  'block.itineraryTable': function(context) {
    if (!context._itineraryData) return '<p style="color:#8a8f98;">(No itinerary data available for this recipient.)</p>';
    return renderItineraryTableHtml_(context._itineraryData);
  }
};

/** Resolves a dotted path ('attendee.firstName') against a context object; returns undefined if any segment is missing. */
function resolveMergeTagPath_(path, context) {
  const parts = path.split('.');
  let cur = context;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/**
 * Single-pass substitution — NOT an iterative find/replace loop. Iterative
 * replacement re-scans already-substituted text, so a recipient whose own
 * free-text data (e.g. Company Name) happens to contain literal
 * "{{...}}" would get it expanded a second time. String.replace with a
 * callback visits the ORIGINAL string exactly once, so merged values are
 * inert by construction.
 *
 * mode: 'html' — value tags are escapeHtml()'d, block tags render raw
 *                (safe internally); used for the email body.
 *       'text' — value tags are NOT html-escaped, block tags are rejected
 *                (a table doesn't belong in a subject line); used for
 *                Subject/PreheaderText.
 *
 * Returns { text, warnings } — warnings collects every tag name that
 * didn't resolve to anything, so the caller can refuse to send (or ask
 * the admin to confirm) rather than silently mailing "{{typo}}" to 400
 * people.
 */
function substituteMergeTags_(raw, context, mode) {
  const warnings = [];
  const text = String(raw || '').replace(COMM_MERGE_TAG_RE_, function(match, tagPath) {
    if (tagPath.indexOf('block.') === 0) {
      if (mode === 'text') { warnings.push(tagPath); return ''; }
      const renderer = COMM_BLOCK_RENDERERS_[tagPath];
      if (!renderer) { warnings.push(tagPath); return ''; }
      try { return renderer(context); } catch (e) { warnings.push(tagPath + ' (render error: ' + e.message + ')'); return ''; }
    }
    const value = resolveMergeTagPath_(tagPath, context);
    if (value === undefined || value === null) { warnings.push(tagPath); return ''; }
    return mode === 'html' ? escapeHtml(value) : String(value);
  });
  return { text: text, warnings: warnings };
}

function dedupeMergeWarnings_(list) {
  const seen = {};
  const out = [];
  (list || []).forEach(w => { if (!seen[w]) { seen[w] = true; out.push(w); } });
  return out;
}

/**
 * Builds the read-mostly indexes ONE per campaign/automation batch (never
 * per-recipient) — at 250+ recipients, re-reading Registrations/
 * SubEventRegistrations per person would dominate the execution budget on
 * sheet reads alone. itineraryEntityId is optional: when set (a B2B
 * sub-event id), buildMergeContextForEmail_ will additionally attempt to
 * attach that recipient's itinerary (for {{block.itineraryTable}} /
 * {{attendee.meetingCount}}) — pass it only when the template/audience
 * actually needs it.
 */
function buildMergeIndexes_(eventId, itineraryEntityId) {
  const event = getEventById_(eventId);
  const topEventId = event ? (event.parentEventId || event.eventId) : String(eventId);

  const registrationsByEmail = {};
  getRegistrationsRaw_().filter(r => r.eventId === topEventId).forEach(r => {
    registrationsByEmail[r.email.trim().toLowerCase()] = r;
  });

  const subEventRegsByEmail = {};
  getSubEventRegsRaw_().filter(r => r.eventId === topEventId).forEach(r => {
    if (!subEventRegsByEmail[r.email]) subEventRegsByEmail[r.email] = [];
    subEventRegsByEmail[r.email].push(r);
  });

  return {
    event: event,
    topEventId: topEventId,
    registrationsByEmail: registrationsByEmail,
    subEventRegsByEmail: subEventRegsByEmail,
    onboarding: getOnboardingData_(),
    settings: getCommSettings_(),
    itineraryEntityId: itineraryEntityId || null
  };
}

function formatEventDateRange_(event) {
  if (!event) return '';
  return event.eventDate || '';
}

/**
 * Builds the full merge-tag context for ONE recipient from indexes built
 * once per batch by buildMergeIndexes_. `extra` lets a specific caller
 * (e.g. an automation firing right after a fresh registration write, or a
 * campaign that already resolved a friendlier registration type) override
 * or supplement individual fields without a second sheet read.
 */
function buildMergeContextForEmail_(indexes, email, extra) {
  const em = (email || '').trim().toLowerCase();
  const reg = indexes.registrationsByEmail[em] || {};
  const subRegs = indexes.subEventRegsByEmail[em] || [];
  const profileRow = findProfileRow_(em);
  const profileVal = function(col) { return profileRow ? String(profileRow.values[profileRow.idx[col]] || '') : ''; };

  // B2B registration-type resolution mirrors getAttendeeItinerary
  // (Code.js) — a modern B2B attendee's flat Registration Type is blank
  // and the real tier lives on their allocated sub-event option instead.
  let registrationType = reg.registrationType || '';
  const regTypesForEventType = indexes.event && indexes.onboarding[indexes.event.eventType]
    ? indexes.onboarding[indexes.event.eventType].registrationTypes : [];
  const allocation = subRegs.find(r => (r.status === 'Confirmed' || r.status === 'Waitlisted') && r.optionLabel);
  if (!registrationType && allocation) registrationType = allocation.optionLabel;

  const firstName = profileVal('FirstName') || (reg.fullName || '').split(' ')[0] || '';
  const lastName = profileVal('Surname') || (reg.fullName || '').split(' ').slice(1).join(' ') || '';

  const context = {
    attendee: Object.assign({
      fullName: reg.fullName || '',
      firstName: firstName,
      lastName: lastName,
      email: reg.email || email,
      jobTitle: profileVal('JobTitle'),
      companyName: reg.companyName || '',
      companyDescription: reg.companyDescription || '',
      membershipType: reg.membershipType || '',
      membershipCategory: reg.membershipCategory || '',
      website: reg.website || '',
      domain: reg.domain || (email.split('@')[1] || ''),
      registrationType: registrationType,
      dietaryRequirements: (reg.dietaryRequirements || '').split('|').filter(Boolean).join(', '),
      subEventStatus: allocation ? allocation.status : '',
      optionLabel: allocation ? allocation.optionLabel : '',
      meetingCount: 0
    }, extra && extra.attendee),
    event: indexes.event ? {
      name: indexes.event.eventName,
      date: indexes.event.eventDate,
      dateRange: formatEventDateRange_(indexes.event),
      time: indexes.event.eventTime,
      location: indexes.event.location,
      description: indexes.event.description,
      website: indexes.event.website,
      detailsPageUrl: indexes.event.detailsPageUrl,
      type: indexes.event.eventType
    } : {},
    portal: {
      url: getWebAppUrl_(),
      eventUrl: getWebAppUrl_() + (indexes.event ? '?eventId=' + encodeURIComponent(indexes.event.eventId) : ''),
      unsubscribeUrl: buildUnsubscribeUrl_(em, indexes.topEventId)
    },
    branding: BRANDING,
    campaign: Object.assign({
      name: '', sentDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM d, yyyy'),
      fromName: indexes.settings.fromName, footerOrgName: indexes.settings.footerOrgName,
      footerPostalAddress: indexes.settings.footerPostalAddress, footerText: indexes.settings.footerText
    }, extra && extra.campaign),
    _itineraryData: null
  };

  if (indexes.itineraryEntityId) {
    try {
      const itin = getAttendeeItinerary(indexes.itineraryEntityId, em);
      context._itineraryData = itin;
      context.attendee.meetingCount = (itin.meetings || []).filter(m => !m.isSpecialBlock).length;
    } catch (e) {
      // Not registered/allocated for that sub-event yet — leave
      // _itineraryData null; {{block.itineraryTable}} renders its "no
      // data" fallback rather than failing the whole send.
    }
  }

  return context;
}

/**
 * Lightweight context for SYSTEM-scoped sends (currently just
 * AdminPasswordReset) — the recipient is an admin, not an attendee, so
 * there's no Registrations/Profiles row to build from. Takes explicit
 * key/values instead of resolving anything from sheets.
 */
function buildSystemMergeContext_(vars) {
  const settings = getCommSettings_();
  return {
    admin: Object.assign({ email: '' }, vars && vars.admin),
    portal: Object.assign({ url: getWebAppUrl_(), resetUrl: '' }, vars && vars.portal),
    branding: BRANDING,
    settings: Object.assign({ resetTtlMinutes: RESET_TOKEN_TTL_MINUTES }, vars && vars.settings),
    campaign: { fromName: settings.fromName, footerOrgName: settings.footerOrgName, footerPostalAddress: settings.footerPostalAddress, footerText: settings.footerText },
    _itineraryData: null
  };
}

function needsUnsubscribeFooter_(template) {
  return template.category !== COMM_CATEGORY_TRANSACTIONAL;
}

/** For BodyMode=FullHtml templates (typically pasted in from an external drag-and-drop design tool as a complete document) — appends the unsubscribe footer before </body> rather than forcing the document through EmailLayoutDefault, since re-wrapping already-tested cross-client HTML risks breaking it. */
function injectUnsubscribeFooter_(html, template, context) {
  if (!needsUnsubscribeFooter_(template)) return html;
  const footer = '<div style="padding:16px 24px;font-size:11px;color:#5B6472;text-align:center;font-family:Arial,sans-serif;">' +
    escapeHtml(context.campaign.footerOrgName || '') +
    (context.campaign.footerPostalAddress ? ' &middot; ' + escapeHtml(context.campaign.footerPostalAddress) : '') +
    '<br><a href="' + context.portal.unsubscribeUrl + '" style="color:#1C7293;">Unsubscribe</a></div>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, footer + '</body>') : html + footer;
}

/**
 * Wraps an already-merged body FRAGMENT in the shared branded layout.
 * bodyHtml is assigned to the template as DATA (tpl.bodyHtml = ...), never
 * passed into HtmlService.createTemplate() itself — <?!= bodyHtml ?> in
 * the layout file EMITS it as a string. If user-authored template text
 * were instead evaluated directly as an HtmlService template, that would
 * be arbitrary Apps Script execution (full Drive/Gmail/Sheets access)
 * triggered by whatever an admin typed into a Body field. This is the one
 * line in the whole feature where getting that distinction wrong would
 * matter most.
 */
function renderEmailLayout_(layoutId, mergedBodyHtml, context, template) {
  const fileName = layoutId === 'Plain' ? 'EmailLayoutPlain' : 'EmailLayoutDefault';
  const tpl = HtmlService.createTemplateFromFile(fileName);
  tpl.branding = BRANDING;
  tpl.bodyHtml = mergedBodyHtml;
  tpl.preheader = '';
  tpl.footerOrgName = context.campaign.footerOrgName || BRANDING.eventTitle;
  tpl.footerPostalAddress = context.campaign.footerPostalAddress || '';
  tpl.footerText = context.campaign.footerText || '';
  tpl.unsubscribeUrl = needsUnsubscribeFooter_(template) ? context.portal.unsubscribeUrl : '';
  return tpl.evaluate().getContent();
}

/**
 * THE single renderer — preview, test-send, automations, and the campaign
 * queue all call this with the same context-building logic, so "what the
 * admin previewed" and "what got sent" can never drift apart into two
 * different code paths.
 */
function renderCommunication_(template, context) {
  const subjectResult = substituteMergeTags_(template.subject, context, 'text');
  const bodyResult = substituteMergeTags_(template.bodyHtml, context, 'html');
  const preheaderResult = template.preheaderText ? substituteMergeTags_(template.preheaderText, context, 'text') : { text: '', warnings: [] };

  let htmlBody;
  if (template.bodyMode === COMM_BODY_MODE_FULLHTML) {
    htmlBody = injectUnsubscribeFooter_(bodyResult.text, template, context);
  } else {
    htmlBody = renderEmailLayout_(template.layoutId, bodyResult.text, context, template);
  }

  return {
    subject: subjectResult.text.replace(/[\r\n]+/g, ' ').substring(0, 150),
    htmlBody: htmlBody,
    preheader: preheaderResult.text,
    warnings: dedupeMergeWarnings_(subjectResult.warnings.concat(bodyResult.warnings, preheaderResult.warnings))
  };
}

/** Extracted from the original emailItinerary — shared by the attendee-triggered "Email Itinerary" button AND {{block.itineraryTable}}, so both render byte-identical tables. */
function renderItineraryTableHtml_(itineraryData) {
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
      }
    });
  }
  tableHtml += `</tbody></table>`;
  return tableHtml;
}

function buildItineraryCsvAttachment_(itineraryData) {
  let csvContent = 'Appointment,Start Time,End Time,Table Number,Status,Company Name,Full Name,Meeting Type\n';
  (itineraryData.meetings || []).forEach(m => {
    if (m.isSpecialBlock) {
      csvContent += `"${m.appointment}","${m.startTime}","${m.endTime}","${m.tableNumber}","","","",""\n`;
    } else {
      csvContent += `"${m.appointment}","${m.startTime}","${m.endTime}","${m.tableNumber}","${m.status}","${m.companyName}","${m.fullName}","${m.meetingType}"\n`;
    }
  });
  const sanitizedFileName = (itineraryData.userName || 'Attendee').replace(/[^a-zA-Z0-9]/g, '_');
  return Utilities.newBlob(csvContent, 'text/csv', `Meeting_Itinerary_${sanitizedFileName}.csv`);
}

// ---- Transport ------------------------------------------------------

/**
 * The ONLY function in this feature allowed to hand a message to an email
 * transport. TransportType (CommunicationsSettings) picks the backend —
 * today only 'MailApp' is implemented, but every caller (queue drain,
 * automations, test sends) already goes through this one seam, so adding
 * 'GmailApp' or an external ESP later is a new branch here, not a rewrite
 * of the callers.
 */
function deliverEmail_(msg) {
  const settings = getCommSettings_();
  try {
    const options = {};
    if (settings.replyTo) options.replyTo = settings.replyTo;
    if (settings.fromName) options.name = settings.fromName;
    if (msg.attachments) options.attachments = msg.attachments;
    MailApp.sendEmail(Object.assign({ to: msg.to, subject: msg.subject, htmlBody: msg.htmlBody }, options));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getRemainingCommQuota_() {
  let remaining;
  try { remaining = MailApp.getRemainingDailyQuota(); } catch (e) { remaining = 0; }
  const settings = getCommSettings_();
  const capped = Math.min(remaining, settings.dailySendCap != null ? settings.dailySendCap : remaining);
  return Math.max(0, capped - COMM_QUOTA_RESERVE);
}

// ---- Unsubscribe secret ------------------------------------------------

/**
 * Lazily-generated HMAC signing secret for unsubscribe links — the first
 * real use of PropertiesService in this codebase (everything else uses
 * sheets or CacheService). ScriptProperties is the right home here
 * specifically because, unlike the spreadsheet, it is NOT shared with the
 * client organization admins the spreadsheet is shared with.
 */
function getCommHmacSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('COMM_HMAC_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('COMM_HMAC_SECRET', secret);
  }
  return secret;
}

function computeUnsubscribeToken_(email, scope) {
  const raw = Utilities.computeHmacSha256Signature(email + '|' + scope, getCommHmacSecret_());
  return Utilities.base64EncodeWebSafe(raw).substring(0, 22);
}

function buildUnsubscribeUrl_(email, eventScope) {
  const scope = eventScope || 'Global';
  const token = computeUnsubscribeToken_(email, scope);
  return getWebAppUrl_() + '?page=unsubscribe&e=' + encodeURIComponent(email) + '&s=' + encodeURIComponent(scope) + '&t=' + encodeURIComponent(token);
}

/* =========================================================================
   AUTOMATED TRIGGERS — v1: RegistrationComplete, AdminPasswordReset,
   AllMilestonesCompleted, MilestoneDeadlineReminder. Synchronous,
   single-recipient sends fired inline by the attendee's/admin's own
   action (the first three) or by a daily scheduled scan (the fourth) —
   distinct from an admin-initiated, audience-targeted Campaign below.
   ========================================================================= */

/**
 * Fires every Active automation bound to (triggerType, eventId[,
 * subEventId]) for one recipient. FAIL-SOFT BY DESIGN: this function
 * never throws — every call site is inside an existing user-facing save
 * (registration, milestone completion), and an email problem must never
 * be able to break the thing it's supposed to confirm. Errors are
 * swallowed after being logged to CommunicationsLog where possible.
 *
 * extra: { dedupeIdentity, dedupe (default true), itineraryEntityId,
 *          attendee: {...overrides}, campaign: {...overrides} }
 * Log-based dedupe (see hasCommLogSentIdentity_) is ON by default — set
 * dedupe:false for triggers that are legitimately allowed to fire more
 * than once for the same person (e.g. AdminPasswordReset, requested
 * again each time someone forgets their password).
 */
function fireCommunicationTrigger_(triggerType, eventId, subEventId, email, extra) {
  extra = extra || {};
  try {
    const em = (email || '').trim().toLowerCase();
    if (!em) return;

    const automations = findActiveAutomations_(triggerType, eventId, subEventId);
    if (!automations.length) return;

    const identity = extra.dedupeIdentity || (triggerType + '::' + (subEventId || eventId) + '::' + em);
    if (extra.dedupe !== false && hasCommLogSentIdentity_(identity)) return;

    const indexes = buildMergeIndexes_(eventId, extra.itineraryEntityId);

    automations.forEach(automation => {
      const template = getCommTemplateById_(automation.templateId);
      if (!template || template.status !== 'Active') return;

      const context = buildMergeContextForEmail_(indexes, em, extra);
      let rendered, result;
      try {
        rendered = renderCommunication_(template, context);
        result = deliverEmail_({ to: em, subject: rendered.subject, htmlBody: rendered.htmlBody });
      } catch (renderErr) {
        result = { ok: false, error: renderErr.message };
        rendered = { subject: '(render failed)' };
      }

      appendCommLogRows_([{
        campaignId: 'trigger:' + identity,
        templateId: template.templateId, templateName: template.name,
        eventId: eventId || '', subEventId: subEventId || '',
        recipientEmail: em, recipientName: context.attendee ? context.attendee.fullName : '',
        subject: rendered.subject, category: template.category,
        status: result.ok ? COMM_LOG_STATUS_SENT : COMM_LOG_STATUS_FAILED,
        errorMessage: result.ok ? '' : result.error,
        sentBy: 'system:trigger'
      }]);
    });
  } catch (e) {
    // Swallow — see function doc. Nowhere safe left to report this that
    // wouldn't risk failing the caller's own save.
  }
}

/**
 * AdminPasswordReset is System-scoped (Scope=System — no EventID) and
 * SECURITY-CRITICAL: an admin locked out of their account can't afford
 * "nobody configured a template yet." Tries the templated path if an
 * Active automation+template is bound; falls back to the original
 * hardcoded email in EVERY other case (no binding, inactive template,
 * render error, or a failed send) — template-driven is the enhancement,
 * never the only path. dedupe:false is implicit here (this isn't routed
 * through fireCommunicationTrigger_'s log-based dedupe at all) since a
 * legitimate second reset request must always go out.
 */
function sendAdminPasswordResetEmail_(email, resetUrl) {
  let sent = false;
  const automations = findActiveAutomations_(COMM_TRIGGER_ADMIN_PASSWORD_RESET, '', '');
  if (automations.length) {
    const template = getCommTemplateById_(automations[0].templateId);
    if (template && template.status === 'Active') {
      try {
        const context = buildSystemMergeContext_({ admin: { email: email }, portal: { resetUrl: resetUrl } });
        const rendered = renderCommunication_(template, context);
        const result = deliverEmail_({ to: email, subject: rendered.subject, htmlBody: rendered.htmlBody });
        appendCommLogRows_([{
          campaignId: 'trigger:' + COMM_TRIGGER_ADMIN_PASSWORD_RESET + '::system::' + email,
          templateId: template.templateId, templateName: template.name, eventId: '', subEventId: '',
          recipientEmail: email, recipientName: '', subject: rendered.subject, category: template.category,
          status: result.ok ? COMM_LOG_STATUS_SENT : COMM_LOG_STATUS_FAILED, errorMessage: result.ok ? '' : result.error,
          sentBy: 'system:trigger'
        }]);
        sent = result.ok;
      } catch (e) {
        sent = false;
      }
    }
  }

  if (!sent) {
    MailApp.sendEmail({
      to: email,
      subject: 'Reset your Admin Portal password',
      htmlBody: '<p>Click the link below to reset your Admin Portal password. This link expires in ' +
        RESET_TOKEN_TTL_MINUTES + ' minutes.</p><p><a href="' + resetUrl + '">Reset Password</a></p>'
    });
  }
}

/**
 * True once an attendee has completed EVERY milestone configured for one
 * entity (top-level event or sub-event) — reuses getMilestonesForEntity_,
 * which already handles the SetPreferences milestone type's special
 * "derived, not row-based" completion status (see that function and
 * hasSubmittedPreferences_). An entity with zero milestones configured is
 * never "complete" (there's nothing to complete), so this returns false
 * rather than vacuously true.
 */
function haveAllMilestonesCompleted_(entityId, email) {
  const milestones = getMilestonesForEntity_(entityId, email);
  if (!milestones.length) return false;
  return milestones.every(m => m.status === 'Completed');
}

/**
 * Ensures exactly one daily time-driven trigger exists for the milestone-
 * deadline-reminder scan. Idempotent — safe to call every time an admin
 * saves a MilestoneDeadlineReminder automation. Project triggers are
 * capped at 20/script/user, so this checks for an existing one by handler
 * name before creating another rather than blindly calling newTrigger.
 */
function ensureDailyReminderTrigger_() {
  const already = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === COMM_REMINDER_TRIGGER_HANDLER);
  if (already) return;
  ScriptApp.newTrigger(COMM_REMINDER_TRIGGER_HANDLER).timeBased().everyDays(1).atHour(8).create();
}

/**
 * Daily scheduled scan (NOT an inline hook — see the COMMUNICATIONS
 * FEATURE header). For every event with an Active MilestoneDeadlineReminder
 * automation, finds milestones with a DueDate, and for each attendee who
 * hasn't completed that milestone and whose DueDate falls within
 * ReminderDaysBefore days, sends one reminder — deduped per (milestone,
 * email) via CommunicationsLog so the same person isn't reminded every
 * day the window stays open. Draws on the same daily quota reserve as
 * everything else (getRemainingCommQuota_, checked once and decremented
 * locally rather than re-queried per recipient), so a reminder run on a
 * busy campaign day logs Skipped rather than erroring once quota is gone.
 *
 * Self-throttles against the 6-minute execution cap the same way
 * drainCommunicationsQueue_ does: once SOFT_LIMIT_MS has elapsed, every
 * remaining candidate is simply left for tomorrow's 8am run rather than
 * risking a hard kill mid-scan (which, unlike the queue drain, has no
 * resumption trigger of its own).
 */
function sendMilestoneDeadlineReminders_() {
  const automations = getCommAutomationsRaw_().filter(a => a.status === 'Active' && a.triggerType === COMM_TRIGGER_MILESTONE_DEADLINE);
  if (!automations.length) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const REMINDER_SOFT_LIMIT_MS = 4.5 * 60 * 1000;
  const startTime = Date.now();
  let quotaRemaining = getRemainingCommQuota_();
  let timeUp = false;

  automations.forEach(automation => {
    if (timeUp) return;
    const entityId = automation.subEventId || automation.eventId;
    if (!entityId) return;
    const daysBefore = automation.reminderDaysBefore != null ? automation.reminderDaysBefore : 3;
    const template = getCommTemplateById_(automation.templateId);
    if (!template || template.status !== 'Active') return;

    const milestonesWithDeadline = getMilestonesRaw_().filter(m => m.eventId === entityId && m.dueDate);
    if (!milestonesWithDeadline.length) return;

    // Every attendee registered at the top-level event this entity
    // belongs to is a candidate — getMilestonesForEntity_ below resolves
    // per-attendee completion status (including the SetPreferences
    // special case), so a non-eligible attendee simply shows "Completed"
    // or isn't affected either way.
    const event = getEventById_(entityId);
    const topEventId = event ? (event.parentEventId || event.eventId) : entityId;
    const candidateEmails = getRegistrationsRaw_().filter(r => r.eventId === topEventId).map(r => r.email.trim().toLowerCase());
    if (!candidateEmails.length) return;

    const indexes = buildMergeIndexes_(entityId);

    milestonesWithDeadline.forEach(milestone => {
      if (timeUp) return;
      let dueDate;
      try { dueDate = new Date(milestone.dueDate); } catch (e) { return; }
      if (isNaN(dueDate.getTime())) return;
      dueDate.setHours(0, 0, 0, 0);
      const daysUntilDue = Math.round((dueDate - today) / (24 * 60 * 60 * 1000));
      // "N days or fewer before, and not yet reminded" rather than
      // "exactly N days before" — self-healing if a quota-exhausted day
      // causes a miss (see the design note this mirrors).
      if (daysUntilDue > daysBefore || daysUntilDue < 0) return;

      candidateEmails.forEach(email => {
        if (timeUp) return;
        if (Date.now() - startTime > REMINDER_SOFT_LIMIT_MS) { timeUp = true; return; }

        if (isOptedOut_(email, topEventId)) return;
        const completion = findMilestoneCompletion_(milestone.milestoneId, email);
        const isDone = milestone.milestoneType === MILESTONE_TYPE_SET_PREFERENCES
          ? hasSubmittedPreferences_(entityId, email)
          : !!completion;
        if (isDone) return;

        const identity = COMM_TRIGGER_MILESTONE_DEADLINE + '::' + milestone.milestoneId + '::' + email;
        if (hasCommLogSentIdentity_(identity)) return;

        if (quotaRemaining <= 0) {
          appendCommLogRows_([{
            campaignId: 'trigger:' + identity, templateId: template.templateId, templateName: template.name,
            eventId: topEventId, subEventId: automation.subEventId || '', recipientEmail: email, recipientName: '',
            subject: '', category: template.category, status: COMM_LOG_STATUS_SKIPPED,
            errorMessage: 'Daily quota exhausted — will retry on next scan', sentBy: 'system:reminder'
          }]);
          return;
        }

        const context = buildMergeContextForEmail_(indexes, email, {
          attendee: { milestoneDueDate: milestone.dueDate, milestoneTitle: milestone.title }
        });
        let rendered, result;
        try {
          rendered = renderCommunication_(template, context);
          result = deliverEmail_({ to: email, subject: rendered.subject, htmlBody: rendered.htmlBody });
        } catch (e) {
          result = { ok: false, error: e.message };
          rendered = { subject: '(render failed)' };
        }
        if (result.ok) quotaRemaining--;
        appendCommLogRows_([{
          campaignId: 'trigger:' + identity, templateId: template.templateId, templateName: template.name,
          eventId: topEventId, subEventId: automation.subEventId || '', recipientEmail: email,
          recipientName: context.attendee.fullName, subject: rendered.subject, category: template.category,
          status: result.ok ? COMM_LOG_STATUS_SENT : COMM_LOG_STATUS_FAILED, errorMessage: result.ok ? '' : result.error,
          sentBy: 'system:reminder'
        }]);
      });
    });
  });
}

/* =========================================================================
   ADMIN-FACING CRUD — templates, automation bindings, settings. Called
   from AdminPortal.html's Communications panel and My Events' Automated
   Emails section.
   ========================================================================= */

function saveCommTemplate(token, payload) {
  const adminEmail = requireAdmin_(token);
  const p = payload || {};
  const name = String(p.name || '').trim();
  if (!name) throw new Error('Template name is required.');
  const category = COMM_CATEGORIES.indexOf(p.category) !== -1 ? p.category : COMM_CATEGORY_TRANSACTIONAL;
  const bodyMode = p.bodyMode === COMM_BODY_MODE_FULLHTML ? COMM_BODY_MODE_FULLHTML : COMM_BODY_MODE_FRAGMENT;
  const subject = String(p.subject || '').trim();
  if (!subject) throw new Error('Subject is required.');

  const sheet = getCommTemplatesSheet_();
  const existing = p.templateId ? getCommTemplateById_(p.templateId) : null;
  const templateId = existing ? existing.templateId : mintId_('CTMPL');
  const version = existing ? existing.version + 1 : 1;
  const row = [
    templateId, name, category, String(p.layoutId || 'Default').trim() || 'Default', bodyMode,
    subject, String(p.preheaderText || '').trim(), String(p.bodyHtml || ''), String(p.eventId || '').trim(),
    String(p.status || 'Active').trim() || 'Active', version, adminEmail, new Date()
  ];

  if (existing) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === templateId) { sheet.getRange(i + 1, 1, 1, COMM_TEMPLATES_HEADERS_.length).setValues([row]); break; }
    }
  } else {
    sheet.appendRow(row);
  }
  invalidateCommTemplatesCache_();
  return { status: 'ok', templateId: templateId };
}

function deleteCommTemplate(token, templateId) {
  requireAdmin_(token);
  const sheet = getCommTemplatesSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(templateId)) {
      sheet.getRange(i + 1, 10).setValue('Archived'); // Status column
      break;
    }
  }
  invalidateCommTemplatesCache_();
  return { status: 'ok' };
}

function listCommTemplates(token, eventId) {
  requireAdmin_(token);
  return getCommTemplatesRaw_()
    .filter(t => t.status !== 'Archived' && (!eventId || !t.eventId || t.eventId === String(eventId)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getCommTemplate(token, templateId) {
  requireAdmin_(token);
  const t = getCommTemplateById_(templateId);
  if (!t) throw new Error('Template not found.');
  return t;
}

/**
 * Upserts ONE automation binding by its natural key (scope, eventId,
 * subEventId, triggerType) — matches the UI model of one dropdown per
 * trigger row (see the My Events "Automated Emails" section). Passing
 * templateId '' / 'None' deletes the existing binding for that key rather
 * than saving an inactive one, so the sheet doesn't accumulate rows for
 * every trigger an admin ever glanced at.
 */
function saveCommAutomationBinding(token, binding) {
  const adminEmail = requireAdmin_(token);
  const b = binding || {};
  const triggerType = String(b.triggerType || '');
  if (COMM_TRIGGER_TYPES.indexOf(triggerType) === -1) throw new Error('Unknown trigger type: ' + triggerType);
  const scope = b.scope === COMM_SCOPE_SYSTEM ? COMM_SCOPE_SYSTEM : COMM_SCOPE_EVENT;
  const eventId = scope === COMM_SCOPE_SYSTEM ? '' : String(b.eventId || '').trim();
  const subEventId = String(b.subEventId || '').trim();
  const templateId = String(b.templateId || '').trim();

  const sheet = getCommAutomationsSheet_();
  const data = sheet.getLastRow() > 1 ? sheet.getDataRange().getValues() : [];
  let rowNum = -1;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[1]) === scope && String(row[2]) === eventId && String(row[3]) === subEventId && String(row[4]) === triggerType) {
      rowNum = i + 1;
      break;
    }
  }

  if (!templateId || templateId === 'None') {
    if (rowNum !== -1) sheet.deleteRow(rowNum);
    invalidateCommAutomationsCache_();
    return { status: 'ok', deleted: true };
  }

  const automationId = rowNum !== -1 ? String(data[rowNum - 1][0]) : mintId_('CAUTO');
  const reminderDaysBefore = triggerType === COMM_TRIGGER_MILESTONE_DEADLINE ? (Number(b.reminderDaysBefore) || 3) : '';
  const row = [automationId, scope, eventId, subEventId, triggerType, String(b.milestoneId || ''), reminderDaysBefore, templateId, 'Active', adminEmail, new Date()];

  if (rowNum !== -1) sheet.getRange(rowNum, 1, 1, COMM_AUTOMATIONS_HEADERS_.length).setValues([row]);
  else sheet.appendRow(row);

  invalidateCommAutomationsCache_();
  if (triggerType === COMM_TRIGGER_MILESTONE_DEADLINE) ensureDailyReminderTrigger_();
  return { status: 'ok', automationId: automationId };
}

/** Automation bindings for one entity, keyed by TriggerType, for the My Events "Automated Emails" section to pre-select each dropdown. Pass eventId='' to get System-scoped bindings (AdminPasswordReset) instead. */
function listCommAutomationsForEntity(token, eventId, subEventId) {
  requireAdmin_(token);
  const scope = eventId ? COMM_SCOPE_EVENT : COMM_SCOPE_SYSTEM;
  return getCommAutomationsRaw_().filter(a =>
    a.scope === scope &&
    (scope === COMM_SCOPE_SYSTEM || (a.eventId === String(eventId) && a.subEventId === String(subEventId || '')))
  );
}

function getCommSettings(token) {
  requireAdmin_(token);
  return getCommSettings_();
}

/* =========================================================================
   AUDIENCE, PREVIEW, TEST-SEND — Phase 3. resolveCommunicationAudience is
   the single source of truth for "who does this reach", called
   identically by the live recipient count, the preview's sample-attendee
   picker, and the actual campaign enqueue — so the number shown on screen
   and the number of emails sent can never drift apart.
   ========================================================================= */

/**
 * Batched "who has this campaign already been sent to" lookup — one
 * CommunicationsQueue read for the whole audience resolution (see
 * resolveCommunicationAudience's excludeAlreadySentCampaignId filter)
 * instead of one full-sheet read per candidate, which for a 1,000-
 * candidate resend meant 1,000 reads inside one synchronous request.
 */
function getQueueSentEmailSet_(campaignId) {
  const result = new Set();
  if (!campaignId) return result;
  const sheet = getCommQueueSheet_();
  if (sheet.getLastRow() <= 1) return result;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, COMM_QUEUE_HEADERS_.length).getValues();
  data.forEach(row => {
    if (String(row[1]) === String(campaignId) && String(row[4]) === COMM_QUEUE_STATUS_SENT) {
      result.add(String(row[2]).trim().toLowerCase());
    }
  });
  return result;
}

/**
 * Batched "who has at least one real (non-special-block) meeting"
 * lookup for one entity — reads each of the Buyer/Supplier meeting
 * sheets exactly ONCE and returns a Set of emails, instead of the
 * per-candidate getAttendeeItinerary() calls resolveCommunicationAudience
 * used to make (each of which re-read the whole sheet from scratch — see
 * that filter for why this matters at scale). A buyer-side and
 * supplier-side attendee can never share an email, so merging both
 * sheets' emails into one Set is safe and avoids replicating the
 * per-attendee buyer/supplier side resolution getAttendeeItinerary does.
 * "isSpecialBlock" mirrors getAttendeeItinerary's own definition exactly:
 * a row only counts as a real meeting if its Appointment column is a
 * non-empty number.
 */
function getEmailsWithMeetings_(eventId) {
  const result = new Set();
  [true, false].forEach(isBuyer => {
    const mtgRaw = getMeetingSheetRaw_(eventId, isBuyer); // shares the same cache getAttendeeItinerary uses
    if (!mtgRaw.rows.length) return;
    const emailIdx = mtgRaw.headers.indexOf('email');
    const apptIdx = mtgRaw.headers.indexOf('appointment');
    if (emailIdx === -1) return;
    mtgRaw.rows.forEach(row => {
      const rawAppt = apptIdx !== -1 ? String(row[apptIdx] || '').trim() : '';
      const isSpecialBlock = isNaN(Number(rawAppt)) || rawAppt === '';
      if (isSpecialBlock) return;
      const email = String(row[emailIdx] || '').trim().toLowerCase();
      if (email) result.add(email);
    });
  });
  return result;
}

/**
 * audienceSpec: { eventId, scope: 'event'|'subEvent', subEventId,
 *   filters: { registrationTypes: [], subEventStatuses: [], hasMeetings: true|false|null },
 *   manualIncludeEmails: [], manualExcludeEmails: [],
 *   templateCategory (drives opt-out suppression), excludeAlreadySentCampaignId }
 * Returns { count, sample (first 10, for the recipients table), recipientEmails
 *   (the full resolved list — what sendCampaign actually enqueues), suppressed:
 *   { optedOut, invalid, alreadySent } } so "252 matched, sending to 247" is
 *   always explainable rather than mysterious.
 */
function resolveCommunicationAudience(token, audienceSpec) {
  requireAdmin_(token);
  const spec = audienceSpec || {};
  const eventId = String(spec.eventId || '');
  if (!eventId) throw new Error('Please select an event.');
  const event = getEventById_(eventId);
  if (!event) throw new Error('Event not found.');
  const topEventId = event.parentEventId || event.eventId;

  const regsByEmail = {};
  getRegistrationsRaw_().filter(r => r.eventId === topEventId).forEach(r => { regsByEmail[r.email.trim().toLowerCase()] = r; });

  let candidates;
  if (spec.scope === 'subEvent' && spec.subEventId) {
    const subRegs = getSubEventRegsRaw_().filter(r => r.eventId === topEventId && r.subEventId === spec.subEventId);
    const byEmail = {};
    subRegs.forEach(sr => {
      const reg = regsByEmail[sr.email] || {};
      byEmail[sr.email] = Object.assign({}, reg, { email: sr.email, subEventStatus: sr.status, optionLabel: sr.optionLabel });
    });
    candidates = Object.keys(byEmail).map(em => byEmail[em]);
  } else {
    const byEmail = {};
    Object.keys(regsByEmail).forEach(em => { byEmail[em] = regsByEmail[em]; });
    candidates = Object.keys(byEmail).map(em => byEmail[em]);
  }

  const filters = spec.filters || {};
  if (filters.registrationTypes && filters.registrationTypes.length) {
    const wanted = filters.registrationTypes;
    candidates = candidates.filter(r => wanted.indexOf(r.registrationType || r.optionLabel || '') !== -1);
  }
  if (filters.subEventStatuses && filters.subEventStatuses.length && spec.scope === 'subEvent') {
    candidates = candidates.filter(r => filters.subEventStatuses.indexOf(r.subEventStatus) !== -1);
  }
  if (filters.hasMeetings === true || filters.hasMeetings === false) {
    const entityForMeetings = spec.scope === 'subEvent' ? spec.subEventId : eventId;
    const emailsWithMeetings = getEmailsWithMeetings_(entityForMeetings); // one read per sheet, not one per candidate
    candidates = candidates.filter(r => {
      const hasM = emailsWithMeetings.has(String(r.email).trim().toLowerCase());
      return filters.hasMeetings ? hasM : !hasM;
    });
  }

  (spec.manualIncludeEmails || []).forEach(raw => {
    const em = String(raw).trim().toLowerCase();
    if (em && !candidates.some(c => c.email === em)) {
      const reg = regsByEmail[em];
      if (reg) candidates.push(Object.assign({}, reg, { email: em }));
    }
  });
  const excludeSet = {};
  (spec.manualExcludeEmails || []).forEach(raw => { excludeSet[String(raw).trim().toLowerCase()] = true; });
  candidates = candidates.filter(r => !excludeSet[r.email]);

  let invalidCount = 0, optedOutCount = 0, alreadySentCount = 0;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // One CommunicationsQueue read for the whole resolution (see
  // getQueueSentEmailSet_) rather than one per candidate.
  const alreadySentEmails = spec.excludeAlreadySentCampaignId ? getQueueSentEmailSet_(spec.excludeAlreadySentCampaignId) : null;
  const finalList = candidates.filter(r => {
    if (!emailRe.test(r.email)) { invalidCount++; return false; }
    if (spec.templateCategory && spec.templateCategory !== COMM_CATEGORY_TRANSACTIONAL && isOptedOut_(r.email, topEventId)) { optedOutCount++; return false; }
    if (alreadySentEmails && alreadySentEmails.has(String(r.email).trim().toLowerCase())) { alreadySentCount++; return false; }
    return true;
  });

  return {
    count: finalList.length,
    sample: finalList.slice(0, 10).map(r => ({
      email: r.email, fullName: r.fullName || '', companyName: r.companyName || '',
      registrationType: r.registrationType || r.optionLabel || '', subEventStatus: r.subEventStatus || ''
    })),
    // Full resolved list (not just the first 10 shown in `sample`) — this
    // is what sendCampaign actually enqueues.
    recipients: finalList.map(r => ({ email: r.email, fullName: r.fullName || '' })),
    suppressed: { optedOut: optedOutCount, invalid: invalidCount, alreadySent: alreadySentCount }
  };
}

/**
 * Renders a template against a REAL recipient (default: the audience's
 * first match) — never fabricated sample data — via the same
 * renderCommunication_ the actual send uses. sampleEmail lets the admin
 * pick a different real attendee to preview against.
 */
function previewCommunication(token, templateId, audienceSpec, sampleEmail) {
  requireAdmin_(token);
  const template = getCommTemplateById_(templateId);
  if (!template) throw new Error('Template not found.');
  const spec = audienceSpec || {};

  let email = sampleEmail ? String(sampleEmail).trim().toLowerCase() : '';
  if (!email) {
    const audience = resolveCommunicationAudience(token, Object.assign({}, spec, { templateCategory: template.category }));
    if (!audience.sample.length) throw new Error('No recipients match this audience yet — cannot preview.');
    email = audience.sample[0].email;
  }

  const needsItinerary = template.bodyHtml.indexOf('block.itineraryTable') !== -1;
  const entityForItinerary = needsItinerary ? (spec.scope === 'subEvent' ? spec.subEventId : spec.eventId) : null;
  const indexes = buildMergeIndexes_(spec.eventId, entityForItinerary);
  const context = buildMergeContextForEmail_(indexes, email, { campaign: { name: '(preview)' } });
  const rendered = renderCommunication_(template, context);

  return {
    subject: rendered.subject,
    htmlBody: rendered.htmlBody,
    warnings: rendered.warnings,
    sampleAttendee: { email: email, name: context.attendee.fullName }
  };
}

/** Sends to the admin's own address (or explicit testRecipients) using the real render pipeline — logged with CampaignID 'TEST' so test sends stay visible in quota accounting rather than looking like they never happened. */
function sendTestCommunication(token, templateId, audienceSpec, sampleEmail, testRecipients) {
  const adminEmail = requireAdmin_(token);
  const preview = previewCommunication(token, templateId, audienceSpec, sampleEmail);
  const template = getCommTemplateById_(templateId);
  const recipients = ((testRecipients && testRecipients.length) ? testRecipients : [adminEmail]).map(e => String(e).trim()).filter(Boolean);
  if (!recipients.length) throw new Error('Please specify at least one test recipient.');

  const results = recipients.map(to => {
    const result = deliverEmail_({ to: to, subject: '[TEST] ' + preview.subject, htmlBody: preview.htmlBody });
    appendCommLogRows_([{
      campaignId: 'TEST', templateId: template.templateId, templateName: template.name,
      eventId: (audienceSpec && audienceSpec.eventId) || '', subEventId: (audienceSpec && audienceSpec.subEventId) || '',
      recipientEmail: to, recipientName: '', subject: '[TEST] ' + preview.subject, category: template.category,
      status: result.ok ? COMM_LOG_STATUS_SENT : COMM_LOG_STATUS_FAILED, errorMessage: result.ok ? '' : result.error, sentBy: adminEmail
    }]);
    return { to: to, ok: result.ok, error: result.error };
  });

  return { status: 'ok', results: results };
}

/* =========================================================================
   QUEUE, DRAIN, CAMPAIGN LIFECYCLE — Phase 4. A campaign can genuinely
   take several days to clear on a free-tier 100/day account, so this has
   to be resumable, idempotent, and never allowed to lock out registration
   or admin password reset. Read the drainCommunicationsQueue_ doc comment
   before touching this section — several of the choices here are load-
   bearing and NOT the same pattern as the LockService.getScriptLock()
   used elsewhere in this file.
   ========================================================================= */

/**
 * Starts a new campaign: creates the CommunicationsCampaigns row, enqueues
 * one CommunicationsQueue row per resolved recipient, then runs the FIRST
 * batch inline (synchronously, in this same request) so an admin sees
 * immediate progress instead of a blank "Queued" state — drainCommunicationsQueue_
 * self-schedules any continuation needed beyond that.
 */
function sendCampaign(token, templateId, audienceSpec, campaignName) {
  const adminEmail = requireAdmin_(token);
  const template = getCommTemplateById_(templateId);
  if (!template) throw new Error('Template not found.');
  if (template.status !== 'Active') throw new Error('Only an Active template can be sent.');

  const spec = Object.assign({}, audienceSpec, { templateCategory: template.category });
  const audience = resolveCommunicationAudience(token, spec);
  if (!audience.count) throw new Error('No recipients match this audience.');

  const campaignId = mintId_('CAMP');
  getCommCampaignsSheet_().appendRow([
    campaignId, String(campaignName || template.name).trim(), templateId, String(spec.eventId || ''),
    JSON.stringify(spec), COMM_CAMPAIGN_STATUS_QUEUED, audience.count, 0, 0, adminEmail, new Date(), '', '', ''
  ]);

  const queueSheet = getCommQueueSheet_();
  const now = new Date();
  const queueRows = audience.recipients.map(r => [mintId_('CQ'), campaignId, r.email, r.fullName, COMM_QUEUE_STATUS_PENDING, 0, now, '', '', '']);
  queueSheet.getRange(queueSheet.getLastRow() + 1, 1, queueRows.length, COMM_QUEUE_HEADERS_.length).setValues(queueRows);

  drainCommunicationsQueue_();
  return { status: 'ok', campaignId: campaignId, recipientCount: audience.count };
}

/**
 * Atomic lease acquisition WITHOUT holding LockService.getScriptLock() for
 * the whole drain. A brief tryLock(0) guards only the "check the cache
 * flag, then set it" instant — released immediately after — so two
 * concurrent drain triggers can't both proceed, while a live attendee
 * registration elsewhere never waits behind a multi-minute send batch
 * (which holding the script lock for the whole drain would cause).
 * tryLock(0), never waitLock: if another execution holds the momentary
 * check-lock, this one just treats the lease as busy and bails — it must
 * NOT queue up and retry, or two drains could interleave claims.
 */
function acquireDrainLease_() {
  const cache = CacheService.getScriptCache();
  const checkLock = LockService.getScriptLock();
  if (!checkLock.tryLock(0)) return null;
  try {
    if (cache.get(COMM_DRAIN_LEASE_KEY)) return null;
    const leaseId = Utilities.getUuid();
    cache.put(COMM_DRAIN_LEASE_KEY, leaseId, COMM_DRAIN_LEASE_TTL_SECONDS);
    return leaseId;
  } finally {
    checkLock.releaseLock();
  }
}

function releaseDrainLease_(leaseId) {
  const cache = CacheService.getScriptCache();
  if (cache.get(COMM_DRAIN_LEASE_KEY) === leaseId) cache.remove(COMM_DRAIN_LEASE_KEY);
}

/** Any queue row stuck 'Sending' for longer than a normal drain execution can possibly take is presumed to have been interrupted (execution killed mid-batch) — marked Failed rather than retried, since a killed execution may have already sent the mail before it could record success; one missing message beats a duplicate to hundreds of people. */
function reconcileStuckClaims_() {
  const sheet = getCommQueueSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const data = sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).getValues();
  const cutoff = new Date(Date.now() - COMM_STUCK_CLAIM_MINUTES * 60000);
  let changed = false;
  data.forEach(row => {
    if (String(row[4]) === COMM_QUEUE_STATUS_SENDING && row[7] instanceof Date && row[7] < cutoff) {
      row[4] = COMM_QUEUE_STATUS_FAILED;
      row[9] = 'Interrupted; not resent (stuck claim reconciled)';
      changed = true;
    }
  });
  if (changed) sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).setValues(data);
}

/** Claims up to maxCount Pending rows (skipping Paused/Cancelled campaigns) by writing Status=Sending + ClaimedAt for all of them in ONE setValues call BEFORE any sending happens — claim-before-send is what makes at-most-once achievable if this execution gets killed partway through. */
function claimQueueSlice_(maxCount) {
  const blocked = {};
  getCommCampaignsRaw_().forEach(c => { if (c.status === COMM_CAMPAIGN_STATUS_PAUSED || c.status === COMM_CAMPAIGN_STATUS_CANCELLED) blocked[c.campaignId] = true; });

  const sheet = getCommQueueSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).getValues();
  const claimed = [];
  const now = new Date();
  for (let i = 0; i < data.length && claimed.length < maxCount; i++) {
    if (String(data[i][4]) === COMM_QUEUE_STATUS_PENDING && !blocked[String(data[i][1])]) {
      data[i][4] = COMM_QUEUE_STATUS_SENDING;
      data[i][7] = now;
      claimed.push({ rowNum: i + 2, queueId: String(data[i][0]), campaignId: String(data[i][1]), email: String(data[i][2]), fullName: String(data[i][3]) });
    }
  }
  if (claimed.length) sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).setValues(data);
  return claimed;
}

function flushQueueResults_(results) {
  if (!results.length) return;
  const sheet = getCommQueueSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const data = sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).getValues();
  const byRowNum = {};
  results.forEach(r => { byRowNum[r.rowNum] = r; });
  for (let i = 0; i < data.length; i++) {
    const rowNum = i + 2;
    const r = byRowNum[rowNum];
    if (!r) continue;
    data[i][4] = r.ok ? COMM_QUEUE_STATUS_SENT : COMM_QUEUE_STATUS_FAILED;
    data[i][5] = (Number(data[i][5]) || 0) + 1;
    data[i][8] = r.ok ? new Date() : '';
    data[i][9] = r.ok ? '' : (r.error || '');
  }
  sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).setValues(data);
}

/** Reverts claimed-but-not-yet-attempted rows back to Pending immediately (rather than leaving them falsely "Sending" for up to COMM_STUCK_CLAIM_MINUTES) when a drain execution stops early because it hit its own time budget. */
function revertUnprocessedClaims_(items) {
  if (!items.length) return;
  const sheet = getCommQueueSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const data = sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).getValues();
  const rowNums = {};
  items.forEach(i => { rowNums[i.rowNum] = true; });
  let changed = false;
  for (let i = 0; i < data.length; i++) {
    if (rowNums[i + 2]) { data[i][4] = COMM_QUEUE_STATUS_PENDING; data[i][7] = ''; changed = true; }
  }
  if (changed) sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).setValues(data);
}

function queueHasClaimablePending_() {
  const blocked = {};
  getCommCampaignsRaw_().forEach(c => { if (c.status === COMM_CAMPAIGN_STATUS_PAUSED || c.status === COMM_CAMPAIGN_STATUS_CANCELLED) blocked[c.campaignId] = true; });
  const sheet = getCommQueueSheet_();
  if (sheet.getLastRow() <= 1) return false;
  const data = sheet.getRange(2, 2, sheet.getLastRow() - 1, 4).getValues(); // CampaignID, Email, FullName, Status
  return data.some(row => String(row[3]) === COMM_QUEUE_STATUS_PENDING && !blocked[String(row[0])]);
}

function campaignQueueHasStatus_(campaignId, status) {
  const sheet = getCommQueueSheet_();
  if (sheet.getLastRow() <= 1) return false;
  const data = sheet.getRange(2, 2, sheet.getLastRow() - 1, 4).getValues();
  return data.some(row => String(row[0]) === String(campaignId) && String(row[3]) === status);
}

function finalizeCompletedCampaigns_() {
  getCommCampaignsRaw_().forEach(camp => {
    if ([COMM_CAMPAIGN_STATUS_RUNNING, COMM_CAMPAIGN_STATUS_QUEUED, COMM_CAMPAIGN_STATUS_AWAITING].indexOf(camp.status) === -1) return;
    if (!campaignQueueHasStatus_(camp.campaignId, COMM_QUEUE_STATUS_PENDING) && !campaignQueueHasStatus_(camp.campaignId, COMM_QUEUE_STATUS_SENDING)) {
      updateCommCampaign_(camp.campaignId, { status: COMM_CAMPAIGN_STATUS_COMPLETED, completedAt: new Date().toISOString() });
    }
  });
}

function markQueuedCampaignsAwaitingQuota_() {
  getCommCampaignsRaw_().forEach(camp => {
    if ((camp.status === COMM_CAMPAIGN_STATUS_RUNNING || camp.status === COMM_CAMPAIGN_STATUS_QUEUED) && campaignQueueHasStatus_(camp.campaignId, COMM_QUEUE_STATUS_PENDING)) {
      updateCommCampaign_(camp.campaignId, { status: COMM_CAMPAIGN_STATUS_AWAITING });
    }
  });
}

/** Schedules the drain to resume shortly after MailApp's daily quota resets (local midnight, script timezone) — idempotent, won't double-schedule if a resume trigger already exists. */
function scheduleNextQuotaResetResume_() {
  const already = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === COMM_DRAIN_TRIGGER_HANDLER);
  if (already) return;
  const resumeAt = new Date();
  resumeAt.setDate(resumeAt.getDate() + 1);
  resumeAt.setHours(0, 15, 0, 0);
  ScriptApp.newTrigger(COMM_DRAIN_TRIGGER_HANDLER).timeBased().at(resumeAt).create();
}

function ensureDrainTriggerSoon_() {
  const already = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === COMM_DRAIN_TRIGGER_HANDLER);
  if (!already) ScriptApp.newTrigger(COMM_DRAIN_TRIGGER_HANDLER).timeBased().after(10 * 1000).create();
}

function needsItineraryEntity_(template, campaign) {
  if (!template || template.bodyHtml.indexOf('block.itineraryTable') === -1) return null;
  const spec = campaign.audienceSpec || {};
  return spec.scope === 'subEvent' ? spec.subEventId : campaign.eventId;
}

/**
 * The trigger handler — called both directly (sendCampaign's inline first
 * batch) and via ScriptApp time-driven triggers (continuations). See the
 * section header comment for why several choices here (the lease instead
 * of getScriptLock, claim-before-send, the quota reserve) are load-bearing
 * and not just style.
 */
function drainCommunicationsQueue_() {
  // Self-cleanup FIRST — the 20-trigger-per-script-per-user ceiling is
  // real; a continuation chain that forgets this hits it within a few
  // campaigns and then every future newTrigger() call throws.
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === COMM_DRAIN_TRIGGER_HANDLER).forEach(t => ScriptApp.deleteTrigger(t));

  const leaseId = acquireDrainLease_();
  if (!leaseId) return; // another execution is already draining — bail immediately, never wait

  try {
    reconcileStuckClaims_();

    const budget = getRemainingCommQuota_();
    if (budget <= 0) {
      markQueuedCampaignsAwaitingQuota_();
      scheduleNextQuotaResetResume_();
      return;
    }

    const claimed = claimQueueSlice_(Math.min(budget, 200));
    if (!claimed.length) {
      finalizeCompletedCampaigns_();
      return;
    }

    const seenCampaigns = {};
    claimed.forEach(c => {
      if (seenCampaigns[c.campaignId]) return;
      seenCampaigns[c.campaignId] = true;
      const camp = getCommCampaignById_(c.campaignId);
      if (camp && camp.status !== COMM_CAMPAIGN_STATUS_RUNNING) {
        updateCommCampaign_(c.campaignId, { status: COMM_CAMPAIGN_STATUS_RUNNING, startedAt: camp.startedAt || new Date().toISOString() });
      }
    });

    const start = Date.now();
    const templateCache = {};
    const indexesCache = {};
    const countsByCampaign = {};
    let pendingResults = [];
    let pendingLogRows = [];
    let processedCount = 0;

    for (; processedCount < claimed.length; processedCount++) {
      if (Date.now() - start > COMM_BATCH_SOFT_LIMIT_MS) break;
      const item = claimed[processedCount];

      if (!(item.campaignId in templateCache)) {
        const campaign = getCommCampaignById_(item.campaignId);
        const template = campaign ? getCommTemplateById_(campaign.templateId) : null;
        templateCache[item.campaignId] = template;
        indexesCache[item.campaignId] = (campaign && template) ? buildMergeIndexes_(campaign.eventId, needsItineraryEntity_(template, campaign)) : null;
        countsByCampaign[item.campaignId] = { sent: 0, failed: 0 };
      }

      const template = templateCache[item.campaignId];
      const indexes = indexesCache[item.campaignId];
      if (!template || !indexes) {
        pendingResults.push({ rowNum: item.rowNum, ok: false, error: 'Template or campaign not found' });
        countsByCampaign[item.campaignId].failed++;
        continue;
      }

      const campaignMeta = getCommCampaignById_(item.campaignId);
      const context = buildMergeContextForEmail_(indexes, item.email, { campaign: { name: campaignMeta ? campaignMeta.name : '' } });
      let rendered, sendResult;
      try {
        rendered = renderCommunication_(template, context);
        sendResult = deliverEmail_({ to: item.email, subject: rendered.subject, htmlBody: rendered.htmlBody });
      } catch (e) {
        sendResult = { ok: false, error: e.message };
        rendered = { subject: '(render failed)' };
      }

      pendingResults.push({ rowNum: item.rowNum, ok: sendResult.ok, error: sendResult.error });
      pendingLogRows.push({
        campaignId: item.campaignId, templateId: template.templateId, templateName: template.name,
        eventId: indexes.event ? indexes.event.eventId : '', recipientEmail: item.email,
        recipientName: context.attendee.fullName, subject: rendered.subject, category: template.category,
        status: sendResult.ok ? COMM_LOG_STATUS_SENT : COMM_LOG_STATUS_FAILED,
        errorMessage: sendResult.ok ? '' : (sendResult.error || ''), sentBy: 'system:campaign'
      });
      if (sendResult.ok) countsByCampaign[item.campaignId].sent++; else countsByCampaign[item.campaignId].failed++;

      if (pendingResults.length >= COMM_STATUS_FLUSH_EVERY) {
        flushQueueResults_(pendingResults); appendCommLogRows_(pendingLogRows);
        pendingResults = []; pendingLogRows = [];
      }
    }

    if (pendingResults.length) { flushQueueResults_(pendingResults); appendCommLogRows_(pendingLogRows); }
    if (processedCount < claimed.length) revertUnprocessedClaims_(claimed.slice(processedCount));

    Object.keys(countsByCampaign).forEach(cid => {
      const camp = getCommCampaignById_(cid);
      if (!camp) return;
      updateCommCampaign_(cid, { sentCount: camp.sentCount + countsByCampaign[cid].sent, failedCount: camp.failedCount + countsByCampaign[cid].failed });
    });

    finalizeCompletedCampaigns_();

    if (queueHasClaimablePending_()) {
      if (getRemainingCommQuota_() > 0) {
        ScriptApp.newTrigger(COMM_DRAIN_TRIGGER_HANDLER).timeBased().after(60 * 1000).create();
      } else {
        markQueuedCampaignsAwaitingQuota_();
        scheduleNextQuotaResetResume_();
      }
    }
  } finally {
    releaseDrainLease_(leaseId);
  }
}

function getCampaignStatus(token, campaignId) {
  requireAdmin_(token);
  const camp = getCommCampaignById_(campaignId);
  if (!camp) throw new Error('Campaign not found.');
  return camp;
}

function listCommCampaigns(token, eventId) {
  requireAdmin_(token);
  return getCommCampaignsRaw_()
    .filter(c => !eventId || c.eventId === String(eventId))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function pauseCampaign(token, campaignId) {
  requireAdmin_(token);
  const camp = getCommCampaignById_(campaignId);
  if (!camp) throw new Error('Campaign not found.');
  if ([COMM_CAMPAIGN_STATUS_QUEUED, COMM_CAMPAIGN_STATUS_RUNNING, COMM_CAMPAIGN_STATUS_AWAITING].indexOf(camp.status) === -1) {
    throw new Error('Only a Queued/Running/AwaitingQuota campaign can be paused.');
  }
  updateCommCampaign_(campaignId, { status: COMM_CAMPAIGN_STATUS_PAUSED });
  return { status: 'ok' };
}

function resumeCampaign(token, campaignId) {
  requireAdmin_(token);
  const camp = getCommCampaignById_(campaignId);
  if (!camp) throw new Error('Campaign not found.');
  if (camp.status !== COMM_CAMPAIGN_STATUS_PAUSED) throw new Error('Only a Paused campaign can be resumed.');
  updateCommCampaign_(campaignId, { status: COMM_CAMPAIGN_STATUS_QUEUED });
  ensureDrainTriggerSoon_();
  return { status: 'ok' };
}

function cancelCampaign(token, campaignId) {
  requireAdmin_(token);
  const camp = getCommCampaignById_(campaignId);
  if (!camp) throw new Error('Campaign not found.');
  updateCommCampaign_(campaignId, { status: COMM_CAMPAIGN_STATUS_CANCELLED, completedAt: new Date().toISOString() });

  const sheet = getCommQueueSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const data = sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).getValues();
    let changed = false;
    data.forEach(row => { if (String(row[1]) === String(campaignId) && String(row[4]) === COMM_QUEUE_STATUS_PENDING) { row[4] = COMM_QUEUE_STATUS_CANCELLED; changed = true; } });
    if (changed) sheet.getRange(2, 1, lastRow - 1, COMM_QUEUE_HEADERS_.length).setValues(data);
  }
  return { status: 'ok' };
}

function getCommLogForCampaign(token, campaignId) {
  requireAdmin_(token);
  const sheet = getCommLogSheet_();
  if (sheet.getLastRow() <= 1) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, COMM_LOG_HEADERS_.length).getValues();
  return data.filter(row => String(row[2]) === String(campaignId)).map(commLogRowToObj_).reverse();
}

function listCommLogRecent(token, eventId, limit) {
  requireAdmin_(token);
  const sheet = getCommLogSheet_();
  if (sheet.getLastRow() <= 1) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, COMM_LOG_HEADERS_.length).getValues();
  const rows = data.filter(row => !eventId || String(row[5]) === String(eventId)).map(commLogRowToObj_);
  rows.reverse();
  return rows.slice(0, limit || 100);
}

function commLogRowToObj_(row) {
  return {
    logId: String(row[0]), timestamp: row[1] instanceof Date ? row[1].toISOString() : String(row[1] || ''),
    campaignId: String(row[2]), templateId: String(row[3]), templateName: String(row[4]), eventId: String(row[5]),
    subEventId: String(row[6]), recipientEmail: String(row[7]), recipientName: String(row[8]), subject: String(row[9]),
    category: String(row[10]), status: String(row[11]), errorMessage: String(row[12]), sentBy: String(row[13])
  };
}

function getCommQuotaStatus(token) {
  requireAdmin_(token);
  let remaining = 0;
  try { remaining = MailApp.getRemainingDailyQuota(); } catch (e) { remaining = 0; }
  const settings = getCommSettings_();
  return { remaining: remaining, reserve: COMM_QUOTA_RESERVE, usable: getRemainingCommQuota_(), dailyCap: settings.dailySendCap, transportType: settings.transportType };
}

/* =========================================================================
   UNSUBSCRIBE — Phase 5. Public (no requireAdmin_) — protected instead by
   an HMAC-signed token (see computeUnsubscribeToken_/getCommHmacSecret_)
   so ?e=anyone@anywhere.com can't unsubscribe an arbitrary address.
   ========================================================================= */

function confirmUnsubscribe(email, scope, token) {
  email = (email || '').trim().toLowerCase();
  scope = scope || 'Global';
  if (!email || token !== computeUnsubscribeToken_(email, scope)) {
    throw new Error('This unsubscribe link is invalid or has expired.');
  }

  const sheet = getCommOptOutSheet_();
  const data = sheet.getLastRow() > 1 ? sheet.getDataRange().getValues() : [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email && String(data[i][1]) === scope) {
      return { status: 'ok', alreadyOptedOut: true };
    }
  }
  sheet.appendRow([email, scope, new Date(), 'Link', '']);
  _rawDataCache_.commOptOut = null;
  invalidateCrossRequestCache_(COMM_OPTOUT_CACHE_KEY_);
  return { status: 'ok', alreadyOptedOut: false };
}
