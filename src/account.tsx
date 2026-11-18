import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { communityConfigured, supabase } from './supabase';
import { Icon } from './Icon';
import { accountPasswordRule, isValidAccountPassword } from './authValidation';
import { t } from './i18n';
import { toUserMessage } from './userMessages';
import type { Locale, Profile, ThemeChoice } from './types';

export function useOtpCooldown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  return { seconds, start: () => setSeconds(60) };
}

export function maskEmail(email?: string) {
  if (!email) return '—';
  const [local, domain] = email.split('@');
  if (!domain) return '—';
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

export function effectiveProfileStatus(profile: Pick<Profile, 'account_status' | 'suspension_expires_at'>) {
  if (profile.account_status === 'suspended' && profile.suspension_expires_at && Date.parse(profile.suspension_expires_at) <= Date.now()) {
    return 'active';
  }
  return profile.account_status;
}

export function AuthView({
  locale,
  onToggleLocale,
  theme,
  onToggleTheme,
  onMessage,
  onAuthenticated,
}: {
  locale: Locale;
  onToggleLocale: () => void;
  theme: ThemeChoice;
  onToggleTheme: () => void;
  onMessage?: (message: string) => void;
  onAuthenticated?: () => void;
}) {
  const isEn = locale === 'en';
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [loginMethod, setLoginMethod] = useState<'password' | 'otp'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { seconds: resendSeconds, start: startResendCooldown } = useOtpCooldown();
  const normalizedEmail = email.trim();

  const reportFailure = (cause: unknown) => {
    const text = toUserMessage(cause, locale);
    setError(text);
    onMessage?.(text);
  };

  const clearCode = () => {
    setCodeSent(false);
    setOtp('');
    setMessage('');
    setError('');
  };

  const sendCode = async () => {
    if (!supabase || busy || resendSeconds > 0) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      reportFailure(new Error(isEn ? 'Please enter a valid email address.' : '请先输入有效的邮箱账号。'));
      return;
    }
    if (mode === 'signup') {
      if (!isValidAccountPassword(password)) {
        reportFailure(new Error(isEn ? 'Password must be at least 8 characters with letters and numbers.' : accountPasswordRule));
        return;
      }
      if (password !== confirmPassword) {
        reportFailure(new Error(isEn ? 'Passwords do not match.' : '两次输入的密码不一致。'));
        return;
      }
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let result: { error: { message: string } | null };
      if (mode === 'signup') {
        result = codeSent
          ? await supabase.auth.resend({ type: 'signup', email: normalizedEmail })
          : await supabase.auth.signUp({ email: normalizedEmail, password });
      } else if (mode === 'reset') {
        result = await supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo: `${window.location.origin}/` });
      } else {
        result = await supabase.auth.signInWithOtp({ email: normalizedEmail, options: { shouldCreateUser: true } });
      }
      if (result.error) throw result.error;
      setCodeSent(true);
      startResendCooldown();
      const success = mode === 'reset'
        ? (isEn ? 'If this email is registered, a verification code has been sent.' : '如果该邮箱已注册，验证码会很快送达。')
        : (isEn ? `Verification code sent to ${normalizedEmail}.` : `验证码已发送至 ${normalizedEmail}。`);
      setMessage(success);
      onMessage?.(success);
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'login' && loginMethod === 'password') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
        if (authError) throw authError;
        onAuthenticated?.();
      } else {
        if (!codeSent) throw new Error(isEn ? 'Please send a verification code first.' : '请先发送邮箱验证码。');
        if (!/^\d{6}$/.test(otp)) throw new Error(isEn ? 'Enter the 6-digit code from your email.' : '请输入邮件中的 6 位数字验证码。');
        if ((mode === 'reset' || mode === 'signup') && !isValidAccountPassword(password)) {
          throw new Error(isEn ? 'Password must be at least 8 characters with letters and numbers.' : accountPasswordRule);
        }
        if (mode === 'signup' && password !== confirmPassword) {
          throw new Error(isEn ? 'Passwords do not match.' : '两次输入的密码不一致。');
        }
        const type = mode === 'signup' ? 'signup' : mode === 'reset' ? 'recovery' : 'email';
        const { error: verifyError } = await supabase.auth.verifyOtp({ email: normalizedEmail, token: otp, type });
        if (verifyError) throw verifyError;
        if (mode === 'reset') {
          const { error: updateError } = await supabase.auth.updateUser({ password });
          if (updateError) throw updateError;
          await supabase.auth.signOut();
          setMode('login');
          setLoginMethod('password');
          setPassword('');
          setOtp('');
          clearCode();
          const doneMsg = isEn ? 'Password updated. Please sign in again.' : '密码修改完成，请重新登录。';
          setMessage(doneMsg);
          onMessage?.(doneMsg);
        } else if (mode === 'signup') {
          onMessage?.(isEn ? 'Account created. Welcome to Renewly!' : '注册成功，欢迎使用 Renewly');
          onAuthenticated?.();
        } else {
          onMessage?.(isEn ? 'Signed in successfully' : '验证码登录/注册成功');
          onAuthenticated?.();
        }
      }
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (next: 'login' | 'signup' | 'reset') => {
    setMode(next);
    setPassword('');
    setConfirmPassword('');
    setLoginMethod('password');
    clearCode();
  };

  const emailLocked = (codeSent && mode !== 'login') || (codeSent && loginMethod === 'otp');
  const codeRow = (label: string, sendLabel: string) => (
    <label className="auth-field">
      <span>{label}</span>
      <span className="otp-input-row">
        <input
          className="otp-code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={otp}
          onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder={isEn ? '6-digit code' : '6 位验证码'}
          required
        />
        <button
          className="soft-button otp-send-button"
          type="button"
          disabled={busy || resendSeconds > 0}
          onClick={() => void sendCode()}
        >
          {resendSeconds > 0 ? `${resendSeconds}s` : codeSent ? (isEn ? 'Resend' : '重新发送') : sendLabel}
        </button>
      </span>
    </label>
  );

  return (
    <div className="landing-shell">
      <header className="landing-topbar">
        <div className="brand">
          <span className="brandmark"><Icon name="repeat" size={18} /></span>
          <span>Renewly</span>
        </div>
        <div className="top-actions">
          <button type="button" className="chip-button" onClick={onToggleLocale} aria-label="Switch language">
            <Icon name="globe" size={15} />
            <span>{locale === 'zh-CN' ? 'EN' : '中文'}</span>
          </button>
          <button type="button" className="icon-button" onClick={onToggleTheme} aria-label="Toggle theme">
            <Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} size={18} />
          </button>
        </div>
      </header>

      <main className="landing-grid">
        <section className="landing-hero">
          <span className="eyebrow">{t(locale, 'landingEyebrow')}</span>
          <h1>
            {t(locale, 'landingTitle1')}
            <br />
            <span>{t(locale, 'landingTitle2')}</span>
          </h1>
          <p className="landing-desc">{t(locale, 'landingSubtitle')}</p>
          <div className="landing-pills">
            <span><Icon name="cloud" size={15} />{t(locale, 'landingFeature1')}</span>
            <span><Icon name="bell" size={15} />{t(locale, 'landingFeature2')}</span>
            <span><Icon name="dollar" size={15} />{t(locale, 'landingFeature3')}</span>
          </div>
          <div className="landing-preview-card">
            <div className="preview-top">
              <div>
                <small>{t(locale, 'monthlySpendLabel')}</small>
                <b>¥ 486.00</b>
              </div>
              <span className="badge-pill mint">9 {t(locale, 'totalSubscriptionsUnit')}</span>
            </div>
            <div className="preview-rows">
              <div><span className="dot" style={{ background: '#E50914' }} /><span>Netflix</span><b>¥ 68.00</b></div>
              <div><span className="dot" style={{ background: '#1DB954' }} /><span>Spotify</span><b>¥ 15.00</b></div>
              <div><span className="dot" style={{ background: '#10A37F' }} /><span>ChatGPT Plus</span><b>$ 20.00</b></div>
            </div>
          </div>
        </section>

        <section className="auth-card auth-card-stack">
          {!communityConfigured || !supabase ? (
            <div className="empty-card">
              <Icon name="cloud_off" size={28} />
              <h3>{isEn ? 'Supabase Not Configured' : '云端服务暂未配置'}</h3>
              <p>{isEn ? 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable cloud sync.' : '请先配置 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY 环境变量。'}</p>
            </div>
          ) : (
            <>
              <div className="auth-card-intro">
                <p className="eyebrow">RENEWLY ACCOUNT</p>
                <h2>
                  {mode === 'login'
                    ? (isEn ? 'Welcome back' : '登录后继续')
                    : mode === 'signup'
                      ? (isEn ? 'Create account' : '创建邮箱账号')
                      : (isEn ? 'Reset password' : '重置密码')}
                </h2>
                <p>
                  {mode === 'signup'
                    ? (isEn ? 'Verify your email with a 6-digit code to start syncing.' : '填写账号信息，验证邮箱后即可云端同步。')
                    : mode === 'reset'
                      ? (isEn ? 'Verify via email code to set a new password.' : '使用邮箱验证码验证后设置新密码。')
                      : (isEn ? 'Sign in with password or a one-time email code.' : '选择适合你的登录方式，数据全量云端保存。')}
                </p>
              </div>

              {mode === 'login' && (
                <div className="login-method-tabs" role="tablist" aria-label={isEn ? 'Sign in method' : '登录方式'}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={loginMethod === 'password'}
                    className={loginMethod === 'password' ? 'active' : ''}
                    onClick={() => { setLoginMethod('password'); clearCode(); }}
                  >
                    {isEn ? 'Password' : '密码登录'}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={loginMethod === 'otp'}
                    className={loginMethod === 'otp' ? 'active' : ''}
                    onClick={() => { setLoginMethod('otp'); clearCode(); }}
                  >
                    {isEn ? 'Email Code' : '验证码登录'}
                  </button>
                </div>
              )}

              <form className="auth-form" onSubmit={submit}>
                <label className="auth-field">
                  <span>{isEn ? 'Email' : '邮箱账号'}</span>
                  <input
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    readOnly={emailLocked}
                    required
                  />
                </label>

                {mode === 'login' && loginMethod === 'password' && (
                  <label className="auth-field">
                    <span>{isEn ? 'Password' : '密码'}</span>
                    <input
                      type="password"
                      autoComplete="current-password"
                      minLength={8}
                      placeholder={isEn ? 'Enter your password' : '请输入密码'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                    />
                  </label>
                )}

                {mode === 'login' && loginMethod === 'otp' && (
                  <>
                    {codeRow(isEn ? 'Verification Code' : '邮箱验证码', isEn ? 'Send Code' : '发送验证码')}
                    {codeSent && (
                      <button type="button" className="text-button change-auth-email" onClick={clearCode}>
                        {isEn ? 'Change email' : '更换邮箱'}
                      </button>
                    )}
                  </>
                )}

                {mode === 'signup' && (
                  <>
                    {codeRow(isEn ? 'Verification Code' : '邮箱验证码', isEn ? 'Send Code' : '发送验证码')}
                    <label className="auth-field">
                      <span>{isEn ? 'Password' : '设置密码'}</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        placeholder={isEn ? '8+ chars with letters & digits' : '8 位以上，含字母和数字'}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        readOnly={codeSent}
                        required
                      />
                    </label>
                    <label className="auth-field">
                      <span>{isEn ? 'Confirm Password' : '确认密码'}</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        placeholder={isEn ? 'Re-enter password' : '再次输入密码'}
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        readOnly={codeSent}
                        required
                      />
                    </label>
                    {codeSent && (
                      <button type="button" className="text-button change-auth-email" onClick={clearCode}>
                        {isEn ? 'Edit email or password' : '更改账号或密码'}
                      </button>
                    )}
                  </>
                )}

                {mode === 'reset' && (
                  <>
                    {codeRow(isEn ? 'Verification Code' : '邮箱验证码', isEn ? 'Send Code' : '发送验证码')}
                    {codeSent && (
                      <button type="button" className="text-button change-auth-email" onClick={clearCode}>
                        {isEn ? 'Change email' : '更换邮箱'}
                      </button>
                    )}
                    <label className="auth-field">
                      <span>{isEn ? 'New Password' : '新密码'}</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        placeholder={isEn ? '8+ chars with letters & digits' : '8 位以上，含字母和数字'}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                      />
                    </label>
                  </>
                )}

                {error && <p className="form-error" role="alert">{toUserMessage(error, locale)}</p>}
                {message && <p className="form-success" role="status">{message}</p>}

                <button
                  className="primary-button auth-submit"
                  disabled={busy || ((mode === 'signup' || mode === 'reset' || loginMethod === 'otp') && !codeSent)}
                >
                  {busy
                    ? (isEn ? 'Please wait…' : '请稍候…')
                    : mode === 'signup'
                      ? (isEn ? 'Create Account' : '立即注册')
                      : mode === 'reset'
                        ? (isEn ? 'Update Password' : '确认修改密码')
                        : loginMethod === 'otp'
                          ? (isEn ? 'Sign In / Sign Up' : '验证码登录 / 注册')
                          : (isEn ? 'Sign In' : '密码登录')}
                </button>

                <div className="auth-switch">
                  {mode === 'login' ? (
                    loginMethod === 'password' ? (
                      <>
                        <button type="button" onClick={() => changeMode('reset')}>{isEn ? 'Forgot password?' : '忘记密码'}</button>
                        <button type="button" onClick={() => changeMode('signup')}>{isEn ? 'Create account' : '立即注册'}</button>
                      </>
                    ) : null
                  ) : (
                    <button type="button" onClick={() => changeMode('login')}>{isEn ? 'Back to sign in' : '返回登录'}</button>
                  )}
                </div>
              </form>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export function AccountSubpage({
  session,
  locale,
  page,
  onBack,
  onMessage,
  onProfileChange,
}: {
  session: Session;
  locale: Locale;
  page: 'edit-profile' | 'change-password' | 'delete-account' | 'logout';
  onBack: () => void;
  onMessage: (message: string) => void;
  onProfileChange: (profile: Profile | null) => void;
}) {
  const isEn = locale === 'en';
  if (page === 'edit-profile') {
    return (
      <div className="subpage-wrap">
        <button className="soft-button subpage-back" type="button" onClick={onBack}>
          <Icon name="arrow_back" size={17} />
          {isEn ? 'Back to Settings' : '返回设置'}
        </button>
        <ProfileEditForm session={session} locale={locale} onMessage={onMessage} onProfileChange={onProfileChange} onComplete={onBack} />
      </div>
    );
  }
  if (page === 'change-password') {
    return (
      <div className="subpage-wrap">
        <button className="soft-button subpage-back" type="button" onClick={onBack}>
          <Icon name="arrow_back" size={17} />
          {isEn ? 'Back to Settings' : '返回设置'}
        </button>
        <PasswordChangeForm session={session} locale={locale} onMessage={onMessage} onComplete={onBack} />
      </div>
    );
  }
  if (page === 'delete-account') {
    return (
      <div className="subpage-wrap">
        <button className="soft-button subpage-back" type="button" onClick={onBack}>
          <Icon name="arrow_back" size={17} />
          {isEn ? 'Back to Settings' : '返回设置'}
        </button>
        <DeleteAccountForm locale={locale} onMessage={onMessage} onComplete={onBack} />
      </div>
    );
  }
  return (
    <div className="subpage-wrap">
      <button className="soft-button subpage-back" type="button" onClick={onBack}>
        <Icon name="arrow_back" size={17} />
        {isEn ? 'Back to Settings' : '返回设置'}
      </button>
      <LogoutForm locale={locale} onMessage={onMessage} onComplete={onBack} />
    </div>
  );
}

function ProfileEditForm({
  session,
  locale,
  onMessage,
  onProfileChange,
  onComplete,
}: {
  session: Session;
  locale: Locale;
  onMessage: (message: string) => void;
  onProfileChange: (profile: Profile | null) => void;
  onComplete: () => void;
}) {
  const isEn = locale === 'en';
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!supabase) return;
      const { data, error } = await supabase
        .from('profiles')
        .select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at')
        .eq('id', session.user.id)
        .maybeSingle();
      if (error) {
        onMessage(toUserMessage(error, locale));
        return;
      }
      const value = data as Profile | null;
      if (active) {
        setProfile(value);
        setDisplayName(value?.display_name ?? '');
        setBio(value?.bio ?? '');
      }
    })();
    return () => { active = false; };
  }, [session.user.id, locale, onMessage]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || busy) return;
    const name = displayName.trim();
    if (!name) {
      onMessage(isEn ? 'Display name cannot be empty.' : '昵称不能为空。');
      return;
    }
    setBusy(true);
    try {
      const update = { display_name: name.slice(0, 40), bio: bio.trim().slice(0, 240) };
      const { error } = await supabase.from('profiles').update(update).eq('id', session.user.id);
      if (error) throw error;
      const updated = profile ? { ...profile, ...update } : null;
      setProfile(updated);
      onProfileChange(updated);
      onMessage(isEn ? 'Profile updated' : '个人资料已保存');
      onComplete();
    } catch (cause) {
      onMessage(toUserMessage(cause, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="surface-card settings-form-card">
      <div className="settings-form-heading">
        <span className="eyebrow">PROFILE</span>
        <h2>{isEn ? 'Edit Profile' : '编辑个人资料'}</h2>
        <p>{isEn ? 'Update your display name and personal note.' : '修改昵称和个人简介。'}</p>
      </div>
      <form className="form-stack" onSubmit={(e) => void save(e)}>
        <label className="field">
          <span>{isEn ? 'Display Name' : '昵称'}</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} required />
        </label>
        <label className="field">
          <span>{isEn ? 'Bio' : '个人简介'}</span>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={240} rows={3} />
        </label>
        <button className="primary-button" disabled={busy}>
          {busy ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save Changes' : '保存资料')}
        </button>
      </form>
    </section>
  );
}

function PasswordChangeForm({
  session,
  locale,
  onMessage,
  onComplete,
}: {
  session: Session;
  locale: Locale;
  onMessage: (message: string) => void;
  onComplete: () => void;
}) {
  const isEn = locale === 'en';
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const { seconds: resendSeconds, start: startResendCooldown } = useOtpCooldown();
  const accountEmail = session.user.email ?? '';

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase
      .from('user_auth_settings')
      .select('password_set')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          onMessage(toUserMessage(error, locale));
          setHasPassword(true);
          return;
        }
        setHasPassword(data?.password_set ?? true);
      });
    return () => { active = false; };
  }, [session.user.id, locale, onMessage]);

  const sendCode = async () => {
    if (!supabase || !accountEmail || busy || resendSeconds > 0) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(accountEmail, { redirectTo: window.location.origin + '/' });
      if (error) throw error;
      setCodeSent(true);
      startResendCooldown();
      onMessage(isEn ? 'Verification code sent' : '验证码已发送');
    } catch (cause) {
      onMessage(toUserMessage(cause, locale));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || busy) return;
    if (!codeSent) {
      onMessage(isEn ? 'Please send a verification code first.' : '请先发送验证码。');
      return;
    }
    if (!/^\d{6}$/.test(otp)) {
      onMessage(isEn ? 'Enter the 6-digit verification code.' : '请输入邮件中的 6 位数字验证码。');
      return;
    }
    if (!isValidAccountPassword(password)) {
      onMessage(isEn ? 'Password must be at least 8 characters with letters and digits.' : accountPasswordRule);
      return;
    }
    setBusy(true);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({ email: accountEmail, token: otp, type: 'recovery' });
      if (verifyError) throw verifyError;
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      await supabase.auth.signOut();
      onMessage(isEn ? 'Password updated. Please sign in again.' : (hasPassword ? '密码修改完成，请重新登录' : '密码设置完成，请重新登录'));
      onComplete();
    } catch (cause) {
      onMessage(toUserMessage(cause, locale));
    } finally {
      setBusy(false);
    }
  };

  const title = hasPassword === null
    ? (isEn ? 'Account Password' : '账号密码')
    : hasPassword
      ? (isEn ? 'Change Password' : '修改密码')
      : (isEn ? 'Set Password' : '设置密码');

  return (
    <section className="surface-card settings-form-card">
      <div className="settings-form-heading">
        <span className="eyebrow">ACCOUNT SECURITY</span>
        <h2>{title}</h2>
        <p>{isEn ? 'Verify with the 6-digit code sent to your email.' : '验证邮件中的 6 位一次性验证码。'}</p>
      </div>
      <form className="form-stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>{isEn ? 'Account' : '账号'}</span>
          <input value={maskEmail(accountEmail)} readOnly />
        </label>
        <label className="field">
          <span>{isEn ? 'Email Code' : '邮箱验证码'}</span>
          <span className="otp-input-row">
            <input
              className="otp-code-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={isEn ? '6-digit code' : '6 位验证码'}
              required
            />
            <button
              className="soft-button otp-send-button"
              type="button"
              onClick={() => void sendCode()}
              disabled={busy || resendSeconds > 0}
            >
              {resendSeconds > 0 ? `${resendSeconds}s` : codeSent ? (isEn ? 'Resend' : '重新发送') : (isEn ? 'Send Code' : '发送验证码')}
            </button>
          </span>
        </label>
        <label className="field">
          <span>{isEn ? 'New Password' : '新密码'}</span>
          <input
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isEn ? '8+ chars with letters & digits' : '8 位以上，含字母和数字'}
            required
          />
        </label>
        <button className="primary-button" disabled={busy || hasPassword === null}>
          {busy ? (isEn ? 'Submitting…' : '正在提交…') : title}
        </button>
      </form>
    </section>
  );
}

function DeleteAccountForm({
  locale,
  onMessage,
  onComplete,
}: {
  locale: Locale;
  onMessage: (message: string) => void;
  onComplete: () => void;
}) {
  const isEn = locale === 'en';
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || busy) return;
    if (confirmation.trim() !== 'DELETE') {
      onMessage(isEn ? 'Please type DELETE to confirm.' : '请输入 DELETE 以确认注销账号。');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('delete-account', { body: { confirmation: 'DELETE' } });
      if (error || data?.error) throw new Error(error?.message ?? data.error);
      await supabase.auth.signOut({ scope: 'local' });
      onMessage(isEn ? 'Account and cloud data deleted.' : '账号及云端订阅数据已注销。');
      onComplete();
    } catch (cause) {
      onMessage(toUserMessage(cause, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="surface-card settings-form-card danger-page">
      <div className="settings-form-heading">
        <span className="eyebrow">DELETE ACCOUNT</span>
        <h2>{isEn ? 'Delete Account' : '注销账号'}</h2>
        <p>{isEn ? 'This permanently deletes your account, subscriptions, categories, payment methods, and billing history from the cloud.' : '此操作将永久删除你的云端账号、所有订阅记录、分类、支付方式和扣费历史，且不可恢复。'}</p>
      </div>
      <form className="form-stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>{isEn ? 'Type DELETE to confirm' : '输入 DELETE 确认'}</span>
          <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" placeholder="DELETE" required />
        </label>
        <button className="danger-button" disabled={busy}>
          {busy ? (isEn ? 'Deleting…' : '正在注销…') : (isEn ? 'Permanently Delete Account' : '确认永久注销账号')}
        </button>
      </form>
    </section>
  );
}

function LogoutForm({
  locale,
  onMessage,
  onComplete,
}: {
  locale: Locale;
  onMessage: (message: string) => void;
  onComplete: () => void;
}) {
  const isEn = locale === 'en';
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    if (!supabase || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      onMessage(error ? (isEn ? 'Signed out locally.' : '已退出本设备登录。') : (isEn ? 'Signed out' : '已退出登录'));
      onComplete();
    } catch (cause) {
      onMessage(toUserMessage(cause, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="surface-card settings-form-card">
      <div className="settings-form-heading">
        <span className="eyebrow">SIGN OUT</span>
        <h2>{isEn ? 'Sign Out' : '退出登录'}</h2>
        <p>{isEn ? 'Your subscriptions remain safely stored in the cloud.' : '你的所有订阅数据仍安全保存在云端，随时可重新登录同步。'}</p>
      </div>
      <button className="primary-button" type="button" disabled={busy} onClick={() => void logout()}>
        {busy ? (isEn ? 'Signing out…' : '正在退出…') : (isEn ? 'Confirm Sign Out' : '确认退出登录')}
      </button>
    </section>
  );
}

export function useUserProfileLoader(session: Session | null, onMessage: (msg: string) => void, locale: Locale) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const load = useCallback(async () => {
    if (!supabase || !session) {
      setProfile(null);
      return;
    }
    const { data, error } = await supabase
      .from('profiles')
      .select('id,uid,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (error) {
      onMessage(toUserMessage(error, locale));
      return;
    }
    setProfile(data as Profile | null);
  }, [session?.user.id, locale, onMessage]);

  useEffect(() => { void load(); }, [load]);
  return { profile, setProfile, reloadProfile: load };
}
