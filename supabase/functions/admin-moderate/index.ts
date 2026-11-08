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
  const [actorAdmin, actorProfile] = await Promise.all([
    admin.from('admin_accounts').select('user_id').eq('user_id', userData.user.id).maybeSingle(),
    admin.from('profiles').select('account_status').eq('id', userData.user.id).maybeSingle()
  ]);
  if (actorAdmin.error || actorProfile.error || !actorAdmin.data || actorProfile.data?.account_status !== 'active') return response({ error: 'forbidden' }, 403);

  let input: { action?: string; targetType?: string; targetId?: string; reportId?: string; reason?: string; suspensionHours?: number };
  try { input = await request.json(); } catch { return response({ error: 'invalid_json' }, 400); }
  const { action, targetType, targetId, reportId, reason, suspensionHours } = input;
  if (!action || !targetType || !targetId || !reason?.trim() || reason.trim().length > 500) return response({ error: 'invalid_request' }, 400);

  const allowedDurations = [24, 168, 720];
  if (targetType === 'user' && action === 'suspend_user' && !allowedDurations.includes(Number(suspensionHours))) return response({ error: 'invalid_suspension_duration' }, 400);
  let metadata: Record<string, unknown> = reportId ? { report_id: reportId } : {};

  if (targetType === 'post' && ['hide_post', 'remove_post', 'restore_post'].includes(action)) {
    const { data: target, error: targetError } = await admin.from('posts').select('image_paths').eq('id', targetId).maybeSingle();
    if (targetError) return response({ error: targetError.message }, 400);
    if (!target) return response({ error: 'target_not_found' }, 404);
    const status = action === 'hide_post' ? 'hidden' : action === 'remove_post' ? 'hidden' : 'visible';
    const updated = await admin.from('posts').update({ moderation_status: status }).eq('id', targetId);
    if (updated.error) return response({ error: updated.error.message }, 400);
    if (action === 'remove_post') {
      const { data: relatedComments, error: commentsError } = await admin.from('comments').select('id,image_paths').eq('post_id', targetId);
      if (commentsError) return response({ error: commentsError.message, partial: true }, 400);
      const hiddenComments = await admin.from('comments').update({ moderation_status: 'hidden' }).eq('post_id', targetId);
      if (hiddenComments.error) return response({ error: hiddenComments.error.message, partial: true }, 400);
      const paths = [...(target.image_paths ?? []), ...(relatedComments ?? []).flatMap((comment) => comment.image_paths ?? [])];
      const removeError = await removeMedia(admin, paths);
      if (removeError) return response({ error: removeError, partial: true }, 400);
      const removedPost = await admin.from('posts').update({ moderation_status: 'removed' }).eq('id', targetId);
      const removedComments = await admin.from('comments').update({ moderation_status: 'removed' }).eq('post_id', targetId);
      if (removedPost.error || removedComments.error) return response({ error: removedPost.error?.message ?? removedComments.error?.message, partial: true }, 400);
      metadata = { ...metadata, removed_media_count: paths.length, removed_comment_count: relatedComments?.length ?? 0 };
    }
  } else if (targetType === 'comment' && ['hide_comment', 'remove_comment', 'restore_comment'].includes(action)) {
    const { data: target, error: targetError } = await admin.from('comments').select('image_paths').eq('id', targetId).maybeSingle();
    if (targetError) return response({ error: targetError.message }, 400);
    if (!target) return response({ error: 'target_not_found' }, 404);
    const status = action === 'hide_comment' || action === 'remove_comment' ? 'hidden' : 'visible';
    const updated = await admin.from('comments').update({ moderation_status: status }).eq('id', targetId);
    if (updated.error) return response({ error: updated.error.message }, 400);
    if (action === 'remove_comment') {
      const removeError = await removeMedia(admin, target.image_paths ?? []);
      if (removeError) return response({ error: removeError, partial: true }, 400);
      const removed = await admin.from('comments').update({ moderation_status: 'removed' }).eq('id', targetId);
      if (removed.error) return response({ error: removed.error.message, partial: true }, 400);
      metadata = { ...metadata, removed_media_count: target.image_paths?.length ?? 0 };
    }
  } else if (targetType === 'user' && ['suspend_user', 'restore_user', 'ban_user', 'unban_user'].includes(action)) {
    const { data: targetProfile, error: targetError } = await admin.from('profiles').select('role,account_status,suspension_expires_at').eq('id', targetId).maybeSingle();
    if (targetError) return response({ error: targetError.message }, 400);
    const { data: targetAdmin, error: targetAdminError } = await admin.from('admin_accounts').select('user_id').eq('user_id', targetId).maybeSingle();
    if (targetAdminError) return response({ error: targetAdminError.message }, 400);
    if (!targetProfile || targetAdmin) return response({ error: 'target_not_manageable' }, 403);
    if (targetProfile.account_status === 'banned' && action !== 'unban_user') return response({ error: 'permanently_banned_accounts_require_manual_unban' }, 400);
    if (action === 'restore_user' && targetProfile.account_status === 'banned') return response({ error: 'permanently_banned_accounts_require_unban' }, 400);
    if (action === 'unban_user' && targetProfile.account_status !== 'banned') return response({ error: 'target_is_not_banned' }, 400);
    const now = Date.now();
    const expiresAt = action === 'suspend_user' ? new Date(now + Number(suspensionHours) * 60 * 60 * 1000).toISOString() : null;
    const account_status = action === 'suspend_user' ? 'suspended' : action === 'ban_user' ? 'banned' : 'active';
    const profileResult = await admin.from('profiles').update({ account_status, suspension_expires_at: expiresAt }).eq('id', targetId).eq('role', 'user');
    if (profileResult.error) return response({ error: profileResult.error.message }, 400);
    const authDuration = action === 'suspend_user' ? `${suspensionHours}h` : action === 'ban_user' ? '876000h' : 'none';
    const authResult = await admin.auth.admin.updateUserById(targetId, { ban_duration: authDuration });
    if (authResult.error) {
      const rollback = await admin.from('profiles').update({ account_status: targetProfile.account_status, suspension_expires_at: targetProfile.suspension_expires_at }).eq('id', targetId);
      return response({ error: rollback.error ? `auth_ban_failed_and_rollback_failed:${authResult.error.message}` : authResult.error.message, partial: Boolean(rollback.error) }, 400);
    }
    metadata = { ...metadata, previous_status: targetProfile.account_status, suspension_hours: action === 'suspend_user' ? Number(suspensionHours) : null, suspension_expires_at: expiresAt };
  } else if (action === 'handle_report' || action === 'dismiss_report') {
    if (!reportId) return response({ error: 'report_id_required' }, 400);
  } else {
    return response({ error: 'unsupported_action' }, 400);
  }

  let reportUpdateFailure: string | null = null;
  if (reportId) {
    const reportResult = await admin.from('reports').update({ status: action === 'dismiss_report' ? 'dismissed' : 'handled', reviewed_by: userData.user.id, reviewed_at: new Date().toISOString() }).eq('id', reportId).select('id').maybeSingle();
    if (reportResult.error) reportUpdateFailure = reportResult.error.message;
    else if (!reportResult.data) reportUpdateFailure = 'report_not_found';
  }
  const auditResult = await admin.from('moderation_audit').insert({ actor_id: userData.user.id, action, target_type: targetType, target_id: targetId, reason: reason.trim(), metadata });
  if (auditResult.error) return response({ error: `action_applied_audit_failed:${auditResult.error.message}`, partial: true }, 500);
  if (reportUpdateFailure) return response({ error: `action_applied_report_update_failed:${reportUpdateFailure}`, partial: true }, 500);
  return response({ ok: true });
});

async function removeMedia(admin: ReturnType<typeof createClient>, paths: string[]) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  for (let start = 0; start < uniquePaths.length; start += 1000) {
    const result = await admin.storage.from('community-media').remove(uniquePaths.slice(start, start + 1000));
    if (result.error) return result.error.message;
  }
  return null;
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
