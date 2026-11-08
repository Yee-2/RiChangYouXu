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
  const { data: actor, error: actorError } = await serviceClient
    .from('profiles')
    .select('id,uid,role,account_status')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (actorError || actor?.role !== 'admin' || actor.account_status !== 'active') {
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
  };
  try { input = await request.json(); }
  catch { return response({ error: 'invalid_json' }, 400, cors); }

  const action = input.action;
  if (action === 'verify') return response({ ok: true, actor: { id: actor.id, uid: actor.uid } }, 200, cors);

  if (action === 'list_accounts' || action === 'list_admins' || action === 'list_users') {
    const limit = Number.isInteger(input.limit) ? Math.min(Math.max(Number(input.limit), 1), 100) : 100;
    const offset = Number.isInteger(input.offset) ? Math.max(Number(input.offset), 0) : 0;
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 160) : null;
    const role = action === 'list_users' ? 'user' : 'admin';
    const { data, error } = await serviceClient.rpc('admin_list_profiles', {
      p_actor_id: actor.id,
      p_role: role,
      p_query: query || null,
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
    const { data, error } = await serviceClient.rpc('admin_find_account', { p_actor_id: actor.id, p_lookup: lookup });
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
      p_actor_id: actor.id,
      p_target_id: targetId,
      p_action: action,
      p_reason: reason
    });
    if (error) return response({ error: mapDatabaseError(error.message) }, 400, cors);
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
