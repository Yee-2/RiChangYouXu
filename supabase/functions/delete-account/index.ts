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

  let body: { confirmation?: string };
  try { body = await request.json(); } catch { return reply({ error: 'invalid_json' }, 400); }
  if (body.confirmation !== 'DELETE') return reply({ error: 'confirmation_required' }, 400);

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) return reply({ error: 'unauthorized' }, 401);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: adminMembership, error: adminMembershipError } = await admin
    .from('admin_accounts')
    .select('user_id')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (adminMembershipError) return reply({ error: 'admin_membership_check_failed' }, 500);
  if (adminMembership) return reply({ error: 'admin_account_cannot_self_delete' }, 403);

  // Deleting the auth user cascades across subscriptions, categories, payment_methods,
  // subscription_events, user_settings, reminder_log, and profiles.
  const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id);
  if (deleteError) return reply({ error: deleteError.message }, 500);

  return reply({ ok: true });
});

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
