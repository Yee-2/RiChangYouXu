import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token || !url || !anon || !service) return reply({ error: 'unauthorized' }, 401);
  const userClient = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return reply({ error: 'unauthorized' }, 401);

  let input: { targetType?: string; targetId?: string };
  try { input = await request.json(); } catch { return reply({ error: 'invalid_json' }, 400); }
  const { targetType, targetId } = input;
  if (!targetId || !['post', 'comment'].includes(String(targetType))) return reply({ error: 'invalid_request' }, 400);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: profile, error: profileError } = await admin.from('profiles').select('account_status,suspension_expires_at').eq('id', userData.user.id).maybeSingle();
  if (profileError || !profile) return reply({ error: 'profile_not_found' }, 403);
  const suspensionExpired = profile.account_status === 'suspended' && profile.suspension_expires_at && Date.parse(profile.suspension_expires_at) <= Date.now();
  if (profile.account_status !== 'active' && !suspensionExpired) return reply({ error: 'account_not_active' }, 403);

  let paths: string[] = [];
  if (targetType === 'post') {
    const { data: post, error } = await admin.from('posts').select('author_id,image_paths').eq('id', targetId).maybeSingle();
    if (error) return reply({ error: error.message }, 400);
    if (!post || post.author_id !== userData.user.id) return reply({ error: 'target_not_owned' }, 403);
    const { data: comments, error: commentsError } = await admin.from('comments').select('id,image_paths').eq('post_id', targetId);
    if (commentsError) return reply({ error: commentsError.message }, 400);
    const hiddenPost = await admin.from('posts').update({ moderation_status: 'hidden' }).eq('id', targetId).eq('author_id', userData.user.id);
    if (hiddenPost.error) return reply({ error: hiddenPost.error.message }, 400);
    const hiddenComments = await admin.from('comments').update({ moderation_status: 'hidden' }).eq('post_id', targetId);
    if (hiddenComments.error) return reply({ error: hiddenComments.error.message, partial: true }, 400);
    paths = [...(post.image_paths ?? []), ...(comments ?? []).flatMap((comment) => comment.image_paths ?? [])];
  } else {
    const { data: comment, error } = await admin.from('comments').select('author_id,image_paths').eq('id', targetId).maybeSingle();
    if (error) return reply({ error: error.message }, 400);
    if (!comment || comment.author_id !== userData.user.id) return reply({ error: 'target_not_owned' }, 403);
    const hidden = await admin.from('comments').update({ moderation_status: 'hidden' }).eq('id', targetId).eq('author_id', userData.user.id);
    if (hidden.error) return reply({ error: hidden.error.message }, 400);
    paths = comment.image_paths ?? [];
  }

  const uniquePaths = [...new Set(paths.filter(Boolean))];
  for (let start = 0; start < uniquePaths.length; start += 1000) {
    const { error } = await admin.storage.from('community-media').remove(uniquePaths.slice(start, start + 1000));
    if (error) return reply({ error: `media_cleanup_failed:${error.message}`, partial: true }, 500);
  }

  const table = targetType === 'post' ? 'posts' : 'comments';
  const { error: deleteError } = await admin.from(table).delete().eq('id', targetId).eq('author_id', userData.user.id);
  if (deleteError) return reply({ error: `content_delete_failed:${deleteError.message}`, partial: true }, 500);
  return reply({ ok: true, deletedMediaCount: uniquePaths.length });
});

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
