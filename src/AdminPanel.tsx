import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useOtpCooldown } from './account';
import { Icon } from './Icon';
import { supabase } from './supabase';
import { useDismissibleDetails } from './useDismissibleDetails';
import { accountPasswordRule, isValidAccountPassword } from './authValidation';
import { BRAND_COLORS, BRAND_ICONS, CURRENCIES, formatMoney } from './i18n';
import { toChineseUserMessage } from './userMessages';
import type { AdminOverviewMetrics, CurrencyCode, Profile, SubscriptionTemplate } from './types';

type AdminSection = 'overview' | 'templates' | 'users' | 'admins' | 'audit';
type AdminProfile = Profile & { uid: string; email?: string; email_confirmed_at?: string | null; suspension_expires_at: string | null; created_at: string };
type AuditRow = { id: string; actor_id: string; target_type: string; target_id: string; action: string; reason: string; created_at: string };
type AdminIdentity = { id: string; uid: string; display_name: string; email: string; avatar_path?: string | null };
type UserStatusFilter = 'all' | 'active' | 'suspended' | 'banned' | 'deleted';
type RegistrationSort = 'newest' | 'oldest';
type RegistrationWindow = 'all' | '7d' | '30d' | '90d';

const sections: Array<{ id: AdminSection; label: string; icon: string }> = [
  { id: 'overview', label: '平台概况', icon: 'pie_chart' },
  { id: 'templates', label: '预设模板', icon: 'layers' },
  { id: 'users', label: '用户管理', icon: 'group' },
  { id: 'admins', label: '管理员账号', icon: 'admin_panel_settings' },
  { id: 'audit', label: '操作记录', icon: 'history' },
];

export default function AdminPanel({ session, onExit, onDenied }: { session: Session; onExit: () => void; onDenied: () => void }) {
  const [section, setSection] = useState<AdminSection>('overview');
  const [access, setAccess] = useState<'loading' | 'allowed' | 'denied'>('loading');
  const [overview, setOverview] = useState<AdminOverviewMetrics>({
    totalUsers: 0,
    activeSubscriptions: 0,
    totalTemplates: 0,
    remindersSentToday: 0,
    remindersFailedToday: 0,
    restrictedAccounts: 0,
  });
  const [templates, setTemplates] = useState<SubscriptionTemplate[]>([]);
  const [accounts, setAccounts] = useState<AdminProfile[]>([]);
  const [users, setUsers] = useState<AdminProfile[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [offsets, setOffsets] = useState({ users: 0, admins: 0, audit: 0 });
  const [hasMore, setHasMore] = useState({ users: false, admins: false, audit: false });
  const [adminIdentity, setAdminIdentity] = useState<AdminIdentity | null>(null);
  const [userStatusFilter, setUserStatusFilter] = useState<UserStatusFilter>('all');
  const [registrationSort, setRegistrationSort] = useState<RegistrationSort>('newest');
  const [registrationWindow, setRegistrationWindow] = useState<RegistrationWindow>('all');

  const [showOwnPassword, setShowOwnPassword] = useState(false);
  const [ownPassword, setOwnPassword] = useState('');
  const [ownPasswordConfirm, setOwnPasswordConfirm] = useState('');
  const [ownPasswordOtp, setOwnPasswordOtp] = useState('');
  const [ownPasswordCodeSent, setOwnPasswordCodeSent] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const { seconds: ownPasswordResendSeconds, start: startOwnPasswordCooldown } = useOtpCooldown();
  const accountMenuRef = useDismissibleDetails();

  const [suspensionHours, setSuspensionHours] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);

  useEffect(() => {
    let active = true;
    if (!supabase) { setAccess('denied'); onDenied(); return; }
    void supabase.functions.invoke('admin-manage', { body: { action: 'verify' } }).then(({ data, error: queryError }) => {
      if (!active) return;
      if (!queryError && data?.ok) {
        setAdminIdentity((data.actor ?? null) as AdminIdentity | null);
        setAccess('allowed');
        return;
      }
      setAccess('denied');
      setError(data?.error ?? queryError?.message ?? '后台权限验证失败。');
      onDenied();
    });
    return () => { active = false; };
  }, [session.user.id]);

  const load = useCallback(async () => {
    if (!supabase || access !== 'allowed') return;
    setLoading(true);
    setError('');

    const [overviewRes, tplRes, adminRes, userRes, auditRes] = await Promise.all([
      supabase.functions.invoke('admin-manage', { body: { action: 'overview' } }),
      supabase.from('subscription_templates').select('*').order('sort', { ascending: true }).order('created_at', { ascending: true }),
      supabase.functions.invoke('admin-manage', { body: { action: 'list_admins', limit: 100, offset: 0 } }),
      supabase.functions.invoke('admin-manage', { body: { action: 'list_users', limit: 100, offset: 0, statusFilter: userStatusFilter, sort: registrationSort, registeredWithin: registrationWindow } }),
      supabase.from('moderation_audit').select('id,actor_id,target_type,target_id,action,reason,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200),
    ]);

    const firstError = overviewRes.error ?? tplRes.error ?? adminRes.error ?? userRes.error ?? auditRes.error;
    if (firstError) {
      setError(firstError.message);
    }

    const nextOverview = (overviewRes.data as { overview?: AdminOverviewMetrics } | null)?.overview;
    if (nextOverview) setOverview(nextOverview);
    setTemplates((tplRes.data ?? []) as SubscriptionTemplate[]);

    const nextAccounts = ((adminRes.data as { admins?: AdminProfile[] } | null)?.admins ?? []);
    const nextUsers = ((userRes.data as { users?: AdminProfile[] } | null)?.users ?? []);
    const nextAudit = (auditRes.data ?? []) as AuditRow[];

    setAccounts(nextAccounts);
    setUsers(nextUsers);
    setAudit(nextAudit);
    setOffsets({ users: nextUsers.length, admins: nextAccounts.length, audit: nextAudit.length });
    setHasMore({ users: nextUsers.length === 100, admins: nextAccounts.length === 100, audit: nextAudit.length === 200 });
    setLoading(false);
  }, [access, registrationSort, registrationWindow, userStatusFilter]);

  useEffect(() => { void load(); }, [load]);

  const searchAccounts = async (role: 'user' | 'admin', query: string) => {
    if (!supabase) return;
    setLoading(true);
    setError('');
    const action = role === 'user' ? 'list_users' : 'list_admins';
    const { data, error: invokeError } = await supabase.functions.invoke('admin-manage', {
      body: { action, query: query.trim(), limit: 100, offset: 0, statusFilter: userStatusFilter, sort: registrationSort, registeredWithin: registrationWindow },
    });
    const failure = await readFunctionFailure(invokeError, data);
    if (invokeError || failure?.error) {
      setError(failure?.error ?? invokeError?.message ?? '账号搜索失败。');
      setLoading(false);
      return;
    }
    const rows = role === 'user'
      ? ((data as { users?: AdminProfile[] } | null)?.users ?? [])
      : ((data as { admins?: AdminProfile[] } | null)?.admins ?? []);
    if (role === 'user') {
      setUsers(rows);
      setOffsets((c) => ({ ...c, users: rows.length }));
      setHasMore((c) => ({ ...c, users: rows.length === 100 }));
    } else {
      setAccounts(rows);
      setOffsets((c) => ({ ...c, admins: rows.length }));
      setHasMore((c) => ({ ...c, admins: rows.length === 100 }));
    }
    setLoading(false);
  };

  const loadMore = async () => {
    if (!supabase || loading) return;
    setLoading(true);
    setError('');
    if (section === 'users' || section === 'admins') {
      const role = section === 'users' ? 'user' : 'admin';
      const pageKey = role === 'user' ? 'users' : 'admins';
      const start = offsets[pageKey];
      const action = role === 'user' ? 'list_users' : 'list_admins';
      const { data, error: queryError } = await supabase.functions.invoke('admin-manage', {
        body: { action, query: search.trim(), limit: 100, offset: start, statusFilter: userStatusFilter, sort: registrationSort, registeredWithin: registrationWindow },
      });
      if (queryError) setError(queryError.message);
      const result = data as { users?: AdminProfile[]; admins?: AdminProfile[] } | null;
      const rows = role === 'user' ? (result?.users ?? []) : (result?.admins ?? []);
      if (role === 'user') {
        setUsers((c) => [...c, ...rows]);
        setOffsets((c) => ({ ...c, users: start + rows.length }));
        setHasMore((c) => ({ ...c, users: rows.length === 100 }));
      } else {
        setAccounts((c) => [...c, ...rows]);
        setOffsets((c) => ({ ...c, admins: start + rows.length }));
        setHasMore((c) => ({ ...c, admins: rows.length === 100 }));
      }
    } else if (section === 'audit') {
      const start = offsets.audit;
      const { data, error: queryError } = await supabase
        .from('moderation_audit')
        .select('id,actor_id,target_type,target_id,action,reason,created_at')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(start, start + 199);
      if (queryError) setError(queryError.message);
      const rows = (data ?? []) as AuditRow[];
      setAudit((c) => [...c, ...rows]);
      setOffsets((c) => ({ ...c, audit: start + rows.length }));
      setHasMore((c) => ({ ...c, audit: rows.length === 200 }));
    }
    setLoading(false);
  };

  const performUserAction = async (action: string, targetId: string, options: { suspensionHours?: number } = {}) => {
    if (!supabase) return;
    if (action === 'ban_user') {
      if (!window.confirm('永久封禁该账号？账号将无法登录或修改云端订阅，之后只能由管理员手动解封。')) return;
    }
    const reason = window.prompt('填写处理原因：')?.trim();
    if (!reason) return;
    setError('');
    setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('admin-moderate', {
      body: { action, targetType: 'user', targetId, reason, suspensionHours: options.suspensionHours },
    });
    const failure = await readFunctionFailure(invokeError, data);
    if (invokeError || failure?.error) {
      setError(failure?.error ?? invokeError?.message ?? '管理操作失败。');
      return;
    }
    setNotice('操作已完成并写入审计记录。');
    await load();
  };

  const runEdgeTask = async (fnName: 'refresh-exchange-rates' | 'send-renewal-reminders') => {
    if (!supabase || taskBusy) return;
    setTaskBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke(fnName);
      const failure = await readFunctionFailure(invokeError, data);
      if (invokeError || failure?.error) throw new Error(failure?.error ?? invokeError?.message ?? '任务执行失败');
      if (fnName === 'refresh-exchange-rates') {
        const res = data as { count?: number; fetched_on?: string };
        setNotice(`汇率已更新（共 ${res.count ?? 36} 条汇率对，基准日期 ${res.fetched_on ?? '最新'}）。`);
      } else {
        const res = data as { resendConfigured?: boolean; processed?: number; sent?: number; skipped?: number; failed?: number };
        if (res.resendConfigured === false) {
          setNotice(`检测到 ${res.processed ?? 0} 条待提醒订阅，但尚未配置 RESEND_API_KEY secret，未发送邮件。`);
        } else {
          setNotice(`提醒检查完成：待处理 ${res.processed ?? 0}，已发送 ${res.sent ?? 0}，跳过 ${res.skipped ?? 0}，失败 ${res.failed ?? 0}。`);
        }
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务执行失败。');
    } finally {
      setTaskBusy(false);
    }
  };

  const updateOwnPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || passwordBusy) return;
    if (!/^\d{6}$/.test(ownPasswordOtp)) { setError('请输入邮件中的 6 位数字验证码。'); return; }
    if (!isValidAccountPassword(ownPassword)) { setError(accountPasswordRule); return; }
    if (ownPassword !== ownPasswordConfirm) { setError('两次输入的新密码不一致。'); return; }
    setPasswordBusy(true);
    setError('');
    try {
      const email = session.user.email;
      if (!email) throw new Error('当前管理员账号没有可用邮箱。');
      const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: ownPasswordOtp, type: 'recovery' });
      if (verifyError) throw verifyError;
      const { error: updateError } = await supabase.auth.updateUser({ password: ownPassword });
      if (updateError) throw updateError;
      setShowOwnPassword(false);
      setOwnPassword('');
      setOwnPasswordConfirm('');
      setOwnPasswordOtp('');
      setOwnPasswordCodeSent(false);
      setNotice('后台登录密码已更新。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '密码更新失败，请重试。');
    } finally {
      setPasswordBusy(false);
    }
  };

  const requestOwnPasswordCode = async () => {
    if (!supabase || passwordBusy || ownPasswordResendSeconds > 0) return;
    const email = session.user.email;
    if (!email) { setError('当前管理员账号没有可用邮箱。'); return; }
    setPasswordBusy(true);
    setError('');
    try {
      const host = window.location.hostname.toLowerCase();
      const redirectTo = host === 'renewly-admin.yeecc.cn'
        ? 'https://renewly-admin.yeecc.cn/'
        : host === 'admin.yeecc.cn'
          ? 'https://admin.yeecc.cn/'
          : `${window.location.origin}/admin`;
      const { error: sendError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (sendError) throw sendError;
      setOwnPasswordCodeSent(true);
      startOwnPasswordCooldown();
      setNotice('验证码已发送到管理员邮箱。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '验证码发送失败，请重试。');
    } finally {
      setPasswordBusy(false);
    }
  };

  const closeOwnPassword = () => {
    setShowOwnPassword(false);
    setOwnPassword('');
    setOwnPasswordConfirm('');
    setOwnPasswordOtp('');
    setOwnPasswordCodeSent(false);
  };

  if (access === 'loading') return <div className="admin-auth-shell"><div className="feed-loading"><Icon name="progress_activity" className="spin" />正在核验管理员权限…</div></div>;
  if (access === 'denied') return <div className="admin-auth-shell"><section className="admin-denied"><span className="empty-icon"><Icon name="lock" size={28} /></span><h1>此页面仅限管理员访问</h1><p>{error || '当前账号没有后台管理权限。'}</p><button className="soft-button" onClick={onExit}><Icon name="arrow_back" />返回登录</button></section></div>;

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <button className="admin-brand" onClick={onExit}>
          <span className="brandmark"><Icon name="repeat" size={19} /></span>
          <span>Renewly <small>管理工作台</small></span>
        </button>
        <p className="admin-nav-label">控制台</p>
        <nav aria-label="管理后台导航">
          {sections.map((item) => (
            <button
              key={item.id}
              className={`admin-nav-item ${section === item.id ? 'active' : ''}`}
              onClick={() => {
                setSection(item.id);
                setSearch('');
                if (item.id === 'users') void searchAccounts('user', '');
                if (item.id === 'admins') void searchAccounts('admin', '');
              }}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar">
          <div>
            <p className="eyebrow">RENEWLY CONSOLE</p>
            <h1>{sections.find((item) => item.id === section)?.label}</h1>
          </div>
          <div className="admin-topbar-actions">
            <div className="admin-topbar-identity">
              <span className="admin-user-avatar">
                {(adminIdentity?.display_name ?? session.user.email ?? 'A').slice(0, 1).toUpperCase()}
              </span>
              <span>
                <b>{adminIdentity?.display_name ?? '管理员'}</b>
                <small>{adminIdentity?.email ?? session.user.email}</small>
              </span>
            </div>
            <details ref={accountMenuRef} className="admin-account-menu">
              <summary aria-label="管理员账号菜单" aria-haspopup="menu"><Icon name="more_horiz" /></summary>
              <div role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    setError('');
                    setOwnPassword('');
                    setOwnPasswordConfirm('');
                    setOwnPasswordOtp('');
                    setOwnPasswordCodeSent(false);
                    setShowOwnPassword(true);
                  }}
                >
                  <Icon name="key" size={16} />
                  修改密码
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    onExit();
                  }}
                >
                  <Icon name="logout" size={16} />
                  退出登录
                </button>
              </div>
            </details>
            <button
              className="soft-button"
              onClick={() => section === 'users' ? void searchAccounts('user', search) : section === 'admins' ? void searchAccounts('admin', search) : void load()}
              disabled={loading}
            >
              <Icon name="refresh" size={16} className={loading ? 'spin' : ''} />
              {loading ? '刷新中…' : '刷新数据'}
            </button>
          </div>
        </header>

        {notice && (
          <div className="community-notice" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice('')} aria-label="关闭"><Icon name="close" size={15} /></button>
          </div>
        )}
        {error && (
          <div className="community-alert" role="alert">
            <span>{toChineseUserMessage(error)}</span>
            <button type="button" onClick={() => setError('')} aria-label="关闭"><Icon name="close" size={15} /></button>
          </div>
        )}

        {section === 'overview' && (
          <OverviewDesk
            metrics={overview}
            recentAudit={audit.slice(0, 6)}
            taskBusy={taskBusy}
            onRefreshRates={() => void runEdgeTask('refresh-exchange-rates')}
            onSendReminders={() => void runEdgeTask('send-renewal-reminders')}
          />
        )}

        {section === 'templates' && (
          <TemplatesDesk
            templates={templates}
            search={search}
            setSearch={setSearch}
            onRefresh={load}
            onMessage={setNotice}
            onError={setError}
          />
        )}

        {section === 'users' && (
          <AccountDesk
            mode="users"
            profiles={users}
            search={search}
            setSearch={setSearch}
            onSearch={(q) => void searchAccounts('user', q)}
            statusFilter={userStatusFilter}
            sort={registrationSort}
            registrationWindow={registrationWindow}
            onUserFiltersChange={(status, sort, win) => {
              setSearch('');
              setUserStatusFilter(status);
              setRegistrationSort(sort);
              setRegistrationWindow(win);
            }}
            suspensionHours={suspensionHours}
            setSuspensionHours={setSuspensionHours}
            onPerform={performUserAction}
            hasMore={hasMore.users}
            loading={loading}
            onLoadMore={() => void loadMore()}
            onRefresh={() => searchAccounts('user', search)}
            onMessage={setError}
            onNotice={setNotice}
          />
        )}

        {section === 'admins' && (
          <AccountDesk
            mode="admins"
            profiles={accounts}
            search={search}
            setSearch={setSearch}
            onSearch={(q) => void searchAccounts('admin', q)}
            suspensionHours={suspensionHours}
            setSuspensionHours={setSuspensionHours}
            onPerform={performUserAction}
            hasMore={hasMore.admins}
            loading={loading}
            onLoadMore={() => void loadMore()}
            onRefresh={() => searchAccounts('admin', search)}
            onMessage={setError}
            onNotice={setNotice}
          />
        )}

        {section === 'audit' && (
          <AuditDesk
            rows={audit}
            search={search}
            setSearch={setSearch}
            hasMore={hasMore.audit}
            loading={loading}
            onLoadMore={() => void loadMore()}
          />
        )}

        <footer className="admin-footer">Renewly Admin · 所有管理员权限变更、模板维护与账号限制均受 RLS 与服务端审计保护。</footer>
      </main>

      {showOwnPassword && (
        <div className="admin-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) closeOwnPassword(); }}>
          <section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="own-password-title">
            <header>
              <div><p className="eyebrow">ACCOUNT SECURITY</p><h2 id="own-password-title">修改我的密码</h2></div>
              <button className="icon-button" aria-label="关闭" onClick={closeOwnPassword}><Icon name="close" /></button>
            </header>
            {!ownPasswordCodeSent ? (
              <>
                <p className="admin-modal-note">我们会向 {adminIdentity?.email ?? session.user.email} 发送一次性验证码。</p>
                <footer>
                  <button type="button" className="soft-button" onClick={closeOwnPassword}>取消</button>
                  <button type="button" className="primary-button" disabled={passwordBusy || ownPasswordResendSeconds > 0} onClick={() => void requestOwnPasswordCode()}>
                    {passwordBusy ? '发送中…' : ownPasswordResendSeconds > 0 ? `${ownPasswordResendSeconds} 秒后可发送` : '发送验证码'}
                  </button>
                </footer>
              </>
            ) : (
              <form onSubmit={(e) => void updateOwnPassword(e)}>
                <label><span>邮箱验证码</span><input type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={ownPasswordOtp} onChange={(e) => setOwnPasswordOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="输入 6 位数字验证码" required /></label>
                <button type="button" className="text-button" disabled={passwordBusy || ownPasswordResendSeconds > 0} onClick={() => void requestOwnPasswordCode()}>
                  {ownPasswordResendSeconds > 0 ? `${ownPasswordResendSeconds} 秒后可重发` : '重新发送验证码'}
                </button>
                <label><span>新密码</span><input type="password" minLength={8} maxLength={128} value={ownPassword} onChange={(e) => setOwnPassword(e.target.value)} required /></label>
                <label><span>确认新密码</span><input type="password" minLength={8} maxLength={128} value={ownPasswordConfirm} onChange={(e) => setOwnPasswordConfirm(e.target.value)} required /></label>
                <footer>
                  <button type="button" className="soft-button" onClick={closeOwnPassword}>取消</button>
                  <button className="primary-button" disabled={passwordBusy}>{passwordBusy ? '验证并更新中…' : '验证并更新密码'}</button>
                </footer>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function OverviewDesk({
  metrics,
  recentAudit,
  taskBusy,
  onRefreshRates,
  onSendReminders,
}: {
  metrics: AdminOverviewMetrics;
  recentAudit: AuditRow[];
  taskBusy: boolean;
  onRefreshRates: () => void;
  onSendReminders: () => void;
}) {
  return (
    <div className="admin-overview-stack">
      <section className="admin-metrics" aria-label="平台运行概况">
        <article>
          <span className="metric-icon blue"><Icon name="group" /></span>
          <div><small>注册用户数</small><b>{metrics.totalUsers}</b></div>
        </article>
        <article>
          <span className="metric-icon green"><Icon name="repeat" /></span>
          <div><small>有效订阅总数</small><b>{metrics.activeSubscriptions}</b></div>
        </article>
        <article>
          <span className="metric-icon coral"><Icon name="layers" /></span>
          <div><small>公共预设模板</small><b>{metrics.totalTemplates}</b></div>
        </article>
        <article>
          <span className="metric-icon amber"><Icon name="bell" /></span>
          <div>
            <small>今日提醒（成 / 败）</small>
            <b>{metrics.remindersSentToday} / {metrics.remindersFailedToday}</b>
          </div>
        </article>
      </section>

      <section className="admin-section-card admin-ops-card">
        <div className="admin-admin-toolbar">
          <div>
            <p className="eyebrow">AUTOMATION & HEALTH</p>
            <h2>定时任务与系统维护</h2>
            <p>每日 00:05 刷新实时汇率、推进到期订阅；09:00 自动发送续费提醒邮件。当前受限账号：{metrics.restrictedAccounts} 个。</p>
          </div>
          <div className="admin-actions">
            <button type="button" className="soft-button" disabled={taskBusy} onClick={onRefreshRates}>
              <Icon name="refresh" size={16} />
              立即刷新汇率
            </button>
            <button type="button" className="primary-button" disabled={taskBusy} onClick={onSendReminders}>
              <Icon name="bell" size={16} />
              触发今日提醒检查
            </button>
          </div>
        </div>
      </section>

      <section className="admin-section-card">
        <div className="admin-admin-toolbar">
          <div>
            <p className="eyebrow">RECENT AUDIT</p>
            <h2>最近操作记录</h2>
          </div>
        </div>
        <div className="admin-data-list">
          {recentAudit.length === 0 ? (
            <div className="admin-empty"><Icon name="history" /><b>暂无操作记录</b></div>
          ) : (
            recentAudit.map((item) => (
              <article className="audit-row" key={item.id}>
                <span className="audit-icon"><Icon name="history" /></span>
                <div>
                  <b>{actionLabel(item.action)} · {targetLabel(item.target_type)}</b>
                  <p>{item.reason}</p>
                  <small>管理员 {item.actor_id} · 目标 {item.target_id} · {formatDate(item.created_at)}</small>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function TemplatesDesk({
  templates,
  search,
  setSearch,
  onRefresh,
  onMessage,
  onError,
}: {
  templates: SubscriptionTemplate[];
  search: string;
  setSearch: (val: string) => void;
  onRefresh: () => Promise<void>;
  onMessage: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState<SubscriptionTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [color, setColor] = useState('#5B5BF0');
  const [icon, setIcon] = useState('sparkles');
  const [categoryKey, setCategoryKey] = useState('entertainment');
  const [amount, setAmount] = useState('0');
  const [currency, setCurrency] = useState<CurrencyCode>('CNY');
  const [interval, setInterval] = useState<'week' | 'month' | 'quarter' | 'year'>('month');
  const [url, setUrl] = useState('');
  const [cancelUrl, setCancelUrl] = useState('');
  const [sort, setSort] = useState('1');
  const [busy, setBusy] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    setName('');
    setNameEn('');
    setColor('#5B5BF0');
    setIcon('sparkles');
    setCategoryKey('entertainment');
    setAmount('15');
    setCurrency('CNY');
    setInterval('month');
    setUrl('');
    setCancelUrl('');
    setSort(String(templates.length + 1));
  };

  const openEdit = (tpl: SubscriptionTemplate) => {
    setCreating(false);
    setEditing(tpl);
    setName(tpl.name);
    setNameEn(tpl.name_en);
    setColor(tpl.color);
    setIcon(tpl.icon);
    setCategoryKey(tpl.category_key);
    setAmount(String(tpl.default_amount));
    setCurrency(tpl.currency);
    setInterval(tpl.interval);
    setUrl(tpl.url);
    setCancelUrl(tpl.cancel_url);
    setSort(String(tpl.sort));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase || busy || !name.trim()) return;
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        name_en: nameEn.trim() || name.trim(),
        color,
        icon,
        category_key: categoryKey,
        default_amount: Number(amount) || 0,
        currency,
        interval,
        url: url.trim(),
        cancel_url: cancelUrl.trim(),
        sort: Number(sort) || 0,
      };
      if (editing) {
        const { error } = await supabase.from('subscription_templates').update(payload).eq('id', editing.id);
        if (error) throw error;
        onMessage(`模板“${payload.name}”已更新。`);
      } else {
        const { error } = await supabase.from('subscription_templates').insert(payload);
        if (error) throw error;
        onMessage(`模板“${payload.name}”已添加。`);
      }
      setCreating(false);
      setEditing(null);
      await onRefresh();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '模板保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tpl: SubscriptionTemplate) => {
    if (!supabase || !window.confirm(`确定删除公共模板“${tpl.name}”吗？`)) return;
    const { error } = await supabase.from('subscription_templates').delete().eq('id', tpl.id);
    if (error) { onError(error.message); return; }
    onMessage(`模板“${tpl.name}”已删除。`);
    await onRefresh();
  };

  const visible = templates.filter((item) => `${item.name} ${item.name_en} ${item.category_key}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <section className="admin-section-card">
      <div className="admin-admin-toolbar">
        <div>
          <p className="eyebrow">PUBLIC PRESETS</p>
          <h2>公共订阅模板</h2>
          <p>用户在添加订阅时可一键选择以下预设服务与参考价格。</p>
        </div>
        <button className="primary-button" onClick={openCreate}>
          <Icon name="add" size={17} />
          添加模板
        </button>
      </div>
      <AdminSearch value={search} onChange={setSearch} placeholder="搜索模板名称或分类…" />
      <div className="admin-data-list">
        {visible.map((tpl) => (
          <article className="admin-data-row" key={tpl.id}>
            <div className="account-target">
              <span className="service-tile" style={{ backgroundColor: tpl.color }}>
                <Icon name={tpl.icon} size={18} />
              </span>
              <div>
                <b>{tpl.name} <small>({tpl.name_en})</small></b>
                <small>
                  {formatMoney(tpl.default_amount, tpl.currency)} / {tpl.interval} · 分类 {tpl.category_key} · 排序 #{tpl.sort}
                </small>
              </div>
            </div>
            <div className="admin-actions">
              <button type="button" className="soft-button" onClick={() => openEdit(tpl)}>编辑</button>
              <button type="button" className="danger-button" onClick={() => void remove(tpl)}>删除</button>
            </div>
          </article>
        ))}
        {visible.length === 0 && <div className="admin-empty"><Icon name="search_off" /><b>没有匹配的模板</b></div>}
      </div>

      {(creating || editing) && (
        <div className="admin-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) { setCreating(false); setEditing(null); } }}>
          <section className="admin-modal" role="dialog" aria-modal="true" aria-label={editing ? '编辑模板' : '添加模板'}>
            <header>
              <div><p className="eyebrow">TEMPLATE</p><h2>{editing ? '编辑订阅模板' : '添加订阅模板'}</h2></div>
              <button type="button" className="icon-button" onClick={() => { setCreating(false); setEditing(null); }}><Icon name="close" /></button>
            </header>
            <form onSubmit={(e) => void save(e)}>
              <div className="two-col">
                <label><span>中文名称</span><input value={name} onChange={(e) => setName(e.target.value)} required /></label>
                <label><span>英文名称</span><input value={nameEn} onChange={(e) => setNameEn(e.target.value)} required /></label>
              </div>
              <div className="two-col">
                <label><span>参考金额</span><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
                <label>
                  <span>币种</span>
                  <select value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)}>
                    {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                  </select>
                </label>
              </div>
              <div className="two-col">
                <label>
                  <span>默认周期</span>
                  <select value={interval} onChange={(e) => setInterval(e.target.value as 'week' | 'month' | 'quarter' | 'year')}>
                    <option value="week">每周</option>
                    <option value="month">每月</option>
                    <option value="quarter">每季</option>
                    <option value="year">每年</option>
                  </select>
                </label>
                <label>
                  <span>默认分类 Key</span>
                  <select value={categoryKey} onChange={(e) => setCategoryKey(e.target.value)}>
                    <option value="entertainment">entertainment（影音娱乐）</option>
                    <option value="productivity">productivity（工具效率）</option>
                    <option value="cloud">cloud（云存储）</option>
                    <option value="fitness">fitness（健康运动）</option>
                    <option value="life">life（生活消费）</option>
                    <option value="other">other（其他订阅）</option>
                  </select>
                </label>
              </div>
              <div className="two-col">
                <label><span>官网链接</span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
                <label><span>排序</span><input type="number" value={sort} onChange={(e) => setSort(e.target.value)} /></label>
              </div>
              <label><span>退订链接</span><input type="url" value={cancelUrl} onChange={(e) => setCancelUrl(e.target.value)} /></label>
              <div className="swatch-row">
                {BRAND_COLORS.map((hex) => (
                  <button type="button" key={hex} className={`swatch ${color === hex ? 'active' : ''}`} style={{ backgroundColor: hex }} onClick={() => setColor(hex)} />
                ))}
              </div>
              <div className="icon-swatch-row">
                {BRAND_ICONS.map((ic) => (
                  <button type="button" key={ic} className={`icon-swatch ${icon === ic ? 'active' : ''}`} onClick={() => setIcon(ic)}>
                    <Icon name={ic} size={15} />
                  </button>
                ))}
              </div>
              <footer>
                <button type="button" className="soft-button" onClick={() => { setCreating(false); setEditing(null); }}>取消</button>
                <button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存模板'}</button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}

function AccountDesk({
  mode,
  profiles,
  search,
  setSearch,
  onSearch,
  statusFilter,
  sort,
  registrationWindow,
  onUserFiltersChange,
  suspensionHours,
  setSuspensionHours,
  onPerform,
  hasMore,
  loading,
  onLoadMore,
  onRefresh,
  onMessage,
  onNotice,
}: {
  mode: 'users' | 'admins';
  profiles: AdminProfile[];
  search: string;
  setSearch: (value: string) => void;
  onSearch: (query: string) => void;
  statusFilter?: UserStatusFilter;
  sort?: RegistrationSort;
  registrationWindow?: RegistrationWindow;
  onUserFiltersChange?: (status: UserStatusFilter, sort: RegistrationSort, window: RegistrationWindow) => void;
  suspensionHours: Record<string, number>;
  setSuspensionHours: (value: Record<string, number>) => void;
  onPerform: (action: string, targetId: string, options?: { suspensionHours?: number }) => Promise<void>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onRefresh: () => Promise<void>;
  onMessage: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [lookup, setLookup] = useState('');
  const [candidate, setCandidate] = useState<AdminProfile | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [grantReason, setGrantReason] = useState('');
  const [resetTarget, setResetTarget] = useState<AdminProfile | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
  const [resetReason, setResetReason] = useState('');
  const [resetBusy, setResetBusy] = useState(false);

  const closeResetAdmin = () => {
    setResetTarget(null);
    setResetPassword('');
    setResetPasswordConfirm('');
    setResetReason('');
  };

  const findAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !lookup.trim() || lookupBusy) return;
    setLookupBusy(true);
    setCandidate(null);
    const { data, error } = await supabase.functions.invoke('admin-manage', { body: { action: 'find_account', lookup: lookup.trim() } });
    const failure = await readFunctionFailure(error, data);
    if (error || failure?.error) {
      onMessage(failure?.error === 'account_not_found' ? '找不到匹配的已注册账号。' : failure?.error ?? error?.message ?? '账号查找失败。');
    } else {
      setCandidate((data as { account?: AdminProfile } | null)?.account ?? null);
    }
    setLookupBusy(false);
  };

  const changeRole = async (person: AdminProfile, action: 'grant_admin' | 'revoke_admin', suppliedReason?: string) => {
    const grant = action === 'grant_admin';
    if (!supabase) return;
    if (!window.confirm(grant ? `将 ${person.display_name}（${person.uid}）设为管理员？` : `撤销 ${person.display_name}（${person.uid}）的管理员权限？`)) return;
    const reason = suppliedReason?.trim() || window.prompt('填写管理员权限变更原因：')?.trim();
    if (!reason) return;
    const { data, error } = await supabase.functions.invoke('admin-manage', { body: { action, targetId: person.id, reason } });
    const failure = await readFunctionFailure(error, data);
    if (error || failure?.error) { onMessage(roleErrorMessage(failure?.error ?? error?.message)); return; }
    setCandidate(null);
    if (grant) { setShowAddAdmin(false); setGrantReason(''); }
    onNotice(grant ? `${person.display_name} 已成为管理员。` : `已撤销 ${person.display_name} 的管理员权限。`);
    await onRefresh();
  };

  const resetAdminPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !resetTarget || resetBusy) return;
    if (!isValidAccountPassword(resetPassword) || resetPassword.length > 128) {
      onMessage('新密码需要为 8 至 128 位，并包含至少 1 个英文字母和 1 个数字。');
      return;
    }
    if (resetPassword !== resetPasswordConfirm) { onMessage('两次输入的新密码不一致。'); return; }
    if (!resetReason.trim()) { onMessage('请填写密码重置原因。'); return; }
    if (!window.confirm(`确认立即将 ${resetTarget.display_name} 的管理员密码重置为你输入的新密码？`)) return;
    setResetBusy(true);
    const { data, error } = await supabase.functions.invoke('admin-manage', {
      body: { action: 'reset_admin_password', targetId: resetTarget.id, newPassword: resetPassword, reason: resetReason.trim() },
    });
    const failure = await readFunctionFailure(error, data);
    if (error || failure?.error) {
      onMessage(failure?.error === 'password_updated_audit_outcome_failed' ? '密码已更新，但审计记录失败，请检查后台操作记录。' : failure?.error ?? error?.message ?? '管理员密码更新失败。');
    } else {
      onNotice(`已更新 ${resetTarget.display_name} 的管理员密码。`);
      closeResetAdmin();
    }
    setResetBusy(false);
  };

  const candidateEligible = candidate?.role === 'user' && candidate.account_status === 'active' && Boolean(candidate.email_confirmed_at);
  const searchPlaceholder = mode === 'users' ? '输入 6 位 UID 或邮箱搜索用户' : '输入 6 位 UID 或邮箱搜索管理员';

  return (
    <section className="admin-section-card">
      {mode === 'admins' && (
        <div className="admin-admin-toolbar">
          <div>
            <p className="eyebrow">ADMINISTRATORS</p>
            <h2>管理员账号</h2>
            <p>管理员单独登记在管理员账号表中。添加时只能授权已验证邮箱的现有账号。</p>
          </div>
          <button className="primary-button" onClick={() => { setCandidate(null); setLookup(''); setGrantReason(''); setShowAddAdmin(true); }}>
            <Icon name="person_add" />
            添加管理员
          </button>
        </div>
      )}

      <form className="admin-role-lookup admin-list-search" onSubmit={(e) => { e.preventDefault(); onSearch(search); }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
        <button className="primary-button compact" type="submit" disabled={loading}><Icon name="search" />搜索</button>
        {search && <button className="soft-button compact" type="button" onClick={() => { setSearch(''); onSearch(''); }}>清除</button>}
      </form>

      {mode === 'users' && (
        <div className="admin-filter-row">
          <label>
            <span>账号状态</span>
            <select value={statusFilter ?? 'all'} onChange={(e) => onUserFiltersChange?.(e.target.value as UserStatusFilter, sort ?? 'newest', registrationWindow ?? 'all')}>
              <option value="all">全部状态</option>
              <option value="active">正常</option>
              <option value="suspended">暂停中</option>
              <option value="banned">永久封禁</option>
            </select>
          </label>
          <label>
            <span>注册范围</span>
            <select value={registrationWindow ?? 'all'} onChange={(e) => onUserFiltersChange?.(statusFilter ?? 'all', sort ?? 'newest', e.target.value as RegistrationWindow)}>
              <option value="all">全部时间</option>
              <option value="7d">近 7 天</option>
              <option value="30d">近 30 天</option>
              <option value="90d">近 90 天</option>
            </select>
          </label>
          <label>
            <span>排序方式</span>
            <select value={sort ?? 'newest'} onChange={(e) => onUserFiltersChange?.(statusFilter ?? 'all', e.target.value as RegistrationSort, registrationWindow ?? 'all')}>
              <option value="newest">最新注册优先</option>
              <option value="oldest">最早注册优先</option>
            </select>
          </label>
        </div>
      )}

      <div className="admin-data-list">
        {profiles.map((person) => {
          const state = effectiveStatus(person);
          const hours = suspensionHours[person.id] ?? 24;
          return (
            <article className="admin-data-row" key={person.id}>
              <div className="account-target">
                <span className="admin-avatar">{(person.display_name || 'U').slice(0, 1).toUpperCase()}</span>
                <div>
                  <b>
                    {person.display_name}
                    {mode === 'admins' && ' · 管理员'}
                    <span className={`status-pill ${state}`}>{statusLabel(state, person.suspension_expires_at)}</span>
                  </b>
                  <small>{person.email ?? '邮箱不可用'} · UID {person.uid} · 注册 {formatDate(person.created_at)}</small>
                  <p>{person.bio || '暂无个人简介'}</p>
                </div>
              </div>
              {mode === 'admins' ? (
                <div className="admin-actions account-actions">
                  <button className="soft-button" onClick={() => { setResetPassword(''); setResetPasswordConfirm(''); setResetReason(''); setResetTarget(person); }}>
                    <Icon name="key" />
                    修改密码
                  </button>
                  <button className="danger-button" onClick={() => void changeRole(person, 'revoke_admin')}>撤销管理员</button>
                </div>
              ) : (
                <div className="admin-actions account-actions">
                  {state !== 'banned' && (
                    <>
                      <select value={hours} onChange={(e) => setSuspensionHours({ ...suspensionHours, [person.id]: Number(e.target.value) })} aria-label={`${person.display_name}的暂停时长`}>
                        <option value={24}>24 小时</option>
                        <option value={168}>7 天</option>
                        <option value={720}>30 天</option>
                      </select>
                      <button className="soft-button" onClick={() => void onPerform('suspend_user', person.id, { suspensionHours: hours })}>
                        {state === 'suspended' ? '重新暂停' : '暂停'}
                      </button>
                    </>
                  )}
                  {state === 'banned'
                    ? <button className="primary-button compact" onClick={() => void onPerform('unban_user', person.id)}>手动解封</button>
                    : <button className="danger-button" onClick={() => void onPerform('ban_user', person.id)}>永久封禁</button>}
                  {state === 'suspended' && (
                    <button className="primary-button compact" onClick={() => void onPerform('restore_user', person.id)}>恢复账号</button>
                  )}
                </div>
              )}
            </article>
          );
        })}
        {profiles.length === 0 && (
          <div className="admin-empty">
            <Icon name="search_off" />
            <b>{search ? '没有匹配账号' : mode === 'users' ? '还没有普通用户' : '还没有管理员'}</b>
          </div>
        )}
      </div>

      {hasMore && (
        <button className="load-more-button" disabled={loading} onClick={onLoadMore}>
          {loading ? '加载中…' : mode === 'users' ? '加载更多用户' : '加载更多管理员'}
        </button>
      )}

      {showAddAdmin && (
        <div className="admin-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setShowAddAdmin(false); }}>
          <section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="add-admin-title">
            <header>
              <div><p className="eyebrow">ADMINISTRATORS</p><h2 id="add-admin-title">添加管理员</h2></div>
              <button className="icon-button" aria-label="关闭" onClick={() => setShowAddAdmin(false)}><Icon name="close" /></button>
            </header>
            <p className="admin-modal-note">输入已注册账号的 6 位 UID 或邮箱。只有邮箱已验证且账号正常的普通用户可以添加。</p>
            <form className="admin-role-lookup" onSubmit={(e) => void findAccount(e)}>
              <input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="6 位 UID 或 name@example.com" required />
              <button className="primary-button" disabled={lookupBusy}><Icon name="search" />{lookupBusy ? '查找中…' : '查找账号'}</button>
            </form>
            {candidate && (
              <article className="admin-role-candidate">
                <span className="admin-avatar">{(candidate.display_name || 'U').slice(0, 1).toUpperCase()}</span>
                <div>
                  <b>{candidate.display_name}</b>
                  <small>{candidate.email ?? '无邮箱'} · UID {candidate.uid}</small>
                  <small>{candidate.email_confirmed_at ? '邮箱已验证' : '邮箱尚未验证'} · {statusLabel(effectiveStatus(candidate), candidate.suspension_expires_at)}</small>
                </div>
              </article>
            )}
            {candidate && candidateEligible && (
              <form className="admin-modal-add-form" onSubmit={(e) => { e.preventDefault(); void changeRole(candidate, 'grant_admin', grantReason); }}>
                <label><span>添加原因（写入操作记录）</span><input maxLength={500} value={grantReason} onChange={(e) => setGrantReason(e.target.value)} required /></label>
                <footer><button className="primary-button compact" type="submit">确认添加管理员</button></footer>
              </form>
            )}
            {candidate && !candidateEligible && <p className="admin-modal-note">该账号需要邮箱验证且状态正常后才能添加。</p>}
            <footer><button className="soft-button" onClick={() => setShowAddAdmin(false)}>关闭</button></footer>
          </section>
        </div>
      )}

      {resetTarget && (
        <div className="admin-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) closeResetAdmin(); }}>
          <section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="reset-admin-title">
            <header>
              <div><p className="eyebrow">ADMIN CREDENTIALS</p><h2 id="reset-admin-title">修改管理员密码</h2></div>
              <button className="icon-button" aria-label="关闭" onClick={closeResetAdmin}><Icon name="close" /></button>
            </header>
            <p className="admin-modal-note">正在修改 <b>{resetTarget.display_name}</b>（{resetTarget.email}）的登录密码。</p>
            <form onSubmit={(e) => void resetAdminPassword(e)}>
              <label><span>新密码</span><input type="password" minLength={8} maxLength={128} value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} required /></label>
              <label><span>确认新密码</span><input type="password" minLength={8} maxLength={128} value={resetPasswordConfirm} onChange={(e) => setResetPasswordConfirm(e.target.value)} required /></label>
              <label><span>重置原因（写入操作记录）</span><input maxLength={500} value={resetReason} onChange={(e) => setResetReason(e.target.value)} required /></label>
              <footer>
                <button type="button" className="soft-button" onClick={closeResetAdmin}>取消</button>
                <button className="primary-button" disabled={resetBusy}>{resetBusy ? '更新中…' : '更新密码'}</button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}

function AuditDesk({ rows, search, setSearch, hasMore, loading, onLoadMore }: { rows: AuditRow[]; search: string; setSearch: (value: string) => void; hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const visible = rows.filter((item) => `${item.actor_id} ${item.target_type} ${item.target_id} ${item.action} ${item.reason}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <section className="admin-section-card">
      <AdminSearch value={search} onChange={setSearch} placeholder="搜索管理员、目标 ID、动作或处理原因" />
      <div className="admin-data-list">
        {visible.map((item) => (
          <article className="audit-row" key={item.id}>
            <span className="audit-icon"><Icon name="history" /></span>
            <div>
              <b>{actionLabel(item.action)} · {targetLabel(item.target_type)}</b>
              <p>{item.reason}</p>
              <small>管理员 {item.actor_id} · 目标 {item.target_id} · {formatDate(item.created_at)}</small>
            </div>
          </article>
        ))}
        {visible.length === 0 && <div className="admin-empty"><Icon name="history" /><b>没有操作记录</b></div>}
      </div>
      {hasMore && <button className="load-more-button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : '加载更早记录'}</button>}
    </section>
  );
}

function AdminSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="admin-search"><Icon name="search" /><input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} /></label>;
}

function effectiveStatus(profile: Pick<AdminProfile, 'account_status' | 'suspension_expires_at'>): 'active' | 'suspended' | 'banned' | 'deleted' {
  if (profile.account_status === 'suspended' && profile.suspension_expires_at && Date.parse(profile.suspension_expires_at) <= Date.now()) return 'active';
  return profile.account_status;
}

function statusLabel(status: string, expiresAt: string | null) {
  if (status === 'active') return expiresAt && Date.parse(expiresAt) <= Date.now() ? '暂停期满，已恢复' : '正常';
  if (status === 'suspended') return expiresAt ? `暂停至 ${formatDate(expiresAt)}` : '暂停中';
  if (status === 'banned') return '永久封禁';
  return '已注销';
}

function targetLabel(type: string) { return type === 'admin' ? '管理员' : '账号'; }

function actionLabel(action: string) {
  const names: Record<string, string> = {
    suspend_user: '暂停账号',
    restore_user: '恢复账号',
    ban_user: '永久封禁',
    unban_user: '手动解封',
    grant_admin: '添加管理员',
    revoke_admin: '撤销管理员',
    reset_admin_password: '重置管理员密码',
    reset_admin_password_started: '重置管理员密码（处理中）',
    reset_admin_password_failed: '重置管理员密码失败',
  };
  return names[action] ?? action;
}

function roleErrorMessage(error?: string) {
  const messages: Record<string, string> = {
    already_admin: '该账号已经是管理员。',
    target_not_eligible: '只有邮箱已验证且状态正常的账号可以成为管理员。',
    target_not_admin: '该账号当前不是管理员。',
    last_active_admin: '不能撤销最后一位有效管理员的权限。',
    account_not_found: '找不到这个账号。',
    invalid_reason: '请填写有效的操作原因。',
    forbidden: '当前账号没有执行此操作的权限。',
  };
  return messages[error ?? ''] ?? '管理员权限操作失败，请稍后重试。';
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function readFunctionFailure(error: unknown, data: unknown): Promise<{ error?: string; partial?: boolean } | null> {
  if (data && typeof data === 'object') return data as { error?: string; partial?: boolean };
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) return await context.clone().json().catch(() => null) as { error?: string; partial?: boolean } | null;
  }
  return null;
}
