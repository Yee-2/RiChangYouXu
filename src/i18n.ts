import type {
  BillingInterval,
  Category,
  CurrencyCode,
  Locale,
  PaymentMethod,
  Subscription,
  SubscriptionStatus,
  SubscriptionTemplate,
} from './types';

export const CURRENCIES: Array<{ code: CurrencyCode; symbol: string; zh: string; en: string }> = [
  { code: 'CNY', symbol: '¥', zh: '人民币 (CNY)', en: 'CNY (¥)' },
  { code: 'USD', symbol: '$', zh: '美元 (USD)', en: 'USD ($)' },
  { code: 'EUR', symbol: '€', zh: '欧元 (EUR)', en: 'EUR (€)' },
  { code: 'HKD', symbol: 'HK$', zh: '港元 (HKD)', en: 'HKD (HK$)' },
  { code: 'JPY', symbol: '¥', zh: '日元 (JPY)', en: 'JPY (¥)' },
  { code: 'GBP', symbol: '£', zh: '英镑 (GBP)', en: 'GBP (£)' },
];

export const BRAND_COLORS = [
  '#5B5BF0',
  '#7C3AED',
  '#E50914',
  '#1DB954',
  '#3B82F6',
  '#10A37F',
  '#F59E0B',
  '#EC4899',
  '#FF6A00',
  '#0F172A',
];

export const BRAND_ICONS = [
  'sparkles',
  'tv',
  'music',
  'cloud',
  'play_circle',
  'briefcase',
  'code',
  'layers',
  'shopping_bag',
  'heart',
  'credit_card',
  'globe',
];

export function currencySymbol(currency: string): string {
  return CURRENCIES.find((item) => item.code === currency)?.symbol ?? `${currency} `;
}

export function formatMoney(amount: number, currency: string, _locale: Locale = 'zh-CN'): string {
  const sym = currencySymbol(currency);
  const abs = Math.abs(Number(amount) || 0);
  const digits = currency === 'JPY' ? 0 : 2;
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return amount < 0 ? `-${sym} ${formatted}` : `${sym} ${formatted}`;
}

export function buildRateMap(rates: Array<{ base: string; quote: string; rate: number }>) {
  const map = new Map<string, number>();
  for (const r of rates) {
    map.set(`${r.base}:${r.quote}`, Number(r.rate));
  }
  return map;
}

export function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  ratesMap: Map<string, number>
): number {
  if (!Number.isFinite(amount)) return 0;
  if (fromCurrency === toCurrency) return amount;
  const direct = ratesMap.get(`${fromCurrency}:${toCurrency}`);
  if (direct && Number.isFinite(direct)) return amount * direct;
  const toCny = ratesMap.get(`${fromCurrency}:CNY`);
  const cnyToTarget = ratesMap.get(`CNY:${toCurrency}`);
  if (toCny && cnyToTarget) return amount * toCny * cnyToTarget;
  return amount;
}

export function toMonthlyAmount(amount: number, interval: BillingInterval, intervalCount = 1): number {
  const count = Math.max(1, Number(intervalCount) || 1);
  switch (interval) {
    case 'week':
      return (amount * (52 / 12)) / count;
    case 'month':
      return amount / count;
    case 'quarter':
      return amount / (3 * count);
    case 'year':
      return amount / (12 * count);
    case 'custom':
    default:
      return (amount * 30.4375) / count;
  }
}

export function localTodayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00.000Z`);
  const b = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function addDaysKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function addMonthsClamped(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  const totalMonths = y * 12 + (m - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const maxDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const clampedDay = Math.min(d, maxDay);
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

export function previewRenewalSchedule(
  sub: Pick<Subscription, 'status' | 'next_renewal_date' | 'trial_end_date' | 'interval' | 'interval_count'>,
  cycles = 1,
  todayKey = localTodayKey()
): { currentDue: string; baseDate: string; nextRenewalDate: string; isExtend: boolean } {
  const count = Math.max(1, Math.min(60, Math.floor(cycles || 1)));
  const step = count * Math.max(1, Number(sub.interval_count) || 1);
  const currentDue = sub.status === 'trial' && sub.trial_end_date ? sub.trial_end_date : sub.next_renewal_date;
  const isExtend = (sub.status === 'active' || sub.status === 'trial') && currentDue >= todayKey;
  const baseDate = isExtend ? currentDue : todayKey;

  let nextRenewalDate: string;
  if (sub.interval === 'week') {
    nextRenewalDate = addDaysKey(baseDate, step * 7);
  } else if (sub.interval === 'month') {
    nextRenewalDate = addMonthsClamped(baseDate, step);
  } else if (sub.interval === 'quarter') {
    nextRenewalDate = addMonthsClamped(baseDate, step * 3);
  } else if (sub.interval === 'year') {
    nextRenewalDate = addMonthsClamped(baseDate, step * 12);
  } else {
    nextRenewalDate = addDaysKey(baseDate, step);
  }

  return { currentDue, baseDate, nextRenewalDate, isExtend };
}

export function renewalDurationLabel(
  interval: BillingInterval,
  intervalCount: number,
  cycles: number,
  locale: Locale
): string {
  const count = Math.max(1, Number(intervalCount) || 1);
  if (interval === 'custom') {
    const totalDays = cycles * count;
    return locale === 'en' ? `${totalDays}d` : `${totalDays} 天`;
  }
  if (count === 1) {
    if (locale === 'en') {
      const unit = interval === 'week' ? 'wk' : interval === 'month' ? 'mo' : interval === 'quarter' ? 'qtr' : 'yr';
      return `${cycles} ${unit}${cycles > 1 ? 's' : ''}`;
    }
    const unit = interval === 'week' ? '周' : interval === 'month' ? '个月' : interval === 'quarter' ? '个季度' : '年';
    return `${cycles} ${unit}`;
  }
  return locale === 'en'
    ? `${cycles}×${cycleLabel(interval, count, locale)}`
    : `${cycles} × ${cycleLabel(interval, count, locale)}`;
}

export function formatShortDate(dateStr: string, locale: Locale): string {
  const dt = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return dateStr;
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(dt);
}

export function getGreeting(locale: Locale, now = new Date()): string {
  const h = now.getHours();
  if (locale === 'en') {
    if (h >= 5 && h < 12) return 'Good morning';
    if (h >= 12 && h < 18) return 'Good afternoon';
    return 'Good evening';
  }
  if (h >= 5 && h < 11) return '早上好';
  if (h >= 11 && h < 14) return '中午好';
  if (h >= 14 && h < 18) return '下午好';
  if (h >= 18 && h < 23) return '晚上好';
  return '夜深了';
}

export function categoryDisplayName(cat: Pick<Category, 'name' | 'name_en'> | null | undefined, locale: Locale): string {
  if (!cat) return locale === 'en' ? 'Other' : '其他订阅';
  return locale === 'en' && cat.name_en.trim() ? cat.name_en : cat.name;
}

export function paymentDisplayName(pm: Pick<PaymentMethod, 'name' | 'name_en' | 'last4'> | null | undefined, locale: Locale): string {
  if (!pm) return locale === 'en' ? 'Unassigned' : '未指定';
  const base = locale === 'en' && pm.name_en.trim() ? pm.name_en : pm.name;
  return pm.last4 ? `${base} · ${pm.last4}` : base;
}

export function templateDisplayName(tpl: Pick<SubscriptionTemplate, 'name' | 'name_en'>, locale: Locale): string {
  return locale === 'en' && tpl.name_en.trim() ? tpl.name_en : tpl.name;
}

export function cycleLabel(interval: BillingInterval, intervalCount: number, locale: Locale): string {
  const count = Math.max(1, intervalCount || 1);
  if (locale === 'en') {
    if (count === 1) {
      return interval === 'week' ? 'Weekly' : interval === 'month' ? 'Monthly' : interval === 'quarter' ? 'Quarterly' : interval === 'year' ? 'Yearly' : 'Every day';
    }
    return interval === 'week' ? `Every ${count}w` : interval === 'month' ? `Every ${count}m` : interval === 'quarter' ? `Every ${count * 3}m` : interval === 'year' ? `Every ${count}y` : `Every ${count}d`;
  }
  if (count === 1) {
    return interval === 'week' ? '每周' : interval === 'month' ? '每月' : interval === 'quarter' ? '每季' : interval === 'year' ? '每年' : '每天';
  }
  return interval === 'week' ? `每 ${count} 周` : interval === 'month' ? `每 ${count} 月` : interval === 'quarter' ? `每 ${count} 季` : interval === 'year' ? `每 ${count} 年` : `每 ${count} 天`;
}

export function statusLabel(status: SubscriptionStatus, locale: Locale): string {
  if (locale === 'en') {
    return status === 'trial' ? 'Trial' : status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Cancelled';
  }
  return status === 'trial' ? '试用中' : status === 'active' ? '生效中' : status === 'paused' ? '已暂停' : '已取消';
}

export function getRenewalBadge(
  sub: Pick<Subscription, 'status' | 'next_renewal_date' | 'trial_end_date'>,
  locale: Locale,
  todayKey = localTodayKey()
): { text: string; tone: 'coral' | 'amber' | 'indigo' | 'muted' } {
  if (sub.status === 'paused') return { text: locale === 'en' ? 'Paused' : '已暂停', tone: 'muted' };
  if (sub.status === 'cancelled') return { text: locale === 'en' ? 'Cancelled' : '已取消', tone: 'muted' };

  const targetDate = sub.status === 'trial' && sub.trial_end_date ? sub.trial_end_date : sub.next_renewal_date;
  const days = daysBetween(todayKey, targetDate);

  if (sub.status === 'trial') {
    if (days <= 0) return { text: locale === 'en' ? 'Trial ends today' : '试用今日到期', tone: 'coral' };
    return { text: locale === 'en' ? `Trial · ${days}d left` : `试用 · 剩 ${days} 天`, tone: 'amber' };
  }
  if (days <= 0) return { text: locale === 'en' ? 'Due today' : '今天续费', tone: 'coral' };
  if (days === 1) return { text: locale === 'en' ? 'Tomorrow' : '明天', tone: 'coral' };
  if (days <= 7) return { text: locale === 'en' ? `In ${days}d` : `${days} 天后`, tone: 'coral' };
  return { text: locale === 'en' ? `In ${days}d` : `${days} 天后`, tone: 'indigo' };
}

const zhDict = {
  appName: 'Renewly',
  tagline: '订阅管理助手',
  offlineBanner: '当前处于离线状态：仅可查看最近同步的数据，联网后可新增或修改订阅。',
  loadingApp: '正在加载 Renewly 云端空间…',
  navOverview: '总览',
  navSubscriptions: '订阅',
  navCalendar: '日历',
  navSettings: '设置',
  addSubscription: '添加订阅',
  editSubscription: '编辑订阅',
  saveSubscription: '保存订阅',
  saving: '保存中…',
  cancel: '取消',
  confirm: '确认',
  delete: '删除',
  close: '关闭',
  retry: '重试',
  refresh: '刷新',
  searchPlaceholder: '搜索订阅名称、备注…',
  monthlySpendLabel: '本月订阅支出',
  yearlyEstimateLabel: '年度约',
  totalSubscriptionsUnit: '项有效订阅',
  dueIn7d: '7 天内续费',
  inTrial: '试用中',
  savedThisMonth: '本月已省',
  upcomingRenewals: '即将续费',
  viewAll: '全部订阅',
  noUpcoming: '未来 30 天暂无待续费项目',
  noUpcomingHint: '添加常用订阅后，系统会自动计算续费时间并在到期前提醒你。',
  categoryBreakdown: '分类占比',
  noCategoryData: '添加生效中的订阅后，这里会展示各类别的支出分布。',
  mySubscriptions: '我的订阅',
  filterAll: '全部',
  filterActive: '生效中',
  filterTrial: '试用',
  filterPaused: '已暂停',
  filterCancelled: '已取消',
  monthlyAvg: '月均',
  yearlyTotal: '年度',
  noSubscriptionsTitle: '还没有订阅记录',
  noSubscriptionsDesc: '从 Netflix、Spotify、iCloud+ 等预设模板快速添加，或自定义你的订阅。',
  noMatchTitle: '没有匹配的订阅',
  noMatchDesc: '试试更换搜索关键词或切换筛选状态。',
  quickTemplates: '热门预设',
  customTemplate: '自定义',
  serviceName: '服务名称',
  serviceNamePlaceholder: '例如：Netflix、iCloud+、健身房月卡',
  brandColor: '品牌颜色',
  brandIcon: '图标',
  amount: '金额',
  currency: '币种',
  billingCycle: '计费周期',
  cycleWeek: '周',
  cycleMonth: '月',
  cycleQuarter: '季',
  cycleYear: '年',
  cycleCustom: '自定义(天)',
  customDays: '间隔天数',
  firstBillingDate: '首次扣费日期',
  category: '分类',
  paymentMethod: '支付方式',
  unassigned: '未指定',
  reminderToggle: '续费前提醒我',
  reminderDaysLabel: '提前天数',
  daysBefore: '天',
  trialToggle: '当前为试用期',
  trialEndDate: '试用到期日',
  autoRenewToggle: '自动续费',
  websiteUrl: '官网链接（可选）',
  cancelUrl: '退订链接（可选）',
  note: '备注（可选）',
  notePlaceholder: '记录账号邮箱、权益说明或合租信息…',
  subSaved: '订阅已保存',
  subUpdated: '订阅已更新',
  subDeleted: '订阅已删除',
  subPaused: '已暂停该订阅',
  subResumed: '已恢复该订阅',
  subCancelled: '已取消该订阅',
  chargeLogged: '已记录本次扣费',
  deleteSubConfirm: '确定永久删除这条订阅记录及其历史事件吗？此操作无法撤销。',
  cancelSaveHint: '取消或暂停此订阅，每年预计可节省',
  pauseAction: '暂停',
  resumeAction: '恢复生效',
  cancelSubAction: '取消订阅',
  logChargeAction: '记一笔扣费',
  openWebsite: '打开官网',
  openCancelUrl: '前往退订',
  nextBilling: '下次续费',
  monthlyEquivalent: '折合每月',
  yearlyEquivalent: '折合每年',
  eventHistory: '扣费与变更记录',
  noEvents: '暂无历史记录',
  eventCharge: '扣费记录',
  eventInAppRenewal: '应用内续费',
  eventPriceChange: '价格变更',
  eventStatusChange: '状态变更',
  renewNow: '立即续费',
  renewInApp: '应用内续费',
  renewCheckoutTitle: '续费收银台',
  renewCyclesLabel: '选择续费时长',
  renewCycleUnit: '个周期',
  renewSchedulePreview: '有效期顺延预览',
  renewFromExisting: '未到期 · 从原到期日顺延',
  renewFromToday: '从今日起重新起算',
  renewCurrentDue: '当前到期',
  renewNewDue: '续费后到期',
  renewSelectPayment: '扣款支付方式',
  renewAmountLabel: '本次实付金额',
  renewResetStandard: '恢复标准价',
  renewNoteLabel: '续费备注（可选）',
  renewNotePlaceholder: '例如：年付优惠券、联合会员抵扣…',
  renewConfirmPay: '确认支付并续费',
  renewProcessing: '正在处理续费账单…',
  renewSuccessTitle: '续费已完成',
  renewSuccessDesc: '账单已记录，下次续费日期已自动顺延同步至云端。',
  renewReceiptCycles: '续费期数',
  renewReceiptDone: '完成',
  renewOfficialPortal: '或前往官方页面续费',
  renewCompletedToast: '续费成功，到期日已顺延',
  calendarTitle: '续费日历',
  calendarMonthTotal: '本月预计扣费',
  calendarToday: '回到本月',
  calendarNoRenewals: '这一天没有计划续费的订阅',
  settingsTitle: '设置与偏好',
  accountSection: '账号与云同步',
  preferencesSection: '通用偏好',
  manageSection: '分类、支付与数据',
  languageLabel: '界面语言',
  baseCurrencyLabel: '基准货币',
  fxUpdatedAt: '汇率更新于',
  refreshRates: '刷新汇率',
  ratesRefreshed: '汇率已更新为最新实时数据',
  themeLabel: '外观主题',
  themeSystem: '跟随系统',
  themeLight: '浅色模式',
  themeDark: '深色模式',
  emailRemindersLabel: '续费邮件提醒',
  emailRemindersDesc: '在续费或试用到期前向绑定邮箱发送通知',
  defaultReminderLabel: '默认提前提醒',
  manageCategories: '管理分类',
  manageCategoriesDesc: '添加或删除自定义订阅分类',
  managePayments: '管理支付方式',
  managePaymentsDesc: '维护支付宝、微信、信用卡等扣款方式',
  exportCsv: '导出 CSV 表格',
  exportCsvDesc: '导出当前所有云端订阅明细',
  importCsv: '导入 CSV 表格',
  importCsvDesc: '从表格批量导入订阅到云端',
  csvExported: 'CSV 备份文件已导出',
  csvImported: '导入完成',
  accountSettingsTitle: '账号与安全',
  editProfile: '编辑个人资料',
  changePassword: '修改密码',
  setPassword: '设置密码',
  signOut: '退出登录',
  deleteAccount: '注销账号',
  landingEyebrow: 'CLOUD SUBSCRIPTION TRACKER',
  landingTitle1: '每一笔定期支出，',
  landingTitle2: '都清晰可见。',
  landingSubtitle: 'Renewly 帮你统一追踪流媒体、软件会员、云存储与日常周期账单，云端实时同步、多币种自动换算，并在续费前通过邮件温柔提醒。',
  landingFeature1: '云端多端实时同步',
  landingFeature2: '到期前邮件自动提醒',
  landingFeature3: '6 种主流货币实时换算',
  signInTitle: '登录或创建 Renewly 账号',
  restrictedBanner: '当前账号处于受限状态，仅可查看已有订阅记录，无法新增或修改数据。',
  aiScanBtn: 'AI 识别',
  aiCaptureTitle: 'AI 智能识别账单',
  aiCaptureSubtitle: '粘贴扣费短信/邮件，或上传截图 / PDF 自动填充表单',
  aiCapturePlaceholder: '例如：粘贴 App Store / 支付宝 / 微信 / 邮箱扣费通知，或输入“ChatGPT Plus 每月 20 美元，每月 12 号扣款”…（支持直接粘贴截图）',
  aiAttachFile: '上传截图 / PDF',
  aiExtractAction: '识别并自动填表',
  aiExtracting: 'Gemini 正在识别账单…',
  aiFilledHint: '已自动填充表单，请核对后保存',
  aiMultipleFound: '识别到多项订阅，点击切换填充：',
  aiNothingFound: '未检测到明确的订阅信息，可补充更多文本或清晰截图后重试。',
  aiOfflineHint: '离线状态下暂不可用 AI 识别，联网后即可使用。',
  aiConfidenceHigh: '高置信度',
  aiConfidenceMedium: '请核对',
  aiConfidenceLow: '低置信度',
  aiRemoveAttachment: '移除附件',
  aiModelLabel: '识别模型',
};

const enDict: Record<keyof typeof zhDict, string> = {
  appName: 'Renewly',
  tagline: 'Subscription Tracker',
  offlineBanner: 'You are offline. Cached subscriptions are read-only until you reconnect.',
  loadingApp: 'Loading your Renewly cloud workspace…',
  navOverview: 'Overview',
  navSubscriptions: 'Subscriptions',
  navCalendar: 'Calendar',
  navSettings: 'Settings',
  addSubscription: 'Add Subscription',
  editSubscription: 'Edit Subscription',
  saveSubscription: 'Save Subscription',
  saving: 'Saving…',
  cancel: 'Cancel',
  confirm: 'Confirm',
  delete: 'Delete',
  close: 'Close',
  retry: 'Retry',
  refresh: 'Refresh',
  searchPlaceholder: 'Search subscriptions or notes…',
  monthlySpendLabel: 'Monthly Spend',
  yearlyEstimateLabel: 'Yearly est.',
  totalSubscriptionsUnit: 'active plans',
  dueIn7d: 'Due in 7d',
  inTrial: 'In Trial',
  savedThisMonth: 'Saved / mo',
  upcomingRenewals: 'Upcoming Renewals',
  viewAll: 'View all',
  noUpcoming: 'No renewals in the next 30 days',
  noUpcomingHint: 'Add your active subscriptions to track upcoming billing dates and email alerts.',
  categoryBreakdown: 'Category Breakdown',
  noCategoryData: 'Add active subscriptions to see your monthly spend split by category.',
  mySubscriptions: 'Subscriptions',
  filterAll: 'All',
  filterActive: 'Active',
  filterTrial: 'Trial',
  filterPaused: 'Paused',
  filterCancelled: 'Cancelled',
  monthlyAvg: 'Monthly',
  yearlyTotal: 'Yearly',
  noSubscriptionsTitle: 'No subscriptions yet',
  noSubscriptionsDesc: 'Pick a popular template like Netflix, Spotify, or iCloud+, or add a custom plan.',
  noMatchTitle: 'No matching subscriptions',
  noMatchDesc: 'Try adjusting your search keyword or status filter.',
  quickTemplates: 'Quick Templates',
  customTemplate: 'Custom',
  serviceName: 'Service Name',
  serviceNamePlaceholder: 'e.g. Netflix, iCloud+, Gym membership',
  brandColor: 'Brand Color',
  brandIcon: 'Icon',
  amount: 'Amount',
  currency: 'Currency',
  billingCycle: 'Billing Cycle',
  cycleWeek: 'Week',
  cycleMonth: 'Month',
  cycleQuarter: 'Quarter',
  cycleYear: 'Year',
  cycleCustom: 'Custom (days)',
  customDays: 'Interval (days)',
  firstBillingDate: 'First Billing Date',
  category: 'Category',
  paymentMethod: 'Payment Method',
  unassigned: 'Unassigned',
  reminderToggle: 'Remind me before renewal',
  reminderDaysLabel: 'Days before',
  daysBefore: 'days',
  trialToggle: 'Free trial period',
  trialEndDate: 'Trial End Date',
  autoRenewToggle: 'Auto-renew',
  websiteUrl: 'Website URL (optional)',
  cancelUrl: 'Cancellation Link (optional)',
  note: 'Notes (optional)',
  notePlaceholder: 'Plan tier, account email, sharing notes…',
  subSaved: 'Subscription saved',
  subUpdated: 'Subscription updated',
  subDeleted: 'Subscription deleted',
  subPaused: 'Subscription paused',
  subResumed: 'Subscription resumed',
  subCancelled: 'Subscription cancelled',
  chargeLogged: 'Charge recorded',
  deleteSubConfirm: 'Permanently delete this subscription and its history? This cannot be undone.',
  cancelSaveHint: 'Pausing or cancelling this saves approx.',
  pauseAction: 'Pause',
  resumeAction: 'Resume',
  cancelSubAction: 'Cancel Plan',
  logChargeAction: 'Log Charge',
  openWebsite: 'Website',
  openCancelUrl: 'Cancel Link',
  nextBilling: 'Next Billing',
  monthlyEquivalent: 'Monthly equiv.',
  yearlyEquivalent: 'Yearly equiv.',
  eventHistory: 'Billing & Activity History',
  noEvents: 'No activity recorded yet',
  eventCharge: 'Charge',
  eventInAppRenewal: 'In-App Renewal',
  eventPriceChange: 'Price Change',
  eventStatusChange: 'Status Change',
  renewNow: 'Renew',
  renewInApp: 'In-App Renewal',
  renewCheckoutTitle: 'Renewal Checkout',
  renewCyclesLabel: 'Renewal Duration',
  renewCycleUnit: 'cycles',
  renewSchedulePreview: 'Validity Rollover Preview',
  renewFromExisting: 'Active · Extends from due date',
  renewFromToday: 'Starts fresh from today',
  renewCurrentDue: 'Current Due',
  renewNewDue: 'New Due Date',
  renewSelectPayment: 'Payment Method',
  renewAmountLabel: 'Total Payment',
  renewResetStandard: 'Reset standard price',
  renewNoteLabel: 'Renewal Note (optional)',
  renewNotePlaceholder: 'e.g. Promo code, bundle discount…',
  renewConfirmPay: 'Confirm & Renew',
  renewProcessing: 'Processing renewal…',
  renewSuccessTitle: 'Renewal Complete',
  renewSuccessDesc: 'Payment recorded and next billing date synced to the cloud.',
  renewReceiptCycles: 'Cycles Renewed',
  renewReceiptDone: 'Done',
  renewOfficialPortal: 'Or open official billing page',
  renewCompletedToast: 'Renewed successfully',
  calendarTitle: 'Renewal Calendar',
  calendarMonthTotal: 'Scheduled this month',
  calendarToday: 'This Month',
  calendarNoRenewals: 'No renewals scheduled on this day',
  settingsTitle: 'Settings',
  accountSection: 'Account & Cloud Sync',
  preferencesSection: 'Preferences',
  manageSection: 'Categories, Payments & Data',
  languageLabel: 'Language',
  baseCurrencyLabel: 'Base Currency',
  fxUpdatedAt: 'FX rates updated',
  refreshRates: 'Refresh FX',
  ratesRefreshed: 'Exchange rates updated',
  themeLabel: 'Appearance',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  emailRemindersLabel: 'Email Reminders',
  emailRemindersDesc: 'Send email alerts before renewals and trial expirations',
  defaultReminderLabel: 'Default Lead Time',
  manageCategories: 'Categories',
  manageCategoriesDesc: 'Create or remove subscription categories',
  managePayments: 'Payment Methods',
  managePaymentsDesc: 'Manage cards, Alipay, WeChat Pay, Apple Pay',
  exportCsv: 'Export CSV',
  exportCsvDesc: 'Download all cloud subscriptions as CSV',
  importCsv: 'Import CSV',
  importCsvDesc: 'Import subscriptions from a CSV file',
  csvExported: 'CSV exported',
  csvImported: 'Import complete',
  accountSettingsTitle: 'Account & Security',
  editProfile: 'Edit Profile',
  changePassword: 'Change Password',
  setPassword: 'Set Password',
  signOut: 'Sign Out',
  deleteAccount: 'Delete Account',
  landingEyebrow: 'CLOUD SUBSCRIPTION TRACKER',
  landingTitle1: 'Every recurring charge,',
  landingTitle2: 'effortlessly clear.',
  landingSubtitle: 'Track streaming, software, cloud storage, and recurring bills in one calm workspace—synced in the cloud with live multi-currency conversion and email renewal reminders.',
  landingFeature1: 'Real-time cloud sync',
  landingFeature2: 'Email alerts before renewal',
  landingFeature3: '6 currencies with live FX',
  signInTitle: 'Sign in or create a Renewly account',
  restrictedBanner: 'Your account is restricted. You can view existing subscriptions, while edits are disabled.',
  aiScanBtn: 'AI Scan',
  aiCaptureTitle: 'AI Smart Capture',
  aiCaptureSubtitle: 'Paste billing SMS/email or upload a receipt image / PDF to auto-fill',
  aiCapturePlaceholder: 'Paste an App Store, Stripe, or email receipt, or type e.g. "ChatGPT Plus $20/mo billed on the 12th"… (or paste a screenshot)',
  aiAttachFile: 'Attach Image / PDF',
  aiExtractAction: 'Extract & Auto-Fill',
  aiExtracting: 'Extracting with Gemini…',
  aiFilledHint: 'Form auto-filled — review details before saving',
  aiMultipleFound: 'Multiple subscriptions detected — select one to fill:',
  aiNothingFound: 'No clear subscription details found. Try adding more text or a clearer receipt.',
  aiOfflineHint: 'AI capture requires an internet connection.',
  aiConfidenceHigh: 'High confidence',
  aiConfidenceMedium: 'Review suggested',
  aiConfidenceLow: 'Low confidence',
  aiRemoveAttachment: 'Remove attachment',
  aiModelLabel: 'AI Model',
};

export type DictKey = keyof typeof zhDict;

export function t(locale: Locale, key: DictKey): string {
  return locale === 'en' ? enDict[key] : zhDict[key];
}
