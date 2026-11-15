const hasChinese = /\p{Script=Han}/u;

export function toChineseUserMessage(value: unknown, fallback = '操作失败，请稍后重试。'): string {
  const error = value && typeof value === 'object' ? value as { message?: unknown; code?: unknown } : undefined;
  const message = typeof value === 'string' ? value : typeof error?.message === 'string' ? error.message : '';
  const code = typeof error?.code === 'string' ? error.code : '';
  const normalized = `${code} ${message}`.trim().toLowerCase();

  if (!normalized) return fallback;
  if (/load failed|failed to fetch|networkerror|network request failed|fetch failed|network is unreachable|err_name_not_resolved|err_connection_(?:reset|refused)|timed? ?out|timeout|aborterror/.test(normalized)) {
    return '连接验证码服务失败，请检查网络后重试；如果持续出现，请联系管理员检查服务状态。';
  }
  if (/cors|cross-origin|access-control-allow-origin/.test(normalized)) {
    return '浏览器未能连接验证码服务，请稍后重试；如果持续出现，请联系管理员检查站点跨域配置。';
  }
  if (/over_email_send_rate_limit|email rate limit|rate limit exceeded|too many requests|too many.*email|for security purposes/.test(normalized)) {
    return '请求过于频繁，请稍后再试。';
  }
  if (/email.*(?:not authorized|not allowed)|email_address_not_authorized/.test(normalized)) {
    return '当前邮箱地址暂不允许接收验证码，请更换邮箱或联系管理员。';
  }
  if (/error sending .*email|failed to send email|smtp|email delivery|mail delivery|mail service.*not configured/.test(normalized)) {
    return '验证码邮件暂时无法发送，请稍后重试；如果持续出现，请联系管理员检查邮件服务配置。';
  }
  if (/invalid login credentials|invalid_credentials|email_not_confirmed|email not confirmed/.test(normalized)) {
    return /email_not_confirmed|email not confirmed/.test(normalized) ? '邮箱尚未验证，请先完成邮箱验证。' : '邮箱或密码不正确。';
  }
  if (/invalid otp|otp_expired|otp_invalid|token has expired|token is invalid|invalid token/.test(normalized)) {
    return '验证码无效或已过期，请重新获取后再试。';
  }
  if (/invalid email|email.*invalid|unable to validate email address/.test(normalized)) {
    return '邮箱地址格式不正确，请检查后重试。';
  }
  if (/user already registered|user_already_exists|email.*already.*registered/.test(normalized)) {
    return '该邮箱已注册，请直接登录。';
  }
  if (/signup.*disabled|signups not allowed|signup_disabled/.test(normalized)) {
    return '当前暂不开放注册，请稍后再试或联系管理员。';
  }
  if (/password.*(weak|short|least)|weak_password/.test(normalized)) {
    return '密码强度不足，请按页面要求设置密码。';
  }
  if (hasChinese.test(message)) return message;
  return fallback;
}
