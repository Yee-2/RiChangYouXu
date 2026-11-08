# 产品使用与部署指南

## 产品介绍

「日常有序」是一款手机优先的生活管理 H5/PWA。个人清单、出门检查、水电燃气读数和宠物日常数据保存在当前设备；社区帖子、评论、图片、关注关系在线保存，需要邮箱账号。第一版不提供个人数据云同步或家庭共享。

## 快速开始

在项目目录执行：

```bash
npm install
npm run dev
```

浏览器打开 Vite 输出的本地地址。若未配置 Supabase，个人模块可直接使用，社区页面会显示配置提示。

## 用户功能

### 首页与主题

首页汇总今天待办、出门检查入口、最近抄表和宠物照护记录。顶部按钮在日间与夜间主题之间切换；首次访问跟随系统外观。主题选择保存在本机。

### 生活清单

创建清单后可添加事项、截止日期和备注。事项完成情况自动保存。清单可改名、归档、恢复或删除；删除清单会同时删除它的事项。可以从旅行、搬家示例开始。

### 出门检查

内置上班出门、健身出门和短途出行模板。创建检查实例会复制一份模板项目，勾选进度单独保存。可编辑、复制或删除模板。实例完成后可从模板重新开始。

### 水电燃气抄表

先添加表具并选择类型和单位，再按日期记录读数。相邻记录之间自动计算用量。日期必须晚于上次抄表，读数不能倒退。第一版不自动算费用。

### 宠物日常

可新增宠物档案，记录喂养、体重、疫苗、驱虫、就诊或自定义事件。事件可填提醒日期；未完成提醒会显示在宠物记录和首页中，逾期事项会标记为已逾期并保留到完成为止。本功能只记录信息，不提供医疗诊断。

### 社区

邮箱注册后，Resend 会发送 8 位验证码；输入正确验证码后账号完成邮箱验证。验证码 10 分钟有效，每 60 秒可重新发送。忘记密码和修改密码同样通过 Resend 邮件验证码验证后设置新密码。验证邮件使用已验证的 `yeecc.cn` 发件域名，由 Supabase Auth 通过 Resend SMTP 投递。

验证邮箱后可发布文字和图片动态、添加 `#话题`、添加评论、表情、点赞、关注作者和举报内容。点击动态或评论作者可查看公开主页、简介、动态与关注数据，也可关注/取消关注或举报账号。动态图片最多 9 张，单张 5 MB；评论图片最多 4 张。删除自己的动态或评论时会先隐藏内容，再通过服务端清理关联图片；如果图片清理失败，内容会保持隐藏并提示重试。删除账号会永久删除线上社区内容和媒体，但保留本机生活记录。

登录后可编辑社区昵称、个人简介和头像。每个账号有系统生成的短 UID；新用户昵称由系统随机生成，也可以自行修改。头像支持 JPG、PNG、WebP，单张不超过 2 MB；保存成功后会显示在个人资料、动态和评论旁。公开主页显示 UID，不显示邮箱。“我的 → 账号设置”显示本人邮箱的掩码形式，并可查看 UID、举报状态、修改密码、退出或注销账号。修改密码需要先发送并验证邮箱验证码，再输入新密码并再次确认；忘记密码也使用同样的验证码流程。

### 管理后台

后台独立地址为 `https://admin.yeecc.cn/`，普通 App 的旧 `/#/admin` 地址会跳转过去。后台登录页只提供已授权账号的邮箱/密码登录和忘记密码，没有注册功能。管理员身份单独存放在启用 RLS 的 `admin_accounts` 表中，普通用户对它没有访问权限；服务端不以 `profiles.role` 单独作为授权凭据。工作台右上角显示管理员名称和邮箱，三点菜单提供修改自己的密码与退出登录。“用户管理”可以搜索 UID/邮箱、筛选账号状态并按注册时间排序；“管理员账号”中可通过弹窗添加现有的已验证普通账号、撤销管理员，或设置其他管理员的新密码。添加、撤销和重置密码都需填写原因并写入操作记录。首次管理员由项目所有者在 Supabase SQL Editor 同时写入管理员表和 profile 兼容角色。

工作台默认显示举报队列和对象详情，可检索举报、动态和评论，隐藏/恢复内容，或移除内容并删除图片。暂停账号可选择 24 小时、7 天或 30 天，到期后自动恢复社区写权限；永久封禁是独立状态，只能由管理员手动解封。隐藏和暂停直接执行，移除内容和永久封禁需二次确认；所有审核操作均填写原因并写入包含管理员、目标、动作、原因和时间的审计记录。

### 本机备份

在“我的”中导出 JSON 备份。选择文件后先查看记录数量和同 ID 冲突数，再确认合并；同 ID 记录会覆盖，其他记录保留。系统会校验版本、记录字段、唯一 ID 和清单/表具/宠物关联后才打开写事务；非法文件不会改变现有数据。导入文件最大 20 MB。备份只包含本机个人记录，不含社区账号和线上内容。请把备份保存在安全位置。

## 手机安装 PWA

通过 HTTPS 部署后，在支持的移动浏览器中使用“添加到主屏幕”或“安装应用”。离线时个人模块仍可读写；社区操作需要网络。通知受浏览器、设备和用户授权影响，不能作为唯一提醒方式。

## 启用 Supabase 社区

1. 创建 Supabase 项目。
2. SQL Editor 按文件名顺序执行 `supabase/migrations/202611080001_initial_community.sql`、`supabase/migrations/202611080002_profile_avatar_policy.sql`、`supabase/migrations/20261108054808_complete_moderation_profile_workflows.sql`、`supabase/migrations/20261108073134_account_identity_admin_management.sql`、`supabase/migrations/20261108090539_numeric_uid_profile_pages_admin_users.sql`、`supabase/migrations/20261108090640_admin_list_profiles_email_cast.sql`、`supabase/migrations/20261108091550_limit_profile_uid_to_six_digits.sql`、`supabase/migrations/20261108095834_separate_admin_accounts_and_filters.sql` 和 `supabase/migrations/20261108103440_align_admin_filters_and_audit.sql`。已执行的旧迁移不要重跑，只补执行尚未应用的迁移。
3. 复制 `.env.example` 到 `.env.local`，填入 Project URL 与 anon/publishable key。
4. 在 Supabase Dashboard 的 Authentication → SMTP Settings 配置自定义 SMTP：主机 `smtp.resend.com`、端口 `465`、用户名 `resend`、发件地址 `no-reply@yeecc.cn`，密码使用 Resend API key。密钥只保存在 Supabase Auth SMTP 配置中，不能放入公开前端变量或 Git。然后运行 `npx.cmd supabase config push --yes` 推送 `supabase/config.toml` 中的 8 位验证码、10 分钟有效期和 `supabase/templates/` 内的注册/找回密码模板。启用邮箱验证；Redirect URLs 保留普通 App 与后台 `https://admin.yeecc.cn/`。
5. 使用 Supabase CLI 登录、关联项目，并部署四个 Edge Function：

```bash
supabase login
supabase link --project-ref <project-ref>
supabase functions deploy admin-moderate
supabase functions deploy admin-manage
supabase functions deploy delete-account
supabase functions deploy delete-content
```

6. 在 Cloudflare 将 `admin.yeecc.cn` 作为现有 `richangyouxu` Worker 的另一个 Custom Domain 绑定，并确认 DNS、HTTPS 正常。前端会按 hostname 显示独立后台；`daily.yeecc.cn` 继续提供普通 App。

7. 注册并验证首位管理员邮箱后，在 SQL Editor 以受信任账号执行以下语句（将邮箱替换成首位管理员邮箱）：

```sql
with target as (
  select u.id, lower(u.email) as email
  from auth.users u
  where lower(u.email) = lower('admin@example.com')
    and u.email_confirmed_at is not null
)
insert into public.admin_accounts(user_id, email, created_by)
select id, email, id from target
on conflict (user_id) do update set email = excluded.email;

update public.profiles
set role = 'admin'
where id = (select id from auth.users where lower(email) = lower('admin@example.com'));
```

不要把 Supabase service-role key 放进 `.env.local`、前端或公开仓库。只将其作为 Edge Function 的服务端 secret 使用。

## 部署 H5

运行 `npm run build`，静态产物在 `dist/`。将 `dist/` 部署到支持 SPA fallback 的 HTTPS 静态托管。首次设置社区时同时配置 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY` 构建变量。可从免费静态托管和 Supabase 免费额度开始，但它们有用量、邮件发送、存储、流量和暂停限制；超出免费额度可能需要付费。使用前查看服务商当前套餐并设置账单提醒。

## 当前范围与限制

- H5/PWA，不含 App Store 或 Google Play 原生发布。
- 个人数据只保存在本机，不能跨设备自动同步；设备存储被清理时需从备份恢复。
- 社区需要用户自行配置 Supabase 项目；当前仓库未包含任何用户项目凭据，也未代为部署。
- Resend 与 Supabase 的邮件量、速率限制和免费额度由服务商套餐控制；开放注册前查看当前额度与发件域名状态。
- 社区管理员操作有审计记录；自动审核、申诉工作流、私信与系统推送不在第一版范围。宠物提醒目前显示在应用内。
