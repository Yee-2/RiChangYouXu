import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { communityConfigured, supabase } from './supabase';
import { Icon } from './Icon';

export type Profile = { id: string; uid: string; username: string | null; display_name: string; avatar_path: string | null; avatar_url?: string; bio: string; role: 'user' | 'admin'; account_status: 'active' | 'suspended' | 'banned' | 'deleted'; suspension_expires_at?: string | null };
type Topic = { id: string; slug: string; title: string };
type Post = { id: string; author_id: string; body: string; image_paths: string[]; created_at: string; moderation_status: 'visible' | 'hidden' | 'removed'; profile?: Profile; topics?: Topic[]; liked?: boolean; followed?: boolean; likes?: number; comments?: CommentItem[]; images?: string[] };
type CommentItem = { id: string; post_id: string; author_id: string; body: string; image_paths: string[]; created_at: string; moderation_status: 'visible' | 'hidden' | 'removed'; profile?: Profile; images?: string[] };
type Report = { id: string; reporter_id: string; target_type: 'post' | 'comment' | 'user'; target_id: string; reason: string; detail: string; status: string; created_at: string };

export default function Community({ session, onOpenMy, initialProfileId, onExitUserProfile }: { session: Session | null; onOpenMy?: () => void; initialProfileId?: string | null; onExitUserProfile?: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(initialProfileId ?? null);
  const [returnToPersonalPage, setReturnToPersonalPage] = useState(Boolean(initialProfileId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showAuthPage, setShowAuthPage] = useState(false);
  const [, refreshStatusClock] = useState(0);

  const loadProfile = useCallback(async () => {
    if (!supabase || !session?.user) { setProfile(null); return; }
    const { data, error: profileError } = await supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at').eq('id', session.user.id).maybeSingle();
    if (profileError) { setError(profileError.message); return; }
    const value = data as Profile | null;
    if (value?.avatar_path) {
      const { data: signed } = await supabase.storage.from('community-media').createSignedUrl(value.avatar_path, 3600);
      value.avatar_url = signed?.signedUrl;
    }
    setProfile(value);
  }, [session?.user?.id]);

  const loadPosts = useCallback(async () => {
    if (!supabase) return;
    setLoading(true); setError('');
    try {
      let query = supabase.from('posts').select('id,author_id,body,image_paths,created_at,moderation_status').order('created_at', { ascending: false }).limit(40);
      if (selectedUserId) {
        query = query.eq('author_id', selectedUserId);
        query = selectedUserId === session?.user.id
          ? query.in('moderation_status', ['visible', 'hidden'])
          : query.eq('moderation_status', 'visible');
      }
      else if (session?.user.id) query = query.or(`moderation_status.eq.visible,and(author_id.eq.${session.user.id},moderation_status.eq.hidden)`);
      else query = query.eq('moderation_status', 'visible');
      if (selectedTopic) {
        const { data: links, error: linkError } = await supabase.from('post_topics').select('post_id').eq('topic_id', selectedTopic.id);
        if (linkError) throw linkError;
        const postIds = (links ?? []).map((link) => link.post_id as string);
        if (postIds.length === 0) { setPosts([]); setLoading(false); return; }
        query = query.in('id', postIds);
      }
      const { data: rawPosts, error: postError } = await query;
      if (postError) throw postError;
      const list = (rawPosts ?? []) as Post[];
      const ids = list.map((post) => post.id); const authors = [...new Set(list.map((post) => post.author_id))];
      const [profileResult, topicResult, likeResult, commentResult, followResult] = await Promise.all([
        authors.length ? supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at').in('id', authors) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('post_topics').select('post_id,topics(id,slug,title)').in('post_id', ids) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('post_likes').select('post_id,user_id').in('post_id', ids) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('comments').select('id,post_id,author_id,body,image_paths,created_at,moderation_status').or(session?.user.id ? `moderation_status.eq.visible,and(author_id.eq.${session.user.id},moderation_status.eq.hidden)` : 'moderation_status.eq.visible').in('post_id', ids).order('created_at', { ascending: true }) : Promise.resolve({ data: [], error: null }),
        session?.user && authors.length ? supabase.from('follows').select('followee_id').eq('follower_id', session.user.id).in('followee_id', authors) : Promise.resolve({ data: [], error: null })
      ]);
      if (profileResult.error) throw profileResult.error; if (topicResult.error) throw topicResult.error; if (likeResult.error) throw likeResult.error; if (commentResult.error) throw commentResult.error; if (followResult.error) throw followResult.error;
      const people = new Map(((profileResult.data ?? []) as Profile[]).map((item) => [item.id, item]));
      const topicLinks = new Map<string, Topic[]>();
      for (const row of (topicResult.data ?? []) as Array<{ post_id: string; topics: Topic | Topic[] | null }>) {
        const topic = Array.isArray(row.topics) ? row.topics[0] : row.topics;
        if (topic) topicLinks.set(row.post_id, [...(topicLinks.get(row.post_id) ?? []), topic]);
      }
      const likes = likeResult.data ?? []; const comments = (commentResult.data ?? []) as CommentItem[]; const followed = new Set((followResult.data ?? []).map((item) => item.followee_id as string));
      const commentAuthors = [...new Set(comments.map((comment) => comment.author_id))];
      const commentProfiles = commentAuthors.length ? await supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at').in('id', commentAuthors) : { data: [], error: null };
      if (commentProfiles.error) throw commentProfiles.error;
      for (const item of (commentProfiles.data ?? []) as Profile[]) people.set(item.id, item);
      const signedPaths = [...new Set([...list.flatMap((post) => post.image_paths), ...comments.flatMap((comment) => comment.image_paths), ...[...people.values()].map((person) => person.avatar_path).filter((path): path is string => Boolean(path))])];
      const signed = signedPaths.length ? await supabase.storage.from('community-media').createSignedUrls(signedPaths, 3600) : { data: [], error: null };
      if (signed.error) throw signed.error;
      const urls = new Map((signed.data ?? []).map((file) => [file.path ?? '', file.signedUrl ?? '']));
      for (const person of people.values()) if (person.avatar_path) person.avatar_url = urls.get(person.avatar_path);
      const decoratedComments = comments.map((comment) => ({ ...comment, profile: people.get(comment.author_id), images: comment.image_paths.map((path) => urls.get(path) ?? '').filter(Boolean) }));
      setPosts(list.map((post) => ({
        ...post, profile: people.get(post.author_id), topics: topicLinks.get(post.id) ?? [],
        liked: Boolean(session?.user && likes.some((like) => like.post_id === post.id && like.user_id === session.user.id)),
        followed: followed.has(post.author_id),
        likes: likes.filter((like) => like.post_id === post.id).length,
        comments: decoratedComments.filter((comment) => comment.post_id === post.id),
        images: post.image_paths.map((path) => urls.get(path) ?? '').filter(Boolean)
      })));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '动态加载失败，请稍后重试。'); }
    finally { setLoading(false); }
  }, [selectedTopic?.id, selectedUserId, session?.user?.id]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);
  useEffect(() => { void loadPosts(); }, [loadPosts]);
  useEffect(() => {
    if (!initialProfileId) return;
    setSelectedUserId(initialProfileId);
    setReturnToPersonalPage(true);
  }, [initialProfileId]);
  useEffect(() => {
    const timer = window.setInterval(() => refreshStatusClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!communityConfigured || !supabase) return <section className="community-cover"><div className="community-spark"><Icon name="forum" /></div><p className="eyebrow">COMMUNITY</p><h1>把生活里的小事<br /><span>分享给同频的人</span></h1><p className="muted">登录后查看社区动态、参与话题，也可以发布图文和评论。</p><div className="community-preview"><span># 宠物日记</span><span># 今天的小确幸</span><span># 生活灵感</span></div><p className="muted">社区服务暂未配置，请稍后再来。</p></section>;

  if (!session && showAuthPage) return <AuthPage onBack={() => setShowAuthPage(false)} />;
  if (!session) return <CommunityWelcome onLogin={() => setShowAuthPage(true)} />;

  const openUserProfile = (userId: string) => { setSelectedUserId(userId); setSelectedTopic(null); setReturnToPersonalPage(false); };
  const closeUserProfile = () => {
    if (returnToPersonalPage && onExitUserProfile) onExitUserProfile();
    else setSelectedUserId(null);
  };
  if (selectedUserId) return <div className="community-page"><button className="soft-button profile-back" onClick={closeUserProfile}><Icon name="arrow_back" />{returnToPersonalPage ? '返回我的' : '返回社区'}</button><PublicProfileHeader userId={selectedUserId} session={session} ownId={session?.user.id} onError={setError} onOpenMy={onOpenMy} />{error && <div className="community-alert" role="alert">{error}</div>}<div className="feed-main profile-feed">{loading ? <div className="feed-loading"><Icon name="progress_activity" />正在加载动态…</div> : posts.length ? posts.map((post) => <PostCard key={post.id} post={post} session={session} profile={profile} onRefresh={loadPosts} onError={setError} onTopic={setSelectedTopic} onOpenProfile={openUserProfile} />) : <div className="feed-empty"><Icon name="article" /><h3>还没有公开动态</h3><p>这个主页发布的动态会显示在这里。</p></div>}</div></div>;
  return <div className="community-page">
    <div className="community-title"><div><p className="eyebrow">SHARE A LITTLE JOY</p><h1>生活社区</h1><p>记录生活的小事，也看看别人的可爱日常。</p></div>{profile?.role === 'admin' && profile.account_status === 'active' && <a className="soft-button admin-entry" href={import.meta.env.DEV ? `${window.location.origin}/#/admin` : 'https://admin.yeecc.cn/'}><Icon name="admin_panel_settings" />管理后台</a>}</div>
    {session && profile && effectiveProfileStatus(profile) !== 'active' && <div className="community-alert">账号当前状态：{profile.account_status === 'suspended' ? `暂停中${profile.suspension_expires_at ? `，预计 ${new Date(profile.suspension_expires_at).toLocaleString('zh-CN')} 恢复` : ''}` : profile.account_status === 'banned' ? '永久封禁，社区发布和互动已关闭。' : '已注销'}。{profile.account_status !== 'deleted' && '如需了解处理原因，请联系管理员。'}</div>}
    <div className="community-feed-layout"><aside className="topic-rail"><h3>热门话题</h3><p className={!selectedTopic ? 'topic-link selected' : 'topic-link'} onClick={() => setSelectedTopic(null)}>全部动态</p>{['宠物日记','生活碎片','今日好心情','养宠新手','居家日常'].map((title) => <TopicShortcut key={title} title={title} active={selectedTopic?.title === title} onClick={(topic) => setSelectedTopic(topic)} />)}<div className="small-note">动态支持图片、表情、话题和评论。</div></aside><div className="feed-main">
      {session && profile && effectiveProfileStatus(profile) === 'active' && <Composer userId={session.user.id} onPosted={loadPosts} onError={setError} />}
      {selectedTopic && <div className="topic-heading"><div><small>正在浏览话题</small><h2>#{selectedTopic.title}</h2></div><button className="icon-button" onClick={() => setSelectedTopic(null)} aria-label="清除话题筛选"><Icon name="close" /></button></div>}
      {error && <div className="community-alert" role="alert">{error}<button onClick={() => void loadPosts()}>重试</button></div>}
      {loading ? <div className="feed-loading"><Icon name="progress_activity" />正在加载新鲜动态…</div> : posts.length ? posts.map((post) => <PostCard key={post.id} post={post} session={session} profile={profile} onRefresh={loadPosts} onError={setError} onTopic={setSelectedTopic} onOpenProfile={openUserProfile} />) : <div className="feed-empty"><Icon name="auto_awesome" /><h3>{selectedTopic ? '这个话题还没有动态' : '这里还很安静'}</h3><p>来分享一件今天的小事吧。</p></div>}
    </div></div>
  </div>;
}

function AuthCard() {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login'); const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [pendingEmail, setPendingEmail] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!supabase) return; setBusy(true); setError(''); setMessage('');
    const values = new FormData(event.currentTarget); const email = String(values.get('email') ?? '').trim(); const password = String(values.get('password') ?? '');
    try {
      if (mode === 'signup') {
        const { data, error: authError } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (authError) throw authError;
        setPendingEmail(email);
        setMessage(data.session ? '账号已创建并登录。' : '注册成功，请检查邮箱并点击验证链接，再回来登录。');
      } else if (mode === 'login') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password }); if (authError) throw authError;
      } else {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/` }); if (authError) throw authError;
        setMessage('如果该邮箱已注册，重置密码邮件会很快送达。');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  };
  const resend = async () => { if (!supabase || !pendingEmail) return; const { error } = await supabase.auth.resend({ type: 'signup', email: pendingEmail }); setError(error?.message ?? ''); if (!error) setMessage('验证邮件已重新发送。'); };
  return <section className="auth-card"><div><p className="eyebrow">日常有序账号</p><h2>{mode === 'login' ? '登录后继续' : mode === 'signup' ? '创建邮箱账号' : '找回密码'}</h2><p>使用邮箱和密码登录或注册，不需要手机号。</p></div><form className="auth-form" onSubmit={submit}><input name="email" type="email" autoComplete="email" placeholder="邮箱地址" required />{mode !== 'reset' && <input name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} placeholder="密码（至少 8 位）" required />}{error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}{pendingEmail && mode === 'signup' && <button type="button" className="text-button" onClick={() => void resend()}>重新发送验证邮件</button>}<button className="primary-button" disabled={busy}>{busy ? '请稍候…' : mode === 'signup' ? '注册并验证邮箱' : mode === 'reset' ? '发送重置邮件' : '邮箱登录'}</button><div className="auth-switch">{mode !== 'login' && <button type="button" onClick={() => { setMode('login'); setError(''); setMessage(''); }}>返回登录</button>}{mode === 'login' && <><button type="button" onClick={() => setMode('signup')}>创建账号</button><button type="button" onClick={() => setMode('reset')}>忘记密码</button></>}</div></form></section>;
}

export function AuthPage({ onBack }: { onBack: () => void }) {
  return <div className="community-auth-page"><button className="soft-button auth-back" type="button" onClick={onBack}><Icon name="arrow_back" />返回</button><AuthCard /></div>;
}

function PublicProfileHeader({ userId, session, ownId, onError, onOpenMy }: { userId: string; session: Session | null; ownId?: string; onError: (message: string) => void; onOpenMy?: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const ownProfile = ownId === userId;
  useEffect(() => {
    let active = true;
    if (!supabase) return;
    void (async () => {
      setLoading(true);
      const [profileResult, followerResult, followingResult, relationship] = await Promise.all([
        supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at').eq('id', userId).maybeSingle(),
        supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('followee_id', userId),
        supabase.from('follows').select('followee_id', { count: 'exact', head: true }).eq('follower_id', userId),
        session ? supabase.from('follows').select('follower_id').eq('follower_id', session.user.id).eq('followee_id', userId).maybeSingle() : Promise.resolve({ data: null, error: null })
      ]);
      const queryError = profileResult.error ?? followerResult.error ?? followingResult.error ?? relationship.error;
      if (queryError) onError(queryError.message);
      const value = profileResult.data as Profile | null;
      if (value?.avatar_path) {
        const { data: signed } = await supabase.storage.from('community-media').createSignedUrl(value.avatar_path, 3600);
        value.avatar_url = signed?.signedUrl;
      }
      if (!active) return;
      setProfile(value); setFollowers(followerResult.count ?? 0); setFollowing(followingResult.count ?? 0); setIsFollowing(Boolean(relationship.data)); setLoading(false);
    })();
    return () => { active = false; };
  }, [userId, session?.user.id]);
  const toggleFollow = async () => {
    if (!supabase || !session) { onError('登录后可以关注用户。'); return; }
    const result = isFollowing
      ? await supabase.from('follows').delete().eq('follower_id', session.user.id).eq('followee_id', userId)
      : await supabase.from('follows').insert({ follower_id: session.user.id, followee_id: userId });
    if (result.error) { onError(result.error.message); return; }
    setIsFollowing(!isFollowing); setFollowers((count) => Math.max(0, count + (isFollowing ? -1 : 1)));
  };
  const report = async () => {
    if (!supabase || !session) { onError('登录后可以举报账号。'); return; }
    const reason = window.prompt('请简要说明举报该账号的原因：')?.trim();
    if (!reason) return;
    const { error } = await supabase.from('reports').insert({ reporter_id: session.user.id, target_type: 'user', target_id: userId, reason });
    onError(error ? error.message : '账号举报已提交，管理员会尽快查看。');
  };
  if (loading) return <div className="feed-loading"><Icon name="progress_activity" className="spin" />正在加载用户主页…</div>;
  if (!profile) return <div className="feed-empty"><Icon name="person_off" /><h3>找不到这个用户</h3><p>账号可能已注销或资料暂不可用。</p></div>;
  return <section className="public-profile-card"><div className="public-profile-avatar">{profile.avatar_url ? <img src={profile.avatar_url} alt={`${profile.display_name}的头像`} /> : <Icon name="person" size={38} />}</div><div className="public-profile-info"><p className="eyebrow">COMMUNITY MEMBER</p><h1>{profile.display_name}</h1><small>UID：{profile.uid} · @{profile.username ?? '未设置用户名'}</small><p>{profile.bio || '这个用户还没有填写简介。'}</p><div className="public-profile-stats"><span><b>{followers}</b> 关注者</span><span><b>{following}</b> 正在关注</span></div></div><div className="public-profile-actions">{ownProfile ? <button className="soft-button" onClick={onOpenMy}><Icon name="edit" />我的账号设置</button> : <>{session && <button className="primary-button compact" onClick={() => void toggleFollow()}><Icon name={isFollowing ? 'person_check' : 'person_add'} />{isFollowing ? '已关注' : '关注'}</button>}{session && <button className="soft-button" onClick={() => void report()}><Icon name="flag" />举报账号</button>}</>}</div></section>;
}

export function FollowingPage({ session, onBack, onOpenProfile, onMessage }: { session: Session; onBack: () => void; onOpenProfile: (userId: string) => void; onMessage: (message: string) => void }) {
  const [people, setPeople] = useState<Profile[]>([]);
  const [followingCount, setFollowingCount] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const touchStartX = useRef<number | null>(null);
  const suppressClickUntil = useRef(0);

  const load = useCallback(async (append = false, offset = 0) => {
    if (!supabase) return;
    append ? setLoadingMore(true) : setLoading(true); setError('');
    const { data: relations, error: followError, count } = await supabase.from('follows').select('followee_id,created_at', { count: 'exact' }).eq('follower_id', session.user.id).order('created_at', { ascending: false }).order('followee_id', { ascending: false }).range(offset, offset + 99);
    if (followError) { setError(followError.message); setLoading(false); setLoadingMore(false); return; }
    const ids = (relations ?? []).map((item) => item.followee_id as string);
    setFollowingCount(count ?? 0); setHasMore(ids.length === 100); setNextOffset(offset + ids.length);
    if (!ids.length) { if (!append) setPeople([]); setLoading(false); setLoadingMore(false); return; }
    const { data: rows, error: profileError } = await supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at').in('id', ids).neq('account_status', 'deleted');
    if (profileError) { setError(profileError.message); setLoading(false); setLoadingMore(false); return; }
    const profiles = (rows ?? []) as Profile[];
    const paths = [...new Set(profiles.map((item) => item.avatar_path).filter((path): path is string => Boolean(path)))];
    const signedByPath = new Map<string, string>();
    if (paths.length) {
      const { data: signed, error: imageError } = await supabase.storage.from('community-media').createSignedUrls(paths, 3600);
      if (imageError) { setError(imageError.message); setLoading(false); setLoadingMore(false); return; }
      paths.forEach((path, index) => { const url = signed?.[index]?.signedUrl; if (url) signedByPath.set(path, url); });
    }
    const byId = new Map(profiles.map((item) => [item.id, item]));
    const mapped = ids.map((id) => byId.get(id)).filter((item): item is Profile => Boolean(item)).map((item) => ({ ...item, avatar_url: item.avatar_path ? signedByPath.get(item.avatar_path) : undefined }));
    setPeople((current) => append ? [...current, ...mapped] : mapped);
    setLoading(false); setLoadingMore(false);
  }, [session.user.id]);

  useEffect(() => { void load(); }, [load]);

  const unfollow = async (person: Profile) => {
    if (!supabase || busyId) return;
    setBusyId(person.id);
    const { error: deleteError } = await supabase.from('follows').delete().eq('follower_id', session.user.id).eq('followee_id', person.id);
    if (deleteError) { setError(deleteError.message); setBusyId(null); return; }
    setPeople((current) => current.filter((item) => item.id !== person.id)); setFollowingCount((count) => Math.max(0, count - 1)); setNextOffset((offset) => Math.max(0, offset - 1));
    setRevealedId(null); setBusyId(null); onMessage(`已取消关注 ${person.display_name}。`);
  };

  return <section className="profile-subpage following-page">
    <button className="soft-button profile-back" type="button" onClick={onBack}><Icon name="arrow_back" />返回我的</button>
    <div className="page-title-row"><div><p className="eyebrow">PEOPLE YOU FOLLOW</p><h1>我的关注</h1></div><span className="profile-count-chip">{followingCount} 位</span></div>
    {error && <div className="community-alert" role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></div>}
    {loading ? <div className="feed-loading"><Icon name="progress_activity" className="spin" />正在读取关注列表…</div> : people.length ? <><div className="following-list">{people.map((person) => <div key={person.id} className={`following-row ${revealedId === person.id ? 'revealed' : ''}`} onTouchStart={(event) => { touchStartX.current = event.changedTouches[0]?.clientX ?? null; }} onTouchEnd={(event) => { const start = touchStartX.current; const end = event.changedTouches[0]?.clientX; touchStartX.current = null; if (start === null || end === undefined) return; const delta = end - start; if (delta > 42) { setRevealedId(person.id); suppressClickUntil.current = Date.now() + 450; } else if (delta < -42) setRevealedId(null); }}>
      <button type="button" className="following-person" onClick={() => { if (Date.now() < suppressClickUntil.current) return; onOpenProfile(person.id); }}><span className="following-avatar">{person.avatar_url ? <img src={person.avatar_url} alt="" /> : <Icon name="person" />}</span><span className="following-copy"><b>{person.display_name}</b><small>UID：{person.uid}</small></span><Icon name="chevron_right" className="following-chevron" /></button>
      <button type="button" className="following-more" aria-label={`显示 ${person.display_name} 的关注操作`} aria-expanded={revealedId === person.id} onClick={() => setRevealedId((current) => current === person.id ? null : person.id)}><Icon name="more_horiz" /></button>
      {revealedId === person.id && <button type="button" className="following-unfollow" disabled={busyId === person.id} onClick={() => void unfollow(person)}>{busyId === person.id ? '处理中…' : '取消关注'}</button>}
    </div>)}</div>{hasMore && <button className="load-more-button" disabled={loadingMore} onClick={() => void load(true, nextOffset)}>{loadingMore ? '加载中…' : '加载更多关注'}</button>}</> : <div className="feed-empty"><Icon name="person_add" /><h3>还没有关注的人</h3><p>去社区看看，遇见喜欢的生活分享。</p></div>}
  </section>;
}

type OwnedPost = { id: string; body: string; image_paths: string[]; created_at: string; moderation_status: 'visible' | 'hidden' };
type OwnedPostView = OwnedPost & { images: string[] };

export function MyPostsPage({ session, onBack, onMessage }: { session: Session; onBack: () => void; onMessage: (message: string) => void }) {
  const [posts, setPosts] = useState<OwnedPostView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<OwnedPostView | null>(null);
  const [editBody, setEditBody] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (append = false) => {
    if (!supabase) return;
    const offset = append ? posts.length : 0;
    append ? setLoadingMore(true) : setLoading(true);
    setError('');
    const { data, error: queryError } = await supabase.from('posts').select('id,body,image_paths,created_at,moderation_status').eq('author_id', session.user.id).in('moderation_status', ['visible', 'hidden']).order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 39);
    if (queryError) { setError(queryError.message); setLoading(false); setLoadingMore(false); return; }
    const rows = (data ?? []) as OwnedPost[];
    const paths = [...new Set(rows.flatMap((item) => item.image_paths))];
    const signedByPath = new Map<string, string>();
    if (paths.length) {
      const { data: signed, error: imageError } = await supabase.storage.from('community-media').createSignedUrls(paths, 3600);
      if (imageError) { setError(imageError.message); setLoading(false); setLoadingMore(false); return; }
      paths.forEach((path, index) => { const url = signed?.[index]?.signedUrl; if (url) signedByPath.set(path, url); });
    }
    const mapped = rows.map((item) => ({ ...item, images: item.image_paths.map((path) => signedByPath.get(path) ?? '').filter(Boolean) }));
    setPosts((current) => append ? [...current, ...mapped] : mapped);
    setHasMore(rows.length === 40); setLoading(false); setLoadingMore(false);
  }, [session.user.id, posts.length]);

  useEffect(() => { void load(); }, [session.user.id]);

  const savePost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !editing || saving) return;
    setSaving(true); setError('');
    const { error: updateError } = await supabase.rpc('update_own_post', { p_post_id: editing.id, p_body: editBody });
    if (updateError) { setError(updateError.message); setSaving(false); return; }
    setEditing(null); setSaving(false); onMessage('动态已更新，图片已保留。'); await load();
  };

  const deletePost = async (post: OwnedPostView) => {
    if (!supabase || !window.confirm('删除这条动态及其评论？相关图片也会一起删除。')) return;
    const { data, error: invokeError } = await supabase.functions.invoke('delete-content', { body: { targetType: 'post', targetId: post.id } });
    const failure = await readFunctionFailure(invokeError, data);
    if (invokeError || failure?.error) { setError(failure?.error ?? invokeError?.message ?? '动态删除失败。'); if (failure?.partial) await load(); return; }
    onMessage('动态已删除。'); await load();
  };

  return <section className="profile-subpage my-posts-page">
    <button className="soft-button profile-back" type="button" onClick={onBack}><Icon name="arrow_back" />返回我的</button>
    <div className="page-title-row"><div><p className="eyebrow">YOUR COMMUNITY POSTS</p><h1>我的动态</h1><p className="muted">查看、编辑或删除你发布过的动态。</p></div></div>
    {error && <div className="community-alert" role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></div>}
    {loading ? <div className="feed-loading"><Icon name="progress_activity" className="spin" />正在读取动态…</div> : posts.length ? <div className="my-post-list-cards">{posts.map((post) => <article className="my-post-card" key={post.id}>
      <div className="my-post-meta"><span>{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(post.created_at))}</span>{post.moderation_status === 'hidden' && <span className="status-pill suspended">审核处理中</span>}</div>
      {post.body && <p className="post-body">{post.body}</p>}
      {post.images.length > 0 && <div className={`post-images count-${Math.min(post.images.length, 4)}`}>{post.images.map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}><img src={url} alt="动态图片" loading="lazy" /></a>)}</div>}
      {post.moderation_status === 'hidden' && <small className="my-post-hidden-note">该动态正处于审核或清理状态，暂不可编辑。</small>}
      <div className="my-post-actions"><button type="button" className="soft-button" disabled={post.moderation_status !== 'visible'} onClick={() => { setEditing(post); setEditBody(post.body); }}><Icon name="edit" />编辑</button><button type="button" className="danger-button" onClick={() => void deletePost(post)}><Icon name="delete" />删除</button></div>
    </article>)}</div> : <div className="feed-empty"><Icon name="article" /><h3>还没有发布过动态</h3><p>你在社区发布的内容会集中显示在这里。</p></div>}
    {!loading && hasMore && <button className="load-more-button" disabled={loadingMore} onClick={() => void load(true)}>{loadingMore ? '加载中…' : '加载更多动态'}</button>}
    {editing && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}><section className="modal post-edit-modal" role="dialog" aria-modal="true" aria-label="编辑动态"><div className="modal-head"><h2>编辑动态</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => setEditing(null)}><Icon name="close" /></button></div><form className="form-stack" onSubmit={(event) => void savePost(event)}><label className="field"><span>动态内容</span><textarea autoFocus rows={7} maxLength={5000} value={editBody} onChange={(event) => setEditBody(event.target.value)} placeholder="写下这条动态…" /></label><p className="muted">已发布的图片会保留；话题会按内容中的 #话题 自动同步。</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="my-post-actions"><button type="button" className="soft-button" onClick={() => setEditing(null)}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存修改'}</button></div></form></section></div>}
  </section>;
}

function MyReports({ session }: { session: Session }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (!supabase) return;
    void supabase.from('reports').select('id,reporter_id,target_type,target_id,reason,detail,status,created_at').eq('reporter_id', session.user.id).order('created_at', { ascending: false }).limit(100).then(({ data, error: queryError }) => {
      if (!active) return;
      setReports((data ?? []) as Report[]); setError(queryError?.message ?? ''); setLoading(false);
    });
    return () => { active = false; };
  }, [session.user.id]);
  return <section className="my-reports-card"><div className="section-heading"><div><p className="eyebrow">REPORT HISTORY</p><h2>我的举报</h2></div><Icon name="flag" /></div>{loading ? <p className="muted">正在读取举报记录…</p> : error ? <p className="form-error">{error}</p> : reports.length === 0 ? <p className="muted">你还没有提交过举报。</p> : <div className="my-report-list">{reports.map((report) => <article key={report.id}><div><b>{report.target_type === 'post' ? '动态' : report.target_type === 'comment' ? '评论' : '账号'} · {report.reason}</b><small>对象 ID：{report.target_id} · {new Date(report.created_at).toLocaleString('zh-CN')}</small></div><span className={`status-pill ${report.status}`}>{report.status === 'open' ? '处理中' : report.status === 'handled' ? '已处理' : '已驳回'}</span></article>)}</div>}</section>;
}

function CommunityWelcome({ onLogin }: { onLogin: () => void }) {
  return <section className="community-welcome"><div className="community-welcome-art"><span className="welcome-orbit orbit-one" /><span className="welcome-orbit orbit-two" /><span className="welcome-sticker sticker-heart">♡</span><span className="welcome-sticker sticker-sparkle">✦</span><div className="welcome-forum-icon"><Icon name="forum" size={34} /></div></div><p className="eyebrow">A LITTLE SPACE FOR EVERYDAY</p><h1>生活里的小事，<br /><span>值得被看见。</span></h1><p className="welcome-description">登录后查看社区动态、参与 #宠物日记 等话题，分享照片、表情和日常，也能认识喜欢同一种生活的人。</p><button className="primary-button welcome-login" onClick={onLogin}><Icon name="login" />登录后查看社区</button><div className="welcome-footnote"><Icon name="password" size={15} />邮箱账号登录，社区内容仅对登录用户开放</div></section>;
}

const communityEmojis = [
  '😀','😃','😄','😁','😆','😅','😂','🤣','🥹','😊','😇','🙂','🙃','😉','😍','🥰','😘','😋','😜','🤪','🤗','🤔','🫡','🤭','🫣','🥳','😎','😭','🥺','😴','😮‍💨','🤩',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🩷','💖','💗','💓','💕','💞','💘','💝','💟','❣️','💔','❤️‍🔥','❤️‍🩹','💋','💌',
  '👋','👏','🙌','🫶','👍','👎','🤝','🙏','💪','✌️','🤞','🫰','🤟','👌','👐','💅','🧸','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🦄','🐝','🦋','🐢','🐬','🐳','🐾',
  '🌸','🌷','🌹','🌻','🌼','🍀','🌿','🌱','🌈','☀️','🌙','⭐','✨','⚡','🔥','☕','🍵','🍰','🍓','🍑','🍊','🍋','🍉','🍇','🍒','🥑','🍜','🍣','🍕','🎂','🎉','🎁','🎈','🎵','📸','🏡','🧡'
];

function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  return <details className="emoji-picker"><summary><Icon name="mood" size={17} />表情</summary><div className="emoji-picker-popover" aria-label="表情选项">{communityEmojis.map((emoji, index) => <button type="button" key={`${emoji}-${index}`} aria-label={`插入${emoji}`} onClick={() => onSelect(emoji)}>{emoji}</button>)}</div></details>;
}

export function AccountSettings({ session, onMessage, onProfileChange }: { session: Session; onMessage: (message: string) => void; onProfileChange: (profile: Profile | null) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const loadProfile = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from('profiles').select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at').eq('id', session.user.id).maybeSingle();
    if (error) { onMessage(error.message); return; }
    const value = data as Profile | null;
    if (value?.avatar_path) {
      const { data: signed, error: avatarError } = await supabase.storage.from('community-media').createSignedUrl(value.avatar_path, 3600);
      if (avatarError) onMessage(avatarError.message);
      value.avatar_url = signed?.signedUrl;
    }
    setProfile(value);
    onProfileChange(value);
  }, [session.user.id, onMessage, onProfileChange]);
  useEffect(() => { void loadProfile(); }, [loadProfile]);
  useEffect(() => {
    const expiry = profile?.account_status === 'suspended' && profile.suspension_expires_at ? Date.parse(profile.suspension_expires_at) : NaN;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return;
    const timer = window.setTimeout(() => setProfile((current) => current ? { ...current } : current), expiry - Date.now() + 100);
    return () => window.clearTimeout(timer);
  }, [profile?.account_status, profile?.suspension_expires_at]);
  const accountStatus = profile ? effectiveProfileStatus(profile) : 'active';
  return <><section className="account-settings"><div className="account-settings-heading"><div><p className="eyebrow">COMMUNITY ACCOUNT</p><h2>个人资料</h2><p>更换头像、昵称或简介，并管理账号安全。</p></div><span className={`account-status-chip ${accountStatus}`}>{accountStatus === 'suspended' ? `暂停至 ${profile?.suspension_expires_at ? new Date(profile.suspension_expires_at).toLocaleString('zh-CN') : '管理员恢复'}` : accountStatus === 'banned' ? '永久封禁' : accountStatus === 'active' && profile?.account_status === 'suspended' ? '暂停期满，已恢复' : '账号正常'}</span></div><AccountBar session={session} profile={profile} onProfileChange={() => void loadProfile()} onMessage={onMessage} /></section><MyReports session={session} /></>;
}

function AccountBar({ session, profile, onProfileChange, onMessage }: { session: Session; profile: Profile | null; onProfileChange: () => void; onMessage: (message: string) => void }) {
  const [editing, setEditing] = useState(false); const [passwordReset, setPasswordReset] = useState(false); const [displayName, setDisplayName] = useState(profile?.display_name ?? ''); const [bio, setBio] = useState(profile?.bio ?? ''); const [avatarFile, setAvatarFile] = useState<File | null>(null); const [busy, setBusy] = useState(false); const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState('');
  const [avatarPreview, setAvatarPreview] = useState(profile?.avatar_url);
  useEffect(() => {
    if (!avatarFile) { setAvatarPreview(profile?.avatar_url); return; }
    const url = URL.createObjectURL(avatarFile); setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile, profile?.avatar_url]);
  useEffect(() => { setDisplayName(profile?.display_name ?? ''); setBio(profile?.bio ?? ''); }, [profile?.display_name, profile?.bio]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase || busy) return;
    const name = displayName.trim(); if (!name) { onMessage('昵称不能为空。'); return; }
    if (avatarFile && (avatarFile.size > 2 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(avatarFile.type))) { onMessage('头像需为 JPG、PNG 或 WebP，且不超过 2 MB。'); return; }
    setBusy(true); let uploadedPath: string | null = null;
    try {
      if (avatarFile) {
        const ext = avatarFile.type === 'image/jpeg' ? 'jpg' : avatarFile.type.split('/')[1];
        uploadedPath = `${session.user.id}/${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from('community-media').upload(uploadedPath, avatarFile, { contentType: avatarFile.type, upsert: false }); if (error) throw error;
      }
      const update: { display_name: string; bio: string; avatar_path?: string } = { display_name: name.slice(0, 40), bio: bio.trim().slice(0, 240) };
      if (uploadedPath) update.avatar_path = uploadedPath;
      const { error } = await supabase.from('profiles').update(update).eq('id', session.user.id);
      if (error) throw error;
      if (uploadedPath && profile?.avatar_path) await supabase.storage.from('community-media').remove([profile.avatar_path]);
      setAvatarFile(null); setEditing(false); onMessage('个人资料已更新'); onProfileChange();
    } catch (cause) {
      if (uploadedPath) await supabase.storage.from('community-media').remove([uploadedPath]);
      onMessage(cause instanceof Error ? cause.message : '资料保存失败，请重试。');
    } finally { setBusy(false); }
  };
  const logout = async () => { const { error } = await supabase!.auth.signOut(); onMessage(error?.message ?? '已退出登录'); };
  const deleteAccount = async () => { if (!supabase) return; const confirmation = window.prompt('删除账号会永久删除你的线上动态、评论、关注和图片；本机生活记录会保留。输入 DELETE 确认。'); if (confirmation !== 'DELETE') return; const { data, error } = await supabase.functions.invoke('delete-account', { body: { confirmation } }); if (error || data?.error) { onMessage(error?.message ?? data.error); return; } await supabase.auth.signOut(); onMessage('社区账号和线上内容已删除；本机生活记录仍保留。'); };
  const updatePassword = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase || busy) return;
    if (newPassword.length < 8) { onMessage('新密码至少需要 8 位。'); return; }
    if (newPassword !== confirmPassword) { onMessage('两次输入的新密码不一致。'); return; }
    setBusy(true);
    try {
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email: session.user.email ?? '', password: currentPassword }); if (verifyError) throw new Error('当前密码不正确，请重新输入。');
      const { error } = await supabase.auth.updateUser({ password: newPassword }); if (error) throw error;
      onMessage('密码已更新'); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordReset(false);
    } catch (cause) { onMessage(cause instanceof Error ? cause.message : '密码更新失败，请重试。'); }
    finally { setBusy(false); }
  };
  const canManageAccount = Boolean(profile && effectiveProfileStatus(profile) === 'active');
  return <section className="account-bar"><div className="account-avatar">{avatarPreview ? <img src={avatarPreview} alt="我的头像" /> : <Icon name="person" />}</div>{editing ? <form className="profile-edit" onSubmit={save}><label className="avatar-upload">更换头像<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)} /></label><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} aria-label="昵称" maxLength={40} placeholder="昵称" required /><input value={bio} onChange={(event) => setBio(event.target.value)} aria-label="个人简介" maxLength={240} placeholder="一句话介绍自己" /><button className="primary-button compact" disabled={busy}>{busy ? '保存中…' : '保存'}</button></form> : <div className="account-copy"><b>{profile?.display_name ?? '账号用户'}</b><small>UID {profile?.uid ?? '加载中'} · {maskEmail(session.user.email)}{profile?.bio ? ` · ${profile.bio}` : ''}</small></div>}{canManageAccount && <><button className="icon-button" onClick={() => { if (editing) setAvatarFile(null); setEditing(!editing); }} aria-label="编辑个人资料"><Icon name="edit" /></button><button className="soft-button" onClick={() => setPasswordReset(!passwordReset)}><Icon name="key" />修改密码</button></>}{!canManageAccount && profile && <p className="account-restriction">当前账号状态下，资料修改和密码修改暂不可用。</p>}<button className="soft-button" onClick={() => void deleteAccount()}><Icon name="delete_forever" />注销账号</button><button className="soft-button" onClick={() => void logout()}><Icon name="logout" />退出</button>{passwordReset && canManageAccount && <form className="password-change" onSubmit={updatePassword}><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required placeholder="当前密码" /><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} autoComplete="new-password" required placeholder="新密码（至少 8 位）" /><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} autoComplete="new-password" required placeholder="再次输入新密码" /><button className="primary-button compact" disabled={busy}>{busy ? '更新中…' : '确认修改'}</button></form>}</section>;
}

function Composer({ userId, onPosted, onError }: { userId: string; onPosted: () => void; onError: (message: string) => void }) {
  const [body, setBody] = useState(''); const [files, setFiles] = useState<File[]>([]); const [busy, setBusy] = useState(false); const [preview, setPreview] = useState<string[]>([]);
  useEffect(() => { const urls = files.map((file) => URL.createObjectURL(file)); setPreview(urls); return () => urls.forEach(URL.revokeObjectURL); }, [files]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase || (!body.trim() && files.length === 0)) return;
    if (files.length > 9 || files.some((file) => file.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp','image/gif'].includes(file.type))) { onError('最多上传 9 张 JPG、PNG、WebP 或 GIF 图片；单张不超过 5 MB。'); return; }
    setBusy(true); onError('');
    try {
      const paths: string[] = [];
      for (const file of files) { const path = `${userId}/${crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg','jpg')}`; const { error } = await supabase.storage.from('community-media').upload(path, file, { contentType: file.type, upsert: false }); if (error) throw error; paths.push(path); }
      const { data: post, error: postError } = await supabase.from('posts').insert({ author_id: userId, body: body.trim(), image_paths: paths }).select('id').single(); if (postError) throw postError;
      const tags = [...new Set([...body.matchAll(/#([\p{L}\p{N}_-]{1,30})/gu)].map((match) => match[1]))];
      for (const title of tags) {
        const slug = title.toLocaleLowerCase(); let { data: topic } = await supabase.from('topics').select('id').eq('slug', slug).maybeSingle();
        if (!topic) { const result = await supabase.from('topics').insert({ slug, title, created_by: userId }).select('id').single(); if (result.error) { const retry = await supabase.from('topics').select('id').eq('slug', slug).single(); if (retry.error) throw result.error; topic = retry.data; } else topic = result.data; }
        const { error } = await supabase.from('post_topics').insert({ post_id: post.id, topic_id: topic.id }); if (error && error.code !== '23505') throw error;
      }
      setBody(''); setFiles([]); onPosted();
    } catch (cause) { onError(cause instanceof Error ? cause.message : '发布失败，请重试。'); }
    finally { setBusy(false); }
  };
  const addEmoji = (emoji: string) => setBody((previous) => `${previous}${emoji}`);
  return <form className="composer" onSubmit={submit}><div className="composer-heading"><span className="composer-avatar"><Icon name="edit_note" /></span><div><b>分享一点今天的生活</b><small>可以添加话题，例如 #宠物日记</small></div></div><textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={5000} placeholder="此刻有什么想记录的？" />{preview.length > 0 && <div className="image-previews">{preview.map((url) => <img src={url} key={url} alt="待上传预览" />)}</div>}<div className="composer-tools"><label className="soft-button upload-button"><Icon name="add_photo_alternate" />图片<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 9))} /></label><EmojiPicker onSelect={addEmoji} /><button className="primary-button compact" disabled={busy}>{busy ? '发布中…' : '发布动态'}</button></div></form>;
}

function TopicShortcut({ title, active, onClick }: { title: string; active: boolean; onClick: (topic: Topic) => void }) {
  const open = async () => { if (!supabase) return; const slug = title.toLocaleLowerCase(); let { data } = await supabase.from('topics').select('id,slug,title').eq('slug', slug).maybeSingle(); if (!data) { const result = await supabase.from('topics').insert({ slug, title }).select('id,slug,title').single(); data = result.data; } if (data) onClick(data as Topic); };
  return <button className={`topic-shortcut ${active ? 'active' : ''}`} onClick={() => void open()}><span>#</span>{title}<Icon name="arrow_outward" /></button>;
}

function PostCard({ post, session, profile, onRefresh, onError, onTopic, onOpenProfile }: { post: Post; session: Session | null; profile: Profile | null; onRefresh: () => void; onError: (message: string) => void; onTopic: (topic: Topic) => void; onOpenProfile: (userId: string) => void }) {
  const [showComments, setShowComments] = useState(false); const [comment, setComment] = useState(''); const [commentFiles, setCommentFiles] = useState<File[]>([]); const [commentPreviews, setCommentPreviews] = useState<string[]>([]); const [busy, setBusy] = useState(false); const commentFileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { const urls = commentFiles.map((file) => URL.createObjectURL(file)); setCommentPreviews(urls); return () => urls.forEach(URL.revokeObjectURL); }, [commentFiles]);
  const name = post.profile?.display_name ?? '生活用户'; const date = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(post.created_at));
  const toggleLike = async () => { if (!supabase || !session) { onError('请先登录再点赞。'); return; } const result = post.liked ? await supabase.from('post_likes').delete().eq('post_id', post.id).eq('user_id', session.user.id) : await supabase.from('post_likes').insert({ post_id: post.id, user_id: session.user.id }); if (result.error) onError(result.error.message); else onRefresh(); };
  const submitComment = async (event: FormEvent) => { event.preventDefault(); if (!supabase || !session || (!comment.trim() && !commentFiles.length)) return; if (commentFiles.length > 4 || commentFiles.some((file) => file.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp','image/gif'].includes(file.type))) { onError('评论最多附 4 张图片，单张不超过 5 MB。'); return; } setBusy(true); try { const paths: string[] = []; for (const file of commentFiles) { const path = `${session.user.id}/${crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg','jpg')}`; const { error } = await supabase.storage.from('community-media').upload(path, file, { contentType: file.type }); if (error) throw error; paths.push(path); } const { error } = await supabase.from('comments').insert({ post_id: post.id, author_id: session.user.id, body: comment.trim(), image_paths: paths }); if (error) throw error; setComment(''); setCommentFiles([]); onRefresh(); } catch (cause) { onError(cause instanceof Error ? cause.message : '评论发送失败，请重试。'); } finally { setBusy(false); } };
  const report = async (kind: 'post' | 'user' | 'comment', targetId: string) => { if (!supabase || !session) { onError('登录后可以提交举报。'); return; } const reason = window.prompt('请简要说明举报原因：')?.trim(); if (!reason) return; const { error } = await supabase.from('reports').insert({ reporter_id: session.user.id, target_type: kind, target_id: targetId, reason }); if (error) onError(error.message); else onError('举报已提交，管理员会尽快查看。'); };
  const deletePost = async () => { if (!supabase || !session || !window.confirm('删除这条动态及其评论？相关图片也会一起删除。')) return; const { data, error } = await supabase.functions.invoke('delete-content', { body: { targetType: 'post', targetId: post.id } }); const failure = await readFunctionFailure(error, data); if (error || failure?.error) { onError(failure?.error ?? error?.message ?? '动态删除失败。'); if (failure?.partial) onRefresh(); } else onRefresh(); };
  const deleteComment = async (comment: CommentItem) => { if (!supabase || !window.confirm('删除这条评论和图片？')) return; const { data, error } = await supabase.functions.invoke('delete-content', { body: { targetType: 'comment', targetId: comment.id } }); const failure = await readFunctionFailure(error, data); if (error || failure?.error) { onError(failure?.error ?? error?.message ?? '评论删除失败。'); if (failure?.partial) onRefresh(); } else onRefresh(); };
  const follow = async () => { if (!supabase || !session) { onError('请先登录再关注用户。'); return; } const { data: existing } = await supabase.from('follows').select('follower_id').eq('follower_id', session.user.id).eq('followee_id', post.author_id).maybeSingle(); const result = existing ? await supabase.from('follows').delete().eq('follower_id', session.user.id).eq('followee_id', post.author_id) : await supabase.from('follows').insert({ follower_id: session.user.id, followee_id: post.author_id }); if (result.error) onError(result.error.message); else onRefresh(); };
  const isFollowingSelf = session?.user.id === post.author_id;
  const followingText = post.followed ? '已关注' : '关注';
  return <article className={`post-card ${post.moderation_status === 'hidden' ? 'post-pending-delete' : ''}`}><header className="post-head"><button className="post-author-link" onClick={() => onOpenProfile(post.author_id)} aria-label={`查看${name}的主页`}><div className="post-avatar">{post.profile?.avatar_url ? <img src={post.profile.avatar_url} alt="" /> : name.slice(0,1)}</div><div className="post-author"><b>{name}</b><small>{date}</small></div></button>{session && <>{!isFollowingSelf && post.moderation_status === 'visible' && <button className="follow-button" onClick={() => void follow()}><Icon name={post.followed ? 'person_check' : 'person_add'} />{followingText}</button>}{post.author_id === session.user.id && <button className="more-button" aria-label={post.moderation_status === 'hidden' ? '继续删除动态' : '删除动态'} onClick={() => void deletePost()}>{post.moderation_status === 'hidden' ? '继续删除' : <Icon name="more_horiz" />}</button>}{post.author_id !== session.user.id && post.moderation_status === 'visible' && <button className="more-button" aria-label="举报动态" onClick={() => void report('post', post.id)}><Icon name="more_horiz" /></button>}</>}</header>
    {post.moderation_status === 'hidden' && <div className="pending-delete-note"><Icon name="info" size={16} />这条内容正在清理图片，其他用户不可见。点击右上角“继续删除”完成清理。</div>}
    {post.body && <p className="post-body">{renderHashtags(post.body, post.topics ?? [], onTopic)}</p>}
    {post.images?.length ? <div className={`post-images count-${Math.min(post.images.length, 4)}`}>{post.images.map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}><img src={url} alt="动态图片" loading="lazy" /></a>)}</div> : null}
    {post.topics && post.topics.length > 0 && <div className="post-topics">{post.topics.map((topic) => <button key={topic.id} onClick={() => onTopic(topic)}>#{topic.title}</button>)}</div>}
    {post.moderation_status === 'visible' && <div className="post-actions"><button className={post.liked ? 'liked' : ''} onClick={() => void toggleLike()}><Icon name={post.liked ? 'favorite' : 'favorite_border'} />{post.likes ?? 0}</button><button onClick={() => setShowComments(!showComments)}><Icon name="chat_bubble" />{post.comments?.length ?? 0}</button><button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/#post-${post.id}`).then(() => onError('动态链接已复制。')).catch(() => onError('复制失败，请手动分享链接。'))}><Icon name="ios_share" />分享</button></div>}
    {showComments && <div className="comments-panel">{(post.comments ?? []).map((item) => <div className={`comment-row ${item.moderation_status === 'hidden' ? 'comment-pending-delete' : ''}`} key={item.id}><button type="button" className="comment-author-link" onClick={() => onOpenProfile(item.author_id)}><div className="comment-avatar">{item.profile?.avatar_url ? <img src={item.profile.avatar_url} alt="" /> : (item.profile?.display_name ?? '生').slice(0,1)}</div><b>{item.profile?.display_name ?? '生活用户'}</b></button><span>{item.body}{item.images?.length ? <span className="comment-images">{item.images.map((url) => <img key={url} src={url} alt="评论图片" loading="lazy" />)}</span> : null}{item.moderation_status === 'hidden' && <small className="pending-comment-label">清理中，其他用户不可见</small>}</span>{item.author_id === session?.user.id && <button type="button" onClick={() => void deleteComment(item)}>{item.moderation_status === 'hidden' ? '继续删除' : '删除'}</button>}{session && item.author_id !== session.user.id && item.moderation_status === 'visible' && <button type="button" onClick={() => void report('comment', item.id)}>举报</button>}</div>)}{session && profile && effectiveProfileStatus(profile) === 'active' && <form className="comment-form" onSubmit={submitComment}><div className="comment-input-wrap"><input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="留一句友善的评论…" maxLength={2000} /><button className="comment-attach" type="button" aria-label="添加评论图片" title="添加图片" onClick={() => commentFileInput.current?.click()}><Icon name="add_photo_alternate" /></button><input ref={commentFileInput} className="visually-hidden-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={(event) => { setCommentFiles(Array.from(event.currentTarget.files ?? []).slice(0,4)); event.currentTarget.value = ''; }} /></div><button className="primary-button compact comment-send" type="submit" disabled={busy || (!comment.trim() && !commentFiles.length)}>{busy ? '发送中…' : '发送'}</button>{commentPreviews.length > 0 && <div className="comment-previews">{commentPreviews.map((url) => <img key={url} src={url} alt="评论图片预览" />)}</div>}<EmojiPicker onSelect={(emoji) => setComment((previous) => `${previous}${emoji}`)} /></form>}</div>}
  </article>;
}

function renderHashtags(body: string, topics: Topic[], onTopic: (topic: Topic) => void) {
  const pieces = body.split(/(#[\p{L}\p{N}_-]{1,30})/gu);
  return pieces.map((piece, index) => { if (!piece.startsWith('#')) return <span key={index}>{piece}</span>; const topic = topics.find((item) => item.title.toLocaleLowerCase() === piece.slice(1).toLocaleLowerCase()); return topic ? <button className="inline-hashtag" key={index} onClick={() => onTopic(topic)}>{piece}</button> : <span className="inline-hashtag-text" key={index}>{piece}</span>; });
}

function maskEmail(email?: string) {
  if (!email) return '邮箱已隐藏';
  const [local, domain] = email.split('@');
  if (!domain) return '邮箱已隐藏';
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

function effectiveProfileStatus(profile: Pick<Profile, 'account_status' | 'suspension_expires_at'>) {
  if (profile.account_status === 'suspended' && profile.suspension_expires_at && Date.parse(profile.suspension_expires_at) <= Date.now()) return 'active';
  return profile.account_status;
}

async function readFunctionFailure(error: unknown, data: unknown): Promise<{ error?: string; partial?: boolean } | null> {
  if (data && typeof data === 'object') return data as { error?: string; partial?: boolean };
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) return await context.clone().json().catch(() => null) as { error?: string; partial?: boolean } | null;
  }
  return null;
}
