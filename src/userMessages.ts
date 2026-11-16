const hasChinese = /\p{Script=Han}/u;
const errorHintPattern = /失败|错误|不正确|无效|过期|不能|不可|不足|不一致|不完整|不支持|未连接|无法|未确认|未验证|尚未|频繁|不允许|暂不|找不到|不存在|已注册|受限|已被移除|至少|不超过|必须|请先|请输入|请选择|请检查|请更换|请联系/;

export function isErrorUserMessage(value: unknown): boolean {
  const error = value && typeof value === 'object' ? value as { message?: unknown; code?: unknown } : undefined;
  const raw = typeof value === 'string' ? value.trim() : typeof error?.message === 'string' ? error.message.trim() : '';
  if (!raw) return false;
  if (!hasChinese.test(raw)) return true;
  const translated = toChineseUserMessage(raw);
  return errorHintPattern.test(raw) || errorHintPattern.test(translated);
}

export function toChineseUserMessage(value: unknown, fallback = '操作失败，请稍后重试。'): string {
  const error = value && typeof value === 'object' ? value as { message?: unknown; code?: unknown } : undefined;
  const message = typeof value === 'string' ? value : typeof error?.message === 'string' ? error.message : '';
  const code = typeof error?.code === 'string' ? error.code : '';
  const normalized = `${code} ${message}`.trim().toLowerCase();

  if (!normalized) return fallback;
  if (/load failed|failed to fetch|networkerror|network request failed|fetch failed|network is unreachable|err_name_not_resolved|err_connection_(?:reset|refused)|timed? ?out|timeout|aborterror/.test(normalized)) {
    return '网络连接失败，请检查网络后重试；如果持续出现，请联系管理员检查服务状态。';
  }
  if (/cors|cross-origin|access-control-allow-origin/.test(normalized)) {
    return '浏览器未能连接服务，请稍后重试；如果持续出现，请联系管理员检查站点跨域配置。';
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
  if (/admin_account_cannot_self_delete/.test(normalized)) {
    return '管理员账号不能直接注销，请先撤销管理员权限。';
  }
  if (/confirmation_required/.test(normalized)) {
    return '请输入正确的确认内容后再提交。';
  }
  if (/account_not_active/.test(normalized)) {
    return '当前账号处于受限状态，暂不能执行此操作。';
  }
  if (/target_not_owned/.test(normalized)) {
    return '只能操作自己发布的内容。';
  }
  if (/profile_not_found/.test(normalized)) {
    return '找不到账号资料，请重新登录后重试。';
  }
  if (/media_cleanup_failed|media_list_failed/.test(normalized)) {
    return '图片清理未完全成功，内容已先隐藏，请稍后重试。';
  }
  if (/content_delete_failed/.test(normalized)) {
    return '内容删除失败，请稍后重试。';
  }
  if (/content_already_removed/.test(normalized)) {
    return '该内容已被移除，无法再次操作。';
  }
  if (/target_not_manageable/.test(normalized)) {
    return '不能对管理员账号或不存在的账号执行此操作。';
  }
  if (/permanently_banned_accounts_require_(?:manual_)?unban/.test(normalized)) {
    return '永久封禁账号需通过“手动解封”恢复。';
  }
  if (/target_is_not_banned/.test(normalized)) {
    return '该账号当前未处于永久封禁状态。';
  }
  if (/invalid_suspension_duration/.test(normalized)) {
    return '请选择有效的暂停时长（24 小时、7 天或 30 天）。';
  }
  if (/report_id_required|report_not_found/.test(normalized)) {
    return '找不到对应的举报记录。';
  }
  if (/action_applied_audit_failed/.test(normalized)) {
    return '操作已生效，但写入审计记录失败，请检查操作记录。';
  }
  if (/action_applied_report_update_failed/.test(normalized)) {
    return '操作已生效，但更新举报状态失败，请刷新后核查。';
  }
  if (/auth_ban_failed_and_rollback_failed/.test(normalized)) {
    return '账号限制同步失败且回滚未完成，请立即刷新核查账号状态。';
  }
  if (/password_updated_audit_(?:outcome_)?failed/.test(normalized)) {
    return '密码已更新，但审计记录写入失败，请检查后台操作记录。';
  }
  if (/password_update_failed_audit_outcome_failed/.test(normalized)) {
    return '密码更新失败，且审计记录更新失败，请检查后台操作记录。';
  }
  if (/password_reset_audit_intent_failed/.test(normalized)) {
    return '无法写入密码重置审计记录，操作已取消。';
  }
  if (/password_update_failed/.test(normalized)) {
    return '密码更新失败，请检查新密码是否符合要求。';
  }
  if (/already_admin/.test(normalized)) {
    return '该账号已经是管理员。';
  }
  if (/target_not_eligible/.test(normalized)) {
    return '只有邮箱已验证且状态正常的账号可以成为管理员。';
  }
  if (/target_not_admin/.test(normalized)) {
    return '该账号当前不是管理员。';
  }
  if (/last_active_admin/.test(normalized)) {
    return '不能撤销最后一位有效管理员的权限。';
  }
  if (/target_not_found|account_not_found/.test(normalized)) {
    return '找不到目标对象或账号。';
  }
  if (/lookup_required/.test(normalized)) {
    return '请输入 6 位 UID 或邮箱。';
  }
  if (/invalid_reason/.test(normalized)) {
    return '请填写有效的操作原因。';
  }
  if (/post_not_editable/.test(normalized)) {
    return '这条动态当前无法编辑。';
  }
  if (/post_has_content|comment_has_content/.test(normalized)) {
    return '内容不能为空，请填写文字或保留图片。';
  }
  if (/post_body_limit/.test(normalized)) {
    return '动态正文不能超过 5000 字。';
  }
  if (/comment_body_limit/.test(normalized)) {
    return '评论内容不能超过 2000 字。';
  }
  if (/origin_not_allowed/.test(normalized)) {
    return '当前访问来源未被允许调用后台管理接口。';
  }
  if (/\bunauthorized\b/.test(normalized)) {
    return '登录状态已失效，请重新登录。';
  }
  if (/\bforbidden\b|42501|row-level security/.test(normalized)) {
    return '当前账号没有执行此操作的权限。';
  }
  if (hasChinese.test(message)) return message;
  return fallback;
}
