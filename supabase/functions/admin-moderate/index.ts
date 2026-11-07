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

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return response({ error: 'unauthorized' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: actor, error: actorError } = await admin.from('profiles').select('role,account_status').eq('id', userData.user.id).maybeSingle();
  if (actorError || actor?.role !== 'admin' || actor.account_status !== 'active') return response({ error: 'forbidden' }, 403);

  let input: { action?: string; targetType?: string; targetId?: string; reportId?: string; reason?: string };
  try { input = await request.json(); } catch { return response({ error: 'invalid_json' }, 400); }
  const { action, targetType, targetId, reportId, reason } = input;
  if (!action || !targetType || !targetId || !reason?.trim() || reason.trim().length > 500) return response({ error: 'invalid_request' }, 400);

  let error: string | null = null;
  if (targetType === 'post' && ['hide_post', 'remove_post', 'restore_post'].includes(action)) {
    const moderation_status = action === 'hide_post' ? 'hidden' : action === 'remove_post' ? 'removed' : 'visible';
    const { data: target, error: targetError } = action === 'remove_post' ? await admin.from('posts').select('image_paths').eq('id', targetId).maybeSingle() : { data: null, error: null };
    if (targetError) return response({ error: targetError.message }, 400);
    const result = await admin.from('posts').update({ moderation_status }).eq('id', targetId);
    error = result.error?.message ?? null;
    if (!error && action === 'remove_post' && target?.image_paths?.length) {
      const mediaResult = await admin.storage.from('community-media').remove(target.image_paths);
      error = mediaResult.error?.message ?? null;
    }
  } else if (targetType === 'comment' && ['hide_comment', 'remove_comment', 'restore_comment'].includes(action)) {
    const moderation_status = action === 'hide_comment' ? 'hidden' : action === 'remove_comment' ? 'removed' : 'visible';
    const { data: target, error: targetError } = action === 'remove_comment' ? await admin.from('comments').select('image_paths').eq('id', targetId).maybeSingle() : { data: null, error: null };
    if (targetError) return response({ error: targetError.message }, 400);
    const result = await admin.from('comments').update({ moderation_status }).eq('id', targetId);
    error = result.error?.message ?? null;
    if (!error && action === 'remove_comment' && target?.image_paths?.length) {
      const mediaResult = await admin.storage.from('community-media').remove(target.image_paths);
      error = mediaResult.error?.message ?? null;
    }
  } else if (targetType === 'user' && ['suspend_user', 'restore_user'].includes(action)) {
    const { data: targetProfile, error: targetError } = await admin.from('profiles').select('role').eq('id', targetId).maybeSingle();
    if (targetError) return response({ error: targetError.message }, 400);
    if (!targetProfile || targetProfile.role === 'admin') return response({ error: 'target_not_manageable' }, 403);
    const account_status = action === 'suspend_user' ? 'suspended' : 'active';
    const profileResult = await admin.from('profiles').update({ account_status }).eq('id', targetId).neq('role', 'admin');
    if (profileResult.error) error = profileResult.error.message;
    else {
      const authResult = await admin.auth.admin.updateUserById(targetId, { ban_duration: action === 'suspend_user' ? '876000h' : 'none' });
      error = authResult.error?.message ?? null;
    }
  } else if (action === 'handle_report' || action === 'dismiss_report') {
    if (!reportId) return response({ error: 'report_id_required' }, 400);
    const result = await admin.from('reports').update({ status: action === 'handle_report' ? 'handled' : 'dismissed', reviewed_by: userData.user.id, reviewed_at: new Date().toISOString() }).eq('id', reportId);
    error = result.error?.message ?? null;
  } else {
    return response({ error: 'unsupported_action' }, 400);
  }
  if (error) return response({ error }, 400);

  if (reportId && action !== 'handle_report' && action !== 'dismiss_report') {
    const reportResult = await admin.from('reports').update({ status: 'handled', reviewed_by: userData.user.id, reviewed_at: new Date().toISOString() }).eq('id', reportId);
    if (reportResult.error) return response({ error: reportResult.error.message }, 400);
  }

  const auditResult = await admin.from('moderation_audit').insert({ actor_id: userData.user.id, action, target_type: targetType, target_id: targetId, reason: reason.trim(), metadata: reportId ? { report_id: reportId } : {} });
  if (auditResult.error) return response({ error: `action_applied_audit_failed:${auditResult.error.message}` }, 500);
  return response({ ok: true });
});

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
