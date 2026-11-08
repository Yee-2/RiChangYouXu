import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useOtpCooldown, type Profile } from './community';
import { Icon } from './Icon';
import { supabase } from './supabase';
import { useDismissibleDetails } from './useDismissibleDetails';

type AdminSection = 'reports' | 'content' | 'users' | 'admins' | 'audit';
type PageKey = 'reports' | 'profiles' | 'users' | 'admins' | 'audit' | 'posts' | 'comments';
type AdminProfile = Profile & { email?: string; email_confirmed_at?: string | null; suspension_expires_at: string | null; created_at: string };
type Report = { id: string; reporter_id: string; reporter_uid?: string; target_type: 'post' | 'comment' | 'user'; target_id: string; reason: string; detail: string; status: 'open' | 'handled' | 'dismissed'; created_at: string; reviewed_at?: string | null };
type ContentRow = { id: string; target_type: 'post' | 'comment'; author_id: string; body: string; image_paths: string[]; moderation_status: 'visible' | 'hidden' | 'removed'; created_at: string; updated_at?: string; post_id?: string };
type AuditRow = { id: string; actor_id: string; target_type: string; target_id: string; action: string; reason: string; created_at: string };
type ReportTarget = { profile?: AdminProfile; author?: AdminProfile; content?: ContentRow; parentPost?: ContentRow; images: string[]; parentImages?: string[]; error?: string };
type AdminMetrics = { openReports: number; hiddenContent: number; restrictedAccounts: number; handledToday: number };
type PerformAdminAction = (action: string, targetType: string, targetId: string, options?: { reportId?: string; suspensionHours?: number }, reason?: string) => Promise<void>;
type AdminIdentity = { id: string; uid: string; display_name: string; email: string };
type UserStatusFilter = 'all' | 'active' | 'suspended' | 'banned' | 'deleted';
type RegistrationSort = 'newest' | 'oldest';
type RegistrationWindow = 'all' | '7d' | '30d' | '90d';

async function attachAvatarUrls<T extends Pick<AdminProfile, 'avatar_path' | 'account_status'>>(rows: T[]) {
  const paths = [...new Set(rows
    .filter((row) => row.account_status !== 'deleted')
    .map((row) => row.avatar_path)
    .filter((path): path is string => Boolean(path)))];

  if (!supabase || !paths.length) {
    return { rows: rows.map((row) => ({ ...row, avatar_url: undefined as string | undefined })) };
  }

  const { data, error } = await supabase.storage.from('community-media').createSignedUrls(paths, 3600);
  if (error) {
    return { rows: rows.map((row) => ({ ...row, avatar_url: undefined as string | undefined })), error: error.message };
  }

  const signedByPath = new Map<string, string>();
  paths.forEach((path, index) => {
    const url = data?.[index]?.signedUrl;
    if (url) signedByPath.set(path, url);
  });

  return {
    rows: rows.map((row) => ({
      ...row,
      avatar_url: row.account_status !== 'deleted' && row.avatar_path ? signedByPath.get(row.avatar_path) : undefined
    }))
  };
}

async function attachReporterUids(rows: Report[]) {
  if (!supabase || !rows.length) return { rows };
  const reporterIds = [...new Set(rows.map((row) => row.reporter_id))];
  const { data, error } = await supabase.from('profiles').select('id,uid').in('id', reporterIds);
  if (error) return { rows, error: error.message };
  const uidById = new Map((data ?? []).map((profile) => [profile.id, profile.uid]));
  return { rows: rows.map((row) => ({ ...row, reporter_uid: uidById.get(row.reporter_id) })) };
}

const sections: Array<{ id: AdminSection; label: string; icon: string }> = [
  { id: 'reports', label: '举报处理', icon: 'flag' },
  { id: 'content', label: '内容管理', icon: 'article' },
  { id: 'users', label: '用户管理', icon: 'group' },
  { id: 'admins', label: '管理员账号', icon: 'admin_panel_settings' },
  { id: 'audit', label: '操作记录', icon: 'history' }
];

export default function AdminPanel({ session, onExit, onDenied }: { session: Session; onExit: () => void; onDenied: () => void }) {
  const [section, setSection] = useState<AdminSection>('reports');
  const [access, setAccess] = useState<'loading' | 'allowed' | 'denied'>('loading');
  const [profiles, setProfiles] = useState<AdminProfile[]>([]);
  const [accounts, setAccounts] = useState<AdminProfile[]>([]);
  const [users, setUsers] = useState<AdminProfile[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [content, setContent] = useState<ContentRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [offsets, setOffsets] = useState<Record<PageKey, number>>({ reports: 0, profiles: 0, users: 0, admins: 0, audit: 0, posts: 0, comments: 0 });
  const [hasMore, setHasMore] = useState<Record<PageKey, boolean>>({ reports: false, profiles: false, users: false, admins: false, audit: false, posts: false, comments: false });
  const [metrics, setMetrics] = useState<AdminMetrics>({ openReports: 0, hiddenContent: 0, restrictedAccounts: 0, handledToday: 0 });
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
  const [error, setError] = useState('');
  const [, refreshStatusClock] = useState(0);
  const selectedReport = reports.find((item) => item.id === selectedReportId) ?? null;
  const openCount = metrics.openReports;
  const hiddenCount = metrics.hiddenContent;
  const accountCount = metrics.restrictedAccounts;

  useEffect(() => {
    let active = true;
    if (!supabase) { setAccess('denied'); onDenied(); return; }
    void supabase.functions.invoke('admin-manage', { body: { action: 'verify' } }).then(async ({ data, error: queryError }) => {
      if (!active) return;
      if (!queryError && data?.ok) { setAdminIdentity(data.actor ?? null); setAccess('allowed'); return; }
      setAccess('denied'); setError(data?.error ?? queryError?.message ?? '后台权限验证失败。');
      onDenied();
    });
    return () => { active = false; };
  }, [session.user.id]);

  const load = useCallback(async () => {
    if (!supabase || access !== 'allowed') return;
    setLoading(true); setError('');
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const [reportResult, profileResult, adminResult, userResult, auditResult, postResult, commentResult, openCountResult, hiddenPostsResult, hiddenCommentsResult, restrictedCountResult, handledTodayResult] = await Promise.all([
      supabase.from('reports').select('*').order('status', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100),
      supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200),
      supabase.functions.invoke('admin-manage', { body: { action: 'list_admins', limit: 100, offset: 0 } }),
      supabase.functions.invoke('admin-manage', { body: { action: 'list_users', limit: 100, offset: 0, statusFilter: userStatusFilter, sort: registrationSort, registeredWithin: registrationWindow } }),
      supabase.from('moderation_audit').select('id,actor_id,target_type,target_id,action,reason,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200),
      supabase.from('posts').select('id,author_id,body,image_paths,moderation_status,created_at,updated_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100),
      supabase.from('comments').select('id,post_id,author_id,body,image_paths,moderation_status,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(150),
      supabase.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      supabase.from('posts').select('id', { count: 'exact', head: true }).eq('moderation_status', 'hidden'),
      supabase.from('comments').select('id', { count: 'exact', head: true }).eq('moderation_status', 'hidden'),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).in('account_status', ['suspended', 'banned']),
      supabase.from('reports').select('id', { count: 'exact', head: true }).gte('reviewed_at', todayStart.toISOString()).lt('reviewed_at', tomorrowStart.toISOString())
    ]);
    const firstError = reportResult.error ?? profileResult.error ?? adminResult.error ?? userResult.error ?? auditResult.error ?? postResult.error ?? commentResult.error ?? openCountResult.error ?? hiddenPostsResult.error ?? hiddenCommentsResult.error ?? restrictedCountResult.error ?? handledTodayResult.error;
    if (firstError) {
      const failedList = adminResult.error ? adminResult : userResult.error ? userResult : null;
      setError(failedList ? (await readFunctionFailure(failedList.error, failedList.data))?.error ?? failedList.error?.message ?? firstError.message : firstError.message);
    }
    setMetrics({ openReports: openCountResult.count ?? 0, hiddenContent: (hiddenPostsResult.count ?? 0) + (hiddenCommentsResult.count ?? 0), restrictedAccounts: restrictedCountResult.count ?? 0, handledToday: handledTodayResult.count ?? 0 });
    const nextReports = (reportResult.data ?? []) as Report[];
    const reportsWithUids = await attachReporterUids(nextReports);
    if (!firstError && reportsWithUids.error) setError(`举报人 UID 读取失败：${reportsWithUids.error}`);
    setReports(reportsWithUids.rows);
    const nextProfiles = (profileResult.data ?? []) as AdminProfile[];
    const nextAccounts = ((adminResult.data as { admins?: AdminProfile[] } | null)?.admins ?? []);
    const nextUsers = ((userResult.data as { users?: AdminProfile[] } | null)?.users ?? []);
    const nextAudit = (auditResult.data ?? []) as AuditRow[];
    const nextPosts = (postResult.data ?? []) as Array<Omit<ContentRow, 'target_type'>>;
    const nextComments = (commentResult.data ?? []) as Array<Omit<ContentRow, 'target_type'>>;
    const [profilesWithAvatars, accountsWithAvatars, usersWithAvatars] = await Promise.all([
      attachAvatarUrls(nextProfiles),
      attachAvatarUrls(nextAccounts),
      attachAvatarUrls(nextUsers)
    ]);
    if (!firstError) {
      const avatarError = profilesWithAvatars.error ?? accountsWithAvatars.error ?? usersWithAvatars.error;
      if (avatarError) setError(`头像暂时无法加载：${avatarError}`);
    }
    setProfiles(profilesWithAvatars.rows);
    setAccounts(accountsWithAvatars.rows);
    setUsers(usersWithAvatars.rows);
    setAudit(nextAudit);
    const rows: ContentRow[] = [
      ...nextPosts.map((item) => ({ ...item, target_type: 'post' as const })),
      ...nextComments.map((item) => ({ ...item, target_type: 'comment' as const }))
    ];
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    setContent(rows);
    setOffsets({ reports: nextReports.length, profiles: nextAccounts.length, users: nextUsers.length, admins: nextAccounts.length, audit: nextAudit.length, posts: nextPosts.length, comments: nextComments.length });
    setHasMore({ reports: nextReports.length === 100, profiles: nextAccounts.length === 100, users: nextUsers.length === 100, admins: nextAccounts.length === 100, audit: nextAudit.length === 200, posts: nextPosts.length === 100, comments: nextComments.length === 150 });
    setSelectedReportId((current) => current && nextReports.some((item) => item.id === current) ? current : nextReports.find((item) => item.status === 'open')?.id ?? nextReports[0]?.id ?? null);
    setLoading(false);
  }, [access, registrationSort, registrationWindow, userStatusFilter]);

  const searchAccounts = async (role: 'user' | 'admin', query: string, statusFilter = userStatusFilter, sort = registrationSort, registeredWithin = registrationWindow) => {
    if (!supabase) return;
    setLoading(true); setError('');
    const action = role === 'user' ? 'list_users' : 'list_admins';
    const { data, error: invokeError } = await supabase.functions.invoke('admin-manage', { body: { action, query: query.trim(), limit: 100, offset: 0, statusFilter, sort, registeredWithin } });
    const failure = await readFunctionFailure(invokeError, data);
    if (invokeError || failure?.error) {
      setError(failure?.error ?? invokeError?.message ?? '账号搜索失败。');
      setLoading(false);
      return;
    }
    const rows = role === 'user'
      ? ((data as { users?: AdminProfile[] } | null)?.users ?? [])
      : ((data as { admins?: AdminProfile[] } | null)?.admins ?? []);
    const avatarResult = await attachAvatarUrls(rows);
    if (avatarResult.error) setError(`头像暂时无法加载：${avatarResult.error}`);
    if (role === 'user') {
      setUsers(avatarResult.rows); setOffsets((current) => ({ ...current, users: rows.length })); setHasMore((current) => ({ ...current, users: rows.length === 100 }));
    } else {
      setAccounts(avatarResult.rows); setOffsets((current) => ({ ...current, admins: rows.length })); setHasMore((current) => ({ ...current, admins: rows.length === 100 }));
    }
    setLoading(false);
  };

  const loadMore = async () => {
    if (!supabase || loading) return;
    setLoading(true); setError('');
    if (section === 'reports') {
      const start = offsets.reports; const { data, error: queryError } = await supabase.from('reports').select('*').order('status', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + 99);
      if (queryError) setError(queryError.message);
      const rows = (data ?? []) as Report[]; const enriched = await attachReporterUids(rows); if (enriched.error) setError(`举报人 UID 读取失败：${enriched.error}`); setReports((current) => [...current, ...enriched.rows]); setOffsets((current) => ({ ...current, reports: start + rows.length })); setHasMore((current) => ({ ...current, reports: rows.length === 100 }));
    } else if (section === 'users' || section === 'admins') {
      const role = section === 'users' ? 'user' : 'admin';
      const pageKey = role === 'user' ? 'users' : 'admins';
      const start = offsets[pageKey]; const action = role === 'user' ? 'list_users' : 'list_admins';
      const { data, error: queryError } = await supabase.functions.invoke('admin-manage', { body: { action, query: search.trim(), limit: 100, offset: start, statusFilter: userStatusFilter, sort: registrationSort, registeredWithin: registrationWindow } });
      const failure = await readFunctionFailure(queryError, data);
      if (queryError || failure?.error) setError(failure?.error ?? queryError?.message ?? '账号读取失败。');
      const result = data as { users?: AdminProfile[]; admins?: AdminProfile[] } | null;
      const rows = role === 'user' ? (result?.users ?? []) : (result?.admins ?? []);
      const avatarResult = await attachAvatarUrls(rows);
      if (avatarResult.error) setError(`头像暂时无法加载：${avatarResult.error}`);
      if (role === 'user') { setUsers((current) => [...current, ...avatarResult.rows]); setOffsets((current) => ({ ...current, users: start + rows.length })); setHasMore((current) => ({ ...current, users: rows.length === 100 })); }
      else { setAccounts((current) => [...current, ...avatarResult.rows]); setOffsets((current) => ({ ...current, admins: start + rows.length })); setHasMore((current) => ({ ...current, admins: rows.length === 100 })); }
    } else if (section === 'audit') {
      const start = offsets.audit; const { data, error: queryError } = await supabase.from('moderation_audit').select('id,actor_id,target_type,target_id,action,reason,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + 199);
      if (queryError) setError(queryError.message);
      const rows = (data ?? []) as AuditRow[]; setAudit((current) => [...current, ...rows]); setOffsets((current) => ({ ...current, audit: start + rows.length })); setHasMore((current) => ({ ...current, audit: rows.length === 200 }));
    } else {
      const [postResult, commentResult] = await Promise.all([
        supabase.from('posts').select('id,author_id,body,image_paths,moderation_status,created_at,updated_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(offsets.posts, offsets.posts + 99),
        supabase.from('comments').select('id,post_id,author_id,body,image_paths,moderation_status,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(offsets.comments, offsets.comments + 149)
      ]);
      if (postResult.error || commentResult.error) setError(postResult.error?.message ?? commentResult.error?.message ?? '内容读取失败。');
      const posts = (postResult.data ?? []) as Array<Omit<ContentRow, 'target_type'>>; const comments = (commentResult.data ?? []) as Array<Omit<ContentRow, 'target_type'>>;
      const rows: ContentRow[] = [...posts.map((item) => ({ ...item, target_type: 'post' as const })), ...comments.map((item) => ({ ...item, target_type: 'comment' as const }))];
      setContent((current) => [...current, ...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setOffsets((current) => ({ ...current, posts: current.posts + posts.length, comments: current.comments + comments.length }));
      setHasMore((current) => ({ ...current, posts: posts.length === 100, comments: comments.length === 150 }));
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => refreshStatusClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    if (!selectedReport || !supabase || access !== 'allowed') { setTarget(null); return; }
    setTarget(null);
    void (async () => {
      try {
        if (selectedReport.target_type === 'user') {
          const { data, error: queryError } = await supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at,created_at').eq('id', selectedReport.target_id).maybeSingle();
          if (queryError) throw queryError;
          const profile = data as AdminProfile | null;
          let images: string[] = [];
          if (profile?.avatar_path) {
            const { data: signed, error: imageError } = await supabase.storage.from('community-media').createSignedUrl(profile.avatar_path, 1800);
            if (imageError) throw imageError;
            images = signed?.signedUrl ? [signed.signedUrl] : [];
          }
          if (active) setTarget({ profile: profile ?? undefined, images });
          return;
        }
        const table = selectedReport.target_type === 'post' ? 'posts' : 'comments';
        const select = selectedReport.target_type === 'post' ? 'id,author_id,body,image_paths,moderation_status,created_at,updated_at' : 'id,post_id,author_id,body,image_paths,moderation_status,created_at';
        const { data, error: queryError } = await supabase.from(table).select(select).eq('id', selectedReport.target_id).maybeSingle();
        if (queryError) throw queryError;
        const contentItem = data ? { ...data, target_type: selectedReport.target_type } as ContentRow : undefined;
        let author: AdminProfile | undefined;
        if (contentItem) {
          const { data: authorData, error: authorError } = await supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at,created_at').eq('id', contentItem.author_id).maybeSingle();
          if (authorError) throw authorError;
          author = authorData as AdminProfile | undefined;
          if (author?.avatar_path) {
            const { data: signedAvatar } = await supabase.storage.from('community-media').createSignedUrl(author.avatar_path, 1800);
            author.avatar_url = signedAvatar?.signedUrl;
          }
        }
        let images: string[] = [];
        if (contentItem?.image_paths?.length) {
          const { data: signed, error: imageError } = await supabase.storage.from('community-media').createSignedUrls(contentItem.image_paths, 1800);
          if (imageError) throw imageError;
          images = (signed ?? []).map((item) => item.signedUrl ?? '').filter(Boolean);
        }
        let parentPost: ContentRow | undefined;
        let parentImages: string[] = [];
        if (selectedReport.target_type === 'comment' && contentItem?.post_id) {
          const { data: parentData, error: parentError } = await supabase.from('posts').select('id,author_id,body,image_paths,moderation_status,created_at,updated_at').eq('id', contentItem.post_id).maybeSingle();
          if (parentError) throw parentError;
          if (parentData) {
            parentPost = { ...parentData, target_type: 'post' } as ContentRow;
            if (parentPost.image_paths.length) {
              const { data: signedParent, error: parentImageError } = await supabase.storage.from('community-media').createSignedUrls(parentPost.image_paths, 1800);
              if (parentImageError) throw parentImageError;
              parentImages = (signedParent ?? []).map((image) => image.signedUrl ?? '').filter(Boolean);
            }
          }
        }
        if (active) setTarget({ content: contentItem, author, parentPost, images, parentImages });
      } catch (cause) {
        if (active) setTarget({ images: [], error: cause instanceof Error ? cause.message : '举报对象暂时无法读取。' });
      }
    })();
    return () => { active = false; };
  }, [selectedReport?.id, access]);

  const perform = async (action: string, targetType: string, targetId: string, options: { reportId?: string; suspensionHours?: number } = {}, suppliedReason?: string) => {
    if (!supabase) return;
    const dangerous = ['remove_post', 'remove_comment', 'ban_user'].includes(action);
    if (dangerous && suppliedReason === undefined) {
      const warning = action === 'ban_user'
        ? '永久封禁该账号？账号将无法登录或发布内容，之后只能由管理员手动解封。'
        : '确认移除这条内容并删除其图片？该操作无法通过后台恢复图片。';
      if (!window.confirm(warning)) return;
    }
    const reason = suppliedReason === undefined ? window.prompt('填写处理原因：')?.trim() : suppliedReason.trim();
    if (!reason) return;
    setError('');
    const { data, error: invokeError } = await supabase.functions.invoke('admin-moderate', {
      body: { action, targetType, targetId, reportId: options.reportId, reason, suspensionHours: options.suspensionHours }
    });
    const failure = await readFunctionFailure(invokeError, data);
    if (invokeError || failure?.error) { setError(failure?.error ?? invokeError?.message ?? '管理操作失败。'); if (failure?.partial) await load(); return; }
    await load();
  };

  const updateOwnPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || passwordBusy) return;
    if (!/^\d{6}$/.test(ownPasswordOtp)) { setError('请输入邮件中的 6 位数字验证码。'); return; }
    if (ownPassword.length < 8) { setError('密码至少需要 8 位。'); return; }
    if (ownPassword !== ownPasswordConfirm) { setError('两次输入的新密码不一致。'); return; }
    setPasswordBusy(true); setError('');
    try {
      const email = session.user.email;
      if (!email) throw new Error('当前管理员账号没有可用邮箱。');
      const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: ownPasswordOtp, type: 'recovery' });
      if (verifyError) throw verifyError;
      const { error: updateError } = await supabase.auth.updateUser({ password: ownPassword });
      if (updateError) throw updateError;
      setShowOwnPassword(false); setOwnPassword(''); setOwnPasswordConfirm(''); setOwnPasswordOtp(''); setOwnPasswordCodeSent(false); setError('后台登录密码已更新。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '密码更新失败，请重试。'); }
    finally { setPasswordBusy(false); }
  };

  const requestOwnPasswordCode = async () => {
    if (!supabase || passwordBusy || ownPasswordResendSeconds > 0) return;
    const email = session.user.email;
    if (!email) { setError('当前管理员账号没有可用邮箱。'); return; }
    setPasswordBusy(true); setError('');
    try {
      const redirectTo = window.location.hostname === 'admin.yeecc.cn' ? 'https://admin.yeecc.cn/' : `${window.location.origin}/admin`;
      const { error: sendError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (sendError) throw sendError;
      setOwnPasswordCodeSent(true); startOwnPasswordCooldown(); setError('验证码已发送到管理员邮箱。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '验证码发送失败，请重试。'); }
    finally { setPasswordBusy(false); }
  };

  const closeOwnPassword = () => { setShowOwnPassword(false); setOwnPassword(''); setOwnPasswordConfirm(''); setOwnPasswordOtp(''); setOwnPasswordCodeSent(false); };

  if (access === 'loading') return <div className="admin-auth-shell"><div className="feed-loading"><Icon name="progress_activity" className="spin" />正在核验管理员权限…</div></div>;
  if (access === 'denied') return <div className="admin-auth-shell"><section className="admin-denied"><span className="empty-icon"><Icon name="lock" size={28} /></span><h1>此页面仅限管理员访问</h1><p>{error || '当前账号没有后台管理权限。管理员角色由项目所有者设置。'}</p><button className="soft-button" onClick={onExit}><Icon name="arrow_back" />返回日常有序</button></section></div>;

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <button className="admin-brand" onClick={onExit}><span className="brandmark"><Icon name="auto_awesome" size={19} /></span><span>日常有序 <small>管理工作台</small></span></button>
      <p className="admin-nav-label">社区治理</p>
      <nav aria-label="管理后台导航">{sections.map((item) => <button key={item.id} className={`admin-nav-item ${section === item.id ? 'active' : ''}`} onClick={() => { setSection(item.id); setSearch(''); if (item.id === 'users') void searchAccounts('user', ''); if (item.id === 'admins') void searchAccounts('admin', ''); }}><Icon name={item.icon} /><span>{item.label}</span>{item.id === 'reports' && openCount > 0 && <b className="admin-nav-count">{openCount}</b>}</button>)}</nav>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar"><div><p className="eyebrow">COMMUNITY SAFETY</p><h1>{sections.find((item) => item.id === section)?.label}</h1></div><div className="admin-topbar-actions"><div className="admin-topbar-identity"><span className="admin-user-avatar">{(adminIdentity?.display_name ?? session.user.email ?? '管').slice(0, 1).toUpperCase()}</span><span><b>{adminIdentity?.display_name ?? '管理员'}</b><small>{adminIdentity?.email ?? session.user.email}</small></span></div><details ref={accountMenuRef} className="admin-account-menu"><summary aria-label="管理员账号菜单" aria-haspopup="menu"><Icon name="more_horiz" /></summary><div role="menu"><button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setError(''); setOwnPassword(''); setOwnPasswordConfirm(''); setOwnPasswordOtp(''); setOwnPasswordCodeSent(false); setShowOwnPassword(true); }}><Icon name="key" />修改密码</button><button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onExit(); }}><Icon name="logout" />退出登录</button></div></details><button className="soft-button" onClick={() => section === 'users' ? void searchAccounts('user', search) : section === 'admins' ? void searchAccounts('admin', search) : void load()} disabled={loading}><Icon name="refresh" />{loading ? '刷新中…' : '刷新数据'}</button></div></header>
      {section === 'reports' && <section className="admin-metrics" aria-label="社区管理概况"><article><span className="metric-icon coral"><Icon name="flag" /></span><div><small>待处理举报</small><b>{openCount}</b></div></article><article><span className="metric-icon blue"><Icon name="visibility_off" /></span><div><small>已隐藏内容</small><b>{hiddenCount}</b></div></article><article><span className="metric-icon amber"><Icon name="person_alert" /></span><div><small>受限账号</small><b>{accountCount}</b></div></article><article><span className="metric-icon green"><Icon name="verified_user" /></span><div><small>今日处理举报</small><b>{metrics.handledToday}</b></div></article></section>}
      {error && <div className="community-alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭提示"><Icon name="close" /></button></div>}
      {loading && reports.length === 0 && profiles.length === 0 && accounts.length === 0 && users.length === 0 && content.length === 0 ? <div className="feed-loading"><Icon name="progress_activity" className="spin" />正在加载管理数据…</div> : section === 'reports' ? <ReportDesk reports={reports} selected={selectedReport} target={target} profiles={profiles} suspensionHours={suspensionHours} setSuspensionHours={setSuspensionHours} onSelect={(id) => setSelectedReportId(id)} onPerform={perform} hasMore={hasMore.reports} loading={loading} onLoadMore={() => void loadMore()} /> : section === 'content' ? <ContentDesk content={content} search={search} setSearch={setSearch} onPerform={perform} hasMore={hasMore.posts || hasMore.comments} loading={loading} onLoadMore={() => void loadMore()} /> : section === 'users' ? <AccountDesk mode="users" profiles={users} search={search} setSearch={setSearch} onSearch={(query) => void searchAccounts('user', query)} statusFilter={userStatusFilter} sort={registrationSort} registrationWindow={registrationWindow} onUserFiltersChange={(status, sort, window) => { setSearch(''); setUserStatusFilter(status); setRegistrationSort(sort); setRegistrationWindow(window); }} suspensionHours={suspensionHours} setSuspensionHours={setSuspensionHours} onPerform={perform} hasMore={hasMore.users} loading={loading} onLoadMore={() => void loadMore()} onRefresh={() => searchAccounts('user', search)} onMessage={setError} /> : section === 'admins' ? <AccountDesk mode="admins" profiles={accounts} search={search} setSearch={setSearch} onSearch={(query) => void searchAccounts('admin', query)} suspensionHours={suspensionHours} setSuspensionHours={setSuspensionHours} onPerform={perform} hasMore={hasMore.admins} loading={loading} onLoadMore={() => void loadMore()} onRefresh={() => searchAccounts('admin', search)} onMessage={setError} /> : <AuditDesk rows={audit} search={search} setSearch={setSearch} hasMore={hasMore.audit} loading={loading} onLoadMore={() => void loadMore()} />}
      <footer className="admin-footer">普通账号与管理员分开管理。管理员授权、撤销和密码重置都会写入操作记录。</footer>
    </main>
    {showOwnPassword && <div className="admin-modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) closeOwnPassword(); }}><section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="own-password-title"><header><div><p className="eyebrow">ACCOUNT SECURITY</p><h2 id="own-password-title">修改我的密码</h2></div><button className="icon-button" aria-label="关闭" onClick={closeOwnPassword}><Icon name="close" /></button></header>{!ownPasswordCodeSent ? <><p className="admin-modal-note">我们会向 {adminIdentity?.email ?? session.user.email} 发送一次性验证码。</p><footer><button type="button" className="soft-button" onClick={closeOwnPassword}>取消</button><button type="button" className="primary-button" disabled={passwordBusy || ownPasswordResendSeconds > 0} onClick={() => void requestOwnPasswordCode()}>{passwordBusy ? '发送中…' : ownPasswordResendSeconds > 0 ? `${ownPasswordResendSeconds} 秒后可发送` : '发送验证码'}</button></footer></> : <form onSubmit={(event) => void updateOwnPassword(event)}><label><span>邮箱验证码</span><input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={ownPasswordOtp} onChange={(event) => setOwnPasswordOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="输入 6 位数字验证码" required /></label><button type="button" className="text-button" disabled={passwordBusy || ownPasswordResendSeconds > 0} onClick={() => void requestOwnPasswordCode()}>{ownPasswordResendSeconds > 0 ? `${ownPasswordResendSeconds} 秒后可重发` : '重新发送验证码'}</button><label><span>新密码</span><input type="password" minLength={8} autoComplete="new-password" value={ownPassword} onChange={(event) => setOwnPassword(event.target.value)} required /></label><label><span>确认新密码</span><input type="password" minLength={8} autoComplete="new-password" value={ownPasswordConfirm} onChange={(event) => setOwnPasswordConfirm(event.target.value)} required /></label><p className="admin-modal-note">密码至少 8 位。验证码验证成功后会立即更新密码。</p><footer><button type="button" className="soft-button" onClick={closeOwnPassword}>取消</button><button className="primary-button" disabled={passwordBusy}>{passwordBusy ? '验证并更新中…' : '验证并更新密码'}</button></footer></form>}</section></div>}
  </div>;
}

function ReportDesk({ reports, selected, target, profiles, suspensionHours, setSuspensionHours, onSelect, onPerform, hasMore, loading, onLoadMore }: {
  reports: Report[]; selected: Report | null; target: ReportTarget | null; profiles: AdminProfile[]; suspensionHours: Record<string, number>; setSuspensionHours: (value: Record<string, number>) => void; onSelect: (id: string) => void; hasMore: boolean; loading: boolean; onLoadMore: () => void;
  onPerform: PerformAdminAction;
}) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [pendingAction, setPendingAction] = useState<{ action: string; targetType: 'post' | 'comment'; targetId: string; reportId: string } | null>(null);
  const visible = reports.filter((item) => filter === 'all' || item.status === 'open');
  const author = target?.author ?? (target?.content ? profiles.find((item) => item.id === target.content?.author_id) : undefined);
  const hours = selected ? suspensionHours[selected.target_id] ?? 24 : 24;
  return <section className="report-desk">
    <div className="report-queue"><div className="report-queue-head"><div><h2>举报收件箱</h2><p>先处理仍处于待处理状态的举报</p></div><select aria-label="举报筛选" value={filter} onChange={(event) => setFilter(event.target.value as 'open' | 'all')}><option value="open">待处理</option><option value="all">全部举报</option></select></div>
      <div className="report-queue-list">{visible.length === 0 ? <div className="admin-empty"><Icon name="task_alt" /><b>没有待处理举报</b><small>新的举报会显示在这里。</small></div> : visible.map((report) => <button key={report.id} className={`report-queue-item ${selected?.id === report.id ? 'selected' : ''}`} onClick={() => onSelect(report.id)}><span className={`report-type-icon ${report.target_type}`}><Icon name={report.target_type === 'user' ? 'person' : report.target_type === 'post' ? 'article' : 'chat_bubble'} /></span><span className="report-queue-copy"><b>{targetLabel(report.target_type)} · {report.reason}</b><small>举报人 UID：{report.reporter_uid ?? '暂不可用'}</small><small>{formatDate(report.created_at)}</small></span><span className={`status-pill ${report.status}`}>{report.status === 'open' ? '待处理' : report.status === 'handled' ? '已处理' : '已驳回'}</span></button>)}{hasMore && <button className="load-more-button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : '加载更早举报'}</button>}</div>
    </div>
    <div className="report-detail">{!selected ? <div className="admin-empty"><Icon name="touch_app" /><b>选择一条举报</b><small>在左侧队列中选择举报，查看举报对象和处理选项。</small></div> : <>
      <header className="report-detail-head"><div><p className="eyebrow">REPORT DETAIL</p><h2>{targetLabel(selected.target_type)}举报</h2></div><span className={`status-pill ${selected.status}`}>{selected.status === 'open' ? '待处理' : selected.status === 'handled' ? '已处理' : '已驳回'}</span></header>
      <div className="report-meta-grid"><div><small>举报原因</small><b>{selected.reason}</b></div><div><small>提交时间</small><b>{formatDate(selected.created_at)}</b></div><div><small>举报人 UID</small><code>{selected.reporter_uid ?? '暂不可用'}</code></div><div><small>{selected.target_type === 'user' ? '被举报用户 UID' : '内容作者 UID'}</small><code>{selected.target_type === 'user' ? target?.profile?.uid ?? '读取中' : target?.author?.uid ?? '读取中'}</code></div>{target?.content && <div><small>内容 ID</small><code>{target.content.id}</code></div>}</div>
      {selected.detail && <p className="report-extra">补充说明：{selected.detail}</p>}
      <section className="reported-object"><h3>被举报对象</h3>{!target ? <div className="target-loading"><Icon name="progress_activity" className="spin" />正在读取对象…</div> : target.error ? <p className="form-error">{target.error}</p> : target.profile ? <div className="target-profile"><Avatar profile={target.profile} url={target.images[0]} /><div><b>{target.profile.display_name}</b><small>UID：{target.profile.uid} · @{target.profile.username ?? '未设置用户名'} · {statusLabel(effectiveStatus(target.profile), target.profile.suspension_expires_at)}</small><p>{target.profile.bio || '这个用户还没有填写简介。'}</p></div></div> : target.content ? <><div className="target-author"><Avatar profile={author} /><span><b>{author?.display_name ?? '举报对象用户'}</b><small>作者 UID：{author?.uid ?? '暂不可用'} · {formatDate(target.content.created_at)} · {target.content.target_type === 'post' ? '动态' : '评论'} · {contentStatus(target.content.moderation_status)}</small></span></div><p className="target-body">{target.content.body || '（纯图片内容）'}</p>{target.images.length > 0 && <div className="target-images">{target.images.map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}><img src={url} alt="举报对象图片" /></a>)}</div>}{target.parentPost && <div className="report-parent-context"><h4>所属动态内容</h4><small>{contentStatus(target.parentPost.moderation_status)} · {formatDate(target.parentPost.created_at)} · ID {target.parentPost.id}</small><p className="target-body">{target.parentPost.body || '（纯图片动态）'}</p>{target.parentImages?.length ? <div className="target-images">{target.parentImages.map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}><img src={url} alt={`关联动态图片 ${index + 1}`} /></a>)}</div> : null}</div>}<small className="target-record-id">内容 ID：{target.content.id}{target.content.post_id ? ` · 所属动态：${target.content.post_id}` : ''}</small></> : <p className="muted">目标内容已被删除或找不到。</p>}</section>
      {selected.status === 'open' && <div className="report-actions"><h3>处理举报</h3>{selected.target_type === 'user' ? <div className="admin-action-row"><select value={hours} onChange={(event) => setSuspensionHours({ ...suspensionHours, [selected.target_id]: Number(event.target.value) })} aria-label="暂停时长"><option value={24}>暂停 24 小时</option><option value={168}>暂停 7 天</option><option value={720}>暂停 30 天</option></select><button className="soft-button" onClick={() => void onPerform('suspend_user', 'user', selected.target_id, { reportId: selected.id, suspensionHours: hours })}>暂停账号</button><button className="danger-button" onClick={() => void onPerform('ban_user', 'user', selected.target_id, { reportId: selected.id })}>永久封禁</button></div> : <div className="admin-action-row"><button className="soft-button" onClick={() => setPendingAction({ action: `hide_${selected.target_type}`, targetType: selected.target_type as 'post' | 'comment', targetId: selected.target_id, reportId: selected.id })}>隐藏内容</button><button className="danger-button" onClick={() => setPendingAction({ action: `remove_${selected.target_type}`, targetType: selected.target_type as 'post' | 'comment', targetId: selected.target_id, reportId: selected.id })}>移除并删除图片</button></div>}<div className="admin-action-row secondary-actions"><button className="primary-button compact" onClick={() => void onPerform('handle_report', selected.target_type, selected.target_id, { reportId: selected.id })}>标记已处理</button><button className="soft-button" onClick={() => void onPerform('dismiss_report', selected.target_type, selected.target_id, { reportId: selected.id })}>驳回举报</button></div></div>}
    </>}</div>
    {pendingAction && <ModerationConfirmDialog kind={pendingAction.action.startsWith('remove_') ? 'remove' : 'hide'} itemLabel={targetLabel(pendingAction.targetType)} onClose={() => setPendingAction(null)} onConfirm={async (reason) => { await onPerform(pendingAction.action, pendingAction.targetType, pendingAction.targetId, { reportId: pendingAction.reportId }, reason); setPendingAction(null); }} />}
  </section>;
}

function ContentDesk({ content, search, setSearch, onPerform, hasMore, loading, onLoadMore }: { content: ContentRow[]; search: string; setSearch: (value: string) => void; onPerform: PerformAdminAction; hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const [selected, setSelected] = useState<ContentRow | null>(null);
  const rows = content.filter((item) => `${item.body} ${item.author_id} ${item.id}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="admin-section-card">
    <AdminSearch value={search} onChange={setSearch} placeholder="搜索动态、评论文字、作者或内容 ID" />
    <div className="admin-data-list">{rows.map((item) => <article className="admin-data-row content-row-trigger" key={`${item.target_type}-${item.id}`} role="button" tabIndex={0} aria-label={`查看${item.target_type === 'post' ? '动态' : '评论'}详情`} onClick={() => setSelected(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(item); } }}>
      <div className="content-target-preview"><span className="report-type-icon"><Icon name={item.target_type === 'post' ? 'article' : 'chat_bubble'} /></span><div><b>{item.target_type === 'post' ? '动态' : '评论'} · {contentStatus(item.moderation_status)}</b><p>{item.body || '（图片内容）'}</p><small>{formatDate(item.created_at)} · 内容 ID {item.id}</small></div></div><Icon name="chevron_right" />
    </article>)}{rows.length === 0 && <div className="admin-empty"><Icon name="search_off" /><b>没有匹配内容</b></div>}</div>
    {hasMore && <button className="load-more-button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : '加载更多内容'}</button>}
    {selected && <ContentDetailDialog item={selected} onClose={() => setSelected(null)} onPerform={onPerform} />}
  </section>;
}

function ContentDetailDialog({ item, onClose, onPerform }: { item: ContentRow; onClose: () => void; onPerform: PerformAdminAction }) {
  const [detailItem, setDetailItem] = useState(item);
  const [author, setAuthor] = useState<AdminProfile | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [parentPost, setParentPost] = useState<ContentRow | null>(null);
  const [parentImages, setParentImages] = useState<string[]>([]);
  const [detailLoading, setDetailLoading] = useState(true);
  const [recordAvailable, setRecordAvailable] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [pendingKind, setPendingKind] = useState<'hide' | 'remove' | 'restore' | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setDetailLoading(true); setDetailError('');
      try {
        if (!supabase) throw new Error('社区服务暂不可用。');
        const table = item.target_type === 'post' ? 'posts' : 'comments';
        const select = item.target_type === 'post'
          ? 'id,author_id,body,image_paths,moderation_status,created_at,updated_at'
          : 'id,post_id,author_id,body,image_paths,moderation_status,created_at';
        const { data: latestData, error: latestError } = await supabase.from(table).select(select).eq('id', item.id).maybeSingle();
        if (latestError) throw latestError;
        if (!latestData) {
          if (active) {
            setRecordAvailable(false);
            setDetailItem({ ...item, moderation_status: 'removed' });
            setDetailError('这条内容已不存在，无法继续操作。');
          }
          return;
        }
        const latestItem = {
          ...(latestData as unknown as ContentRow),
          target_type: item.target_type,
          image_paths: (latestData as unknown as { image_paths?: string[] }).image_paths ?? []
        };
        if (active) { setDetailItem(latestItem); setRecordAvailable(true); }

        const { data: authorData, error: authorError } = await supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at,created_at').eq('id', latestItem.author_id).maybeSingle();
        if (authorError) throw authorError;
        let nextAuthor = authorData as AdminProfile | null;
        if (nextAuthor?.avatar_path && nextAuthor.account_status !== 'deleted') {
          const { data: signedAvatar } = await supabase.storage.from('community-media').createSignedUrl(nextAuthor.avatar_path, 1800);
          nextAuthor = { ...nextAuthor, avatar_url: signedAvatar?.signedUrl };
        }

        let nextImages: string[] = [];
        if (latestItem.image_paths.length) {
          const { data: signed, error: imageError } = await supabase.storage.from('community-media').createSignedUrls(latestItem.image_paths, 1800);
          if (imageError) setDetailError(`部分图片暂时无法读取：${imageError.message}`);
          else nextImages = (signed ?? []).map((file) => file.signedUrl ?? '').filter(Boolean);
        }

        let nextParentPost: ContentRow | null = null;
        let nextParentImages: string[] = [];
        if (latestItem.target_type === 'comment' && latestItem.post_id) {
          const { data: parent, error: parentError } = await supabase.from('posts').select('id,author_id,body,image_paths,moderation_status,created_at,updated_at').eq('id', latestItem.post_id).maybeSingle();
          if (parentError) throw parentError;
          if (parent) {
            nextParentPost = { ...parent, target_type: 'post' } as ContentRow;
            if (nextParentPost.image_paths.length) {
              const { data: signed, error: parentImageError } = await supabase.storage.from('community-media').createSignedUrls(nextParentPost.image_paths, 1800);
              if (parentImageError) setDetailError(`关联动态图片暂时无法读取：${parentImageError.message}`);
              else nextParentImages = (signed ?? []).map((file) => file.signedUrl ?? '').filter(Boolean);
            }
          }
        }

        if (active) { setAuthor(nextAuthor); setImages(nextImages); setParentPost(nextParentPost); setParentImages(nextParentImages); }
      } catch (cause) {
        if (active) { setRecordAvailable(false); setDetailError(cause instanceof Error ? cause.message : '内容详情暂时无法读取。'); }
      } finally {
        if (active) setDetailLoading(false);
      }
    })();
    return () => { active = false; };
  }, [item.id, item.target_type, item.author_id, item.post_id]);

  const contentLabel = detailItem.target_type === 'post' ? '这条动态' : '这条评论';
  const action = pendingKind === 'hide' ? `hide_${detailItem.target_type}` : pendingKind === 'restore' ? `restore_${detailItem.target_type}` : `remove_${detailItem.target_type}`;
  return <div className="admin-modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="admin-modal content-detail-modal" role="dialog" aria-modal="true" aria-labelledby="content-detail-title">
      <header><div><p className="eyebrow">CONTENT REVIEW</p><h2 id="content-detail-title">{detailItem.target_type === 'post' ? '动态详情' : '评论详情'}</h2></div><button type="button" className="icon-button" aria-label="关闭内容详情" onClick={onClose}><Icon name="close" /></button></header>
      <div className="content-detail-meta">
        <span className={`status-pill ${detailItem.moderation_status}`}>{contentStatus(detailItem.moderation_status)}</span>
        <span>发布时间：{formatDate(detailItem.created_at)}</span>
        {detailItem.updated_at ? <span>最近更新：{formatDate(detailItem.updated_at)}</span> : null}
        <span>内容 ID：<code>{detailItem.id}</code></span>
        {detailItem.post_id ? <span>所属动态 ID：<code>{detailItem.post_id}</code></span> : null}
      </div>
      <div className="content-detail-author"><Avatar profile={author ?? undefined} /><div><b>{author?.display_name ?? '内容作者'}</b><small>作者 UID：{author?.uid ?? '读取中'}</small></div></div>
      <section className="content-detail-section"><h3>发布内容</h3><p className="content-detail-body">{detailItem.body || '（纯图片内容）'}</p>{images.length > 0 && <div className="content-detail-images">{images.map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}><img src={url} alt={`内容图片 ${index + 1}`} /></a>)}</div>}</section>
      {parentPost && <section className="content-detail-section parent-post-preview"><h3>所属动态内容</h3><small>{contentStatus(parentPost.moderation_status)} · {formatDate(parentPost.created_at)} · ID {parentPost.id}</small><p className="content-detail-body">{parentPost.body || '（纯图片动态）'}</p>{parentImages.length > 0 && <div className="content-detail-images">{parentImages.map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}><img src={url} alt={`关联动态图片 ${index + 1}`} /></a>)}</div>}</section>}
      {detailLoading && <p className="muted">正在读取最新内容、作者和图片信息…</p>}{detailError && <p className="form-error" role="alert">{detailError}</p>}
      <footer className="content-detail-actions">{detailItem.moderation_status !== 'removed' ? <>{detailItem.moderation_status === 'visible' ? <button type="button" className="soft-button" disabled={!recordAvailable || detailLoading} onClick={() => setPendingKind('hide')}>隐藏内容</button> : <button type="button" className="primary-button compact" disabled={!recordAvailable || detailLoading} onClick={() => setPendingKind('restore')}>恢复内容</button>}<button type="button" className="danger-button" disabled={!recordAvailable || detailLoading} onClick={() => setPendingKind('remove')}>删除内容</button></> : <span className="muted">此内容已删除</span>}</footer>
    </section>
    {pendingKind && <ModerationConfirmDialog kind={pendingKind} itemLabel={contentLabel} onClose={() => setPendingKind(null)} onConfirm={async (reason) => { await onPerform(action, detailItem.target_type, detailItem.id, undefined, reason); setPendingKind(null); onClose(); }} />}
  </div>;
}

function ModerationConfirmDialog({ kind, itemLabel, onClose, onConfirm }: { kind: 'hide' | 'remove' | 'restore'; itemLabel: string; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const copy = kind === 'hide'
    ? { title: '确认隐藏内容？', description: '隐藏后，普通用户将无法在社区看到这条内容。', button: '确认隐藏', danger: false }
    : kind === 'remove'
      ? { title: '确认删除内容？', description: '系统会移除这条内容并清理相关图片；此操作无法通过后台恢复。', button: '确认删除', danger: true }
      : { title: '确认恢复内容？', description: '恢复后，这条内容会重新对社区用户显示。', button: '确认恢复', danger: false };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !reason.trim()) return;
    setBusy(true);
    try { await onConfirm(reason.trim()); }
    finally { setBusy(false); }
  };
  return <div className="admin-modal-backdrop action-confirm-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="admin-modal content-action-confirm" role="dialog" aria-modal="true" aria-labelledby="content-action-confirm-title">
      <header><div><p className="eyebrow">{itemLabel}</p><h2 id="content-action-confirm-title">{copy.title}</h2></div><button type="button" className="icon-button" aria-label="关闭确认弹窗" onClick={onClose}><Icon name="close" /></button></header>
      <p className="admin-modal-note">{copy.description}</p>
      <form onSubmit={(event) => void submit(event)}><label><span>操作原因（写入后台记录）</span><textarea maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} required /></label><footer><button type="button" className="soft-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className={copy.danger ? 'danger-button' : 'primary-button'} disabled={busy || !reason.trim()}>{busy ? '处理中…' : copy.button}</button></footer></form>
    </section>
  </div>;
}

function AccountDesk({ mode, profiles, search, setSearch, onSearch, statusFilter, sort, registrationWindow, onUserFiltersChange, suspensionHours, setSuspensionHours, onPerform, hasMore, loading, onLoadMore, onRefresh, onMessage }: {
  mode: 'users' | 'admins'; profiles: AdminProfile[]; search: string; setSearch: (value: string) => void; onSearch: (query: string) => void;
  statusFilter?: UserStatusFilter; sort?: RegistrationSort; registrationWindow?: RegistrationWindow; onUserFiltersChange?: (status: UserStatusFilter, sort: RegistrationSort, window: RegistrationWindow) => void;
  suspensionHours: Record<string, number>; setSuspensionHours: (value: Record<string, number>) => void;
  onPerform: (action: string, targetType: string, targetId: string, options?: { suspensionHours?: number }) => Promise<void>;
  hasMore: boolean; loading: boolean; onLoadMore: () => void; onRefresh: () => Promise<void>; onMessage: (message: string) => void;
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

  const closeResetAdmin = () => { setResetTarget(null); setResetPassword(''); setResetPasswordConfirm(''); setResetReason(''); };

  const findAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !lookup.trim() || lookupBusy) return;
    setLookupBusy(true); setCandidate(null);
    const { data, error } = await supabase.functions.invoke('admin-manage', { body: { action: 'find_account', lookup: lookup.trim() } });
    const failure = await readFunctionFailure(error, data);
    if (error || failure?.error) onMessage(failure?.error === 'account_not_found' ? '找不到匹配的已注册账号。' : failure?.error ?? error?.message ?? '账号查找失败。');
    else {
      const account = (data as { account?: AdminProfile } | null)?.account ?? null;
      if (account) {
        const avatarResult = await attachAvatarUrls([account]);
        setCandidate(avatarResult.rows[0] ?? account);
        if (avatarResult.error) onMessage(`头像暂时无法加载：${avatarResult.error}`);
      } else setCandidate(null);
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
    onMessage(grant ? `${person.display_name} 已成为管理员。` : `已撤销 ${person.display_name} 的管理员权限。`);
    await onRefresh();
  };

  const resetAdminPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !resetTarget || resetBusy) return;
    if (resetPassword.length < 8 || resetPassword.length > 128) { onMessage('新密码需要为 8 至 128 位。'); return; }
    if (resetPassword !== resetPasswordConfirm) { onMessage('两次输入的新密码不一致。'); return; }
    if (!resetReason.trim()) { onMessage('请填写密码重置原因。'); return; }
    if (!window.confirm(`确认立即将 ${resetTarget.display_name} 的管理员密码重置为你输入的新密码？`)) return;
    setResetBusy(true);
    const { data, error } = await supabase.functions.invoke('admin-manage', { body: { action: 'reset_admin_password', targetId: resetTarget.id, newPassword: resetPassword, reason: resetReason.trim() } });
    const failure = await readFunctionFailure(error, data);
    if (error || failure?.error) onMessage(failure?.error === 'password_updated_audit_failed' ? '密码已更新，但审计记录失败，请检查后台操作记录。' : failure?.error ?? error?.message ?? '管理员密码更新失败。');
    else onMessage(`已更新 ${resetTarget.display_name} 的管理员密码。请通过安全渠道告知对方新密码。`);
    setResetBusy(false);
    if (!error && !failure?.error) { setResetTarget(null); setResetPassword(''); setResetPasswordConfirm(''); setResetReason(''); }
  };

  const candidateEligible = candidate?.role === 'user' && candidate.account_status === 'active' && Boolean(candidate.email_confirmed_at);
  const searchPlaceholder = mode === 'users' ? '输入纯数字 UID 或邮箱搜索普通用户' : '输入纯数字 UID 或邮箱搜索管理员';
  return <section className="admin-section-card">
    {mode === 'admins' && <div className="admin-admin-toolbar"><div><p className="eyebrow">ADMINISTRATORS</p><h2>管理员账号</h2><p>管理员单独登记在管理员账号表中。添加时只能授权已验证邮箱的现有账号。</p></div><button className="primary-button" onClick={() => { setCandidate(null); setLookup(''); setGrantReason(''); setShowAddAdmin(true); }}><Icon name="person_add" />添加管理员</button></div>}
    <form className="admin-role-lookup admin-list-search" onSubmit={(event) => { event.preventDefault(); onSearch(search); }}>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
      <button className="primary-button compact" type="submit" disabled={loading}><Icon name="search" />搜索</button>
      {search && <button className="soft-button compact" type="button" onClick={() => { setSearch(''); onSearch(''); }}>清除</button>}
    </form>
    {mode === 'users' && <div className="admin-filter-row"><label><span>账号状态</span><select value={statusFilter ?? 'all'} onChange={(event) => onUserFiltersChange?.(event.target.value as UserStatusFilter, sort ?? 'newest', registrationWindow ?? 'all')}><option value="all">全部状态</option><option value="active">正常</option><option value="suspended">暂停中</option><option value="banned">永久封禁</option></select></label><label><span>注册范围</span><select value={registrationWindow ?? 'all'} onChange={(event) => onUserFiltersChange?.(statusFilter ?? 'all', sort ?? 'newest', event.target.value as RegistrationWindow)}><option value="all">全部时间</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="90d">近 90 天</option></select></label><label><span>排序方式</span><select value={sort ?? 'newest'} onChange={(event) => onUserFiltersChange?.(statusFilter ?? 'all', event.target.value as RegistrationSort, registrationWindow ?? 'all')}><option value="newest">最新注册优先</option><option value="oldest">最早注册优先</option></select></label></div>}
    <div className="admin-data-list">{profiles.map((person) => {
      const state = effectiveStatus(person); const hours = suspensionHours[person.id] ?? 24;
      return <article className="admin-data-row" key={person.id}><div className="account-target"><Avatar profile={person} /><div><b>{person.display_name}{mode === 'admins' && ' · 管理员'}<span className={`status-pill ${state}`}>{statusLabel(state, person.suspension_expires_at)}</span></b><small>{person.email ?? '邮箱不可用'} · UID {person.uid} · 注册 {formatDate(person.created_at)}</small><p>{person.bio || '暂无个人简介'}</p></div></div>{mode === 'admins' ? <div className="admin-actions account-actions"><button className="soft-button" onClick={() => { setResetPassword(''); setResetPasswordConfirm(''); setResetReason(''); setResetTarget(person); }}><Icon name="key" />修改密码</button><button className="danger-button" onClick={() => void changeRole(person, 'revoke_admin')}>撤销管理员</button></div> : <div className="admin-actions account-actions">{state !== 'banned' && <><select value={hours} onChange={(event) => setSuspensionHours({ ...suspensionHours, [person.id]: Number(event.target.value) })} aria-label={`${person.display_name}的暂停时长`}><option value={24}>24 小时</option><option value={168}>7 天</option><option value={720}>30 天</option></select><button className="soft-button" onClick={() => void onPerform('suspend_user', 'user', person.id, { suspensionHours: hours })}>{state === 'suspended' ? '重新暂停' : '暂停'}</button></>}{state === 'banned' ? <button className="primary-button compact" onClick={() => void onPerform('unban_user', 'user', person.id)}>手动解封</button> : <button className="danger-button" onClick={() => void onPerform('ban_user', 'user', person.id)}>永久封禁</button>}{state === 'suspended' && <button className="primary-button compact" onClick={() => void onPerform('restore_user', 'user', person.id)}>恢复账号</button>}</div>}</article>;
    })}{profiles.length === 0 && <div className="admin-empty"><Icon name="search_off" /><b>{search ? '没有匹配账号' : mode === 'users' ? '还没有普通用户' : '还没有管理员'}</b></div>}</div>
    {hasMore && <button className="load-more-button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : mode === 'users' ? '加载更多用户' : '加载更多管理员'}</button>}
    {showAddAdmin && <div className="admin-modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setShowAddAdmin(false); }}><section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="add-admin-title"><header><div><p className="eyebrow">ADMINISTRATORS</p><h2 id="add-admin-title">添加管理员</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setShowAddAdmin(false)}><Icon name="close" /></button></header><p className="admin-modal-note">输入已注册账号的 6 位 UID 或邮箱。只有邮箱已验证且账号正常的普通用户可以添加；管理员权限由独立管理员账号表授权。</p><form className="admin-role-lookup" onSubmit={(event) => void findAccount(event)}><input value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="6 位 UID 或 name@example.com" aria-label="通过 UID 或邮箱查找账号" required /><button className="primary-button" disabled={lookupBusy}><Icon name="search" />{lookupBusy ? '查找中…' : '查找账号'}</button></form>{candidate && <article className="admin-role-candidate"><Avatar profile={candidate} /><div><b>{candidate.display_name}</b><small>{candidate.email ?? '无邮箱'} · UID {candidate.uid}</small><small>{candidate.email_confirmed_at ? '邮箱已验证' : '邮箱尚未验证'} · {statusLabel(effectiveStatus(candidate), candidate.suspension_expires_at)}</small></div></article>}{candidate && candidateEligible && <form className="admin-modal-add-form" onSubmit={(event) => { event.preventDefault(); void changeRole(candidate, 'grant_admin', grantReason); }}><label><span>添加原因（写入操作记录）</span><input maxLength={500} value={grantReason} onChange={(event) => setGrantReason(event.target.value)} required /></label><footer><button className="primary-button compact" type="submit">确认添加管理员</button></footer></form>}{candidate && !candidateEligible && <p className="admin-modal-note">该账号需要邮箱验证且状态正常后才能添加。</p>}<footer><button className="soft-button" onClick={() => setShowAddAdmin(false)}>关闭</button></footer></section></div>}
    {resetTarget && <div className="admin-modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) closeResetAdmin(); }}><section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="reset-admin-title"><header><div><p className="eyebrow">ADMIN CREDENTIALS</p><h2 id="reset-admin-title">修改管理员密码</h2></div><button className="icon-button" aria-label="关闭" onClick={closeResetAdmin}><Icon name="close" /></button></header><p className="admin-modal-note">正在修改 <b>{resetTarget.display_name}</b>（{resetTarget.email}）的登录密码。新密码会立即生效，系统不会显示旧密码。</p><form onSubmit={(event) => void resetAdminPassword(event)}><label><span>新密码</span><input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} required /></label><label><span>确认新密码</span><input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={resetPasswordConfirm} onChange={(event) => setResetPasswordConfirm(event.target.value)} required /></label><label><span>重置原因（写入操作记录）</span><input maxLength={500} value={resetReason} onChange={(event) => setResetReason(event.target.value)} required /></label><footer><button type="button" className="soft-button" onClick={closeResetAdmin}>取消</button><button className="primary-button" disabled={resetBusy}>{resetBusy ? '更新中…' : '更新密码'}</button></footer></form></section></div>}
  </section>;
}

function AuditDesk({ rows, search, setSearch, hasMore, loading, onLoadMore }: { rows: AuditRow[]; search: string; setSearch: (value: string) => void; hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const visible = rows.filter((item) => `${item.actor_id} ${item.target_type} ${item.target_id} ${item.action} ${item.reason}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="admin-section-card">
    <AdminSearch value={search} onChange={setSearch} placeholder="搜索管理员、目标 ID、动作或处理原因" />
    <div className="admin-data-list">
      {visible.map((item) => <article className="audit-row" key={item.id}>
        <span className="audit-icon"><Icon name="history" /></span>
        <div><b>{actionLabel(item.action)} · {targetLabel(item.target_type)}</b><p>{item.reason}</p><small>管理员 {item.actor_id} · 目标 {item.target_id} · {formatDate(item.created_at)}</small></div>
      </article>)}
      {visible.length === 0 && <div className="admin-empty"><Icon name="history" /><b>没有操作记录</b></div>}
    </div>
    {hasMore && <button className="load-more-button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : '加载更早记录'}</button>}
  </section>;
}

function AdminSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="admin-search"><Icon name="search" /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function Avatar({ profile, url }: { profile?: Pick<Profile, 'display_name' | 'avatar_url'>; url?: string }) {
  const source = url ?? profile?.avatar_url;
  return <span className="admin-avatar">{source ? <img src={source} alt="" /> : (profile?.display_name ?? '生').slice(0, 1)}</span>;
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

function targetLabel(type: string) { return type === 'post' ? '动态' : type === 'comment' ? '评论' : '账号'; }
function contentStatus(status: string) { return status === 'visible' ? '公开' : status === 'hidden' ? '已隐藏' : '已移除'; }
function actionLabel(action: string) {
  const names: Record<string, string> = { hide_post: '隐藏动态', remove_post: '移除动态', restore_post: '恢复动态', hide_comment: '隐藏评论', remove_comment: '移除评论', restore_comment: '恢复评论', suspend_user: '暂停账号', restore_user: '恢复账号', ban_user: '永久封禁', unban_user: '手动解封', grant_admin: '添加管理员', revoke_admin: '撤销管理员', reset_admin_password: '重置管理员密码', reset_admin_password_started: '重置管理员密码（处理中）', reset_admin_password_failed: '重置管理员密码失败', handle_report: '标记举报已处理', dismiss_report: '驳回举报' };
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
    forbidden: '当前账号没有执行此操作的权限。'
  };
  return messages[error ?? ''] ?? '管理员权限操作失败，请稍后重试。';
}
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
async function readFunctionFailure(error: unknown, data: unknown): Promise<{ error?: string; partial?: boolean } | null> {
  if (data && typeof data === 'object') return data as { error?: string; partial?: boolean };
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) return await context.clone().json().catch(() => null) as { error?: string; partial?: boolean } | null;
  }
  return null;
}
