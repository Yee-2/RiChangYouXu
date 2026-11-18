# Renewly Product Requirements & Architecture Baseline

This document summarizes the implemented **Renewly** subscription management application (`v0.2.0`), superseding the earlier local-first daily checklist/utility baseline.

## 1. Product Positioning

- **Name**: Renewly
- **Architecture**: Cloud-synced SaaS / PWA (authenticated users read & write directly to Supabase Postgres; legacy local IndexedDB `idb` storage, checklists, departure checks, utility meters, pets, and community modules are removed from the application).
- **Visual System**: Clean fintech card aesthetic (`#F7F7FB` light surface, `#0F111A` dark surface, `#5B5BF0` indigo-violet primary accent), responsive desktop layout and mobile bottom navigation.
- **Localization**: First-class bilingual support (`zh-CN` default for mainland users and `en`), synchronized across UI copy, categories, payment methods, templates, and reminder emails.

## 2. Core Functional Requirements (Implemented)

| Module | Scope & Implementation |
| --- | --- |
| Authentication & Account | Supabase GoTrue OTP + Password authentication (`src/account.tsx`); profile editing, password creation/reset, sign-out, self-service permanent deletion (`delete-account`). |
| Subscription CRUD & Templates | Full lifecycle (`trial`, `active`, `paused`, `cancelled`), billing intervals (`week`, `month`, `quarter`, `year`, `custom`), category & payment method links, event logging (`subscription_events`), 12 seeded `subscription_templates`. |
| Multi-Currency & Analytics | 6 supported currencies (`CNY`, `USD`, `EUR`, `HKD`, `JPY`, `GBP`), 36 pairwise rates in `exchange_rates`, daily Frankfurter sync (`refresh-exchange-rates`), server-side SQL aggregation (`get_spending_summary`). |
| Calendar & Reminders | Monthly projection grid (`CalendarTab`), in-app urgency badges, configurable lead days, daily rollover (`process_due_subscriptions`), daily Resend email dispatch (`send-renewal-reminders`), and idempotent `reminder_log`. |
| Data Portability | Client-side UTF-8 CSV export and validated CSV import (`src/App.tsx`). |
| Operations & Governance | Dedicated admin host (`https://renewly-admin.yeecc.cn`), platform KPIs (`overview`), global `subscription_templates` CRUD, user moderation (`admin-moderate`), admin role governance (`admin-manage`), and `moderation_audit`. |

## 3. Infrastructure & Hosting

- **Database & Auth**: Supabase (`obyqyzgycivgituobdzm`), hardened with RLS on all user/admin tables, explicit `SET search_path` on Postgres functions, and `pg_cron` background jobs (`renewly-rollover-due`, `renewly-refresh-rates`, `renewly-send-reminders`).
- **Frontend Hosting**: Cloudflare Workers (`richangyouxu`) serving Vite SPA assets (`dist/`) with custom domain bindings for `renewly.yeecc.cn`, `renewly-admin.yeecc.cn`, `daily.yeecc.cn`, and `admin.yeecc.cn`.
- **Legacy Database Compatibility**: Pre-existing non-subscription tables on the shared Supabase database were preserved non-destructively while their frontend surfaces and unused `delete-content` Edge Function were removed.
