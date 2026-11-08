import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useOtpCooldown } from './community';
import { Icon } from './Icon';
import { communityConfigured, supabase } from './supabase';

type AuthMode = 'login' | 'forgot' | 'recover';
const AdminPanel = lazy(() => import('./AdminPanel'));

export default function AdminPortal() {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<AuthMode>('login');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    let active = true;
    const recoveryType = new URLSearchParams(window.location.hash.slice(1)).get('type');
    if (recoveryType === 'recovery') setMode('recover');
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (event === 'SIGNED_OUT') setMode('login');
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    setSession(null);
    setMode('login');
  };

  const rejectNonAdmin = async () => {
    setNotice('此账号没有后台管理权限，已安全退出。');
    await signOut();
  };

  if (loading) return <div className="admin-auth-shell"><div className="feed-loading"><Icon name="progress_activity" className="spin" />正在检查登录状态…</div></div>;
  if (!communityConfigured || !supabase) return <div className="admin-auth-shell"><section className="admin-login-card"><AdminBrand /><h1>后台尚未连接</h1><p>请先配置 Supabase 项目地址和公开客户端密钥。</p></section></div>;
  if (mode === 'recover') return <AdminPasswordRecovery onBack={() => setMode('login')} hasSession={Boolean(session)} />;
  if (mode === 'forgot') return <AdminLogin mode={mode} setMode={setMode} notice={notice} setNotice={setNotice} />;
  if (session) return <Suspense fallback={<div className="admin-auth-shell"><div className="feed-loading"><Icon name="progress_activity" className="spin" />正在打开管理工作台…</div></div>}><AdminPanel session={session} onExit={() => void signOut()} onDenied={() => void rejectNonAdmin()} /></Suspense>;
  return <AdminLogin mode={mode} setMode={setMode} notice={notice} setNotice={setNotice} />;
}

function AdminLogin({ mode, setMode, notice, setNotice }: { mode: AuthMode; setMode: (mode: AuthMode) => void; notice: string; setNotice: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [resetCodeSent, setResetCodeSent] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { seconds: resendSeconds, start: startResendCooldown } = useOtpCooldown();

  useEffect(() => {
    if (mode !== 'forgot') { setResetCodeSent(false); setResetEmail(''); setOtp(''); setPassword(''); setConfirmPassword(''); }
  }, [mode]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || busy) return;
    setBusy(true); setError(''); setMessage(''); setNotice('');
    const values = new FormData(event.currentTarget);
    const email = (resetCodeSent ? resetEmail : String(values.get('email') ?? '')).trim();
    try {
      if (mode === 'forgot') {
        if (!resetCodeSent) {
          const redirectTo = window.location.hostname === 'admin.yeecc.cn' ? 'https://admin.yeecc.cn/' : `${window.location.origin}/admin`;
          const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
          if (resetError) throw resetError;
          setResetEmail(email); setResetCodeSent(true); startResendCooldown();
          setMessage('如果该邮箱对应可用管理员账号，验证码会很快送达。');
        } else {
          if (!/^\d{8}$/.test(otp)) throw new Error('请输入邮件中的 8 位数字验证码。');
          if (password.length < 8) throw new Error('新密码至少需要 8 位。');
          if (password !== confirmPassword) throw new Error('两次输入的新密码不一致。');
          const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: otp, type: 'recovery' });
          if (verifyError) throw verifyError;
          const { error: updateError } = await supabase.auth.updateUser({ password });
          if (updateError) throw updateError;
          await supabase.auth.signOut();
          setResetCodeSent(false); setOtp(''); setPassword(''); setConfirmPassword('');
          setMode('login'); setMessage('密码已更新，请使用新密码登录后台。');
        }
      } else {
        const password = String(values.get('password') ?? '');
        const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
        if (loginError) throw loginError;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally { setBusy(false); }
  };

  const resendResetCode = async () => {
    if (!supabase || !resetEmail || busy || resendSeconds > 0) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const redirectTo = window.location.hostname === 'admin.yeecc.cn' ? 'https://admin.yeecc.cn/' : `${window.location.origin}/admin`;
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(resetEmail, { redirectTo });
      if (resetError) throw resetError;
      startResendCooldown(); setMessage('验证码已重新发送。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '验证码发送失败，请重试。'); }
    finally { setBusy(false); }
  };

  const changeMode = (next: AuthMode) => { setError(''); setMessage(''); setMode(next); };

  return <main className="admin-auth-shell">
    <section className="admin-login-card">
      <AdminBrand />
      <p className="eyebrow">PRIVATE ADMIN AREA</p>
      <h1>{mode === 'forgot' ? '找回后台密码' : '欢迎回来'}</h1>
      <p className="admin-login-description">{mode === 'forgot' ? resetCodeSent ? `验证码已发送到 ${resetEmail}。输入验证码和新密码完成重置。` : '输入已登记的管理员邮箱，我们会发送一次性验证码。' : '使用已授权的管理员账号登录日常有序后台。'}</p>
      <form className="admin-login-form" onSubmit={submit}>
        <label><span>管理员邮箱</span><input name="email" type="email" autoComplete="username" placeholder="name@example.com" value={resetEmail} onChange={(event) => setResetEmail(event.target.value)} readOnly={resetCodeSent} required /></label>
        {mode === 'login' && <label><span>密码</span><input name="password" type="password" autoComplete="current-password" placeholder="输入密码" required /></label>}
        {mode === 'forgot' && resetCodeSent && <><label><span>邮箱验证码</span><input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="输入 8 位数字验证码" required /></label><label><span>新密码</span><input type="password" minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label><span>确认新密码</span><input type="password" minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label><button type="button" className="text-button" disabled={busy || resendSeconds > 0} onClick={() => void resendResetCode()}>{resendSeconds > 0 ? `${resendSeconds} 秒后可重发` : '重新发送验证码'}</button></>}
        {notice && <p className="admin-auth-notice">{notice}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {message && <p className="form-success" role="status">{message}</p>}
        <button className="primary-button admin-login-submit" disabled={busy}>{busy ? '请稍候…' : mode === 'forgot' ? resetCodeSent ? '验证并更新密码' : '发送验证码' : '登录管理后台'}</button>
      </form>
      <div className="admin-login-links">
        {mode === 'login' ? <button type="button" onClick={() => changeMode('forgot')}>忘记密码？</button> : <button type="button" onClick={() => changeMode('login')}>返回登录</button>}
      </div>
      <p className="admin-login-footnote"><Icon name="shield_lock" size={15} />后台仅对已授权管理员开放</p>
    </section>
  </main>;
}

function AdminPasswordRecovery({ onBack, hasSession }: { onBack: () => void; hasSession: boolean }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || busy) return;
    if (!hasSession) { setError('重置链接已失效或不完整，请重新申请。'); return; }
    if (password.length < 8) { setError('新密码至少需要 8 位。'); return; }
    if (password !== confirm) { setError('两次输入的新密码不一致。'); return; }
    setBusy(true); setError('');
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) setError(updateError.message);
    else setDone(true);
    setBusy(false);
  };

  if (done) return <main className="admin-auth-shell"><section className="admin-login-card"><AdminBrand /><span className="admin-recovery-success"><Icon name="check_circle" /></span><h1>密码已更新</h1><p className="admin-login-description">请使用新密码重新登录后台。</p><button className="primary-button admin-login-submit" onClick={async () => { await supabase?.auth.signOut(); onBack(); }}>返回登录</button></section></main>;

  return <main className="admin-auth-shell"><section className="admin-login-card">
    <AdminBrand /><p className="eyebrow">ACCOUNT RECOVERY</p><h1>设置新密码</h1>
    <p className="admin-login-description">密码至少 8 位。设置完成后，请重新登录后台。</p>
    <form className="admin-login-form" onSubmit={submit}>
      <label><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <label><span>确认新密码</span><input type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button admin-login-submit" disabled={busy}>{busy ? '保存中…' : '更新密码'}</button>
    </form>
    {!hasSession && <button className="text-button admin-recovery-back" onClick={onBack}>重新申请重置邮件</button>}
  </section></main>;
}

function AdminBrand() {
  return <div className="admin-login-brand"><span className="brandmark"><Icon name="auto_awesome" size={19} /></span><span><b>日常有序</b><small>管理工作台</small></span></div>;
}
