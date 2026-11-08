import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AuthPage, type Profile } from './community';
import { Icon } from './Icon';
import { supabase } from './supabase';

type AdminSection = 'reports' | 'content' | 'accounts' | 'audit';
type PageKey = 'reports' | 'profiles' | 'audit' | 'posts' | 'comments';
type AdminProfile = Profile & { suspension_expires_at: string | null; created_at: string };
type Report = { id: string; reporter_id: string; target_type: 'post' | 'comment' | 'user'; target_id: string; reason: string; detail: string; status: 'open' | 'handled' | 'dismissed'; created_at: string; reviewed_at?: string | null };
type ContentRow = { id: string; target_type: 'post' | 'comment'; author_id: string; body: string; image_paths: string[]; moderation_status: 'visible' | 'hidden' | 'removed'; created_at: string; post_id?: string };
type AuditRow = { id: string; actor_id: string; target_type: string; target_id: string; action: string; reason: string; created_at: string };
type ReportTarget = { profile?: AdminProfile; content?: ContentRow; images: string[]; error?: string };
type AdminMetrics = { openReports: number; hiddenContent: number; restrictedAccounts: number; handledToday: number };

const sections: Array<{ id: AdminSection; label: string; icon: string }> = [
  { id: 'reports', label: '举报处理', icon: 'flag' },
  { id: 'content', label: '内容管理', icon: 'article' },
  { id: 'accounts', label: '账号管理', icon: 'group' },
  { id: 'audit', label: '操作记录', icon: 'history' }
];

export default function AdminPanel({ session, onExit }: { session: Session | null; onExit: () => void }) {
  const [section, setSection] = useState<AdminSection>('reports');
  const [access, setAccess] = useState<'loading' | 'allowed' | 'denied'>('loading');
  const [profiles, setProfiles] = useState<AdminProfile[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [content, setContent] = useState<ContentRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [offsets, setOffsets] = useState<Record<PageKey, number>>({ reports: 0, profiles: 0, audit: 0, posts: 0, comments: 0 });
  const [hasMore, setHasMore] = useState<Record<PageKey, boolean>>({ reports: false, profiles: false, audit: false, posts: false, comments: false });
  const [metrics, setMetrics] = useState<AdminMetrics>({ openReports: 0, hiddenContent: 0, restrictedAccounts: 0, handledToday: 0 });
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
    if (!session || !supabase) { setAccess('denied'); return; }
    void supabase.from('profiles').select('id,role,account_status,suspension_expires_at').eq('id', session.user.id).maybeSingle().then(({ data, error: queryError }) => {
      if (!active) return;
      setAccess(!queryError && data?.role === 'admin' && data.account_status === 'active' ? 'allowed' : 'denied');
      if (queryError) setError(queryError.message);
    });
    return () => { active = false; };
  }, [session?.user.id]);

  const load = useCallback(async () => {
    if (!supabase || access !== 'allowed') return;
    setLoading(true); setError('');
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const [reportResult, profileResult, auditResult, postResult, commentResult, openCountResult, hiddenPostsResult, hiddenCommentsResult, restrictedCountResult, handledTodayResult] = await Promise.all([
      supabase.from('reports').select('*').order('status', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100),
      supabase.from('profiles').select('id,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200),
      supabase.from('moderation_audit').select('id,actor_id,target_type,target_id,action,reason,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200),
      supabase.from('posts').select('id,author_id,body,image_paths,moderation_status,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100),
      supabase.from('comments').select('id,post_id,author_id,body,image_paths,moderation_status,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(150),
      supabase.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      supabase.from('posts').select('id', { count: 'exact', head: true }).eq('moderation_status', 'hidden'),
      supabase.from('comments').select('id', { count: 'exact', head: true }).eq('moderation_status', 'hidden'),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).in('account_status', ['suspended', 'banned']),
      supabase.from('reports').select('id', { count: 'exact', head: true }).gte('reviewed_at', todayStart.toISOString()).lt('reviewed_at', tomorrowStart.toISOString())
    ]);
    const firstError = reportResult.error ?? profileResult.error ?? auditResult.error ?? postResult.error ?? commentResult.error ?? openCountResult.error ?? hiddenPostsResult.error ?? hiddenCommentsResult.error ?? restrictedCountResult.error ?? handledTodayResult.error;
    if (firstError) setError(firstError.message);
    setMetrics({ openReports: openCountResult.count ?? 0, hiddenContent: (hiddenPostsResult.count ?? 0) + (hiddenCommentsResult.count ?? 0), restrictedAccounts: restrictedCountResult.count ?? 0, handledToday: handledTodayResult.count ?? 0 });
    const nextReports = (reportResult.data ?? []) as Report[];
    setReports(nextReports);
    const nextProfiles = (profileResult.data ?? []) as AdminProfile[];
    const nextAudit = (auditResult.data ?? []) as AuditRow[];
    const nextPosts = (postResult.data ?? []) as Array<Omit<ContentRow, 'target_type'>>;
    const nextComments = (commentResult.data ?? []) as Array<Omit<ContentRow, 'target_type'>>;
    setProfiles(nextProfiles);
    setAudit(nextAudit);
    const rows: ContentRow[] = [
      ...nextPosts.map((item) => ({ ...item, target_type: 'post' as const })),
      ...nextComments.map((item) => ({ ...item, target_type: 'comment' as const }))
    ];
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    setContent(rows);
    setOffsets({ reports: nextReports.length, profiles: nextProfiles.length, audit: nextAudit.length, posts: nextPosts.length, comments: nextComments.length });
    setHasMore({ reports: nextReports.length === 100, profiles: nextProfiles.length === 200, audit: nextAudit.length === 200, posts: nextPosts.length === 100, comments: nextComments.length === 150 });
    setSelectedReportId((current) => current && nextReports.some((item) => item.id === current) ? current : nextReports.find((item) => item.status === 'open')?.id ?? nextReports[0]?.id ?? null);
    setLoading(false);
  }, [access]);

  const loadMore = async () => {
    if (!supabase || loading) return;
    setLoading(true); setError('');
    if (section === 'reports') {
      const start = offsets.reports; const { data, error: queryError } = await supabase.from('reports').select('*').order('status', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + 99);
      if (queryError) setError(queryError.message);
      const rows = (data ?? []) as Report[]; setReports((current) => [...current, ...rows]); setOffsets((current) => ({ ...current, reports: start + rows.length })); setHasMore((current) => ({ ...current, reports: rows.length === 100 }));
    } else if (section === 'accounts') {
      const start = offsets.profiles; const { data, error: queryError } = await supabase.from('profiles').select('id,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + 199);
      if (queryError) setError(queryError.message);
      const rows = (data ?? []) as AdminProfile[]; setProfiles((current) => [...current, ...rows]); setOffsets((current) => ({ ...current, profiles: start + rows.length })); setHasMore((current) => ({ ...current, profiles: rows.length === 200 }));
    } else if (section === 'audit') {
      const start = offsets.audit; const { data, error: queryError } = await supabase.from('moderation_audit').select('id,actor_id,target_type,target_id,action,reason,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + 199);
      if (queryError) setError(queryError.message);
      const rows = (data ?? []) as AuditRow[]; setAudit((current) => [...current, ...rows]); setOffsets((current) => ({ ...current, audit: start + rows.length })); setHasMore((current) => ({ ...current, audit: rows.length === 200 }));
    } else {
      const [postResult, commentResult] = await Promise.all([
        supabase.from('posts').select('id,author_id,body,moderation_status,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(offsets.posts, offsets.posts + 99),
        supabase.from('comments').select('id,post_id,author_id,body,moderation_status,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(offsets.comments, offsets.comments + 149)
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
          const { data, error: queryError } = await supabase.from('profiles').select('id,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at,created_at').eq('id', selectedReport.target_id).maybeSingle();
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
        const { data, error: queryError } = await supabase.from(table).select('id,post_id,author_id,body,image_paths,moderation_status,created_at').eq('id', selectedReport.target_id).maybeSingle();
        if (queryError) throw queryError;
        const contentItem = data ? { ...data, target_type: selectedReport.target_type } as ContentRow : undefined;
        let images: string[] = [];
        if (contentItem?.image_paths?.length) {
          const { data: signed, error: imageError } = await supabase.storage.from('community-media').createSignedUrls(contentItem.image_paths, 1800);
          if (imageError) throw imageError;
          images = (signed ?? []).map((item) => item.signedUrl ?? '').filter(Boolean);
        }
        if (active) setTarget({ content: contentItem, images });
      } catch (cause) {
        if (active) setTarget({ images: [], error: cause instanceof Error ? cause.message : '举报对象暂时无法读取。' });
      }
    })();
    return () => { active = false; };
  }, [selectedReport?.id, access]);

  const perform = async (action: string, targetType: string, targetId: string, options: { reportId?: string; suspensionHours?: number } = {}) => {
    if (!supabase) return;
    const dangerous = ['remove_post', 'remove_comment', 'ban_user'].includes(action);
    if (dangerous) {
      const warning = action === 'ban_user'
        ? '永久封禁该账号？账号将无法登录或发布内容，之后只能由管理员手动解封。'
        : '确认移除这条内容并删除其图片？该操作无法通过后台恢复图片。';
      if (!window.confirm(warning)) return;
    }
    const reason = window.prompt('填写处理原因：')?.trim();
    if (!reason) return;
    setError('');
    const { data, error: invokeError } = await supabase.functions.invoke('admin-moderate', {
      body: { action, targetType, targetId, reportId: options.reportId, reason, suspensionHours: options.suspensionHours }
    });
    const failure = await readFunctionFailure(invokeError, data);
    if (invokeError || failure?.error) { setError(failure?.error ?? invokeError?.message ?? '管理操作失败。'); if (failure?.partial) await load(); return; }
    await load();
  };

  if (!session) return <div className="admin-auth-shell"><AuthPage onBack={onExit} /></div>;
  if (access === 'loading') return <div className="admin-auth-shell"><div className="feed-loading"><Icon name="progress_activity" className="spin" />正在核验管理员权限…</div></div>;
  if (access === 'denied') return <div className="admin-auth-shell"><section className="admin-denied"><span className="empty-icon"><Icon name="lock" size={28} /></span><h1>此页面仅限管理员访问</h1><p>{error || '当前账号没有后台管理权限。管理员角色由项目所有者设置。'}</p><button className="soft-button" onClick={onExit}><Icon name="arrow_back" />返回日常有序</button></section></div>;

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <button className="admin-brand" onClick={onExit}><span className="brandmark"><Icon name="auto_awesome" size={19} /></span><span>日常有序 <small>管理工作台</small></span></button>
      <p className="admin-nav-label">社区治理</p>
      <nav aria-label="管理后台导航">{sections.map((item) => <button key={item.id} className={`admin-nav-item ${section === item.id ? 'active' : ''}`} onClick={() => { setSection(item.id); setSearch(''); }}><Icon name={item.icon} /><span>{item.label}</span>{item.id === 'reports' && openCount > 0 && <b className="admin-nav-count">{openCount}</b>}</button>)}</nav>
      <div className="admin-sidebar-bottom"><span className="admin-user-avatar">{(session.user.email ?? '管').slice(0, 1).toUpperCase()}</span><span><b>管理员</b><small>{session.user.email}</small></span><button className="icon-button small" aria-label="退出后台" onClick={onExit}><Icon name="logout" /></button></div>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar"><div><p className="eyebrow">COMMUNITY SAFETY</p><h1>{sections.find((item) => item.id === section)?.label}</h1></div><button className="soft-button" onClick={() => void load()} disabled={loading}><Icon name="refresh" />{loading ? '刷新中…' : '刷新数据'}</button></header>
      <section className="admin-metrics" aria-label="社区管理概况"><article><span className="metric-icon coral"><Icon name="flag" /></span><div><small>待处理举报</small><b>{openCount}</b></div></article><article><span className="metric-icon blue"><Icon name="visibility_off" /></span><div><small>已隐藏内容</small><b>{hiddenCount}</b></div></article><article><span className="metric-icon amber"><Icon name="person_alert" /></span><div><small>受限账号</small><b>{accountCount}</b></div></article><article><span className="metric-icon green"><Icon name="verified_user" /></span><div><small>今日处理举报</small><b>{metrics.handledToday}</b></div></article></section>
      {error && <div className="community-alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭提示"><Icon name="close" /></button></div>}
      {loading && reports.length === 0 && profiles.length === 0 && content.length === 0 ? <div className="feed-loading"><Icon name="progress_activity" className="spin" />正在加载管理数据…</div> : section === 'reports' ? <ReportDesk reports={reports} selected={selectedReport} target={target} profiles={profiles} suspensionHours={suspensionHours} setSuspensionHours={setSuspensionHours} onSelect={(id) => setSelectedReportId(id)} onPerform={perform} hasMore={hasMore.reports} loading={loading} onLoadMore={() => void loadMore()} /> : section === 'content' ? <ContentDesk content={content} search={search} setSearch={setSearch} onPerform={perform} hasMore={hasMore.posts || hasMore.comments} loading={loading} onLoadMore={() => void loadMore()} /> : section === 'accounts' ? <AccountDesk profiles={profiles} search={search} setSearch={setSearch} suspensionHours={suspensionHours} setSuspensionHours={setSuspensionHours} onPerform={perform} hasMore={hasMore.profiles} loading={loading} onLoadMore={() => void loadMore()} /> : <AuditDesk rows={audit} search={search} setSearch={setSearch} hasMore={hasMore.audit} loading={loading} onLoadMore={() => void loadMore()} />}
      <footer className="admin-footer">管理操作会记录管理员、处理对象、动作、原因与时间。新增账号在邮箱验证后可直接使用。</footer>
    </main>
  </div>;
}

function ReportDesk({ reports, selected, target, profiles, suspensionHours, setSuspensionHours, onSelect, onPerform, hasMore, loading, onLoadMore }: {
  reports: Report[]; selected: Report | null; target: ReportTarget | null; profiles: AdminProfile[]; suspensionHours: Record<string, number>; setSuspensionHours: (value: Record<string, number>) => void; onSelect: (id: string) => void; hasMore: boolean; loading: boolean; onLoadMore: () => void;
  onPerform: (action: string, targetType: string, targetId: string, options?: { reportId?: string; suspensionHours?: number }) => Promise<void>;
}) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const visible = reports.filter((item) => filter === 'all' || item.status === 'open');
  const author = target?.content ? profiles.find((item) => item.id === target.content?.author_id) : undefined;
  const hours = selected ? suspensionHours[selected.target_id] ?? 24 : 24;
  return <section className="report-desk">
    <div className="report-queue"><div className="report-queue-head"><div><h2>举报收件箱</h2><p>先处理仍处于待处理状态的举报</p></div><select aria-label="举报筛选" value={filter} onChange={(event) => setFilter(event.target.value as 'open' | 'all')}><option value="open">待处理</option><option value="all">全部举报</option></select></div>
      <div className="report-queue-list">{visible.length === 0 ? <div className="admin-empty"><Icon name="task_alt" /><b>没有待处理举报</b><small>新的举报会显示在这里。</small></div> : visible.map((report) => <button key={report.id} className={`report-queue-item ${selected?.id === report.id ? 'selected' : ''}`} onClick={() => onSelect(report.id)}><span className={`report-type-icon ${report.target_type}`}><Icon name={report.target_type === 'user' ? 'person' : report.target_type === 'post' ? 'article' : 'chat_bubble'} /></span><span className="report-queue-copy"><b>{targetLabel(report.target_type)} · {report.reason}</b><small>{profiles.find((item) => item.id === report.reporter_id)?.display_name ?? `举报人 ${shortId(report.reporter_id)}`}</small><small>{formatDate(report.created_at)}</small></span><span className={`status-pill ${report.status}`}>{report.status === 'open' ? '待处理' : report.status === 'handled' ? '已处理' : '已驳回'}</span></button>)}{hasMore && <button className="load-more-button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : '加载更早举报'}</button>}</div>
    </div>
    <div className="report-detail">{!selected ? <div className="admin-empty"><Icon name="touch_app" /><b>选择一条举报</b><small>在左侧队列中选择举报，查看举报对象和处理选项。</small></div> : <>
      <header className="report-detail-head"><div><p className="eyebrow">REPORT DETAIL</p><h2>{targetLabel(selected.target_type)}举报</h2></div><span className={`status-pill ${selected.status}`}>{selected.status === 'open' ? '待处理' : selected.status === 'handled' ? '已处理' : '已驳回'}</span></header>
      <div className="report-meta-grid"><div><small>举报原因</small><b>{selected.reason}</b></div><div><small>提交时间</small><b>{formatDate(selected.created_at)}</b></div><div><small>举报人</small><code>{selected.reporter_id}</code></div><div><small>对象 ID</small><code>{selected.target_id}</code></div></div>
      {selected.detail && <p className="report-extra">补充说明：{selected.detail}</p>}
      <section className="reported-object"><h3>被举报对象</h3>{!target ? <div className="target-loading"><Icon name="progress_activity" className="spin" />正在读取对象…</div> : target.error ? <p className="form-error">{target.error}</p> : target.profile ? <div className="target-profile"><Avatar profile={target.profile} url={target.images[0]} /><div><b>{target.profile.display_name}</b><small>@{target.profile.username ?? '未设置用户名'} · {statusLabel(effectiveStatus(target.profile), target.profile.suspension_expires_at)}</small><p>{target.profile.bio || '这个用户还没有填写简介。'}</p></div></div> : target.content ? <><div className="target-author"><Avatar profile={author} /><span><b>{author?.display_name ?? `用户 ${shortId(target.content.author_id)}`}</b><small>{formatDate(target.content.created_at)} · {target.content.target_type === 'post' ? '动态' : '评论'}</small></span></div><p className="target-body">{target.content.body || '（纯图片内容）'}</p>{target.images.length > 0 && <div className="target-images">{target.images.map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}><img src={url} alt="举报对象图片" /></a>)}</div>}<small className="target-record-id">内容 ID：{target.content.id}{target.content.post_id ? ` · 所属动态：${target.content.post_id}` : ''}</small></> : <p className="muted">目标内容已被删除或找不到。</p>}</section>
      {selected.status === 'open' && <div className="report-actions"><h3>处理举报</h3>{selected.target_type === 'user' ? <div className="admin-action-row"><select value={hours} onChange={(event) => setSuspensionHours({ ...suspensionHours, [selected.target_id]: Number(event.target.value) })} aria-label="暂停时长"><option value={24}>暂停 24 小时</option><option value={168}>暂停 7 天</option><option value={720}>暂停 30 天</option></select><button className="soft-button" onClick={() => void onPerform('suspend_user', 'user', selected.target_id, { reportId: selected.id, suspensionHours: hours })}>暂停账号</button><button className="danger-button" onClick={() => void onPerform('ban_user', 'user', selected.target_id, { reportId: selected.id })}>永久封禁</button></div> : <div className="admin-action-row"><button className="soft-button" onClick={() => void onPerform(`hide_${selected.target_type}`, selected.target_type, selected.target_id, { reportId: selected.id })}>隐藏内容</button><button className="danger-button" onClick={() => void onPerform(`remove_${selected.target_type}`, selected.target_type, selected.target_id, { reportId: selected.id })}>移除并删除图片</button></div>}<div className="admin-action-row secondary-actions"><button className="primary-button compact" onClick={() => void onPerform('handle_report', selected.target_type, selected.target_id, { reportId: selected.id })}>标记已处理</button><button className="soft-button" onClick={() => void onPerform('dismiss_report', selected.target_type, selected.target_id, { reportId: selected.id })}>驳回举报</button></div></div>}
    </>}</div>
  </section>;
}

function ContentDesk({ content, search, setSearch, onPerform, hasMore, loading, onLoadMore }: { content: ContentRow[]; search: string; setSearch: (value: string) => void; onPerform: (action: string, targetType: string, targetId: string) => Promise<void>; hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const rows = content.filter((item) => `${item.body} ${item.author_id} ${item.id}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="admin-section-card"><AdminSearch value={search} onChange={setSearch} placeholder="搜索动态、评论文字、作者或内容 ID" /><div className="admin-data-list">{rows.map((item) => <article className="admin-data-row" key={`${item.target_type}-${item.id}`}><div className="content-target-preview"><span className="report-type-icon"><Icon name={item.target_type === 'post' ? 'article' : 'chat_bubble'} /></span><div><b>{item.target_type === 'post' ? '动态' : '评论'} · {contentStatus(item.moderation_status)}</b><p>{item.body || '（图片内容）'}</p><small>作者 {item.author_id} · {formatDate(item.created_at)} · ID {item.id}</small></div></div><div className="admin-actions">{item.moderation_status !== 'removed' && <button className="soft-button" onClick={() => void onPerform(item.moderation_status === 'visible' ? `hide_${item.target_type}` : `restore_${item.target_type}`, item.target_type, item.id)}>{item.moderation_status === 'visible' ? '隐藏' : '恢复'}</button>}<button className="danger-button" onClick={() => void onPerform(`remove_${item.target_type}`, item.target_type, item.id)}>移除</button></div></article>)}{rows.length === 0 && <div className="admin-empty"><Icon name="search_off" /><b>没有匹配内容</b></div>}</div>{hasMore && <button className="load-more-button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : '加载更多内容'}</button>}</section>;
}

function AccountDesk({ profiles, search, setSearch, suspensionHours, setSuspensionHours, onPerform, hasMore, loading, onLoadMore }: { profiles: AdminProfile[]; search: string; setSearch: (value: string) => void; suspensionHours: Record<string, number>; setSuspensionHours: (value: Record<string, number>) => void; onPerform: (action: string, targetType: string, targetId: string, options?: { suspensionHours?: number }) => Promise<void>; hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const rows = profiles.filter((item) => `${item.display_name} ${item.username ?? ''} ${item.id}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="admin-section-card"><AdminSearch value={search} onChange={setSearch} placeholder="搜索昵称、用户名或账号 ID" /><div className="admin-data-list">{rows.map((person) => {
    const state = effectiveStatus(person); const hours = suspensionHours[person.id] ?? 24;
    return <article className="admin-data-row" key={person.id}><div className="account-target"><Avatar profile={person} /><div><b>{person.display_name} {person.role === 'admin' ? '· 管理员' : ''}<span className={`status-pill ${state}`}>{statusLabel(state, person.suspension_expires_at)}</span></b><small>{person.username ? `@${person.username} · ` : ''}{person.id} · 注册 {formatDate(person.created_at)}</small><p>{person.bio || '暂无个人简介'}</p></div></div>{person.role !== 'admin' && <div className="admin-actions account-actions">{state !== 'banned' && <><select value={hours} onChange={(event) => setSuspensionHours({ ...suspensionHours, [person.id]: Number(event.target.value) })} aria-label={`${person.display_name}的暂停时长`}><option value={24}>24 小时</option><option value={168}>7 天</option><option value={720}>30 天</option></select><button className="soft-button" onClick={() => void onPerform('suspend_user', 'user', person.id, { suspensionHours: hours })}>{state === 'suspended' ? '重新暂停' : '暂停'}</button></>}{state === 'banned' ? <button className="primary-button compact" onClick={() => void onPerform('unban_user', 'user', person.id)}>手动解封</button> : <button className="danger-button" onClick={() => void onPerform('ban_user', 'user', person.id)}>永久封禁</button>}{state === 'suspended' && <button className="primary-button compact" onClick={() => void onPerform('restore_user', 'user', person.id)}>恢复账号</button>}</div>}</article>;
  })}{rows.length === 0 && <div className="admin-empty"><Icon name="search_off" /><b>没有匹配账号</b></div>}</div>{hasMore && <button className="load-more-button" disabled={loading} onClick={onLoadMore}>{loading ? '加载中…' : '加载更多账号'}</button>}</section>;
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
  const names: Record<string, string> = { hide_post: '隐藏动态', remove_post: '移除动态', restore_post: '恢复动态', hide_comment: '隐藏评论', remove_comment: '移除评论', restore_comment: '恢复评论', suspend_user: '暂停账号', restore_user: '恢复账号', ban_user: '永久封禁', unban_user: '手动解封', handle_report: '标记举报已处理', dismiss_report: '驳回举报' };
  return names[action] ?? action;
}
function shortId(value: string) { return value.slice(0, 8); }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
async function readFunctionFailure(error: unknown, data: unknown): Promise<{ error?: string; partial?: boolean } | null> {
  if (data && typeof data === 'object') return data as { error?: string; partial?: boolean };
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) return await context.clone().json().catch(() => null) as { error?: string; partial?: boolean } | null;
  }
  return null;
}
