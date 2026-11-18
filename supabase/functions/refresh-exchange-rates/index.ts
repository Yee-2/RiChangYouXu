import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const SUPPORTED = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'] as const;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) return reply({ error: 'server_misconfigured' }, 500);

  const serviceClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const cronSecret = request.headers.get('x-cron-secret') ?? '';

  let authorized = false;
  if (cronSecret) {
    const { data: validCron } = await serviceClient.rpc('verify_cron_secret', { p_secret: cronSecret });
    authorized = Boolean(validCron);
  }

  if (!authorized) {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return reply({ error: 'unauthorized' }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false }
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData.user) return reply({ error: 'unauthorized' }, 401);
    authorized = true;
  }

  let fetchedDate = new Date().toISOString().slice(0, 10);
  const cnyRates: Record<string, number> = { CNY: 1 };

  try {
    let payload: { date?: string; rates?: Record<string, number> } | null = null;
    const primary = await fetch('https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD,EUR,HKD,JPY,GBP');
    if (primary.ok) {
      payload = await primary.json();
    } else {
      const fallback = await fetch('https://api.frankfurter.app/latest?from=CNY&to=USD,EUR,HKD,JPY,GBP');
      if (!fallback.ok) throw new Error(`fx_upstream_status_${fallback.status}`);
      payload = await fallback.json();
    }

    if (payload?.date) fetchedDate = payload.date;
    for (const code of SUPPORTED) {
      if (code === 'CNY') continue;
      const val = payload?.rates?.[code];
      if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
        throw new Error(`missing_rate_${code}`);
      }
      cnyRates[code] = val;
    }
  } catch (cause) {
    return reply({ error: cause instanceof Error ? cause.message : 'fx_fetch_failed' }, 502);
  }

  const nowIso = new Date().toISOString();
  const rows: Array<{ base: string; quote: string; rate: number; fetched_on: string; updated_at: string }> = [];
  for (const base of SUPPORTED) {
    for (const quote of SUPPORTED) {
      const rate = base === quote ? 1 : Number((cnyRates[quote] / cnyRates[base]).toFixed(6));
      rows.push({
        base,
        quote,
        rate,
        fetched_on: fetchedDate,
        updated_at: nowIso
      });
    }
  }

  const { error: upsertError } = await serviceClient
    .from('exchange_rates')
    .upsert(rows, { onConflict: 'base,quote' });

  if (upsertError) return reply({ error: upsertError.message }, 500);

  return reply({ ok: true, count: rows.length, fetched_on: fetchedDate });
});

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
