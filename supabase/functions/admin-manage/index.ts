import { createClient } from 'jsr:@supabase/supabase-js@2';

const allowedOrigins = new Set([
  'https://admin.yeecc.cn',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin') ?? '';
  const cors = {
    ...(allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
  if (origin && !allowedOrigins.has(origin)) return response({ error: 'origin_not_allowed' }, 403, cors);
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405, cors);

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token || !supabaseUrl || !anonKey || !serviceKey) return response({ error: 'unauthorized' }, 401, cors);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return response({ error: 'unauthorized' }, 401, cors);

  const serviceClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const [adminResult, profileResult] = await Promise.all([
    serviceClient.from('admin_accounts').select('user_id,email').eq('user_id', userData.user.id).maybeSingle(),
    serviceClient.from('profiles').select('id,uid,display_name,avatar_path,account_status').eq('id', userData.user.id).maybeSingle()
  ]);
  const actor = adminResult.data;
  const actorProfile = profileResult.data;
  if (adminResult.error || profileResult.error || !actor || actorProfile?.account_status !== 'active') {
    return response({ error: 'forbidden' }, 403, cors);
  }

  let input: {
    action?: string;
    query?: string;
    lookup?: string;
    offset?: number;
    limit?: number;
    targetId?: string;
    reason?: string;
    statusFilter?: string;
    sort?: string;
    registeredWithin?: string;
    newPassword?: string;
  };
  try { input = await request.json(); }
  catch { return response({ error: 'invalid_json' }, 400, cors); }

  const action = input.action;
  if (action === 'verify') {
    return response({ ok: true, actor: { id: actorProfile.id, uid: actorProfile.uid, display_name: actorProfile.display_name, avatar_path: actorProfile.avatar_path, email: userData.user.email ?? actor.email } }, 200, cors);
  }

  if (action === 'list_accounts' || action === 'list_admins' || action === 'list_users') {
    const limit = Number.isInteger(input.limit) ? Math.min(Math.max(Number(input.limit), 1), 100) : 100;
    const offset = Number.isInteger(input.offset) ? Math.max(Number(input.offset), 0) : 0;
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 160) : null;
    const role = action === 'list_users' ? 'user' : 'admin';
    const statusFilter = role === 'user' && typeof input.statusFilter === 'string' ? input.statusFilter : 'all';
    const sort = role === 'user' && typeof input.sort === 'string' ? input.sort : 'newest';
    const registeredWithin = role === 'user' && typeof input.registeredWithin === 'string' ? input.registeredWithin : 'all';
    const registeredDays: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
    if (role === 'user' && registeredWithin !== 'all' && !(registeredWithin in registeredDays)) {
      return response({ error: 'invalid_registration_window' }, 400, cors);
    }
    const registeredAfter = registeredWithin === 'all' ? null : new Date(Date.now() - registeredDays[registeredWithin] * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await serviceClient.rpc('admin_list_profiles_filtered', {
      p_actor_id: actorProfile.id,
      p_role: role,
      p_query: query || null,
      p_status_filter: statusFilter,
      p_sort: sort,
      p_registered_after: registeredAfter,
      p_limit: limit,
      p_offset: offset
    });
    if (error) return response({ error: mapDatabaseError(error.message) }, 400, cors);
    const collection = action === 'list_users' ? 'users' : action === 'list_accounts' ? 'accounts' : 'admins';
    return response({ ok: true, [collection]: data ?? [] }, 200, cors);
  }

  if (action === 'find_account') {
    const lookup = typeof input.lookup === 'string' ? input.lookup.trim().slice(0, 320) : '';
    if (!lookup) return response({ error: 'lookup_required' }, 400, cors);
    const { data, error } = await serviceClient.rpc('admin_find_account', { p_actor_id: actorProfile.id, p_lookup: lookup });
    if (error) return response({ error: mapDatabaseError(error.message) }, 400, cors);
    const account = Array.isArray(data) ? data[0] : null;
    if (!account) return response({ error: 'account_not_found' }, 404, cors);
    return response({ ok: true, account }, 200, cors);
  }

  if (action === 'grant_admin' || action === 'revoke_admin') {
    const targetId = typeof input.targetId === 'string' ? input.targetId : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!isUuid(targetId) || !reason || reason.length > 500) return response({ error: 'invalid_request' }, 400, cors);
    const { error } = await serviceClient.rpc('admin_change_role', {
      p_actor_id: actorProfile.id,
      p_target_id: targetId,
      p_action: action,
      p_reason: reason
    });
    if (error) return response({ error: mapDatabaseError(error.message) }, 400, cors);
    return response({ ok: true }, 200, cors);
  }

  if (action === 'reset_admin_password') {
    const targetId = typeof input.targetId === 'string' ? input.targetId : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';
    if (!isUuid(targetId) || targetId === actorProfile.id || !reason || reason.length > 500 || newPassword.length < 8 || newPassword.length > 128) {
      return response({ error: 'invalid_request' }, 400, cors);
    }
    const { data: targetAdmin, error: targetError } = await serviceClient
      .from('admin_accounts').select('user_id').eq('user_id', targetId).maybeSingle();
    if (targetError) return response({ error: 'admin_operation_failed' }, 400, cors);
    if (!targetAdmin) return response({ error: 'target_not_admin' }, 404, cors);

    const auditIntent = await serviceClient.from('moderation_audit').insert({
      actor_id: actorProfile.id,
      action: 'reset_admin_password_started',
      target_type: 'admin',
      target_id: targetId,
      reason,
      metadata: { credential_changed: false, outcome: 'pending' }
    }).select('id').single();
    if (auditIntent.error || !auditIntent.data) return response({ error: 'password_reset_audit_intent_failed' }, 500, cors);

    const passwordResult = await serviceClient.auth.admin.updateUserById(targetId, { password: newPassword });
    const outcome = passwordResult.error
      ? { action: 'reset_admin_password_failed', metadata: { credential_changed: false, outcome: 'failed' } }
      : { action: 'reset_admin_password', metadata: { credential_changed: true, outcome: 'succeeded' } };
    const auditResult = await serviceClient.from('moderation_audit').update(outcome)
      .eq('id', auditIntent.data.id);
    if (passwordResult.error) {
      if (auditResult.error) return response({ error: 'password_update_failed_audit_outcome_failed', partial: true }, 500, cors);
      return response({ error: 'password_update_failed' }, 400, cors);
    }
    if (auditResult.error) return response({ error: 'password_updated_audit_outcome_failed', partial: true }, 500, cors);
    return response({ ok: true }, 200, cors);
  }

  return response({ error: 'unsupported_action' }, 400, cors);
});

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mapDatabaseError(message: string) {
  const known: Record<string, string> = {
    forbidden: 'forbidden',
    already_admin: 'already_admin',
    target_not_eligible: 'target_not_eligible',
    target_not_admin: 'target_not_admin',
    last_active_admin: 'last_active_admin',
    target_not_found: 'account_not_found',
    invalid_reason: 'invalid_reason',
    lookup_required: 'lookup_required',
    invalid_role_filter: 'invalid_request',
    invalid_status_filter: 'invalid_request',
    invalid_sort: 'invalid_request',
    unsupported_action: 'unsupported_action'
  };
  const key = Object.keys(known).find((candidate) => message.includes(candidate));
  return key ? known[key] : 'admin_operation_failed';
}

function response(body: Record<string, unknown>, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
