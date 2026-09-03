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
    }
  };
})();
