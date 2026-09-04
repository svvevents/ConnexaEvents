/**
 * Control Centre v1 -- thin Supabase client wrapper.
 *
 * Same Supabase project/anon key as the tenant-facing app's
 * supabase-shim.js -- safe to embed client-side by the same reasoning
 * documented there (protected by RLS/RPC gating, not a secret). No
 * google.script.run-compatibility layer here: this is new code, not a
 * port, so it's just plain async functions on a CC namespace.
 *
 * Loaded via a plain <script src="control-centre-shim.js"> tag, after
 * the Supabase CDN script and before ControlCentre.html's own script.
 */

(function () {
  'use strict';

  var SUPABASE_URL = 'https://dzznpdxxmlasnafxokrf.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6em5wZHh4bWxhc25hZnhva3JmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNjUyMTIsImV4cCI6MjEwMTk0MTIxMn0.tcx_W9MLP1wT3IpzV8wHx4xDT1NyihAxzlZ2PZBidOo';

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  window.supabaseClient = sb;

  function asError(err) {
    if (!err) return new Error('Unknown error.');
    return new Error(typeof err.message === 'string' ? err.message : String(err));
  }

  function rpc(name, payload) {
    return sb.rpc(name, payload).then(function (res) {
      if (res.error) throw asError(res.error);
      return res.data;
    });
  }

  window.CC = {
    staffLogin: function (email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        if (res.error) throw asError(res.error);
        return res.data;
      });
    },
    staffLogout: function () {
      return sb.auth.signOut();
    },
    getSession: function () {
      return sb.auth.getSession().then(function (res) {
        return res && res.data && res.data.session;
      });
    },
    getTenantsOverview: function () {
      return rpc('get_platform_tenants_overview');
    },
    getTenantDetail: function (tenantId) {
      return rpc('get_platform_tenant_detail', { p_tenant_id: tenantId });
    },
    setTenantStatus: function (tenantId, status) {
      return rpc('set_platform_tenant_status', { p_tenant_id: tenantId, p_status: status });
    },
    createTenant: function (name, slug, planId, adminEmail) {
      return rpc('create_platform_tenant', { p_name: name, p_slug: slug, p_plan_id: planId, p_admin_email: adminEmail });
    },
    resetTenant: function (tenantId, mode) {
      return rpc('reset_platform_tenant', { p_tenant_id: tenantId, p_mode: mode });
    },
    getTenantMembershipEnabled: function (tenantId) {
      return rpc('get_platform_tenant_membership_flag', { p_tenant_id: tenantId });
    },
    setTenantMembershipEnabled: function (tenantId, enabled) {
      return rpc('set_platform_tenant_membership_enabled', { p_tenant_id: tenantId, p_enabled: enabled });
    },
    setTenantBranding: function (tenantId, branding) {
      return rpc('set_platform_tenant_branding', { p_tenant_id: tenantId, p_branding: branding });
    },
    removeTenantAdmin: function (tenantId, adminUserId) {
      return rpc('remove_platform_tenant_admin', { p_tenant_id: tenantId, p_admin_user_id: adminUserId });
    },
    deleteTenant: function (tenantId, confirmSlug) {
      return rpc('delete_platform_tenant', { p_tenant_id: tenantId, p_confirm_slug: confirmSlug });
    },
    listIdeas: function (status, category) {
      return rpc('list_product_ideas', { p_status: status || null, p_category: category || null });
    },
    createIdea: function (title, description, category, priority, relatedArea, sourceNote) {
      return rpc('create_product_idea', { p_title: title, p_description: description, p_category: category, p_priority: priority, p_related_area: relatedArea, p_source_note: sourceNote });
    },
    updateIdea: function (id, title, description, category, priority, relatedArea, sourceNote) {
      return rpc('update_product_idea', { p_id: id, p_title: title, p_description: description, p_category: category, p_priority: priority, p_related_area: relatedArea, p_source_note: sourceNote });
    },
    setIdeaStatus: function (id, status) {
      return rpc('set_product_idea_status', { p_id: id, p_status: status });
    },
    deleteIdea: function (id) {
      return rpc('delete_product_idea', { p_id: id });
    },
    listProspects: function (stage) {
      return rpc('list_crm_prospects', { p_stage: stage || null });
    },
    getProspectDetail: function (id) {
      return rpc('get_crm_prospect_detail', { p_id: id });
    },
    createProspect: function (companyName, contactName, contactEmail, contactPhone, source, vertical, estimatedValue, nextFollowUpDate, notesSummary) {
      return rpc('create_crm_prospect', { p_company_name: companyName, p_contact_name: contactName, p_contact_email: contactEmail, p_contact_phone: contactPhone, p_source: source, p_vertical: vertical, p_estimated_value: estimatedValue, p_next_follow_up_date: nextFollowUpDate, p_notes_summary: notesSummary });
    },
    updateProspect: function (id, companyName, contactName, contactEmail, contactPhone, source, vertical, estimatedValue, nextFollowUpDate, notesSummary) {
      return rpc('update_crm_prospect', { p_id: id, p_company_name: companyName, p_contact_name: contactName, p_contact_email: contactEmail, p_contact_phone: contactPhone, p_source: source, p_vertical: vertical, p_estimated_value: estimatedValue, p_next_follow_up_date: nextFollowUpDate, p_notes_summary: notesSummary });
    },
    setProspectStage: function (id, stage, lostReason) {
      return rpc('set_crm_prospect_stage', { p_id: id, p_stage: stage, p_lost_reason: lostReason || null });
    },
    deleteProspect: function (id) {
      return rpc('delete_crm_prospect', { p_id: id });
    },
    addProspectInteraction: function (prospectId, type, summary) {
      return rpc('add_crm_interaction', { p_prospect_id: prospectId, p_type: type, p_summary: summary });
    },
    markProspectWon: function (id, tenantName, tenantSlug, tenantPlanId) {
      return rpc('mark_crm_prospect_won', { p_id: id, p_tenant_name: tenantName, p_tenant_slug: tenantSlug, p_tenant_plan_id: tenantPlanId || null });
    }
  };
})();
