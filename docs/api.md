# Renewly API & Backend Reference

Supabase project ref: `obyqyzgycivgituobdzm` (`https://obyqyzgycivgituobdzm.supabase.co`).

All client data queries go through `@supabase/supabase-js` with JWT-authenticated Row Level Security (RLS), Postgres RPCs, and Supabase Edge Functions.

## 1. Authentication

Auth uses Supabase GoTrue (`/auth/v1/*`) configured in `supabase/config.toml` with site URL `https://renewly.yeecc.cn` and branded templates in `supabase/templates/`.

- Email OTP sign-in & sign-up (`signInWithOtp` / `verifyOtp`)
- Email + Password sign-in (`signInWithPassword`) and password recovery/setup (`resetPasswordForEmail` + `verifyOtp(type: 'recovery')` + `updateUser({ password })`)
- Sign out (`signOut({ scope: 'local' })`)

## 2. Database Tables (`public`)

### User-Owned Subscription Tables (RLS: user owns rows & must be `active` to mutate)

- **`categories`**
  - Columns: `id` (uuid PK), `user_id` (uuid), `key` (text), `name` (text), `name_en` (text), `color` (text), `icon` (text), `sort` (integer), `created_at` (timestamptz)
  - RLS: `SELECT` own rows; `INSERT`/`UPDATE`/`DELETE` own rows when account is active.
- **`payment_methods`**
  - Columns: `id` (uuid PK), `user_id` (uuid), `name` (text), `name_en` (text), `type` (`alipay|wechat|card|apple_pay|paypal|bank|other|wallet`), `last4` (text), `created_at` (timestamptz)
  - RLS: `SELECT` own rows; `INSERT`/`UPDATE`/`DELETE` own rows when account is active.
- **`subscriptions`**
  - Columns: `id` (uuid PK), `user_id` (uuid), `name` (text), `color` (text), `icon` (text), `amount` (numeric), `currency` (`CNY|USD|EUR|HKD|JPY|GBP`), `interval` (`week|month|quarter|year|custom`), `interval_count` (integer), `start_date` (date), `next_renewal_date` (date), `status` (`trial|active|paused|cancelled`), `trial_end_date` (date), `auto_renew` (boolean), `category_id` (uuid FK), `payment_method_id` (uuid FK), `url` (text), `cancel_url` (text), `note` (text), `reminder_days` (integer), `cancelled_at` (timestamptz), `created_at` (timestamptz), `updated_at` (timestamptz)
  - Triggers: `subscriptions_before_write` (normalizes dates/status/cancelled_at), `subscriptions_after_write` (writes audit events to `subscription_events`).
  - RLS: `SELECT` own rows; `INSERT`/`UPDATE`/`DELETE` own rows when account is active.
- **`subscription_events`**
  - Columns: `id` (uuid PK), `subscription_id` (uuid FK), `user_id` (uuid), `type` (text), `amount` (numeric), `currency` (text), `occurred_on` (date), `meta` (jsonb), `created_at` (timestamptz)
  - RLS: `SELECT`, `INSERT`, `DELETE` own rows (`INSERT`/`DELETE` when active).
- **`user_settings`**
  - Columns: `user_id` (uuid PK), `locale` (`zh-CN|en`), `base_currency` (`CNY|USD|EUR|HKD|JPY|GBP`), `theme` (`system|light|dark`), `email_reminders` (boolean), `default_reminder_days` (integer), `updated_at` (timestamptz)
  - RLS: `SELECT`, `INSERT`, `UPDATE` own row (`auth.uid() = user_id`).
- **`reminder_log`**
  - Columns: `id` (uuid PK), `subscription_id` (uuid FK), `user_id` (uuid), `remind_for_date` (date), `sent_at` (timestamptz), `status` (text), `error_message` (text)
  - RLS: `SELECT` for row owner or admins. Writes are performed server-side by `send-renewal-reminders` using `service_role`.

### Reference & Catalog Tables

- **`exchange_rates`**
  - Columns: `base` (text), `quote` (text), `rate` (numeric), `fetched_on` (date), `updated_at` (timestamptz)
  - Seeded with 36 (`6 x 6`) pairs across `CNY`, `USD`, `EUR`, `HKD`, `JPY`, `GBP`.
  - RLS: publicly readable (`SELECT`). Refreshed via `refresh-exchange-rates`.
- **`subscription_templates`**
  - Columns: `id` (uuid PK), `name` (text), `name_en` (text), `color` (text), `icon` (text), `category_key` (text), `default_amount` (numeric), `currency` (text), `interval` (text), `url` (text), `cancel_url` (text), `sort` (integer), `created_at` (timestamptz)
  - Seeded with 12 templates.
  - RLS: publicly readable (`SELECT`); admins (`admin_accounts`) may `INSERT`, `UPDATE`, `DELETE`.

### Account & Admin Tables

- **`profiles`**: `id`, `username`, `display_name`, `avatar_path`, `bio`, `role`, `account_status`, `created_at`, `updated_at`, `suspension_expires_at`, `uid`
- **`user_auth_settings`**: `user_id`, `password_set`, `updated_at`
- **`admin_accounts`**: `user_id`, `email`, `created_at`, `created_by`
- **`moderation_audit`**: `id`, `actor_id`, `action`, `target_type`, `target_id`, `reason`, `metadata`, `created_at`

## 3. PostgreSQL RPC Functions (`public`)

- **`calculate_next_renewal_date(p_start_date date, p_interval text, p_interval_count integer, p_from_date date) -> date`**
  Computes the next billing date on or after `p_from_date` for `week`, `month`, `quarter`, `year`, or `custom` (days).
- **`get_spending_summary(p_base_currency text DEFAULT 'CNY') -> jsonb`**
  Returns normalized spending summary in `p_base_currency`:
  ```json
  {
    "base_currency": "CNY",
    "monthly_total": 128.50,
    "yearly_total": 1542.00,
    "saved_monthly": 30.00,
    "due_7d_count": 2,
    "trial_count": 1,
    "active_count": 5,
    "by_category": [{ "category_id": "...", "name": "...", "name_en": "...", "color": "...", "monthly_amount": 60.00 }],
    "upcoming": [{ "id": "...", "name": "...", "color": "...", "icon": "...", "amount": 25, "currency": "CNY", "status": "active", "next_renewal_date": "2026-11-21", "trial_end_date": null, "days_until": 3 }]
  }
  ```
- **`ensure_user_defaults() -> void`**
  Idempotently ensures the calling authenticated user has default `categories`, `payment_methods`, and `user_settings`.
- **`seed_defaults_for_user(p_user_id uuid) -> void`**
  Called automatically on signup (`handle_new_user`) to seed default categories, payment methods, and settings.
- **`process_due_subscriptions() -> integer`**
  Advances past-due active subscriptions (`auto_renew = true`) to the next billing date and logs renewal events. Scheduled daily via `pg_cron`.
- **`renew_subscription(p_subscription_id uuid, p_cycles integer DEFAULT 1, p_amount numeric DEFAULT NULL, p_payment_method_id uuid DEFAULT NULL, p_note text DEFAULT NULL) -> jsonb`**
  Atomically performs an in-app renewal for the authenticated active user: extends `next_renewal_date` from the existing due date (when active/trial and not expired) or resets from today (`Asia/Shanghai`) across `p_cycles` cycles, sets status to `active`, writes a `charge` event to `public.subscription_events` with `meta.in_app_renewal = true`, and returns `{ "subscription": ..., "event": ... }`.
- **`verify_cron_secret(p_secret text) -> boolean`**
  Validates internal `x-cron-secret` header against `private.cron_secrets` (service-only).

## 4. Edge Functions (`/functions/v1/<name>`)

| Function | JWT Required | Auth / Caller | Purpose & Actions |
| --- | --- | --- | --- |
| `admin-manage` | Yes | Active admin in `admin_accounts`; CORS restricted (`renewly-admin.yeecc.cn`, `renewly.yeecc.cn`, `admin.yeecc.cn`, `daily.yeecc.cn`, `localhost:5173`) | Actions: `verify`, `overview` (returns `totalUsers`, `activeSubscriptions`, `totalTemplates`, `remindersSentToday`, `remindersFailedToday`, `restrictedAccounts`), `list_accounts`, `list_admins`, `list_users`, `find_account`, `grant_admin`, `revoke_admin`, `reset_admin_password` |
| `admin-moderate` | Yes | Active admin in `admin_accounts` | `targetType: "user"`, `actions`: `suspend_user` (`24 \| 168 \| 720` hours), `restore_user`, `ban_user`, `unban_user` (writes `profiles`, `auth.admin.updateUserById`, and `moderation_audit`) |
| `delete-account` | Yes | Authenticated non-admin user (`{ confirmation: "DELETE" }`) | Permanently deletes `auth.users` row, cascading across user's subscriptions, categories, payment methods, events, settings, reminders, and profile |
| `send-renewal-reminders` | No (`x-cron-secret` or Admin JWT) | `pg_cron` or active admin | Queries active/trial subscriptions within `reminder_days`, respects `user_settings.email_reminders` and `locale`, deduplicates via `reminder_log`, and sends bilingual emails via Resend (`RESEND_API_KEY`, sender `Renewly <no-reply@yeecc.cn>`) |
| `refresh-exchange-rates` | No (`x-cron-secret` or User JWT) | `pg_cron` or authenticated user | Fetches live FX rates from `api.frankfurter.dev` (fallback `api.frankfurter.app`) and upserts all 36 `base`/`quote` pairs into `public.exchange_rates` |

## 5. Scheduled Jobs (`pg_cron`)

- `renewly-rollover-due` (`5 16 * * *` UTC / `00:05 UTC+8`): executes `public.process_due_subscriptions()`.
- `renewly-refresh-rates` (`15 16 * * *` UTC / `00:15 UTC+8`): triggers `refresh-exchange-rates`.
- `renewly-send-reminders` (`0 1 * * *` UTC / `09:00 UTC+8`): triggers `send-renewal-reminders`.
