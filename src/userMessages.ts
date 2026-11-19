import type { Locale } from './types';

const hasChinese = /\p{Script=Han}/u;
const errorHintPattern = /失败|错误|不正确|无效|过期|不能|不可|不足|不一致|不完整|不支持|未连接|无法|未确认|未验证|尚未|频繁|不允许|暂不|找不到|不存在|已注册|受限|已被移除|至少|不超过|必须|请先|请输入|请选择|请检查|请更换|请联系|error|failed|invalid|unauthorized|forbidden|expired|unable|cannot|not found|too many/i;

export function isErrorUserMessage(value: unknown): boolean {
  const error = value && typeof value === 'object' ? value as { message?: unknown; code?: unknown } : undefined;
  const raw = typeof value === 'string' ? value.trim() : typeof error?.message === 'string' ? error.message.trim() : '';
  if (!raw) return false;
  const translatedZh = toUserMessage(raw, 'zh-CN');
  if (errorHintPattern.test(raw) || errorHintPattern.test(translatedZh)) return true;
  return !hasChinese.test(raw) && typeof value !== 'string';
}

export function toChineseUserMessage(value: unknown, fallback = '操作失败，请稍后重试。'): string {
  return toUserMessage(value, 'zh-CN', fallback);
}

export function toUserMessage(value: unknown, locale: Locale = 'zh-CN', fallback?: string): string {
  const defaultFallback = fallback ?? (locale === 'en' ? 'Action failed. Please try again.' : '操作失败，请稍后重试。');
  const error = value && typeof value === 'object' ? value as { message?: unknown; code?: unknown } : undefined;
  const message = typeof value === 'string' ? value : typeof error?.message === 'string' ? error.message : '';
  const code = typeof error?.code === 'string' ? error.code : '';
  const normalized = `${code} ${message}`.trim().toLowerCase();

  if (!normalized) return defaultFallback;
  if (/load failed|failed to fetch|failed to send a request to the edge function|edge_network_error|networkerror|network request failed|fetch failed|network is unreachable|err_name_not_resolved|err_connection_(?:reset|refused)|timed? ?out|timeout|aborterror/.test(normalized)) {
    return locale === 'en'
      ? 'Network request failed. Check your connection and try again.'
      : '网络连接失败，请检查网络后重试；如果持续出现，请联系管理员检查服务状态。';
  }
  if (/cors|cross-origin|access-control-allow-origin/.test(normalized)) {
    return locale === 'en'
      ? 'Cross-origin connection blocked. Please check domain configuration.'
      : '浏览器未能连接服务，请稍后重试；如果持续出现，请联系管理员检查站点跨域配置。';
  }
  if (/over_email_send_rate_limit|email rate limit|rate limit exceeded|too many requests|too many.*email|for security purposes/.test(normalized)) {
    return locale === 'en' ? 'Too many requests. Please wait a moment.' : '请求过于频繁，请稍后再试。';
  }
  if (/email.*(?:not authorized|not allowed)|email_address_not_authorized/.test(normalized)) {
    return locale === 'en' ? 'This email address is not allowed right now.' : '当前邮箱地址暂不允许接收验证码，请更换邮箱或联系管理员。';
  }
  if (/error sending .*email|failed to send email|smtp|email delivery|mail delivery|mail service.*not configured/.test(normalized)) {
    return locale === 'en' ? 'Failed to send verification email. Please try again later.' : '验证码邮件暂时无法发送，请稍后重试；如果持续出现，请联系管理员检查邮件服务配置。';
  }
  if (/invalid login credentials|invalid_credentials|email_not_confirmed|email not confirmed/.test(normalized)) {
    const unconfirmed = /email_not_confirmed|email not confirmed/.test(normalized);
    if (locale === 'en') return unconfirmed ? 'Email not verified yet. Please verify your email first.' : 'Incorrect email or password.';
    return unconfirmed ? '邮箱尚未验证，请先完成邮箱验证。' : '邮箱或密码不正确。';
  }
  if (/invalid otp|otp_expired|otp_invalid|token has expired|token is invalid|invalid token/.test(normalized)) {
    return locale === 'en' ? 'Verification code is invalid or expired.' : '验证码无效或已过期，请重新获取后再试。';
  }
  if (/invalid email|email.*invalid|unable to validate email address/.test(normalized)) {
    return locale === 'en' ? 'Invalid email address format.' : '邮箱地址格式不正确，请检查后重试。';
  }
  if (/user already registered|user_already_exists|email.*already.*registered/.test(normalized)) {
    return locale === 'en' ? 'This email is already registered. Please sign in.' : '该邮箱已注册，请直接登录。';
  }
  if (/signup.*disabled|signups not allowed|signup_disabled/.test(normalized)) {
    return locale === 'en' ? 'Signups are currently disabled.' : '当前暂不开放注册，请稍后再试或联系管理员。';
  }
  if (/password.*(weak|short|least)|weak_password/.test(normalized)) {
    return locale === 'en' ? 'Password must be at least 8 characters with letters and numbers.' : '密码强度不足，请按页面要求设置密码。';
  }
  if (/admin_account_cannot_self_delete/.test(normalized)) {
    return locale === 'en' ? 'Admin accounts must revoke admin role before self-deletion.' : '管理员账号不能直接注销，请先撤销管理员权限。';
  }
  if (/confirmation_required/.test(normalized)) {
    return locale === 'en' ? 'Please enter the exact confirmation text.' : '请输入正确的确认内容后再提交。';
  }
  if (/account_not_active|account_restricted/.test(normalized)) {
    return locale === 'en' ? 'Your account is restricted and cannot perform this action.' : '当前账号处于受限状态，暂不能执行此操作。';
  }
  if (/subscription_not_found/.test(normalized)) {
    return locale === 'en' ? 'Subscription record could not be found.' : '未找到对应的订阅记录。';
  }
  if (/invalid_payment_method/.test(normalized)) {
    return locale === 'en' ? 'Selected payment method is invalid.' : '选择的支付方式无效，请刷新后重试。';
  }
  if (/categories_user_name_key|payment_methods_user_name_key|duplicate key value/.test(normalized)) {
    return locale === 'en' ? 'An item with that name already exists.' : '名称已存在，请换一个名称。';
  }
  if (/already_admin/.test(normalized)) {
    return locale === 'en' ? 'This account is already an admin.' : '该账号已经是管理员。';
  }
  if (/target_not_eligible/.test(normalized)) {
    return locale === 'en' ? 'Only active accounts with verified email can be granted admin.' : '只有邮箱已验证且状态正常的账号可以成为管理员。';
  }
  if (/target_not_admin/.test(normalized)) {
    return locale === 'en' ? 'This account is not currently an admin.' : '该账号当前不是管理员。';
  }
  if (/last_active_admin/.test(normalized)) {
    return locale === 'en' ? 'Cannot revoke the last active administrator.' : '不能撤销最后一位有效管理员的权限。';
  }
  if (/target_not_found|account_not_found/.test(normalized)) {
    return locale === 'en' ? 'Target account or record was not found.' : '找不到目标对象或账号。';
  }
  if (/lookup_required/.test(normalized)) {
    return locale === 'en' ? 'Please enter a 6-digit UID or email.' : '请输入 6 位 UID 或邮箱。';
  }
  if (/invalid_reason/.test(normalized)) {
    return locale === 'en' ? 'Please enter a valid reason.' : '请填写有效的操作原因。';
  }
  if (/password_updated_audit_(?:outcome_)?failed/.test(normalized)) {
    return locale === 'en' ? 'Password updated, but audit log write failed.' : '密码已更新，但审计记录写入失败，请检查后台操作记录。';
  }
  if (/password_update_failed_audit_outcome_failed/.test(normalized)) {
    return locale === 'en' ? 'Password update and audit update both failed.' : '密码更新失败，且审计记录更新失败，请检查后台操作记录。';
  }
  if (/password_reset_audit_intent_failed/.test(normalized)) {
    return locale === 'en' ? 'Could not initialize audit record; action cancelled.' : '无法写入密码重置审计记录，操作已取消。';
  }
  if (/password_update_failed/.test(normalized)) {
    return locale === 'en' ? 'Password update failed.' : '密码更新失败，请检查新密码是否符合要求。';
  }
  if (/origin_not_allowed/.test(normalized)) {
    return locale === 'en' ? 'Origin is not allowed for admin endpoint.' : '当前访问来源未被允许调用后台管理接口。';
  }
  if (/gemini_not_configured/.test(normalized)) {
    return locale === 'en'
      ? 'AI Smart Capture is not configured yet (missing GEMINI_API_KEY secret on Supabase).'
      : 'AI 智能识别尚未配置（服务端缺少 GEMINI_API_KEY 密钥）。';
  }
  if (/input_required/.test(normalized)) {
    return locale === 'en'
      ? 'Please paste billing text or attach a receipt screenshot / PDF.'
      : '请先输入账单文本，或上传账单截图 / PDF。';
  }
  if (/unsupported_file_type/.test(normalized)) {
    return locale === 'en'
      ? 'Only PNG, JPG, WEBP, HEIC, GIF images or PDF files are supported.'
      : '仅支持 PNG、JPG、WEBP、HEIC、GIF 图片或 PDF 文件。';
  }
  if (/file_too_large/.test(normalized)) {
    return locale === 'en'
      ? 'File is too large. Please upload an image or PDF under 8 MB.'
      : '文件过大，请上传 8 MB 以内的图片或 PDF。';
  }
  if (/gemini_parse_failed/.test(normalized)) {
    return locale === 'en'
      ? 'Could not parse structured subscription details. Please try clearer text or image.'
      : '未能解析出结构化订阅信息，请更换更清晰的文本或截图重试。';
  }
  if (/gemini_upstream_error/.test(normalized)) {
    return locale === 'en'
      ? 'Gemini AI service is temporarily unavailable. Please try again shortly.'
      : 'Gemini AI 服务暂时不可用，请稍后重试。';
  }
  if (/file_read_failed/.test(normalized)) {
    return locale === 'en'
      ? 'Failed to read the attached file. Please select it again.'
      : '读取附件失败，请重新选择图片或 PDF 后重试。';
  }
  if (/edge_relay_error/.test(normalized)) {
    return locale === 'en'
      ? 'Edge Function relay error. Please try again shortly.'
      : '云函数节点暂时异常，请稍后重试。';
  }
  if (/edge_timeout/.test(normalized)) {
    return locale === 'en'
      ? 'Recognition timed out. Try a smaller file or try again shortly.'
      : '账单识别超时，请换用更小的文件或稍后重试。';
  }
  if (/edge function returned a non-2xx status code/.test(normalized)) {
    return locale === 'en'
      ? 'Cloud recognition endpoint returned an error. Please try again.'
      : '云端识别接口返回异常，请稍后重试。';
  }
  if (/\bunauthorized\b/.test(normalized)) {
    return locale === 'en' ? 'Session expired. Please sign in again.' : '登录状态已失效，请重新登录。';
  }
  if (/\bforbidden\b|42501|row-level security/.test(normalized)) {
    return locale === 'en' ? 'You do not have permission for this action.' : '当前账号没有执行此操作的权限。';
  }
  if (locale === 'zh-CN' && hasChinese.test(message)) return message;
  if (locale === 'en' && !hasChinese.test(message) && message.trim()) return message;
  return defaultFallback;
}
