/**
 * Phase 07 -- google.script.run compatibility shim.
 *
 * Every existing call site in Portal.html (and, from Stage B onward,
 * AdminPortal.html and friends) keeps its exact original syntax --
 * google.script.run.withSuccessHandler(fn).withFailureHandler(fn).functionName(...args)
 * -- unchanged. This file replaces the Apps Script builtin with a
 * lookup-table-driven Proxy that resolves each functionName to either a
 * Supabase RPC call, a Supabase Auth SDK call, or (for the handful of
 * functions with no backend counterpart yet) a clear "not implemented"
 * error -- see FN_MAP below.
 *
 * Loaded via a plain <script src="supabase-shim.js"> tag, same as the
 * existing interactjs CDN-script precedent in AdminFloorPlan.html -- no
 * build step, consistent with how this project has always been static
 * HTML/vanilla JS.
 *
 * Must be loaded AFTER the Supabase CDN script and BEFORE any page's own
 * <script> block that calls google.script.run.
 */

(function () {
  'use strict';

  var SUPABASE_URL = 'https://dzznpdxxmlasnafxokrf.supabase.co';
  // Anon key -- safe to embed in static client code by design (protected
  // by RLS, not a secret the way a service-role key is). See Phase 06's
  // own header notes on the equivalent distinction for the Resend key.
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6em5wZHh4bWxhc25hZnhva3JmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNjUyMTIsImV4cCI6MjEwMTk0MTIxMn0.tcx_W9MLP1wT3IpzV8wHx4xDT1NyihAxzlZ2PZBidOo';

  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  var sb = window.supabaseClient;

  /** Every Postgres/Auth error normalized to {message: string} -- matches every existing call site's err.message access pattern exactly. */
  function asShimError(err) {
    if (!err) return { message: 'Unknown error.' };
    if (typeof err.message === 'string') return { message: err.message };
    return { message: String(err) };
  }

  function rpc(pgName, buildPayload) {
    return function (args) {
      var payload = buildPayload ? buildPayload(args) : undefined;
      return sb.rpc(pgName, payload).then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
    };
  }

  function notImplemented(label) {
    return function () {
      return Promise.reject({ message: label + ' is not wired up yet in the new Supabase backend (Phase 07 follow-up).' });
    };
  }

  /**
   * Stage B (AdminPortal.html) helpers -- these need more than a plain
   * RPC passthrough, so they're named functions referenced from FN_MAP
   * below rather than inline rpc(...) calls.
   */

  /** Minimal Appointment/Start/End CSV -> [{appointment,start,end}] parser -- mirrors parseB2BDiarySlotsCsv_'s column lookup, but HH:MM validation and isBreak are left to save_b2b_diary_template server-side (it already does both). No quoted-field handling -- this file has never needed one, same trust level as every other admin-pasted sheet in this app. */
  function parseSimpleDiaryCsv_(csvText) {
    var lines = String(csvText || '').replace(/\r\n/g, '\n').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) throw new Error('The uploaded file is empty.');
    var headers = lines[0].split(',').map(function (h) { return h.trim().toLowerCase(); });
    var apptIdx = headers.indexOf('appointment'), startIdx = headers.indexOf('start'), endIdx = headers.indexOf('end');
    if (apptIdx === -1 || startIdx === -1 || endIdx === -1) {
      throw new Error('Expected columns "Appointment, Start, End" — download the starter template if unsure of the format.');
    }
    var slots = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = lines[i].split(',');
      slots.push({
        appointment: (cols[apptIdx] || '').trim(),
        start: (cols[startIdx] || '').trim(),
        end: (cols[endIdx] || '').trim()
      });
    }
    return slots;
  }

  /**
   * uploadEventBannerImage -- real architecture change from the original
   * (which received base64 and wrote to Drive server-side): the client
   * uploads to the 'event-banners' Storage bucket directly, then calls
   * set_event_banner to record the path, exactly matching the call
   * pattern documented in 20260810221147_event_banner.sql's own header.
   */
  function uploadEventBannerImage_(args) {
    var payload = args[1] || {};
    var eventId = payload.eventId;
    var base64 = payload.base64;
    var fileName = String(payload.fileName || '').trim();
    var mimeType = String(payload.mimeType || 'application/octet-stream').trim();
    if (!base64 || !fileName) return Promise.reject({ message: 'Please choose an image to upload.' });

    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: mimeType });
    var path = eventId + '/' + Date.now() + '_' + fileName;

    return sb.storage.from('event-banners').upload(path, blob, { upsert: true, contentType: mimeType }).then(function (uploadRes) {
      if (uploadRes.error) throw uploadRes.error;
      return sb.rpc('set_event_banner', { p_event_id: eventId, p_storage_path: path });
    }).then(function (res) {
      if (res.error) throw res.error;
      if (res.data && res.data.oldPath) {
        sb.storage.from('event-banners').remove([res.data.oldPath]); // best-effort, not awaited -- matches original's "never lets cleanup block the new upload" intent
      }
      var publicUrl = sb.storage.from('event-banners').getPublicUrl(path).data.publicUrl;
      return { status: 'ok', bannerImageUrl: publicUrl };
    });
  }

  /** removeEventBannerImage -- clear_event_banner only clears the columns (Storage has no auto-delete-on-unlink); this does the actual blob removal the original's Drive trash step did. */
  function removeEventBannerImage_(args) {
    return sb.rpc('clear_event_banner', { p_event_id: args[1] }).then(function (res) {
      if (res.error) throw res.error;
      if (res.data && res.data.oldPath) {
        sb.storage.from('event-banners').remove([res.data.oldPath]);
      }
      return { status: 'ok' };
    });
  }

  /** uploadFloorPlanBackgroundImage (Phase 11) -- same 2-step Storage pattern as uploadEventBannerImage_, reusing the SAME 'event-banners' bucket (already admin-write RLS-gated) rather than a new one, since bucket creation isn't stable via SQL migration on this platform. */
  function uploadFloorPlanBackgroundImage_(args) {
    var payload = args[1] || {};
    var eventId = payload.eventId;
    var base64 = payload.base64;
    var fileName = String(payload.fileName || '').trim();
    var mimeType = String(payload.mimeType || 'application/octet-stream').trim();
    if (!base64 || !fileName) return Promise.reject({ message: 'Please choose an image to upload.' });

    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: mimeType });
    var path = eventId + '/floorplan_bg_' + Date.now() + '_' + fileName;

    return sb.storage.from('event-banners').upload(path, blob, { upsert: true, contentType: mimeType }).then(function (uploadRes) {
      if (uploadRes.error) throw uploadRes.error;
      return sb.rpc('set_floor_plan_background', { p_event_id: eventId, p_storage_path: path });
    }).then(function (res) {
      if (res.error) throw res.error;
      if (res.data && res.data.oldPath) {
        sb.storage.from('event-banners').remove([res.data.oldPath]); // best-effort, not awaited
      }
      var publicUrl = sb.storage.from('event-banners').getPublicUrl(path).data.publicUrl;
      return { status: 'ok', backgroundImageUrl: publicUrl };
    });
  }

  /** clearFloorPlanBackgroundImage (Phase 11) -- mirrors removeEventBannerImage_. */
  function clearFloorPlanBackgroundImage_(args) {
    return sb.rpc('clear_floor_plan_background', { p_event_id: args[1] }).then(function (res) {
      if (res.error) throw res.error;
      if (res.data && res.data.oldPath) {
        sb.storage.from('event-banners').remove([res.data.oldPath]);
      }
      return { status: 'ok' };
    });
  }

  /** sendTestCommunication -- original sends the SAME rendered preview to every recipient (no per-recipient personalization); test_send_communication already renders + delivers in one call, so this just loops it once per recipient, same shape as the original's own .map(). */
  function sendTestCommunication_(args) {
    var templateId = args[1];
    var testRecipients = args[4];
    var recipients = ((testRecipients && testRecipients.length) ? testRecipients : []).map(function (e) { return String(e).trim(); }).filter(Boolean);
    var recipientsPromise = recipients.length
      ? Promise.resolve(recipients)
      : sb.auth.getSession().then(function (sessionRes) {
          var email = sessionRes && sessionRes.data && sessionRes.data.session && sessionRes.data.session.user.email;
          if (!email) throw new Error('Please specify at least one test recipient.');
          return [email];
        });

    return recipientsPromise.then(function (finalRecipients) {
      return Promise.all(finalRecipients.map(function (to) {
        return sb.rpc('test_send_communication', { p_template_id: templateId, p_to_email: to }).then(function (res) {
          if (res.error) return { to: to, ok: false, error: res.error.message };
          return { to: to, ok: true };
        });
      }));
    }).then(function (results) {
      return { status: 'ok', results: results };
    });
  }

  /** saveB2BDiaryTemplate -- the shim parses the uploaded CSV client-side (parseSimpleDiaryCsv_) since save_b2b_diary_template takes pre-parsed jsonb slots, not raw CSV text the way the original Apps Script RPC did. */
  function saveB2BDiaryTemplate_(args) {
    var entityId = args[1], side = args[2], csvText = args[3];
    var slots;
    try {
      slots = parseSimpleDiaryCsv_(csvText);
    } catch (e) {
      return Promise.reject(e);
    }
    return sb.rpc('save_b2b_diary_template', { p_entity_id: entityId, p_side: side, p_slots: slots }).then(function (res) {
      if (res.error) throw res.error;
      return res.data;
    });
  }

  /**
   * resolveCommunicationAudience / sendCampaign -- AdminPortal.html's
   * buildCommAudienceSpec() nests registrationTypes/subEventStatuses/
   * hasMeetings under spec.filters, but resolve_communication_audience
   * (Phase 06) reads them flat off the top-level audience_spec object --
   * a real shape mismatch between the never-wired-up UI and the RPC
   * built without it in view. Flattened here, once, rather than
   * reshaping buildCommAudienceSpec's stable return value used by four
   * other call sites too.
   */
  function flattenAudienceSpec_(spec) {
    var flat = {};
    if (spec.filters) {
      flat.registrationTypes = spec.filters.registrationTypes;
      flat.subEventStatuses = spec.filters.subEventStatuses;
      flat.hasMeetings = spec.filters.hasMeetings;
    }
    if (spec.excludeEmails) flat.excludeEmails = spec.excludeEmails;
    return flat;
  }

  function audienceEventId_(spec) {
    return (spec.scope === 'subEvent' && spec.subEventId) ? spec.subEventId : spec.eventId;
  }

  /**
   * Some Communications RPCs from Phase 06 (list_comm_templates,
   * list_comm_campaigns, get_comm_log_for_campaign, get_comm_settings,
   * list_comm_automations_for_entity) `return setof <table>`/`returns
   * <table>` directly -- raw snake_case DB columns, never reshaped into
   * the camelCase AdminPortal.html expects everywhere (a pre-existing
   * Phase 06 gap, only surfaced once this frontend was actually wired up
   * and click-tested -- e.g. `id` read as `t.templateId` was silently
   * `undefined`, which made "Edit" on an existing template behave like a
   * fresh create instead of an update). Converted here rather than
   * touching the already-tested RPCs themselves.
   */
  function snakeToCamel_(s) {
    return s.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
  }
  function toCamelRow_(row, idKey) {
    if (!row || typeof row !== 'object') return row;
    var out = {};
    Object.keys(row).forEach(function (k) {
      out[(k === 'id' && idKey) ? idKey : snakeToCamel_(k)] = row[k];
    });
    return out;
  }
  function toCamelRows_(rows, idKey) {
    return (rows || []).map(function (r) { return toCamelRow_(r, idKey); });
  }

  /**
   * Name -> async (argsArray) => result. `args` are the ORIGINAL
   * positional arguments from the unchanged call site, in order --
   * including the old sessionToken, which every entry below simply
   * ignores: Supabase Auth's own session (attached automatically by the
   * client to every request) replaces it entirely, the same way
   * current_attendee_email() replaced the server-side sessionToken
   * lookup on the Postgres side back in Phase 04/05.
   */
  var FN_MAP = {
    // ---- Auth (Supabase Auth SDK, not .rpc()) ----
    requestAttendeeLoginCode: function (args) {
      var email = args[0];
      return sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(function (res) {
        if (res.error) throw res.error;
        return { status: 'ok' };
      });
    },
    verifyAttendeeLoginCode: function (args) {
      var email = args[0], code = args[1];
      return sb.auth.verifyOtp({ email: email, token: code, type: 'email' }).then(function (res) {
        if (res.error) throw res.error;
        return { sessionToken: res.data.session ? res.data.session.access_token : '', email: res.data.user ? res.data.user.email : email };
      });
    },
    adminLogin: function (args) {
      var email = args[0], password = args[1];
      return sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        if (res.error) return { success: false, message: res.error.message };
        // signInWithPassword only proves valid Supabase Auth credentials --
        // it says nothing about whether this account is a tenant admin, so
        // any authenticated user (e.g. an attendee who also has a
        // password set) would otherwise sail through login and only hit
        // "Caller is not a tenant admin" later, as a raw Postgres error,
        // from the first admin RPC call inside the shell
        // (get_admin_events_tree in AdminPortal.html's loadEventsList).
        // Probe that same tenant-admin-gated RPC here instead, before
        // ever reporting success, and undo the sign-in if it rejects --
        // so a non-admin never sees the admin shell at all.
        return sb.rpc('get_admin_events_tree').then(function (probeRes) {
          if (probeRes.error) {
            return sb.auth.signOut().then(function () {
              return { success: false, message: 'This account is not an admin for this tenant.' };
            });
          }
          return { success: true, redirectUrl: 'AdminPortal.html' };
        });
      });
    },
    requestAdminPasswordReset: function (args) {
      var email = args[0];
      var redirectTo = window.location.origin + '/Portal.html';
      return sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo }).then(function (res) {
        if (res.error) throw res.error;
        return { message: 'If that email is registered, a password reset link has been sent.' };
      });
    },

    // ---- The one bundle-loader RPC (get_attendee_portal_data) ----
    authenticateUserPortal: rpc('get_attendee_portal_data'),

    // ---- Registration / milestones / profile ----
    getRegistrationFormDefinition: rpc('get_registration_form_definition', function (args) {
      return { p_event_id: args[1] };
    }),
    submitEventRegistrationBatch: rpc('submit_event_registration_batch', function (args) {
      return { p_event_id: args[1], p_attendees: args[2] };
    }),
    getMilestonesForAttendee: rpc('get_milestones_for_attendee', function (args) {
      return { p_event_id: args[1] };
    }),
    completeMilestone: rpc('complete_milestone', function (args) {
      var payload = args[1];
      return { p_milestone_id: payload.milestoneId, p_payload: payload };
    }),
    getMyAttendeeInfo: rpc('get_my_attendee_info', function () { return {}; }),
    saveMyProfile: rpc('save_my_profile', function (args) {
      // save_my_profile now requires an event_id (profiles are
      // tenant-scoped, resolved via events.id) that the old 2-arg call
      // never had to supply -- reach into the shared portalState global
      // for the attendee's first known event rather than touching the
      // call site itself.
      var eventId = (window.portalState && portalState.tiles && portalState.tiles.length) ? portalState.tiles[0].eventId : null;
      return { p_event_id: eventId, p_payload: args[1] };
    }),

    // ---- B2B meetings ----
    initializePreferencesSession: rpc('initialize_b2b_preferences_session', function (args) {
      return { p_event_id: args[1] };
    }),
    savePreferences: rpc('save_b2b_meeting_preferences', function (args) {
      var payload = args[2];
      return { p_event_id: args[1], p_selections: (payload && payload.selectedSelections) || [] };
    }),
    getMyChosenByReport: rpc('get_my_chosen_by_report', function (args) {
      return { p_event_id: args[1] };
    }),
    cancelB2BMeeting: rpc('cancel_b2b_meeting', function (args) {
      return { p_event_id: args[1], p_meeting_ref: args[2], p_message: args[3] || '' };
    }),
    getB2BMeetingCandidates: rpc('get_b2b_meeting_candidates', function (args) {
      return { p_event_id: args[1], p_appointment: args[2], p_filter: args[3] || null };
    }),
    requestB2BMeeting: rpc('request_b2b_meeting', function (args) {
      return { p_event_id: args[1], p_appointment: args[2], p_target_email: args[3] };
    }),
    respondToB2BMeeting: rpc('respond_to_b2b_meeting', function (args) {
      return { p_event_id: args[1], p_meeting_ref: args[2], p_accept: args[3] };
    }),
    blockB2BMeetingSlot: rpc('block_b2b_meeting_slot', function (args) {
      return { p_event_id: args[1], p_appointment: args[2], p_note: args[3] || '' };
    }),
    unblockB2BMeetingSlot: rpc('unblock_b2b_meeting_slot', function (args) {
      return { p_event_id: args[1], p_appointment: args[2] };
    }),

    // ---- Phase 08: wired up for real (were stubbed in Phase 07 Stage A) ----
    getMyDetailsForAttendee: rpc('get_my_details_for_attendee', function (args) {
      return { p_entity_id: args[1] };
    }),
    updateMyDetailsForAttendee: rpc('update_my_details_for_attendee', function (args) {
      return { p_entity_id: args[1], p_payload: args[2] };
    }),
    getEventDetailsForAttendee: rpc('get_event_details_for_attendee', function (args) {
      return { p_event_id: args[0] };
    }),

    // ---- Genuine gaps, deliberately stubbed per explicit scope decision
    // (Phase 07 Stage A covers register / complete a milestone / request
    // a B2B meeting -- these aren't on that path) ----
    getUpdateRegistrationData: rpc('get_update_registration_data', function (args) { return { p_event_id: args[1] }; }),
    addSubEventSelectionsForAttendee: rpc('add_sub_event_selections_for_attendee', function (args) {
      return { p_event_id: args[1], p_selections: args[2] };
    }),
    withdrawSubEventRegistration: rpc('withdraw_sub_event_registration', function (args) {
      return { p_event_id: args[1], p_sub_event_id: args[2] };
    }),
    getMyAttendeeItinerary: notImplemented('Loading your meeting itinerary'),
    getAttendeeModalDetails: notImplemented('Loading attendee profile details'),
    emailItinerary: notImplemented('Emailing your itinerary'),

    // ---- Phase 07 Stage B: AdminPortal.html (45 distinct function names,
    // 57 call sites) ----

    // -- Auth (Supabase Auth SDK, not .rpc()) --
    adminLogout: function () {
      return sb.auth.signOut().then(function () { return { status: 'ok' }; });
    },

    // Control Centre v1 companion -- checked by checkAdminSession_ right
    // after a session is confirmed, so a suspended tenant's admin gets a
    // distinct "suspended" screen instead of the admin dashboard.
    getAdminSessionStatus: rpc('get_admin_session_status', function () { return {}; }),

    // -- Events / Settings reads+writes --
    getAdminEventsTree: rpc('get_admin_events_tree', function () { return {}; }),
    createOrUpdateEvent: rpc('create_or_update_event', function (args) { return { p_payload: args[1] }; }),
    getEventTypesAndRegTypes: rpc('get_event_types_and_reg_types', function (args) { return { p_umbrella_event_id: args[1] }; }),
    getEventTypeOptions: rpc('get_event_type_options', function (args) { return { p_umbrella_event_id: args[1] }; }),
    saveClientOnboardingType: rpc('save_client_onboarding_type', function (args) {
      return { p_umbrella_event_id: args[1], p_event_type: args[2], p_payload: args[3] };
    }),
    renameClientOnboardingType: rpc('rename_client_onboarding_type', function (args) {
      return { p_umbrella_event_id: args[1], p_old_name: args[2], p_new_name: args[3] };
    }),
    deleteClientOnboardingType: rpc('delete_client_onboarding_type', function (args) {
      return { p_umbrella_event_id: args[1], p_event_type: args[2], p_force: !!args[3] };
    }),
    getRegistrationFormFieldsAdmin: rpc('get_registration_form_fields_admin', function (args) { return { p_umbrella_event_id: args[1] }; }),
    saveRegistrationFormFieldsForType: rpc('save_registration_form_fields_for_type', function (args) {
      return { p_umbrella_event_id: args[1], p_event_type: args[2], p_fields: args[3] };
    }),
    uploadEventBannerImage: uploadEventBannerImage_,
    removeEventBannerImage: removeEventBannerImage_,
    getSubEventAllocationSummary: rpc('get_sub_event_allocation_summary', function (args) { return { p_sub_event_id: args[1] }; }),

    // -- Dashboard --
    getExecutiveSummary: rpc('get_executive_summary', function () { return {}; }),
    getEventDashboardData: rpc('get_event_dashboard_data', function (args) { return { p_event_id: args[1] }; }),
    getCrossEventPortfolio: rpc('get_cross_event_portfolio', function () { return {}; }),

    // -- Budget --
    getBudgetCategories: rpc('get_budget_categories', function () { return {}; }),
    saveBudgetCategories: rpc('save_budget_categories', function (args) { return { p_line_type: args[1], p_category_names: args[2] }; }),
    getBudgetSummary: rpc('get_budget_summary', function (args) { return { p_event_id: args[1] }; }),
    saveBudgetLine: rpc('save_budget_line', function (args) { return { p_event_id: args[1], p_line: args[2] }; }),
    deleteBudgetLine: rpc('delete_budget_line', function (args) { return { p_event_id: args[1], p_line_id: args[2] }; }),
    updateOrderPaymentStatus: rpc('update_order_payment_status', function (args) { return { p_order_id: args[1], p_new_status: args[2] }; }),

    // -- B2B: table allocation + diaries + matching --
    getB2BTableAllocationOptions: rpc('get_b2b_table_allocation_options', function (args) { return { p_entity_id: args[1] }; }),
    assignB2BTableNumbers: rpc('assign_b2b_table_numbers', function (args) { return { p_entity_id: args[1], p_registration_type: args[2] }; }),
    getB2BDiaryTemplates: rpc('get_b2b_diary_templates', function (args) { return { p_entity_id: args[1] }; }),
    getB2BDiaryTemplateStarterCsv: function () {
      // Trivial static content -- Code.js's original returns the same
      // hardcoded string, no backend call was ever needed for this one.
      return Promise.resolve({
        filename: 'diary_slot_template.csv',
        csv: 'Appointment,Start,End\n1,09:00,09:20\n2,09:20,09:40\nCoffee Break,10:40,11:00\n3,11:00,11:20\n'
      });
    },
    saveB2BDiaryTemplate: saveB2BDiaryTemplate_,
    generateB2BDiaries: rpc('generate_b2b_diaries', function (args) { return { p_entity_id: args[1], p_force: !!args[2] }; }),
    // Repointed, not ported -- generateB2BMatchingSql exported a SQL
    // script for an external MySQL matching engine that Phase 05's
    // generate_b2b_meetings (native, runs directly against this DB)
    // already superseded. AdminPortal.html's "Data Bridge" button/UI
    // was updated to call this new name directly instead.
    generateB2BMeetings: rpc('generate_b2b_meetings', function (args) { return { p_entity_id: args[1] }; }),
    getB2BMeetingOutcomesReport: rpc('get_b2b_meeting_outcomes_report', function (args) { return { p_entity_id: args[1] }; }),

    // -- Communications --
    listCommTemplates: function (args) {
      return sb.rpc('list_comm_templates', { p_event_id: args[1] || null, p_include_archived: !!args[2] }).then(function (res) {
        if (res.error) throw res.error;
        return toCamelRows_(res.data, 'templateId');
      });
    },
    saveCommTemplate: rpc('save_comm_template', function (args) { return { p_payload: args[1] }; }),
    deleteCommTemplate: rpc('delete_comm_template', function (args) { return { p_template_id: args[1] }; }),
    restoreCommTemplate: rpc('restore_comm_template', function (args) { return { p_template_id: args[1] }; }),
    listCommAutomationsForEntity: function (args) {
      return sb.rpc('list_comm_automations_for_entity', { p_event_id: args[1] || null, p_sub_event_id: args[2] || null }).then(function (res) {
        if (res.error) throw res.error;
        return toCamelRows_(res.data, 'bindingId');
      });
    },
    saveCommAutomationBinding: rpc('save_comm_automation_binding', function (args) { return { p_binding: args[1] }; }),
    resolveCommunicationAudience: rpc('resolve_communication_audience', function (args) {
      var spec = args[1] || {};
      return { p_event_id: audienceEventId_(spec), p_template_id: spec.templateId, p_audience_spec: flattenAudienceSpec_(spec) };
    }),
    previewCommunication: rpc('preview_communication', function (args) {
      var spec = args[2] || {};
      // preview_communication (unlike resolve_communication_audience/
      // send_campaign) takes no separate p_event_id param -- its fallback
      // "pick a real registrant" path reads eventId off audience_spec
      // itself, so it's kept in here rather than flattened away.
      var flat = flattenAudienceSpec_(spec);
      flat.eventId = audienceEventId_(spec);
      return { p_template_id: args[1], p_audience_spec: flat, p_sample_email: args[3] || null };
    }),
    getCommQuotaStatus: rpc('get_comm_quota_status', function () { return {}; }),
    sendTestCommunication: sendTestCommunication_,
    sendCampaign: rpc('send_campaign', function (args) {
      var spec = args[2] || {};
      return { p_name: args[3], p_template_id: args[1], p_event_id: audienceEventId_(spec), p_audience_spec: flattenAudienceSpec_(spec), p_scheduled_for: args[4] || null };
    }),
    listCommCampaigns: function (args) {
      return sb.rpc('list_comm_campaigns', { p_event_id: args[1] || null }).then(function (res) {
        if (res.error) throw res.error;
        return toCamelRows_(res.data, 'campaignId');
      });
    },
    pauseCampaign: rpc('pause_campaign', function (args) { return { p_campaign_id: args[1] }; }),
    resumeCampaign: rpc('resume_campaign', function (args) { return { p_campaign_id: args[1] }; }),
    cancelCampaign: rpc('cancel_campaign', function (args) { return { p_campaign_id: args[1] }; }),
    sendScheduledCampaignNow: rpc('send_scheduled_campaign_now', function (args) { return { p_campaign_id: args[1] }; }),
    listCommSavedSegments: function () {
      return sb.rpc('list_comm_saved_segments', {}).then(function (res) {
        if (res.error) throw res.error;
        return toCamelRows_(res.data, 'segmentId');
      });
    },
    saveCommSavedSegment: rpc('save_comm_saved_segment', function (args) { return { p_name: args[1], p_spec: args[2] }; }),
    deleteCommSavedSegment: rpc('delete_comm_saved_segment', function (args) { return { p_id: args[1] }; }),
    getCommLogForCampaign: function (args) {
      return sb.rpc('get_comm_log_for_campaign', { p_campaign_id: args[1] }).then(function (res) {
        if (res.error) throw res.error;
        return toCamelRows_(res.data, 'logId');
      });
    },
    getCommSettings: function () {
      return sb.rpc('get_comm_settings', {}).then(function (res) {
        if (res.error) throw res.error;
        return toCamelRow_(res.data, null);
      });
    },
    saveCommSettings: rpc('save_comm_settings', function (args) { return { p_settings: args[1] }; }),

    // ---- Phase 07 Stage C: AdminFloorPlan.html ----
    // getExhibitionEventOptions was never an RPC even in the original
    // Postgres migration (20260810223009_floor_plan.sql's own header:
    // "a plain filter (is_exhibition = true), a direct client query once
    // there's a frontend") -- a direct table read, not a .rpc() call.
    getExhibitionEventOptions: function () {
      return sb.from('events').select('id, event_name, parent_event_id').eq('is_exhibition', true).then(function (res) {
        if (res.error) throw res.error;
        return (res.data || []).map(function (e) {
          return { eventId: e.id, eventName: e.event_name, isSubEvent: !!e.parent_event_id };
        });
      });
    },
    getFloorPlanLayout: rpc('get_floor_plan_layout', function (args) { return { p_event_id: args[1] }; }),
    saveFloorPlanLayout: rpc('save_floor_plan_layout', function (args) { return { p_event_id: args[1], p_elements: args[2] }; }),

    // ---- Phase 09/10/11: live status, holds, designer v2 ----
    getExhibitionBoothStatusAdmin: rpc('get_exhibition_booth_status_admin', function (args) { return { p_event_id: args[1] }; }),
    holdBooth: rpc('hold_booth', function (args) {
      var payload = args[2] || {};
      return { p_sub_event_id: args[1], p_option_id: payload.optionId, p_hold_seconds: payload.holdSeconds || 480 };
    }),
    releaseBooth: rpc('release_booth', function (args) { return { p_sub_event_id: args[1], p_option_id: args[2] }; }),
    uploadFloorPlanBackgroundImage: uploadFloorPlanBackgroundImage_,
    clearFloorPlanBackgroundImage: clearFloorPlanBackgroundImage_,
    saveFloorPlanTemplate: rpc('save_floor_plan_template', function (args) { return { p_event_id: args[1], p_name: args[2] }; }),
    listFloorPlanTemplates: rpc('list_floor_plan_templates', function () { return {}; }),
    applyFloorPlanTemplate: rpc('apply_floor_plan_template', function (args) { return { p_event_id: args[1], p_template_id: args[2] }; }),

    // ---- Phase 07 Stage C: Unsubscribe.html / MeetingResponse.html --
    // both public, no-login pages, args[0] is a REAL param here (not the
    // usual ignored sessionToken -- these were never session-based).
    confirmUnsubscribe: rpc('confirm_unsubscribe', function (args) {
      return { p_tenant_id: args[0], p_email: args[1], p_scope: args[2], p_token: args[3] };
    }),
    confirmB2BMeetingResponseByToken: rpc('confirm_b2b_meeting_response_by_token', function (args) {
      return { p_event_id: args[0], p_meeting_ref: args[1], p_email: args[2], p_action: args[3], p_token: args[4] };
    })
  };

  function makeChain(successHandler, failureHandler) {
    var chain = {
      withSuccessHandler: function (fn) { return makeChain(fn, failureHandler); },
      withFailureHandler: function (fn) { return makeChain(successHandler, fn); }
    };
    return new Proxy(chain, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        var handler = FN_MAP[prop];
        return function () {
          var args = Array.prototype.slice.call(arguments);
          if (!handler) {
            var err = asShimError({ message: 'No shim mapping for "' + String(prop) + '".' });
            if (failureHandler) failureHandler(err); else console.error(err.message);
            return;
          }
          Promise.resolve()
            .then(function () { return handler(args); })
            .then(function (result) { if (successHandler) successHandler(result); })
            .catch(function (err) {
              var shimErr = asShimError(err);
              if (failureHandler) failureHandler(shimErr); else console.error(String(prop) + ' failed:', shimErr.message);
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeChain(null, null);
})();
