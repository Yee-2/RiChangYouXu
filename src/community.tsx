import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { communityConfigured, supabase } from './supabase';

type Profile = { id: string; username: string | null; display_name: string; avatar_path: string | null; avatar_url?: string; bio: string; role: 'user' | 'admin'; account_status: 'active' | 'suspended' | 'deleted' };
type Topic = { id: string; slug: string; title: string };
type Post = { id: string; author_id: string; body: string; image_paths: string[]; created_at: string; profile?: Profile; topics?: Topic[]; liked?: boolean; followed?: boolean; likes?: number; comments?: CommentItem[]; images?: string[] };
type CommentItem = { id: string; post_id: string; author_id: string; body: string; image_paths: string[]; created_at: string; profile?: Profile; images?: string[] };
type Report = { id: string; reporter_id: string; target_type: 'post' | 'comment' | 'user'; target_id: string; reason: string; detail: string; status: string; created_at: string };

function MaterialIcon({ name }: { name: string }) { return <span className="material-symbols-rounded icon" aria-hidden="true">{name}</span>; }

export default function Community({ session }: { session: Session | null }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adminOpen, setAdminOpen] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!supabase || !session?.user) { setProfile(null); return; }
    const { data, error: profileError } = await supabase.from('profiles').select('id,username,display_name,avatar_path,bio,role,account_status').eq('id', session.user.id).maybeSingle();
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
      let query = supabase.from('posts').select('id,author_id,body,image_paths,created_at').eq('moderation_status', 'visible').order('created_at', { ascending: false }).limit(40);
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
        authors.length ? supabase.from('profiles').select('id,username,display_name,avatar_path,bio,role,account_status').in('id', authors) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('post_topics').select('post_id,topics(id,slug,title)').in('post_id', ids) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('post_likes').select('post_id,user_id').in('post_id', ids) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('comments').select('id,post_id,author_id,body,image_paths,created_at').eq('moderation_status', 'visible').in('post_id', ids).order('created_at', { ascending: true }) : Promise.resolve({ data: [], error: null }),
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
      const commentProfiles = commentAuthors.length ? await supabase.from('profiles').select('id,username,display_name,avatar_path,bio,role,account_status').in('id', commentAuthors) : { data: [], error: null };
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
  }, [selectedTopic?.id, session?.user?.id]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);
  useEffect(() => { void loadPosts(); }, [loadPosts]);

  if (!communityConfigured || !supabase) return <section className="community-cover"><div className="community-spark"><MaterialIcon name="forum" /></div><p className="eyebrow">COMMUNITY SETUP</p><h1>你的生活社区<br /><span>即将上线</span></h1><p className="muted">社区代码已准备好。配置 Supabase 项目后即可启用邮箱账号、图文动态、话题和互动。</p><div className="community-preview"><span># 宠物日记</span><span># 今天的小确幸</span><span># 生活灵感</span></div><p className="muted">配置步骤见项目根目录的 `.env.example` 和产品指南。</p></section>;

  if (adminOpen && profile?.role === 'admin') return <AdminPanel onBack={() => setAdminOpen(false)} />;
  return <div className="community-page">
    <div className="community-title"><div><p className="eyebrow">SHARE A LITTLE JOY</p><h1>生活社区</h1><p>记录生活的小事，也看看别人的可爱日常。</p></div>{profile?.role === 'admin' && <button className="soft-button" onClick={() => setAdminOpen(true)}><MaterialIcon name="admin_panel_settings" />管理后台</button>}</div>
    {!session ? <AuthCard /> : <AccountBar session={session} profile={profile} onProfileChange={loadProfile} onMessage={setNotice} />}
    {notice && <div className="community-notice">{notice}</div>}
    {session && profile?.account_status !== 'active' && profile && <div className="community-alert">账号当前状态：{profile.account_status === 'suspended' ? '暂时停用' : '已注销'}。社区发布和互动已关闭。</div>}
    <div className="community-feed-layout"><aside className="topic-rail"><h3>热门话题</h3><p className={!selectedTopic ? 'topic-link selected' : 'topic-link'} onClick={() => setSelectedTopic(null)}>全部动态</p>{['宠物日记','生活碎片','今日好心情','养宠新手','居家日常'].map((title) => <TopicShortcut key={title} title={title} active={selectedTopic?.title === title} onClick={(topic) => setSelectedTopic(topic)} />)}<div className="small-note">动态支持图片、表情、话题和评论。</div></aside><div className="feed-main">
      {session && profile?.account_status === 'active' && <Composer userId={session.user.id} onPosted={loadPosts} onError={setError} />}
      {selectedTopic && <div className="topic-heading"><div><small>正在浏览话题</small><h2>#{selectedTopic.title}</h2></div><button className="icon-button" onClick={() => setSelectedTopic(null)} aria-label="清除话题筛选"><MaterialIcon name="close" /></button></div>}
      {error && <div className="community-alert" role="alert">{error}<button onClick={() => void loadPosts()}>重试</button></div>}
      {loading ? <div className="feed-loading"><MaterialIcon name="progress_activity" />正在加载新鲜动态…</div> : posts.length ? posts.map((post) => <PostCard key={post.id} post={post} session={session} profile={profile} onRefresh={loadPosts} onError={setError} onTopic={setSelectedTopic} />) : <div className="feed-empty"><MaterialIcon name="auto_awesome" /><h3>{selectedTopic ? '这个话题还没有动态' : '这里还很安静'}</h3><p>来分享一件今天的小事吧。</p></div>}
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
        const { data, error: authError } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin, data: { display_name: email.split('@')[0] } } });
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
  return <section className="auth-card"><div><p className="eyebrow">加入生活社区</p><h2>{mode === 'login' ? '登录后参与互动' : mode === 'signup' ? '创建邮箱账号' : '找回密码'}</h2><p>注册使用邮箱和密码，不需要手机号。</p></div><form className="auth-form" onSubmit={submit}><input name="email" type="email" autoComplete="email" placeholder="邮箱地址" required />{mode !== 'reset' && <input name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} placeholder="密码（至少 8 位）" required />}{error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}{pendingEmail && mode === 'signup' && <button type="button" className="text-button" onClick={() => void resend()}>重新发送验证邮件</button>}<button className="primary-button" disabled={busy}>{busy ? '请稍候…' : mode === 'signup' ? '注册并验证邮箱' : mode === 'reset' ? '发送重置邮件' : '邮箱登录'}</button><div className="auth-switch">{mode !== 'login' && <button type="button" onClick={() => { setMode('login'); setError(''); setMessage(''); }}>返回登录</button>}{mode === 'login' && <><button type="button" onClick={() => setMode('signup')}>创建账号</button><button type="button" onClick={() => setMode('reset')}>忘记密码</button></>}</div></form></section>;
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
  return <section className="account-bar"><div className="account-avatar">{avatarPreview ? <img src={avatarPreview} alt="我的头像" /> : <MaterialIcon name="person" />}</div>{editing ? <form className="profile-edit" onSubmit={save}><label className="avatar-upload">更换头像<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)} /></label><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} aria-label="昵称" maxLength={40} placeholder="昵称" required /><input value={bio} onChange={(event) => setBio(event.target.value)} aria-label="个人简介" maxLength={240} placeholder="一句话介绍自己" /><button className="primary-button compact" disabled={busy}>{busy ? '保存中…' : '保存'}</button></form> : <div className="account-copy"><b>{profile?.display_name ?? session.user.email}</b><small>{session.user.email}{profile?.bio ? ` · ${profile.bio}` : ''}</small></div>}<button className="icon-button" onClick={() => { if (editing) setAvatarFile(null); setEditing(!editing); }} aria-label="编辑个人资料"><MaterialIcon name="edit" /></button><button className="soft-button" onClick={() => setPasswordReset(!passwordReset)}><MaterialIcon name="key" />修改密码</button><button className="soft-button" onClick={() => void deleteAccount()}><MaterialIcon name="delete_forever" />注销账号</button><button className="soft-button" onClick={() => void logout()}><MaterialIcon name="logout" />退出</button>{passwordReset && <form className="password-change" onSubmit={updatePassword}><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required placeholder="当前密码" /><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} autoComplete="new-password" required placeholder="新密码（至少 8 位）" /><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} autoComplete="new-password" required placeholder="再次输入新密码" /><button className="primary-button compact" disabled={busy}>{busy ? '更新中…' : '确认修改'}</button></form>}</section>;
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
  return <form className="composer" onSubmit={submit}><div className="composer-heading"><span className="composer-avatar"><MaterialIcon name="edit_note" /></span><div><b>分享一点今天的生活</b><small>可以添加话题，例如 #宠物日记</small></div></div><textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={5000} placeholder="此刻有什么想记录的？" />{preview.length > 0 && <div className="image-previews">{preview.map((url) => <img src={url} key={url} alt="待上传预览" />)}</div>}<div className="composer-tools"><label className="soft-button upload-button"><MaterialIcon name="add_photo_alternate" />图片<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 9))} /></label><div className="emoji-row">{['😊','🐾','✨','❤️'].map((emoji) => <button type="button" key={emoji} onClick={() => addEmoji(emoji)}>{emoji}</button>)}</div><button className="primary-button compact" disabled={busy}>{busy ? '发布中…' : '发布动态'}</button></div></form>;
}

function TopicShortcut({ title, active, onClick }: { title: string; active: boolean; onClick: (topic: Topic) => void }) {
  const open = async () => { if (!supabase) return; const slug = title.toLocaleLowerCase(); let { data } = await supabase.from('topics').select('id,slug,title').eq('slug', slug).maybeSingle(); if (!data) { const result = await supabase.from('topics').insert({ slug, title }).select('id,slug,title').single(); data = result.data; } if (data) onClick(data as Topic); };
  return <button className={`topic-shortcut ${active ? 'active' : ''}`} onClick={() => void open()}><span>#</span>{title}<MaterialIcon name="arrow_outward" /></button>;
}

function PostCard({ post, session, profile, onRefresh, onError, onTopic }: { post: Post; session: Session | null; profile: Profile | null; onRefresh: () => void; onError: (message: string) => void; onTopic: (topic: Topic) => void }) {
  const [showComments, setShowComments] = useState(false); const [comment, setComment] = useState(''); const [commentFiles, setCommentFiles] = useState<File[]>([]); const [commentPreviews, setCommentPreviews] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  useEffect(() => { const urls = commentFiles.map((file) => URL.createObjectURL(file)); setCommentPreviews(urls); return () => urls.forEach(URL.revokeObjectURL); }, [commentFiles]);
  const name = post.profile?.display_name ?? '生活用户'; const date = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(post.created_at));
  const toggleLike = async () => { if (!supabase || !session) { onError('请先登录再点赞。'); return; } const result = post.liked ? await supabase.from('post_likes').delete().eq('post_id', post.id).eq('user_id', session.user.id) : await supabase.from('post_likes').insert({ post_id: post.id, user_id: session.user.id }); if (result.error) onError(result.error.message); else onRefresh(); };
  const submitComment = async (event: FormEvent) => { event.preventDefault(); if (!supabase || !session || (!comment.trim() && !commentFiles.length)) return; if (commentFiles.length > 4 || commentFiles.some((file) => file.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp','image/gif'].includes(file.type))) { onError('评论最多附 4 张图片，单张不超过 5 MB。'); return; } setBusy(true); try { const paths: string[] = []; for (const file of commentFiles) { const path = `${session.user.id}/${crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg','jpg')}`; const { error } = await supabase.storage.from('community-media').upload(path, file, { contentType: file.type }); if (error) throw error; paths.push(path); } const { error } = await supabase.from('comments').insert({ post_id: post.id, author_id: session.user.id, body: comment.trim(), image_paths: paths }); if (error) throw error; setComment(''); setCommentFiles([]); onRefresh(); } catch (cause) { onError(cause instanceof Error ? cause.message : '评论发送失败，请重试。'); } finally { setBusy(false); } };
  const report = async (kind: 'post' | 'user' | 'comment', targetId: string) => { if (!supabase || !session) { onError('登录后可以提交举报。'); return; } const reason = window.prompt('请简要说明举报原因：')?.trim(); if (!reason) return; const { error } = await supabase.from('reports').insert({ reporter_id: session.user.id, target_type: kind, target_id: targetId, reason }); if (error) onError(error.message); else onError('举报已提交，管理员会尽快查看。'); };
  const deletePost = async () => { if (!supabase || !session || !window.confirm('删除这条动态？')) return; const { error } = await supabase.from('posts').delete().eq('id', post.id); if (error) onError(error.message); else { if (post.image_paths.length) await supabase.storage.from('community-media').remove(post.image_paths); onRefresh(); } };
  const follow = async () => { if (!supabase || !session) { onError('请先登录再关注用户。'); return; } const { data: existing } = await supabase.from('follows').select('follower_id').eq('follower_id', session.user.id).eq('followee_id', post.author_id).maybeSingle(); const result = existing ? await supabase.from('follows').delete().eq('follower_id', session.user.id).eq('followee_id', post.author_id) : await supabase.from('follows').insert({ follower_id: session.user.id, followee_id: post.author_id }); if (result.error) onError(result.error.message); else onRefresh(); };
  const isFollowingSelf = session?.user.id === post.author_id;
  const followingText = post.followed ? '已关注' : '关注';
  return <article className="post-card"><header className="post-head"><div className="post-avatar">{post.profile?.avatar_url ? <img src={post.profile.avatar_url} alt="" /> : name.slice(0,1)}</div><div className="post-author"><b>{name}</b><small>{date}</small></div>{session && <>{!isFollowingSelf && <button className="follow-button" onClick={() => void follow()}><MaterialIcon name="person_add" />{followingText}</button>}<button className="more-button" aria-label="更多操作" onClick={() => post.author_id === session.user.id ? void deletePost() : void report('post', post.id)}><MaterialIcon name="more_horiz" /></button></>}</header>
    {post.body && <p className="post-body">{renderHashtags(post.body, post.topics ?? [], onTopic)}</p>}
    {post.images?.length ? <div className={`post-images count-${Math.min(post.images.length, 4)}`}>{post.images.map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}><img src={url} alt="动态图片" loading="lazy" /></a>)}</div> : null}
    {post.topics && post.topics.length > 0 && <div className="post-topics">{post.topics.map((topic) => <button key={topic.id} onClick={() => onTopic(topic)}>#{topic.title}</button>)}</div>}
    <div className="post-actions"><button className={post.liked ? 'liked' : ''} onClick={() => void toggleLike()}><MaterialIcon name={post.liked ? 'favorite' : 'favorite_border'} />{post.likes ?? 0}</button><button onClick={() => setShowComments(!showComments)}><MaterialIcon name="chat_bubble" />{post.comments?.length ?? 0}</button><button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/#post-${post.id}`).then(() => onError('动态链接已复制。')).catch(() => onError('复制失败，请手动分享链接。'))}><MaterialIcon name="ios_share" />分享</button></div>
    {showComments && <div className="comments-panel">{(post.comments ?? []).map((item) => <div className="comment-row" key={item.id}><div className="comment-avatar">{item.profile?.avatar_url ? <img src={item.profile.avatar_url} alt="" /> : (item.profile?.display_name ?? '生').slice(0,1)}</div><b>{item.profile?.display_name ?? '生活用户'}</b><span>{item.body}{item.images?.length ? <span className="comment-images">{item.images.map((url) => <img key={url} src={url} alt="评论图片" loading="lazy" />)}</span> : null}</span>{item.author_id === session?.user.id && <button onClick={async () => { const { error } = await supabase!.from('comments').delete().eq('id', item.id); if (error) onError(error.message); else { if (item.image_paths.length) await supabase!.storage.from('community-media').remove(item.image_paths); onRefresh(); } }}>删除</button>}{session && item.author_id !== session.user.id && <button onClick={() => void report('comment', item.id)}>举报</button>}</div>)}{session && profile?.account_status === 'active' && <form className="comment-form" onSubmit={submitComment}><div className="comment-input-wrap"><input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="留一句友善的评论… 😊" maxLength={2000} /><label className="comment-attach" aria-label="添加评论图片"><MaterialIcon name="add_photo_alternate" /><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={(event) => setCommentFiles(Array.from(event.target.files ?? []).slice(0,4))} /></label></div><button className="primary-button compact" disabled={busy || (!comment.trim() && !commentFiles.length)}>{busy ? '发送中…' : '发送'}</button>{commentPreviews.length > 0 && <div className="comment-previews">{commentPreviews.map((url) => <img key={url} src={url} alt="评论图片预览" />)}</div>}<div className="comment-emojis">{['😊','🐾','✨'].map((emoji) => <button type="button" key={emoji} onClick={() => setComment((previous) => `${previous}${emoji}`)}>{emoji}</button>)}</div></form>}</div>}
  </article>;
}

function renderHashtags(body: string, topics: Topic[], onTopic: (topic: Topic) => void) {
  const pieces = body.split(/(#[\p{L}\p{N}_-]{1,30})/gu);
  return pieces.map((piece, index) => { if (!piece.startsWith('#')) return <span key={index}>{piece}</span>; const topic = topics.find((item) => item.title.toLocaleLowerCase() === piece.slice(1).toLocaleLowerCase()); return topic ? <button className="inline-hashtag" key={index} onClick={() => onTopic(topic)}>{piece}</button> : <span className="inline-hashtag-text" key={index}>{piece}</span>; });
}

function AdminPanel({ onBack }: { onBack: () => void }) {
  const [reports, setReports] = useState<Report[]>([]); const [profiles, setProfiles] = useState<Profile[]>([]); const [audit, setAudit] = useState<Array<Record<string, unknown>>>([]); const [content, setContent] = useState<Array<Record<string, unknown>>>([]); const [section, setSection] = useState<'reports' | 'content' | 'accounts' | 'audit'>('reports'); const [search, setSearch] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { if (!supabase) return; setLoading(true); setError(''); const [r, p, a, posts, comments] = await Promise.all([supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(100), supabase.from('profiles').select('id,username,display_name,avatar_path,bio,role,account_status').order('created_at', { ascending: false }).limit(200), supabase.from('moderation_audit').select('*').order('created_at', { ascending: false }).limit(100), supabase.from('posts').select('id,author_id,body,moderation_status,created_at').order('created_at', { ascending: false }).limit(100), supabase.from('comments').select('id,post_id,author_id,body,moderation_status,created_at').order('created_at', { ascending: false }).limit(150)]); const err = r.error ?? p.error ?? a.error ?? posts.error ?? comments.error; if (err) setError(err.message); setReports((r.data ?? []) as Report[]); setProfiles((p.data ?? []) as Profile[]); setAudit((a.data ?? []) as Array<Record<string, unknown>>); const contentRows: Array<Record<string, unknown>> = [...((posts.data ?? []) as Array<Record<string, unknown>>).map((row) => ({ ...row, target_type: 'post' })), ...((comments.data ?? []) as Array<Record<string, unknown>>).map((row) => ({ ...row, target_type: 'comment' }))]; contentRows.sort((x, y) => String(y['created_at']).localeCompare(String(x['created_at']))); setContent(contentRows); setLoading(false); }, []);
  useEffect(() => { void load(); }, [load]);
  const perform = async (action: string, targetType: string, targetId: string, reportId?: string) => { if (!supabase) return; const reason = window.prompt('填写处理原因：')?.trim(); if (!reason) return; const { data, error: invokeError } = await supabase.functions.invoke('admin-moderate', { body: { action, targetType, targetId, reportId, reason } }); if (invokeError || data?.error) setError(invokeError?.message ?? data?.error); else { setError(''); await load(); } };
  return <div className="admin-page"><div className="page-title-row"><div><p className="eyebrow">ONLY FOR ADMINISTRATORS</p><h1>社区管理后台</h1></div><button className="soft-button" onClick={onBack}><MaterialIcon name="arrow_back" />返回社区</button></div><div className="admin-tabs">{([['reports','举报队列'],['content','内容管理'],['accounts','账号管理'],['audit','操作记录']] as const).map(([key,label]) => <button key={key} className={section===key?'active':''} onClick={() => setSection(key)}>{label}</button>)}</div>{error && <div className="community-alert">{error}</div>}{loading ? <div className="feed-loading">正在加载管理数据…</div> : section === 'reports' ? <div className="admin-list">{reports.length === 0 ? <div className="feed-empty"><MaterialIcon name="task_alt" /><h3>暂时没有举报</h3></div> : reports.map((report) => <div className="admin-row" key={report.id}><div><b>{report.target_type} · {report.reason}</b><small>{report.detail || '无补充说明'} · {new Date(report.created_at).toLocaleString('zh-CN')} · 状态：{report.status}</small></div><div className="admin-actions">{report.status === 'open' && <>{report.target_type === 'user' ? <button className="soft-button" onClick={() => void perform('suspend_user', 'user', report.target_id, report.id)}>暂停账号</button> : <button className="soft-button" onClick={() => void perform(`hide_${report.target_type}`, report.target_type, report.target_id, report.id)}>隐藏内容</button>}<button className="primary-button compact" onClick={() => void perform('handle_report', report.target_type, report.target_id, report.id)}>完成处理</button><button className="soft-button" onClick={() => void perform('dismiss_report', report.target_type, report.target_id, report.id)}>驳回</button></>}</div></div>)}</div> : section === 'content' ? <div className="admin-list"><div className="admin-search"><MaterialIcon name="search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索动态或评论文字、作者 ID" /></div>{content.filter((row) => `${row.body ?? ''} ${row.author_id ?? ''} ${row.id ?? ''}`.toLowerCase().includes(search.toLowerCase())).map((row) => { const kind = String(row.target_type); const status = String(row.moderation_status); const action = status === 'visible' ? `hide_${kind}` : 'restore_' + kind; return <div className="admin-row" key={`${kind}-${String(row.id)}`}><div><b>{kind === 'post' ? '动态' : '评论'} · {status}</b><small>{String(row.body || '（图片内容）').slice(0,120)} · 作者 {String(row.author_id).slice(0,8)} · {new Date(String(row.created_at)).toLocaleString('zh-CN')}</small></div><div className="admin-actions">{status !== 'removed' && <button className="soft-button" onClick={() => void perform(action, kind, String(row.id))}>{status === 'visible' ? '隐藏' : '恢复'}</button>}<button className="soft-button" onClick={() => void perform(`remove_${kind}`, kind, String(row.id))}>移除</button></div></div>; })}</div> : section === 'accounts' ? <div className="admin-list"><div className="admin-search"><MaterialIcon name="search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索昵称、用户名或账号 ID" /></div>{profiles.filter((person) => `${person.display_name} ${person.username ?? ''} ${person.id}`.toLowerCase().includes(search.toLowerCase())).map((person) => <div className="admin-row" key={person.id}><div><b>{person.display_name} {person.role === 'admin' ? '· 管理员' : ''}</b><small>{person.username ? `@${person.username} · ` : ''}{person.id} · {person.account_status}</small></div>{person.role !== 'admin' && <button className="soft-button" onClick={() => void perform(person.account_status === 'suspended' ? 'restore_user' : 'suspend_user', 'user', person.id)}>{person.account_status === 'suspended' ? '恢复账号' : '暂停账号'}</button>}</div>)}</div> : <div className="admin-list">{audit.map((entry) => <div className="admin-row" key={String(entry.id)}><div><b>{String(entry.action)} · {String(entry.target_type)}</b><small>{String(entry.reason)} · {new Date(String(entry.created_at)).toLocaleString('zh-CN')}</small></div><code>{String(entry.actor_id).slice(0,8)}</code></div>)}</div>}</div>;
}
