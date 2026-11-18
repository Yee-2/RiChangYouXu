import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);

  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token || !supabaseUrl || !anonKey || !serviceKey) return response({ error: 'unauthorized' }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return response({ error: 'unauthorized' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const [actorAdmin, actorProfile] = await Promise.all([
    admin.from('admin_accounts').select('user_id').eq('user_id', userData.user.id).maybeSingle(),
    admin.from('profiles').select('account_status').eq('id', userData.user.id).maybeSingle()
  ]);
  if (actorAdmin.error || actorProfile.error || !actorAdmin.data || actorProfile.data?.account_status !== 'active') {
    return response({ error: 'forbidden' }, 403);
  }

  let input: { action?: string; targetType?: string; targetId?: string; reason?: string; suspensionHours?: number };
  try { input = await request.json(); } catch { return response({ error: 'invalid_json' }, 400); }
  const { action, targetType, targetId, reason, suspensionHours } = input;
  if (!action || targetType !== 'user' || !targetId || !reason?.trim() || reason.trim().length > 500) {
    return response({ error: 'invalid_request' }, 400);
  }

  if (!['suspend_user', 'restore_user', 'ban_user', 'unban_user'].includes(action)) {
    return response({ error: 'unsupported_action' }, 400);
  }

  const allowedDurations = [24, 168, 720];
  if (action === 'suspend_user' && !allowedDurations.includes(Number(suspensionHours))) {
    return response({ error: 'invalid_suspension_duration' }, 400);
  }

  const { data: targetProfile, error: targetError } = await admin
    .from('profiles')
    .select('account_status,suspension_expires_at')
    .eq('id', targetId)
    .maybeSingle();
  if (targetError) return response({ error: targetError.message }, 400);

  const { data: targetAdmin, error: targetAdminError } = await admin
    .from('admin_accounts')
    .select('user_id')
    .eq('user_id', targetId)
    .maybeSingle();
  if (targetAdminError) return response({ error: targetAdminError.message }, 400);

  if (!targetProfile || targetAdmin) return response({ error: 'target_not_manageable' }, 403);
  if (targetProfile.account_status === 'banned' && action !== 'unban_user') {
    return response({ error: 'permanently_banned_accounts_require_manual_unban' }, 400);
  }
  if (action === 'restore_user' && targetProfile.account_status === 'banned') {
    return response({ error: 'permanently_banned_accounts_require_unban' }, 400);
  }
  if (action === 'unban_user' && targetProfile.account_status !== 'banned') {
    return response({ error: 'target_is_not_banned' }, 400);
  }

  const now = Date.now();
  const expiresAt = action === 'suspend_user'
    ? new Date(now + Number(suspensionHours) * 60 * 60 * 1000).toISOString()
    : null;
  const account_status = action === 'suspend_user' ? 'suspended' : action === 'ban_user' ? 'banned' : 'active';

  const profileResult = await admin
    .from('profiles')
    .update({ account_status, suspension_expires_at: expiresAt })
    .eq('id', targetId)
    .select('id')
    .maybeSingle();
  if (profileResult.error) return response({ error: profileResult.error.message }, 400);
  if (!profileResult.data) return response({ error: 'target_not_found' }, 404);

  const authDuration = action === 'suspend_user' ? `${suspensionHours}h` : action === 'ban_user' ? '876000h' : 'none';
  const authResult = await admin.auth.admin.updateUserById(targetId, { ban_duration: authDuration });
  if (authResult.error) {
    const rollback = await admin
      .from('profiles')
      .update({ account_status: targetProfile.account_status, suspension_expires_at: targetProfile.suspension_expires_at })
      .eq('id', targetId);
    return response(
      {
        error: rollback.error ? `auth_ban_failed_and_rollback_failed:${authResult.error.message}` : authResult.error.message,
        partial: Boolean(rollback.error)
      },
      400
    );
  }

  const metadata: Record<string, unknown> = {
    previous_status: targetProfile.account_status,
    suspension_hours: action === 'suspend_user' ? Number(suspensionHours) : null,
    suspension_expires_at: expiresAt
  };

  const auditResult = await admin.from('moderation_audit').insert({
    actor_id: userData.user.id,
    action,
    target_type: targetType,
    target_id: targetId,
    reason: reason.trim(),
    metadata
  });
  if (auditResult.error) {
    return response({ error: `action_applied_audit_failed:${auditResult.error.message}`, partial: true }, 500);
  }

  return response({ ok: true });
});

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
