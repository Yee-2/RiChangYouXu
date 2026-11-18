# Renewly Product Guide

Renewly is a cloud-synced personal subscription manager and renewal reminder PWA designed for clarity across currencies, billing cycles, and languages (`zh-CN` / `en`).

## 1. User Workflows

### Sign In & Onboarding
- Open `https://renewly.yeecc.cn` and sign in with email + password or email OTP verification code.
- New accounts are automatically provisioned via database triggers with default bilingual categories, common payment methods (Alipay, WeChat Pay, Credit/Debit Card, Apple Pay, etc.), and user settings (`locale: zh-CN`, `base_currency: CNY`, `theme: system`, `email_reminders: true`, `default_reminder_days: 3`).
- Use the top-right language pill (`中文` / `EN`) or the Theme toggle (`light` / `dark` / `system`) at any time; signed-in preferences persist to `user_settings` in the cloud.

### Overview (`overview`)
- **Spending Summary Hero**: View normalized **Monthly Total** and **Yearly Projection** in your chosen base currency, alongside **7-Day Due Count**, **Active / Trial Count**, and **Saved This Month** (monthly equivalent of recently paused or cancelled subscriptions).
- **Category Breakdown**: Interactive donut chart grouping active & trial recurring spend by category.
- **Upcoming Renewals (30 Days)**: Sorted agenda of imminent renewals and trial expirations with due badges (`Today`, `Tomorrow`, `N days`).

### Subscriptions (`subscriptions`)
- **Quick Add & Templates**: Tap `+ Add` to pick from admin-curated service templates (Netflix, Spotify, iCloud+, ChatGPT Plus, Adobe Creative Cloud, etc.) or create a custom subscription.
- **Flexible Billing**: Configure amount, currency (`CNY`, `USD`, `EUR`, `HKD`, `JPY`, `GBP`), cycle (`week`, `month`, `quarter`, `year`, or custom days), start/next renewal date, trial end date, auto-renew toggle, category, payment method, management/cancel URLs, notes, and custom reminder lead days.
- **Search, Filter & Actions**: Filter by status (`all`, `trial`, `active`, `paused`, `cancelled`) or category, search by name/note, inspect event history in the detail drawer, record manual renewals, pause/resume, or cancel.

### Calendar (`calendar`)
- Monthly calendar grid projecting all recurring dates within the selected month and highlighting selected-day renewals and converted amounts.

### Settings (`settings`)
- Manage **Language** (`zh-CN` / `en`), **Base Currency** (`CNY`, `USD`, `EUR`, `HKD`, `JPY`, `GBP`), **Theme**, **Email Reminders**, and **Default Reminder Days**.
- Refresh live exchange rates on demand (`Refresh FX Rates`).
- Customize **Categories** and **Payment Methods**.
- **CSV Export & Import**: Export all cloud subscriptions to UTF-8 CSV or import rows from CSV into Supabase.
- **Account Center**: Update display name/bio, set or change password via OTP recovery, sign out, or permanently delete account (`DELETE` confirmation).

## 2. Admin Console (`https://renewly-admin.yeecc.cn`)

Accessible to accounts registered in `public.admin_accounts`:
1. **Overview (`overview`)**: Live platform metrics — total non-deleted users, active/trial subscriptions, template count, reminders sent/failed today, and restricted accounts.
2. **Templates (`templates`)**: Create, edit, reorder, and delete quick-add `subscription_templates` shown to all users.
3. **Users (`users`)**: Search by UID/email/name, filter by status or registration window, and suspend (`24h` / `7d` / `30d`), restore, ban, or unban user accounts with mandatory audit reasons.
4. **Admins (`admins`)**: Grant/revoke admin privileges and reset peer admin passwords with audit tracking.
5. **Audit Log (`audit`)**: Paginated searchable history of moderation and admin governance actions (`moderation_audit`).
