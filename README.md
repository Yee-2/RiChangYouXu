# Renewly

Cloud-synced, bilingual (`zh-CN` / `en`) subscription management & renewal reminder PWA built with React 19, TypeScript, Vite, Supabase, and Cloudflare Workers.

## Features

- **Cloud-First Subscription Workspace**: Sign in via email OTP or password (`supabase.auth`). All subscriptions, categories, payment methods, renewal events, and user preferences sync to Supabase PostgreSQL with Row Level Security (RLS).
- **4-Tab Interface**:
  - **Overview (`overview`)**: Monthly/yearly spending totals converted to your base currency (`CNY`, `USD`, `EUR`, `HKD`, `JPY`, `GBP`), active/trial counts, 7-day due count, monthly savings from paused/cancelled plans, category donut breakdown, and upcoming 30-day renewals.
  - **Subscriptions (`subscriptions`)**: Search, status filtering, **AI Smart Capture** (paste a billing SMS/email or upload/paste a receipt screenshot or PDF in the Add Subscription sheet to auto-fill details via Gemini), quick subscription templates (`subscription_templates`), custom billing cycles (`week` / `month` / `quarter` / `year` / `custom`), trial tracking, **In-App Renewal Checkout** (`renew_subscription` with smart date rollover, multi-cycle presets, payment method selection, custom amount, and receipt view), pause/resume/cancel actions, payment method tagging, and event history.
  - **Calendar (`calendar`)**: Monthly renewal calendar highlighting recurring charge dates and daily renewal totals.
  - **Settings (`settings`)**: Bilingual switcher (`zh-CN` / `en`), base currency preference with live exchange rate refresh (`refresh-exchange-rates`), light/dark/system theme, default reminder days, email reminder toggle, custom categories & payment methods manager, CSV import/export, and account security (profile, password, sign out, account deletion).
- **Automated Reminders & Rollovers**: Scheduled `pg_cron` jobs automatically roll over due renewals (`renewly-rollover-due`), refresh Frankfurter FX rates (`renewly-refresh-rates`), and dispatch daily bilingual reminder emails (`renewly-send-reminders` via Resend).
- **Admin Console**: Dedicated operator portal on `https://renewly-admin.yeecc.cn` with platform overview metrics, subscription template management, user moderation (suspend/restore/ban/unban), admin role governance, and moderation audit logs.

## Production Domains

- **Main App**: `https://renewly.yeecc.cn` (legacy alias `https://daily.yeecc.cn` preserved in `wrangler.toml`)
- **Admin Console**: `https://renewly-admin.yeecc.cn` (legacy alias `https://admin.yeecc.cn`; `/#/admin` on main origins redirects to `https://renewly-admin.yeecc.cn/`)

## Project Structure

- `src/App.tsx` — Main application shell, cloud state sync, CSV import/export, routing, and toast notifications
- `src/subscriptions.tsx` — Overview, Subscriptions, Calendar, subscription form/detail sheets, and category/payment-method modals
- `src/gemini.ts` — Client helper for Gemini-powered Smart Receipt & Text Capture (`prepareReceiptAttachment` and `parseSubscriptionWithGemini`)
- `src/account.tsx` — Auth screen (OTP / password sign-in & sign-up), profile, security/password setup, and account deletion
- `src/i18n.ts` — Bilingual (`zh-CN` / `en`) dictionary and formatting helpers
- `src/AdminPortal.tsx` & `src/AdminPanel.tsx` — Dedicated Admin login and 5-desk console (`overview`, `templates`, `users`, `admins`, `audit`)
- `supabase/migrations/` — Postgres schema, RLS policies, RPCs, triggers, seeds, and `pg_cron` schedules
- `supabase/functions/` — `admin-manage`, `admin-moderate`, `delete-account`, `parse-subscription`, `send-renewal-reminders`, `refresh-exchange-rates`
- `supabase/templates/` — Branded bilingual auth email templates (`confirmation.html`, `magic_link.html`, `recovery.html`)

## Local Development

```bash
npm install
```

Create `.env.local` with your Supabase project credentials:

```env
VITE_SUPABASE_URL=https://obyqyzgycivgituobdzm.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Start the dev server or build for production:

```bash
npm run dev
npm run build
npm run preview
```

## Backend & Deployment Setup

### 1. Supabase Secrets

Automated reminder emails use [Resend](https://resend.com), and AI Smart Capture uses the [Gemini API](https://ai.google.dev/) (defaults to Free Tier `gemini-3.5-flash-lite` via `@google/genai` Interactions API, with an in-app model selector and optional `GEMINI_MODEL` secret override). Set `RESEND_API_KEY` and `GEMINI_API_KEY` as Supabase Edge Function secrets (without `RESEND_API_KEY`, `send-renewal-reminders` safely returns `resendConfigured: false`; without `GEMINI_API_KEY`, `parse-subscription` returns `503 gemini_not_configured`):

```bash
npx supabase secrets set RESEND_API_KEY=re_xxxxxxxxx GEMINI_API_KEY=AIzaSyxxxxxxxxx
```

### 2. Deploy Edge Functions & Auth Config

```bash
npx supabase functions deploy admin-manage --use-api --yes
npx supabase functions deploy admin-moderate --use-api --yes
npx supabase functions deploy delete-account --use-api --yes
npx supabase functions deploy parse-subscription --use-api --yes
npx supabase functions deploy send-renewal-reminders --use-api --yes
npx supabase functions deploy refresh-exchange-rates --use-api --yes
npx supabase config push --yes
```

### 3. Cloudflare Workers Deployment

Cloudflare Workers Builds watches pushes to `main`, builds with `npm run build`, and deploys `dist/` using `wrangler.toml` (`name = "richangyouxu"`, `not_found_handling = "single-page-application"`).
