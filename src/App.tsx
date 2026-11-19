import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Icon } from './Icon';
import {
  CURRENCIES,
  buildRateMap,
  categoryDisplayName,
  getGreeting,
  localTodayKey,
  paymentDisplayName,
  t,
} from './i18n';
import { isErrorUserMessage, toUserMessage } from './userMessages';
import {
  CalendarTab,
  CategoriesModal,
  OverviewTab,
  PaymentMethodsModal,
  RenewCheckoutModal,
  SubscriptionDetailModal,
  SubscriptionFormModal,
  SubscriptionsTab,
} from './subscriptions';
import type {
  BillingInterval,
  Category,
  CurrencyCode,
  ExchangeRate,
  Locale,
  NavKey,
  PaymentMethod,
  Profile,
  Subscription,
  SubscriptionEvent,
  SubscriptionStatus,
  SubscriptionTemplate,
  ThemeChoice,
  UserSettings,
} from './types';

const AdminPortal = lazy(() => import('./AdminPortal'));
const AuthView = lazy(async () => ({ default: (await import('./account')).AuthView }));
const AccountSubpage = lazy(async () => ({ default: (await import('./account')).AccountSubpage }));

type AccountSubView = null | 'edit-profile' | 'change-password' | 'delete-account' | 'logout';

function maskEmail(email?: string) {
  if (!email) return '—';
  const [local, domain] = email.split('@');
  if (!domain) return '—';
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

function effectiveProfileStatus(profile: Pick<Profile, 'account_status' | 'suspension_expires_at'>) {
  if (profile.account_status === 'suspended' && profile.suspension_expires_at && Date.parse(profile.suspension_expires_at) <= Date.now()) {
    return 'active';
  }
  return profile.account_status;
}

export default function App() {
  const host = window.location.hostname.toLowerCase();
  const adminHost = host === 'renewly-admin.yeecc.cn' || host === 'admin.yeecc.cn';
  const localAdminRoute = import.meta.env.DEV && (window.location.pathname === '/admin' || window.location.hash === '#/admin');
  if (adminHost || localAdminRoute) {
    return (
      <Suspense fallback={<div className="loading"><Icon name="progress_activity" className="spin" /><p>Opening Renewly Admin…</p></div>}>
        <AdminPortal />
      </Suspense>
    );
  }
  if (window.location.hash === '#/admin') return <RedirectToAdmin />;
  return <RenewlyApp />;
}

function RedirectToAdmin() {
  useEffect(() => { window.location.replace('https://renewly-admin.yeecc.cn/'); }, []);
  return <div className="loading"><Icon name="open_in_new" /><p>Redirecting to Renewly Admin…</p></div>;
}

function RenewlyApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);

  const [locale, setLocale] = useState<Locale>(() => (localStorage.getItem('renewly_locale') === 'en' ? 'en' : 'zh-CN'));
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    const saved = localStorage.getItem('renewly_theme');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });

  const [nav, setNav] = useState<NavKey>('overview');
  const [accountView, setAccountView] = useState<AccountSubView>(null);
  const [toast, setToast] = useState('');

  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<UserSettings>({
    user_id: '',
    locale,
    base_currency: 'CNY',
    theme,
    email_reminders: true,
    default_reminder_days: 3,
    updated_at: '',
  });
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [templates, setTemplates] = useState<SubscriptionTemplate[]>([]);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [openSmartCapture, setOpenSmartCapture] = useState(false);
  const [editingSub, setEditingSub] = useState<Subscription | null>(null);
  const [renewingSub, setRenewingSub] = useState<Subscription | null>(null);
  const [detailSub, setDetailSub] = useState<Subscription | null>(null);
  const [detailEvents, setDetailEvents] = useState<SubscriptionEvent[]>([]);
  const [detailEventsLoading, setDetailEventsLoading] = useState(false);
  const [showCategoriesModal, setShowCategoriesModal] = useState(false);
  const [showPaymentsModal, setShowPaymentsModal] = useState(false);
  const [fxRefreshing, setFxRefreshing] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const notify = useCallback((msg: unknown) => {
    const text = toUserMessage(msg, locale);
    setToast(text);
  }, [locale]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    localStorage.setItem('renewly_locale', locale);
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    localStorage.setItem('renewly_theme', theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#0F111A' : '#5B5BF0');
    };
    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void import('./supabase').then(({ supabase }) => {
      if (!active) return;
      if (!supabase) {
        setAuthReady(true);
        return;
      }
      void supabase.auth.getSession().then(({ data }) => {
        if (!active) return;
        setSession(data.session);
        setAuthReady(true);
      });
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        if (!active) return;
        setSession(nextSession);
        setAuthReady(true);
        if (!nextSession) {
          setAccountView(null);
          setSubscriptions([]);
          setCategories([]);
          setPaymentMethods([]);
          setProfile(null);
        }
      });
      unsubscribe = () => subscription.unsubscribe();
    }).catch(() => {
      if (active) setAuthReady(true);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const loadCloudData = useCallback(async (uid: string) => {
    setDataLoading(true);
    const cacheKey = `renewly_cache_${uid}`;

    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;

      let [
        profileRes,
        settingsRes,
        catsRes,
        pmsRes,
        subsRes,
        tplsRes,
        ratesRes,
      ] = await Promise.all([
        supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at').eq('id', uid).maybeSingle(),
        supabase.from('user_settings').select('*').eq('user_id', uid).maybeSingle(),
        supabase.from('categories').select('*').eq('user_id', uid).order('sort', { ascending: true }).order('created_at', { ascending: true }),
        supabase.from('payment_methods').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
        supabase.from('subscriptions').select('*').eq('user_id', uid).order('next_renewal_date', { ascending: true }),
        supabase.from('subscription_templates').select('*').order('sort', { ascending: true }),
        supabase.from('exchange_rates').select('*'),
      ]);

      if (!settingsRes.error && (!settingsRes.data || !(catsRes.data?.length))) {
        await supabase.rpc('ensure_user_defaults');
        [settingsRes, catsRes, pmsRes] = await Promise.all([
          supabase.from('user_settings').select('*').eq('user_id', uid).maybeSingle(),
          supabase.from('categories').select('*').eq('user_id', uid).order('sort', { ascending: true }).order('created_at', { ascending: true }),
          supabase.from('payment_methods').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
        ]);
      }

      const firstErr = profileRes.error ?? settingsRes.error ?? catsRes.error ?? pmsRes.error ?? subsRes.error ?? tplsRes.error ?? ratesRes.error;
      if (firstErr) throw firstErr;

      const nextProfile = profileRes.data as Profile | null;
      const nextSettings = (settingsRes.data as UserSettings | null) ?? {
        user_id: uid,
        locale,
        base_currency: 'CNY' as CurrencyCode,
        theme,
        email_reminders: true,
        default_reminder_days: 3,
        updated_at: new Date().toISOString(),
      };
      const nextCats = (catsRes.data ?? []) as Category[];
      const nextPms = (pmsRes.data ?? []) as PaymentMethod[];
      const nextSubs = (subsRes.data ?? []) as Subscription[];
      const nextTpls = (tplsRes.data ?? []) as SubscriptionTemplate[];
      const nextRates = (ratesRes.data ?? []) as ExchangeRate[];

      setProfile(nextProfile);
      setSettings(nextSettings);
      setLocale(nextSettings.locale);
      setTheme(nextSettings.theme);
      setCategories(nextCats);
      setPaymentMethods(nextPms);
      setSubscriptions(nextSubs);
      setTemplates(nextTpls);
      setExchangeRates(nextRates);

      localStorage.setItem(
        cacheKey,
        JSON.stringify({
          profile: nextProfile,
          settings: nextSettings,
          categories: nextCats,
          paymentMethods: nextPms,
          subscriptions: nextSubs,
          templates: nextTpls,
          exchangeRates: nextRates,
        })
      );
    } catch (cause) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as {
            profile?: Profile | null;
            settings?: UserSettings;
            categories?: Category[];
            paymentMethods?: PaymentMethod[];
            subscriptions?: Subscription[];
            templates?: SubscriptionTemplate[];
            exchangeRates?: ExchangeRate[];
          };
          if (parsed.profile !== undefined) setProfile(parsed.profile);
          if (parsed.settings) setSettings(parsed.settings);
          if (parsed.categories) setCategories(parsed.categories);
          if (parsed.paymentMethods) setPaymentMethods(parsed.paymentMethods);
          if (parsed.subscriptions) setSubscriptions(parsed.subscriptions);
          if (parsed.templates) setTemplates(parsed.templates);
          if (parsed.exchangeRates) setExchangeRates(parsed.exchangeRates);
        } catch {
          // ignore malformed cache
        }
      }
      if (navigator.onLine) notify(cause);
    } finally {
      setDataLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (session?.user.id) {
      void loadCloudData(session.user.id);
    }
  }, [session?.user.id, loadCloudData]);

  const ratesMap = useMemo(() => buildRateMap(exchangeRates), [exchangeRates]);
  const isRestricted = Boolean(profile && effectiveProfileStatus(profile) !== 'active');
  const canEdit = online && !isRestricted && Boolean(session);

  const updateSettings = async (patch: Partial<UserSettings>) => {
    const optimistic = { ...settings, ...patch };
    setSettings(optimistic);
    if (patch.locale) setLocale(patch.locale);
    if (patch.theme) setTheme(patch.theme);

    if (!session || !online) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { error } = await supabase
        .from('user_settings')
        .upsert({ ...optimistic, user_id: session.user.id, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
    } catch (cause) {
      notify(cause);
    }
  };

  const openDetail = async (sub: Subscription) => {
    setDetailSub(sub);
    setDetailEvents([]);
    if (!online) return;
    setDetailEventsLoading(true);
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { data, error } = await supabase
        .from('subscription_events')
        .select('*')
        .eq('subscription_id', sub.id)
        .order('occurred_on', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      setDetailEvents((data ?? []) as SubscriptionEvent[]);
    } catch (cause) {
      notify(cause);
    } finally {
      setDetailEventsLoading(false);
    }
  };

  const saveSubscription = async (payload: {
    name: string;
    color: string;
    icon: string;
    amount: number;
    currency: CurrencyCode;
    interval: BillingInterval;
    interval_count: number;
    start_date: string;
    status: SubscriptionStatus;
    trial_end_date: string | null;
    auto_renew: boolean;
    category_id: string | null;
    payment_method_id: string | null;
    url: string;
    cancel_url: string;
    note: string;
    reminder_days: number;
  }) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      if (editingSub) {
        const { error } = await supabase
          .from('subscriptions')
          .update(payload)
          .eq('id', editingSub.id)
          .eq('user_id', session.user.id);
        if (error) throw error;
        setToast(t(locale, 'subUpdated'));
      } else {
        const { error } = await supabase
          .from('subscriptions')
          .insert({ ...payload, user_id: session.user.id });
        if (error) throw error;
        setToast(t(locale, 'subSaved'));
      }
      setShowForm(false);
      setOpenSmartCapture(false);
      setEditingSub(null);
      await loadCloudData(session.user.id);
    } catch (cause) {
      notify(cause);
    }
  };

  const togglePause = async (sub: Subscription) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const nextStatus: SubscriptionStatus = sub.status === 'paused' ? 'active' : 'paused';
      const { data, error } = await supabase
        .from('subscriptions')
        .update({ status: nextStatus })
        .eq('id', sub.id)
        .eq('user_id', session.user.id)
        .select('*')
        .single();
      if (error) throw error;
      setToast(nextStatus === 'paused' ? t(locale, 'subPaused') : t(locale, 'subResumed'));
      await loadCloudData(session.user.id);
      if (data) void openDetail(data as Subscription);
    } catch (cause) {
      notify(cause);
    }
  };

  const cancelSub = async (sub: Subscription) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { data, error } = await supabase
        .from('subscriptions')
        .update({ status: 'cancelled', auto_renew: false })
        .eq('id', sub.id)
        .eq('user_id', session.user.id)
        .select('*')
        .single();
      if (error) throw error;
      setToast(t(locale, 'subCancelled'));
      await loadCloudData(session.user.id);
      if (data) void openDetail(data as Subscription);
    } catch (cause) {
      notify(cause);
    }
  };

  const logCharge = async (sub: Subscription) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { error } = await supabase.from('subscription_events').insert({
        subscription_id: sub.id,
        user_id: session.user.id,
        type: 'charge',
        amount: sub.amount,
        currency: sub.currency,
        occurred_on: localTodayKey(),
        meta: { manual: true },
      });
      if (error) throw error;
      setToast(t(locale, 'chargeLogged'));
      void openDetail(sub);
    } catch (cause) {
      notify(cause);
    }
  };

  const renewSubscription = async (
    sub: Subscription,
    payload: { cycles: number; amount: number; paymentMethodId: string | null; note: string }
  ): Promise<Subscription | null> => {
    if (!session || !canEdit) return null;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return null;
      const { data, error } = await supabase.rpc('renew_subscription', {
        p_subscription_id: sub.id,
        p_cycles: payload.cycles,
        p_amount: payload.amount,
        p_payment_method_id: payload.paymentMethodId,
        p_note: payload.note || null,
      });
      if (error) throw error;
      const result = data as { subscription?: Subscription } | null;
      const updated = result?.subscription ?? null;
      setToast(t(locale, 'renewCompletedToast'));
      await loadCloudData(session.user.id);
      if (detailSub?.id === sub.id && updated) {
        void openDetail(updated);
      }
      return updated;
    } catch (cause) {
      notify(cause);
      return null;
    }
  };

  const deleteSubscription = async (sub: Subscription) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { error } = await supabase
        .from('subscriptions')
        .delete()
        .eq('id', sub.id)
        .eq('user_id', session.user.id);
      if (error) throw error;
      setDetailSub(null);
      setToast(t(locale, 'subDeleted'));
      await loadCloudData(session.user.id);
    } catch (cause) {
      notify(cause);
    }
  };

  const addCategory = async (payload: { name: string; name_en: string; color: string; icon: string }) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { error } = await supabase.from('categories').insert({
        user_id: session.user.id,
        key: 'custom',
        name: payload.name,
        name_en: payload.name_en,
        color: payload.color,
        icon: payload.icon,
        sort: categories.length + 1,
      });
      if (error) throw error;
      await loadCloudData(session.user.id);
    } catch (cause) {
      notify(cause);
    }
  };

  const deleteCategory = async (id: string) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { error } = await supabase.from('categories').delete().eq('id', id).eq('user_id', session.user.id);
      if (error) throw error;
      await loadCloudData(session.user.id);
    } catch (cause) {
      notify(cause);
    }
  };

  const addPaymentMethod = async (payload: { name: string; name_en: string; type: PaymentMethod['type']; last4: string | null }) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { error } = await supabase.from('payment_methods').insert({
        user_id: session.user.id,
        ...payload,
      });
      if (error) throw error;
      await loadCloudData(session.user.id);
    } catch (cause) {
      notify(cause);
    }
  };

  const deletePaymentMethod = async (id: string) => {
    if (!session || !canEdit) return;
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { error } = await supabase.from('payment_methods').delete().eq('id', id).eq('user_id', session.user.id);
      if (error) throw error;
      await loadCloudData(session.user.id);
    } catch (cause) {
      notify(cause);
    }
  };

  const refreshRates = async () => {
    if (!session || !online || fxRefreshing) return;
    setFxRefreshing(true);
    try {
      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { data, error } = await supabase.functions.invoke('refresh-exchange-rates');
      if (error || data?.error) throw new Error(error?.message ?? data?.error ?? 'fx_failed');
      setToast(t(locale, 'ratesRefreshed'));
      await loadCloudData(session.user.id);
    } catch (cause) {
      notify(cause);
    } finally {
      setFxRefreshing(false);
    }
  };

  const exportCsv = () => {
    const header = ['name', 'amount', 'currency', 'interval', 'interval_count', 'start_date', 'status', 'trial_end_date', 'auto_renew', 'category', 'payment_method', 'url', 'cancel_url', 'reminder_days', 'note'];
    const escapeCell = (val: unknown) => {
      const s = String(val ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = subscriptions.map((sub) => {
      const cat = categories.find((c) => c.id === sub.category_id);
      const pm = paymentMethods.find((p) => p.id === sub.payment_method_id);
      return [
        sub.name,
        sub.amount,
        sub.currency,
        sub.interval,
        sub.interval_count,
        sub.start_date,
        sub.status,
        sub.trial_end_date ?? '',
        sub.auto_renew,
        cat ? categoryDisplayName(cat, locale) : '',
        pm ? paymentDisplayName(pm, locale) : '',
        sub.url,
        sub.cancel_url,
        sub.reminder_days,
        sub.note,
      ].map(escapeCell).join(',');
    });
    const csv = '\uFEFF' + [header.join(','), ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `renewly-subscriptions-${localTodayKey()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(t(locale, 'csvExported'));
  };

  const importCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !session || !canEdit) return;
    if (file.size > 5 * 1024 * 1024) {
      notify(locale === 'en' ? 'CSV file must be under 5 MB.' : 'CSV 文件不能超过 5 MB。');
      return;
    }
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      const parsed = parseCsv(text);
      if (parsed.length < 2) throw new Error(locale === 'en' ? 'CSV is empty.' : 'CSV 文件为空。');
      const cols = parsed[0].map((h) => h.trim().toLowerCase());
      const idx = (name: string) => cols.indexOf(name);
      const nameIdx = idx('name');
      const amountIdx = idx('amount');
      if (nameIdx === -1 || amountIdx === -1) {
        throw new Error(locale === 'en' ? 'CSV must include name and amount columns.' : 'CSV 必须包含 name 和 amount 列。');
      }

      const validCurrencies = new Set(['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP']);
      const validIntervals = new Set(['week', 'month', 'quarter', 'year', 'custom']);
      const validStatuses = new Set(['trial', 'active', 'paused', 'cancelled']);

      const inserts = parsed.slice(1).filter((r) => r.some((cell) => cell.trim())).map((row) => {
        const rawName = (row[nameIdx] ?? '').trim().slice(0, 80);
        const rawAmount = Number(row[amountIdx]);
        if (!rawName || !Number.isFinite(rawAmount) || rawAmount < 0) return null;

        const curr = ((row[idx('currency')] ?? settings.base_currency).trim().toUpperCase()) as CurrencyCode;
        const inter = ((row[idx('interval')] ?? 'month').trim().toLowerCase()) as BillingInterval;
        const stat = ((row[idx('status')] ?? 'active').trim().toLowerCase()) as SubscriptionStatus;
        const catStr = (row[idx('category')] ?? '').trim().toLowerCase();
        const pmStr = (row[idx('payment_method')] ?? '').trim().toLowerCase();
        const matchedCat = categories.find((c) => c.name.toLowerCase() === catStr || c.name_en.toLowerCase() === catStr);
        const matchedPm = paymentMethods.find((p) => p.name.toLowerCase() === pmStr || p.name_en.toLowerCase() === pmStr);
        const startRaw = (row[idx('start_date')] ?? '').trim();

        return {
          user_id: session.user.id,
          name: rawName,
          amount: Math.round(rawAmount * 100) / 100,
          currency: validCurrencies.has(curr) ? curr : settings.base_currency,
          interval: validIntervals.has(inter) ? inter : 'month',
          interval_count: Math.max(1, Math.min(365, Number(row[idx('interval_count')] ?? 1) || 1)),
          start_date: /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? startRaw : localTodayKey(),
          status: validStatuses.has(stat) ? stat : 'active',
          trial_end_date: /^\d{4}-\d{2}-\d{2}$/.test((row[idx('trial_end_date')] ?? '').trim()) ? row[idx('trial_end_date')].trim() : null,
          auto_renew: (row[idx('auto_renew')] ?? 'true').trim().toLowerCase() !== 'false',
          category_id: matchedCat?.id ?? null,
          payment_method_id: matchedPm?.id ?? null,
          url: (row[idx('url')] ?? '').trim(),
          cancel_url: (row[idx('cancel_url')] ?? '').trim(),
          reminder_days: Math.max(0, Math.min(30, Number(row[idx('reminder_days')] ?? settings.default_reminder_days) || 0)),
          note: (row[idx('note')] ?? '').trim().slice(0, 500),
        };
      }).filter((item): item is NonNullable<typeof item> => item !== null);

      if (!inserts.length) throw new Error(locale === 'en' ? 'No valid subscription rows found.' : '没有找到有效的订阅记录行。');

      const { supabase } = await import('./supabase');
      if (!supabase) return;
      const { error } = await supabase.from('subscriptions').insert(inserts);
      if (error) throw error;
      setToast(`${t(locale, 'csvImported')} (${inserts.length})`);
      await loadCloudData(session.user.id);
    } catch (cause) {
      notify(cause);
    }
  };

  if (!authReady) {
    return (
      <div className="loading">
        <Icon name="progress_activity" className="spin" size={28} />
        <p>{t(locale, 'loadingApp')}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <>
        <Suspense fallback={<div className="loading"><Icon name="progress_activity" className="spin" size={28} /></div>}>
          <AuthView
            locale={locale}
            onToggleLocale={() => setLocale((c) => (c === 'zh-CN' ? 'en' : 'zh-CN'))}
            theme={theme}
            onToggleTheme={() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}
            onMessage={notify}
          />
        </Suspense>
        {toast && <ToastBar toast={toast} />}
      </>
    );
  }

  const navItems: Array<{ key: NavKey; icon: string; label: string }> = [
    { key: 'overview', icon: 'layout_grid', label: t(locale, 'navOverview') },
    { key: 'subscriptions', icon: 'repeat', label: t(locale, 'navSubscriptions') },
    { key: 'calendar', icon: 'calendar', label: t(locale, 'navCalendar') },
    { key: 'settings', icon: 'sliders', label: t(locale, 'navSettings') },
  ];

  const fxDate = exchangeRates[0]?.fetched_on;
  const resolvedDark = document.documentElement.dataset.theme === 'dark';

  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href="#overview"
          onClick={(e) => { e.preventDefault(); setAccountView(null); setNav('overview'); }}
        >
          <span className="brandmark"><Icon name="repeat" size={18} /></span>
          <span>
            <b>Renewly</b>
            <small>{getGreeting(locale)}{profile?.display_name ? ` · ${profile.display_name}` : ''}</small>
          </span>
        </a>

        <div className="top-actions">
          <button
            type="button"
            className="chip-button"
            onClick={() => void updateSettings({ locale: locale === 'zh-CN' ? 'en' : 'zh-CN' })}
            aria-label={t(locale, 'languageLabel')}
          >
            <Icon name="globe" size={15} />
            <span>{locale === 'zh-CN' ? 'EN' : '中文'}</span>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void updateSettings({ theme: resolvedDark ? 'light' : 'dark' })}
            aria-label={t(locale, 'themeLabel')}
          >
            <Icon name={resolvedDark ? 'light_mode' : 'dark_mode'} size={18} />
          </button>
          <button
            type="button"
            className="avatar-chip"
            onClick={() => { setAccountView(null); setNav('settings'); }}
            aria-label={t(locale, 'navSettings')}
          >
            {(profile?.display_name ?? session.user.email ?? 'R').slice(0, 1).toUpperCase()}
          </button>
        </div>
      </header>

      <main className="main-content">
        {!online && (
          <div className="status-banner warning" role="status">
            <Icon name="wifi_off" size={17} />
            <span>{t(locale, 'offlineBanner')}</span>
          </div>
        )}
        {isRestricted && (
          <div className="status-banner danger" role="alert">
            <Icon name="error" size={17} />
            <span>{t(locale, 'restrictedBanner')}</span>
          </div>
        )}

        {dataLoading && subscriptions.length === 0 ? (
          <div className="surface-card loading-card">
            <Icon name="progress_activity" className="spin" size={26} />
            <p>{t(locale, 'loadingApp')}</p>
          </div>
        ) : accountView ? (
          <Suspense fallback={<div className="surface-card loading-card"><Icon name="progress_activity" className="spin" size={24} /></div>}>
            <AccountSubpage
              session={session}
              locale={locale}
              page={accountView}
              onBack={() => setAccountView(null)}
              onMessage={notify}
              onProfileChange={setProfile}
            />
          </Suspense>
        ) : nav === 'overview' ? (
          <OverviewTab
            locale={locale}
            baseCurrency={settings.base_currency}
            subscriptions={subscriptions}
            categories={categories}
            paymentMethods={paymentMethods}
            ratesMap={ratesMap}
            canEdit={canEdit}
            onAdd={() => { setEditingSub(null); setOpenSmartCapture(false); setShowForm(true); }}
            onSmartAdd={() => { setEditingSub(null); setOpenSmartCapture(true); setShowForm(true); }}
            onGoSubscriptions={() => setNav('subscriptions')}
            onSelectSubscription={(sub) => void openDetail(sub)}
            onRenew={(sub) => setRenewingSub(sub)}
          />
        ) : nav === 'subscriptions' ? (
          <SubscriptionsTab
            locale={locale}
            baseCurrency={settings.base_currency}
            subscriptions={subscriptions}
            categories={categories}
            paymentMethods={paymentMethods}
            ratesMap={ratesMap}
            canEdit={canEdit}
            onAdd={() => { setEditingSub(null); setOpenSmartCapture(false); setShowForm(true); }}
            onSmartAdd={() => { setEditingSub(null); setOpenSmartCapture(true); setShowForm(true); }}
            onSelectSubscription={(sub) => void openDetail(sub)}
            onRenew={(sub) => setRenewingSub(sub)}
          />
        ) : nav === 'calendar' ? (
          <CalendarTab
            locale={locale}
            baseCurrency={settings.base_currency}
            subscriptions={subscriptions}
            ratesMap={ratesMap}
            canEdit={canEdit}
            onSelectSubscription={(sub) => void openDetail(sub)}
            onRenew={(sub) => setRenewingSub(sub)}
          />
        ) : (
          <div className="tab-stack">
            <div className="page-head-row">
              <h1>{t(locale, 'settingsTitle')}</h1>
              {profile?.role === 'admin' && effectiveProfileStatus(profile) === 'active' && (
                <a
                  className="soft-button compact"
                  href={import.meta.env.DEV ? `${window.location.origin}/#/admin` : 'https://renewly-admin.yeecc.cn/'}
                >
                  <Icon name="admin_panel_settings" size={16} />
                  <span>{locale === 'en' ? 'Admin' : '管理后台'}</span>
                </a>
              )}
            </div>

            <section className="surface-card account-card">
              <div className="account-card-top">
                <span className="account-avatar-lg">
                  {(profile?.display_name ?? session.user.email ?? 'R').slice(0, 1).toUpperCase()}
                </span>
                <div className="account-card-meta">
                  <b>{profile?.display_name ?? 'Renewly User'}</b>
                  <small>{maskEmail(session.user.email)}</small>
                  {profile?.uid && <small>UID {profile.uid}</small>}
                </div>
                <span className={`badge-pill ${isRestricted ? 'coral' : 'mint'}`}>
                  {isRestricted
                    ? (locale === 'en' ? 'Restricted' : '受限')
                    : (locale === 'en' ? 'Cloud Synced' : '云端已同步')}
                </span>
              </div>
              <div className="settings-rows">
                <button type="button" className="settings-row" disabled={!canEdit} onClick={() => setAccountView('edit-profile')}>
                  <span className="settings-icon"><Icon name="edit" size={17} /></span>
                  <span><b>{t(locale, 'editProfile')}</b></span>
                  <Icon name="chevron_right" size={17} />
                </button>
                <button type="button" className="settings-row" disabled={!canEdit} onClick={() => setAccountView('change-password')}>
                  <span className="settings-icon"><Icon name="key" size={17} /></span>
                  <span><b>{t(locale, 'changePassword')}</b></span>
                  <Icon name="chevron_right" size={17} />
                </button>
                <button type="button" className="settings-row" onClick={() => setAccountView('logout')}>
                  <span className="settings-icon"><Icon name="logout" size={17} /></span>
                  <span><b>{t(locale, 'signOut')}</b></span>
                  <Icon name="chevron_right" size={17} />
                </button>
                <button type="button" className="settings-row danger" disabled={!online} onClick={() => setAccountView('delete-account')}>
                  <span className="settings-icon red"><Icon name="delete_forever" size={17} /></span>
                  <span><b>{t(locale, 'deleteAccount')}</b></span>
                  <Icon name="chevron_right" size={17} />
                </button>
              </div>
            </section>

            <section className="surface-card settings-group">
              <h2>{t(locale, 'preferencesSection')}</h2>
              <div className="settings-rows">
                <div className="settings-row static">
                  <span className="settings-icon"><Icon name="globe" size={17} /></span>
                  <span><b>{t(locale, 'languageLabel')}</b></span>
                  <select
                    className="inline-select"
                    value={locale}
                    onChange={(e) => void updateSettings({ locale: e.target.value as Locale })}
                    aria-label={t(locale, 'languageLabel')}
                  >
                    <option value="zh-CN">简体中文</option>
                    <option value="en">English</option>
                  </select>
                </div>

                <div className="settings-row static">
                  <span className="settings-icon"><Icon name="dollar" size={17} /></span>
                  <span>
                    <b>{t(locale, 'baseCurrencyLabel')}</b>
                    {fxDate && <small>{t(locale, 'fxUpdatedAt')} {fxDate}</small>}
                  </span>
                  <div className="inline-controls">
                    <select
                      className="inline-select"
                      value={settings.base_currency}
                      onChange={(e) => void updateSettings({ base_currency: e.target.value as CurrencyCode })}
                      aria-label={t(locale, 'baseCurrencyLabel')}
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c.code} value={c.code}>{c.code}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="soft-button compact"
                      disabled={!online || fxRefreshing}
                      onClick={() => void refreshRates()}
                      title={t(locale, 'refreshRates')}
                    >
                      <Icon name="refresh" size={15} className={fxRefreshing ? 'spin' : ''} />
                    </button>
                  </div>
                </div>

                <div className="settings-row static">
                  <span className="settings-icon"><Icon name={resolvedDark ? 'dark_mode' : 'light_mode'} size={17} /></span>
                  <span><b>{t(locale, 'themeLabel')}</b></span>
                  <select
                    className="inline-select"
                    value={theme}
                    onChange={(e) => void updateSettings({ theme: e.target.value as ThemeChoice })}
                    aria-label={t(locale, 'themeLabel')}
                  >
                    <option value="system">{t(locale, 'themeSystem')}</option>
                    <option value="light">{t(locale, 'themeLight')}</option>
                    <option value="dark">{t(locale, 'themeDark')}</option>
                  </select>
                </div>

                <label className="settings-row">
                  <span className="settings-icon"><Icon name="bell" size={17} /></span>
                  <span>
                    <b>{t(locale, 'emailRemindersLabel')}</b>
                    <small>{t(locale, 'emailRemindersDesc')}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.email_reminders}
                    disabled={!online}
                    onChange={(e) => void updateSettings({ email_reminders: e.target.checked })}
                  />
                </label>

                <div className="settings-row static">
                  <span className="settings-icon"><Icon name="date" size={17} /></span>
                  <span><b>{t(locale, 'defaultReminderLabel')}</b></span>
                  <select
                    className="inline-select"
                    value={settings.default_reminder_days}
                    onChange={(e) => void updateSettings({ default_reminder_days: Number(e.target.value) })}
                    aria-label={t(locale, 'defaultReminderLabel')}
                  >
                    <option value={1}>1 {t(locale, 'daysBefore')}</option>
                    <option value={3}>3 {t(locale, 'daysBefore')}</option>
                    <option value={7}>7 {t(locale, 'daysBefore')}</option>
                    <option value={14}>14 {t(locale, 'daysBefore')}</option>
                  </select>
                </div>
              </div>
            </section>

            <section className="surface-card settings-group">
              <h2>{t(locale, 'manageSection')}</h2>
              <div className="settings-rows">
                <button type="button" className="settings-row" disabled={!canEdit} onClick={() => setShowCategoriesModal(true)}>
                  <span className="settings-icon"><Icon name="layers" size={17} /></span>
                  <span>
                    <b>{t(locale, 'manageCategories')}</b>
                    <small>{t(locale, 'manageCategoriesDesc')}</small>
                  </span>
                  <Icon name="chevron_right" size={17} />
                </button>
                <button type="button" className="settings-row" disabled={!canEdit} onClick={() => setShowPaymentsModal(true)}>
                  <span className="settings-icon"><Icon name="credit_card" size={17} /></span>
                  <span>
                    <b>{t(locale, 'managePayments')}</b>
                    <small>{t(locale, 'managePaymentsDesc')}</small>
                  </span>
                  <Icon name="chevron_right" size={17} />
                </button>
                <button type="button" className="settings-row" onClick={exportCsv}>
                  <span className="settings-icon mint"><Icon name="download" size={17} /></span>
                  <span>
                    <b>{t(locale, 'exportCsv')}</b>
                    <small>{t(locale, 'exportCsvDesc')}</small>
                  </span>
                  <Icon name="chevron_right" size={17} />
                </button>
                <button type="button" className="settings-row" disabled={!canEdit} onClick={() => csvInputRef.current?.click()}>
                  <span className="settings-icon amber"><Icon name="upload_file" size={17} /></span>
                  <span>
                    <b>{t(locale, 'importCsv')}</b>
                    <small>{t(locale, 'importCsvDesc')}</small>
                  </span>
                  <Icon name="chevron_right" size={17} />
                </button>
                <input
                  ref={csvInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="visually-hidden-file"
                  onChange={(e) => void importCsv(e)}
                />
              </div>
            </section>
          </div>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Main navigation">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`nav-button ${nav === item.key ? 'active' : ''}`}
            onClick={() => { setAccountView(null); setNav(item.key); }}
            aria-current={nav === item.key ? 'page' : undefined}
          >
            <span className="nav-icon-wrap"><Icon name={item.icon} size={20} /></span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {toast && <ToastBar toast={toast} />}

      {showForm && (
        <SubscriptionFormModal
          locale={locale}
          initialSub={editingSub}
          settings={settings}
          categories={categories}
          paymentMethods={paymentMethods}
          templates={templates}
          online={online}
          initialOpenSmartCapture={openSmartCapture}
          onNotify={notify}
          onClose={() => { setShowForm(false); setOpenSmartCapture(false); setEditingSub(null); }}
          onSave={saveSubscription}
        />
      )}

      {detailSub && (
        <SubscriptionDetailModal
          locale={locale}
          sub={detailSub}
          baseCurrency={settings.base_currency}
          categories={categories}
          paymentMethods={paymentMethods}
          ratesMap={ratesMap}
          events={detailEvents}
          eventsLoading={detailEventsLoading}
          canEdit={canEdit}
          onClose={() => setDetailSub(null)}
          onEdit={() => {
            const target = detailSub;
            setDetailSub(null);
            setEditingSub(target);
            setOpenSmartCapture(false);
            setShowForm(true);
          }}
          onRenew={() => setRenewingSub(detailSub)}
          onLogCharge={() => logCharge(detailSub)}
          onTogglePause={() => togglePause(detailSub)}
          onCancelSub={() => cancelSub(detailSub)}
          onDelete={() => deleteSubscription(detailSub)}
        />
      )}

      {renewingSub && (
        <RenewCheckoutModal
          locale={locale}
          sub={renewingSub}
          baseCurrency={settings.base_currency}
          paymentMethods={paymentMethods}
          ratesMap={ratesMap}
          onClose={() => setRenewingSub(null)}
          onConfirmRenew={(payload) => renewSubscription(renewingSub, payload)}
        />
      )}

      {showCategoriesModal && (
        <CategoriesModal
          locale={locale}
          categories={categories}
          onClose={() => setShowCategoriesModal(false)}
          onAdd={addCategory}
          onDelete={deleteCategory}
        />
      )}

      {showPaymentsModal && (
        <PaymentMethodsModal
          locale={locale}
          paymentMethods={paymentMethods}
          onClose={() => setShowPaymentsModal(false)}
          onAdd={addPaymentMethod}
          onDelete={deletePaymentMethod}
        />
      )}
    </div>
  );
}

function ToastBar({ toast }: { toast: string }) {
  const isError = isErrorUserMessage(toast);
  return (
    <div className={`toast${isError ? ' toast-error' : ''}`} role={isError ? 'alert' : 'status'}>
      <Icon name={isError ? 'error' : 'check_circle'} size={18} />
      <span>{toast}</span>
    </div>
  );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
