import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  name: string;
  amount: number;
  currency: string;
  status: 'trial' | 'active' | 'paused' | 'cancelled';
  next_renewal_date: string;
  trial_end_date: string | null;
  reminder_days: number;
};

type SettingsRow = {
  user_id: string;
  locale: 'zh-CN' | 'en';
  email_reminders: boolean;
};

const currencySymbols: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  HKD: 'HK$',
  JPY: '¥',
  GBP: '£'
};

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

    const [adminRes, profileRes] = await Promise.all([
      serviceClient.from('admin_accounts').select('user_id').eq('user_id', userData.user.id).maybeSingle(),
      serviceClient.from('profiles').select('account_status').eq('id', userData.user.id).maybeSingle()
    ]);
    if (adminRes.error || profileRes.error || !adminRes.data || profileRes.data?.account_status !== 'active') {
      return reply({ error: 'forbidden' }, 403);
    }
    authorized = true;
  }

  const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const localToday = shanghaiNow.toISOString().slice(0, 10);
  const maxDate = addDays(localToday, 30);

  const { data: subs, error: subsError } = await serviceClient
    .from('subscriptions')
    .select('id,user_id,name,amount,currency,status,next_renewal_date,trial_end_date,reminder_days')
    .in('status', ['active', 'trial'])
    .gte('next_renewal_date', localToday)
    .lte('next_renewal_date', maxDate);

  if (subsError) return reply({ error: subsError.message }, 500);

  const dueSubs = ((subs ?? []) as SubscriptionRow[]).filter((sub) => {
    const targetDate = sub.status === 'trial' && sub.trial_end_date ? sub.trial_end_date : sub.next_renewal_date;
    const diff = diffDays(localToday, targetDate);
    return diff >= 0 && diff <= sub.reminder_days;
  });

  if (!dueSubs.length) {
    return reply({ ok: true, resendConfigured: Boolean(Deno.env.get('RESEND_API_KEY')), processed: 0, sent: 0, skipped: 0, failed: 0 });
  }

  const userIds = [...new Set(dueSubs.map((s) => s.user_id))];
  const subIds = dueSubs.map((s) => s.id);

  const [settingsRes, profilesRes, logsRes] = await Promise.all([
    serviceClient.from('user_settings').select('user_id,locale,email_reminders').in('user_id', userIds),
    serviceClient.from('profiles').select('id,account_status').in('id', userIds),
    serviceClient.from('reminder_log').select('subscription_id,remind_for_date,status').in('subscription_id', subIds)
  ]);

  if (settingsRes.error || profilesRes.error || logsRes.error) {
    return reply({ error: 'reminder_context_query_failed' }, 500);
  }

  const settingsMap = new Map(((settingsRes.data ?? []) as SettingsRow[]).map((s) => [s.user_id, s]));
  const activeUsers = new Set(
    ((profilesRes.data ?? []) as Array<{ id: string; account_status: string }>)
      .filter((p) => p.account_status === 'active')
      .map((p) => p.id)
  );
  const sentKeys = new Set(
    ((logsRes.data ?? []) as Array<{ subscription_id: string; remind_for_date: string; status: string }>)
      .filter((l) => l.status === 'sent')
      .map((l) => `${l.subscription_id}:${l.remind_for_date}`)
  );

  const resendKey = Deno.env.get('RESEND_API_KEY')?.trim();
  if (!resendKey) {
    return reply({
      ok: true,
      resendConfigured: false,
      processed: dueSubs.length,
      sent: 0,
      skipped: dueSubs.length,
      failed: 0,
      message: 'RESEND_API_KEY is not configured in Edge Function secrets.'
    });
  }

  const emailCache = new Map<string, string | null>();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const sub of dueSubs) {
    const targetDate = sub.status === 'trial' && sub.trial_end_date ? sub.trial_end_date : sub.next_renewal_date;
    const logKey = `${sub.id}:${targetDate}`;
    if (sentKeys.has(logKey)) {
      skipped += 1;
      continue;
    }
    const setting = settingsMap.get(sub.user_id);
    if (!activeUsers.has(sub.user_id) || (setting && !setting.email_reminders)) {
      skipped += 1;
      continue;
    }

    let email = emailCache.get(sub.user_id);
    if (email === undefined) {
      const { data: userLookup } = await serviceClient.auth.admin.getUserById(sub.user_id);
      email = userLookup.user?.email ?? null;
      emailCache.set(sub.user_id, email);
    }
    if (!email) {
      skipped += 1;
      continue;
    }

    const locale = setting?.locale ?? 'zh-CN';
    const daysLeft = diffDays(localToday, targetDate);
    const { subject, html } = buildReminderEmail(sub, targetDate, daysLeft, locale);

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Renewly <no-reply@yeecc.cn>',
          to: [email],
          subject,
          html
        })
      });

      if (!res.ok) {
        const errBody = await res.text();
        await serviceClient.from('reminder_log').upsert(
          {
            subscription_id: sub.id,
            user_id: sub.user_id,
            remind_for_date: targetDate,
            status: 'failed',
            error_message: errBody.slice(0, 300),
            sent_at: new Date().toISOString()
          },
          { onConflict: 'subscription_id,remind_for_date' }
        );
        failed += 1;
      } else {
        await serviceClient.from('reminder_log').upsert(
          {
            subscription_id: sub.id,
            user_id: sub.user_id,
            remind_for_date: targetDate,
            status: 'sent',
            error_message: null,
            sent_at: new Date().toISOString()
          },
          { onConflict: 'subscription_id,remind_for_date' }
        );
        sent += 1;
      }
    } catch (cause) {
      await serviceClient.from('reminder_log').upsert(
        {
          subscription_id: sub.id,
          user_id: sub.user_id,
          remind_for_date: targetDate,
          status: 'failed',
          error_message: cause instanceof Error ? cause.message.slice(0, 300) : 'send_failed',
          sent_at: new Date().toISOString()
        },
        { onConflict: 'subscription_id,remind_for_date' }
      );
      failed += 1;
    }
  }

  return reply({ ok: true, resendConfigured: true, processed: dueSubs.length, sent, skipped, failed });
});

function buildReminderEmail(sub: SubscriptionRow, targetDate: string, daysLeft: number, locale: 'zh-CN' | 'en') {
  const sym = currencySymbols[sub.currency] ?? sub.currency;
  const amountText = `${sym}${Number(sub.amount).toFixed(2)} ${sub.currency}`;
  const isTrial = sub.status === 'trial';
  const safeName = escapeHtml(sub.name);

  if (locale === 'en') {
    const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
    const actionLabel = isTrial ? 'trial ends' : 'renews';
    const subject = `Renewly Reminder: ${sub.name} ${actionLabel} ${when}`;
    const html = `
      <div style="margin:0;padding:32px 12px;background:#F7F7FB;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;color:#111827;">
        <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:20px;padding:28px;">
          <p style="margin:0 0 8px;color:#5B5BF0;font-size:13px;font-weight:700;letter-spacing:0.6px;">RENEWLY · SUBSCRIPTION REMINDER</p>
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.35;">${safeName} ${actionLabel} ${when}</h1>
          <p style="margin:0 0 20px;color:#4B5563;font-size:14px;line-height:1.6;">
            ${isTrial ? 'Your free trial is ending soon.' : 'Your subscription has an upcoming renewal.'} Review your plan in Renewly before billing occurs.
          </p>
          <div style="background:#F7F7FB;border-radius:14px;padding:16px 18px;margin-bottom:20px;">
            <div style="font-size:13px;color:#6B7280;margin-bottom:4px;">${isTrial ? 'Post-trial amount' : 'Renewal amount'}</div>
            <div style="font-size:24px;font-weight:800;color:#111827;">${amountText}</div>
            <div style="font-size:13px;color:#6B7280;margin-top:6px;">Date: ${targetDate}</div>
          </div>
          <a href="https://renewly.yeecc.cn/" style="display:inline-block;background:#5B5BF0;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:12px;">Open Renewly</a>
        </div>
      </div>
    `;
    return { subject, html };
  }

  const when = daysLeft === 0 ? '今天' : daysLeft === 1 ? '明天' : `${daysLeft} 天后`;
  const actionLabel = isTrial ? '试用即将到期' : '即将自动续费';
  const subject = `Renewly 提醒：${sub.name} ${when}${isTrial ? '试用到期' : '续费'}`;
  const html = `
    <div style="margin:0;padding:32px 12px;background:#F7F7FB;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#111827;">
      <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:20px;padding:28px;">
        <p style="margin:0 0 8px;color:#5B5BF0;font-size:13px;font-weight:700;letter-spacing:0.6px;">RENEWLY · 订阅续费提醒</p>
        <h1 style="margin:0 0 12px;font-size:22px;line-height:1.4;">${safeName} ${when}${actionLabel}</h1>
        <p style="margin:0 0 20px;color:#4B5563;font-size:14px;line-height:1.7;">
          ${isTrial ? '你的免费试用期即将结束，若不打算继续使用请及时在服务商处取消。' : '你的订阅即将迎来新一期扣费，可登录 Renewly 查看或管理此订阅。'}
        </p>
        <div style="background:#F7F7FB;border-radius:14px;padding:16px 18px;margin-bottom:20px;">
          <div style="font-size:13px;color:#6B7280;margin-bottom:4px;">${isTrial ? '到期后费用' : '本期扣费金额'}</div>
          <div style="font-size:24px;font-weight:800;color:#111827;">${amountText}</div>
          <div style="font-size:13px;color:#6B7280;margin-top:6px;">预计日期：${targetDate}</div>
        </div>
        <a href="https://renewly.yeecc.cn/" style="display:inline-block;background:#5B5BF0;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:12px;">前往 Renewly 查看</a>
      </div>
    </div>
  `;
  return { subject, html };
}

function addDays(dateStr: string, days: number) {
  const dt = new Date(`${dateStr}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function diffDays(fromDate: string, toDate: string) {
  const a = Date.parse(`${fromDate}T00:00:00.000Z`);
  const b = Date.parse(`${toDate}T00:00:00.000Z`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
