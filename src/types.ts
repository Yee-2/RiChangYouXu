export type Locale = 'zh-CN' | 'en';
export type CurrencyCode = 'CNY' | 'USD' | 'EUR' | 'HKD' | 'JPY' | 'GBP';
export type ThemeChoice = 'system' | 'light' | 'dark';
export type NavKey = 'overview' | 'subscriptions' | 'calendar' | 'settings';
export type BillingInterval = 'week' | 'month' | 'quarter' | 'year' | 'custom';
export type SubscriptionStatus = 'trial' | 'active' | 'paused' | 'cancelled';
export type PaymentType = 'alipay' | 'wechat' | 'card' | 'apple_pay' | 'paypal' | 'bank' | 'other' | 'wallet';

export interface Profile {
  id: string;
  uid?: string;
  username: string | null;
  display_name: string;
  avatar_path: string | null;
  avatar_url?: string;
  bio: string;
  role: 'user' | 'admin';
  account_status: 'active' | 'suspended' | 'banned' | 'deleted';
  suspension_expires_at?: string | null;
}

export interface Category {
  id: string;
  user_id: string;
  key: string;
  name: string;
  name_en: string;
  color: string;
  icon: string;
  sort: number;
  created_at: string;
}

export interface PaymentMethod {
  id: string;
  user_id: string;
  name: string;
  name_en: string;
  type: PaymentType;
  last4: string | null;
  created_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  name: string;
  color: string;
  icon: string;
  amount: number;
  currency: CurrencyCode;
  interval: BillingInterval;
  interval_count: number;
  start_date: string;
  next_renewal_date: string;
  status: SubscriptionStatus;
  trial_end_date: string | null;
  auto_renew: boolean;
  category_id: string | null;
  payment_method_id: string | null;
  url: string;
  cancel_url: string;
  note: string;
  reminder_days: number;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionEvent {
  id: string;
  subscription_id: string;
  user_id: string;
  type: 'charge' | 'price_change' | 'status_change';
  amount: number;
  currency: CurrencyCode;
  occurred_on: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface UserSettings {
  user_id: string;
  locale: Locale;
  base_currency: CurrencyCode;
  theme: ThemeChoice;
  email_reminders: boolean;
  default_reminder_days: number;
  updated_at: string;
}

export interface ExchangeRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number;
  fetched_on: string;
  updated_at: string;
}

export interface SubscriptionTemplate {
  id: string;
  name: string;
  name_en: string;
  color: string;
  icon: string;
  category_key: string;
  default_amount: number;
  currency: CurrencyCode;
  interval: 'week' | 'month' | 'quarter' | 'year';
  url: string;
  cancel_url: string;
  sort: number;
  created_at: string;
}

export interface AdminOverviewMetrics {
  totalUsers: number;
  activeSubscriptions: number;
  totalTemplates: number;
  remindersSentToday: number;
  remindersFailedToday: number;
  restrictedAccounts: number;
}

export type ExtractionConfidence = 'high' | 'medium' | 'low';
export type GeminiModelId =
  | 'gemini-3.5-flash-lite'
  | 'gemini-3.8-flash'
  | 'gemini-4-hydrogen'
  | 'gemini-4-argon'
  | 'gemini-4-carbon';

export interface ParsedSubscriptionDraft {
  name: string;
  amount: number;
  currency: CurrencyCode;
  interval: BillingInterval;
  interval_count: number;
  start_date: string;
  is_trial: boolean;
  trial_end_date: string | null;
  auto_renew: boolean;
  category_id: string | null;
  payment_method_id: string | null;
  color: string;
  icon: string;
  url: string;
  cancel_url: string;
  note: string;
  confidence: ExtractionConfidence;
}

export interface ParseSubscriptionResult {
  model: string;
  found: boolean;
  summary: string;
  items: ParsedSubscriptionDraft[];
}
