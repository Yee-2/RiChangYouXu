# 产品使用与部署指南

文档更新时间：2026-11-08

产品版本：0.1.0

## 产品介绍

「日常有序」是一款手机优先的生活管理 H5/PWA。个人清单、出门检查、水电燃气读数和宠物日常数据保存在当前设备；社区帖子、评论、图片、关注关系在线保存，需要邮箱账号。第一版不提供个人数据云同步或家庭共享。

当前生产入口：

- 普通 App：`https://daily.yeecc.cn/`
- 独立管理后台：`https://admin.yeecc.cn/`

两个域名由同一个 Cloudflare Worker 和同一份前端产物提供，应用按 hostname 分流。生产配置和数据库迁移不会替代本机个人数据备份。

## 快速开始

在项目目录执行：

```bash
npm install
npm run dev
```

浏览器打开 Vite 输出的本地地址。若未配置 Supabase，个人模块可直接使用，社区页面会显示配置提示。

## 用户功能

### 首页与主题

首页问候语按设备本地时间显示早上、中午、下午、晚上或夜深提示；顶部按钮在日间与夜间主题之间切换，首次访问跟随系统外观。清单勾选完成时记录本地完成时间，首页按当天展示已完成事项和进度；主题选择保存在本机。

### 生活清单

创建清单后可添加事项、截止日期和备注。事项完成情况和完成时间自动保存；取消完成会清除本次完成时间。首页只把当天完成的事项计入当天进度。清单可改名、归档、恢复或删除；删除清单会同时删除它的事项。可以从旅行、搬家示例开始。

### 出门检查

内置上班出门、健身出门和短途出行模板。创建检查实例会复制一份模板项目，勾选进度单独保存。可编辑、复制或删除模板。实例完成后可从模板重新开始。

### 水电燃气抄表

先添加表具并选择类型和单位，再按日期记录读数。相邻记录之间自动计算用量。日期必须晚于上次抄表，读数不能倒退。第一版不自动算费用。

### 宠物日常

可新增宠物档案，记录喂养、体重、疫苗、驱虫、就诊或自定义事件。事件可填提醒日期；未完成提醒会显示在宠物记录和首页中，逾期事项会标记为已逾期并保留到完成为止。本功能只记录信息，不提供医疗诊断。

### 社区

登录页提供密码登录和验证码登录。验证码登录同时支持登录和注册：新邮箱验证 6 位验证码后自动创建账号，不需要先进入单独注册页或设置密码；密码登录页仍可选择密码注册。新账号昵称由系统随机生成且不含 UID。忘记密码、设置密码和修改密码均使用 6 位邮箱验证码；新验证码账号在个人账号设置中显示“设置密码”，已有密码的账号显示“修改密码”。验证码 10 分钟有效，每 60 秒可重新发送。验证邮件使用已验证的 `yeecc.cn` 发件域名，由 Supabase Auth 通过 Resend SMTP 投递。

密码至少 8 位，并同时包含英文字母和数字。Supabase 项目可另外启用泄露密码保护；该能力仅适用于 Pro 及以上套餐，免费套餐不会因本仓库配置自动获得。密码变更后 Supabase Auth 可发送安全通知邮件。

验证邮箱后可发布文字和图片动态、添加 `#话题`、添加评论、表情、点赞、关注作者和举报内容。点击动态或评论作者可查看公开主页、简介、动态与关注数据，也可关注/取消关注或举报账号。动态图片最多 9 张，单张 5 MB；评论图片最多 4 张。删除自己的动态或评论时会先隐藏内容，再通过服务端清理关联图片；如果图片清理失败，内容会保持隐藏并提示重试。删除账号会永久删除线上社区内容和媒体，但保留本机生活记录。

在“我的举报”中可查看每条举报的处理状态。被驳回的举报会显示管理员填写的驳回理由；仅举报人本人和管理员可以读取这项理由。

登录后可编辑社区昵称、个人简介和头像。系统为每个账号生成唯一 6 位数字 UID，供后台按 UID 或邮箱查找；普通用户页面不显示或请求 UID，也不显示他人的真实邮箱。“我的 → 账号设置”显示本人邮箱的掩码形式；编辑资料、设置/修改密码、注销账号和退出登录分别进入独立页面。设置或修改密码时填写账号邮箱、验证码和新密码；完成后会退出当前会话并返回登录页，需要重新登录。忘记密码也使用同样的验证码流程。注销账号会删除线上 Auth/profile 和社区数据，不删除本机个人记录；管理员需先撤销管理员身份才能自助注销。

### 管理后台

后台独立地址为 `https://admin.yeecc.cn/`，普通 App 的旧 `/#/admin` 地址会跳转过去。后台登录页只提供已授权账号的邮箱/密码登录和忘记密码，没有注册功能。管理员身份单独存放在启用 RLS 的 `admin_accounts` 表中，普通用户对它没有访问权限；服务端不以 `profiles.role` 单独作为授权凭据。工作台右上角显示管理员头像、名称和邮箱；没有可用头像时显示名称首字。三点菜单提供修改自己的密码与退出登录。“用户管理”可以搜索 UID/邮箱、筛选账号状态并按注册时间排序；“管理员账号”中可通过弹窗添加现有的已验证普通账号、撤销管理员，或设置其他管理员的新密码。添加、撤销和重置密码都需填写原因并写入操作记录；管理员新密码为 8–128 位且至少包含字母和数字。首次管理员由项目所有者在 Supabase SQL Editor 同时写入管理员表和 profile 兼容角色。

工作台默认显示举报队列和对象详情，可检索举报、动态和评论。举报详情显示举报人 UID；被举报对象是用户时显示其 UID，被举报对象是动态或评论时显示内容作者 UID、内容 ID 和正文图片。内容管理中点击每条动态或评论可打开详情弹窗，查看完整文字、图片、作者 UID、内容状态和时间；评论同时展示所属动态。隐藏、恢复和删除都要求填写原因并二次确认；内容状态或图片未能完整读取时，操作按钮会禁用。移除后的内容不能恢复。驳回举报时，管理员填写的原因会保存到举报记录，并显示给提交该举报的用户。暂停账号可选择 24 小时、7 天或 30 天，到期后自动恢复社区写权限；永久封禁是独立状态，只能由管理员手动解封；所有审核操作均填写原因并写入包含管理员、目标、动作、原因和时间的审计记录。

### 本机备份

在“我的”中导出 JSON 备份。选择文件后先查看记录数量和同 ID 冲突数，再确认合并；同 ID 记录会覆盖，其他记录保留。系统会校验版本、记录字段、唯一 ID 和清单/表具/宠物关联后才打开写事务；非法文件不会改变现有数据。导入文件最大 20 MB。备份只包含本机个人记录，不含社区账号和线上内容。请把备份保存在安全位置。

## 手机安装 PWA

通过 HTTPS 部署后，在支持的移动浏览器中使用“添加到主屏幕”或“安装应用”。离线时个人模块仍可读写；社区操作需要网络。通知受浏览器、设备和用户授权影响，不能作为唯一提醒方式。

## 启用 Supabase 社区

1. 创建 Supabase 项目。
2. 按文件名顺序执行 `supabase/migrations/` 中所有尚未应用的迁移。也可以使用 Supabase CLI 关联项目，先比较历史再推送；已手工执行过 SQL 的项目要先核验对应对象，必要时使用 `supabase migration repair` 补齐历史，不能盲目 `--include-all` 重放初始建表。
3. 复制 `.env.example` 到 `.env.local`，填入 Project URL 与 anon/publishable key。文件已被 Git 忽略；只把同等配置写入部署平台的构建变量。
4. 在 Supabase Dashboard 的 Authentication → SMTP Settings 配置自定义 SMTP：主机 `smtp.resend.com`、端口 `465`、用户名 `resend`、发件地址 `no-reply@yeecc.cn`，密码使用 Resend API key。密钥只保存在 Supabase Auth SMTP 配置中，不能放入公开前端变量或 Git。运行 `npx.cmd supabase config diff` 检查配置，再运行 `npx.cmd supabase config push --yes` 推送验证码、密码规则、邮件通知和模板。启用邮箱验证；Redirect URLs 保留普通 App 与后台 `https://admin.yeecc.cn/`。泄露密码保护需要 Pro 及以上套餐，部署前确认计划支持情况。
5. 使用 Supabase CLI 登录、关联项目，并部署四个 Edge Function：

```powershell
npx.cmd supabase login
npx.cmd supabase link --project-ref <project-ref>
npx.cmd supabase functions deploy admin-moderate --use-api --yes
npx.cmd supabase functions deploy admin-manage --use-api --yes
npx.cmd supabase functions deploy delete-account --use-api --yes
npx.cmd supabase functions deploy delete-content --use-api --yes
npx.cmd supabase functions list --project-ref <project-ref>
```

四个函数均保持 `verify_jwt = true`。`--use-api` 不需要本地 Docker。

6. 在 Cloudflare 将 `daily.yeecc.cn` 与 `admin.yeecc.cn` 绑定为 `richangyouxu` Worker 的 Custom Domain，并确认 DNS、HTTPS 正常。前端按 hostname 显示普通 App 或独立后台。

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

8. 构建并发布 Worker。仓库根目录的 `wrangler.toml` 已将两个域名和 `dist/` 单页应用资源写入配置：

```powershell
npm run build
npx.cmd wrangler@4 deploy
```

如果不使用 Cloudflare，可将 `dist/` 部署到支持 SPA fallback 的 HTTPS 静态托管，并配置相同的 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY` 构建变量。推送到 `main` 不会自动发布前端，除非已连接 Cloudflare Workers Builds；使用 Workers Builds 时，生产分支设为 `main`，构建命令为 `npm run build`，部署命令为 `npx wrangler deploy`。

## 部署检查

- `npm run build` 成功，`dist/manifest.webmanifest` 和本地图标存在。
- `supabase migration list --remote` 显示本地与远端迁移一致。
- `supabase db lint --remote` 报告 `No schema errors found`。
- `supabase config diff` 除托管 SMTP 凭据外无差异。
- 四个 Edge Function 状态为 `ACTIVE` 且版本已更新。
- `daily.yeecc.cn` 与 `admin.yeecc.cn` 的 DNS、HTTPS、SPA 回退和 hostname 分流正常。
- 普通账号、暂停账号和非管理员账号不能进入后台；active 管理员可以进入。

## 当前范围与限制

- H5/PWA，不含 App Store 或 Google Play 原生发布。
- 个人数据只保存在本机，不能跨设备自动同步；设备存储被清理时需从备份恢复。
- 社区需要 Supabase 项目。仓库按安全要求不提交 Project secret、SMTP 密码或 service-role key；每次新环境部署都需单独配置凭据和 Auth 回调地址。
- Resend 与 Supabase 的邮件量、速率限制和免费额度由服务商套餐控制；开放注册前查看当前额度与发件域名状态。
- 泄露密码保护仅适用于 Supabase Pro 及以上套餐；免费套餐仍需前端密码规则和服务端密码规则兜底。
- 当前 `main` 推送不等同于 Cloudflare 自动发布；没有 Workers Builds 配置时必须保留手工 `wrangler deploy` 步骤。
- 社区管理员操作有审计记录；自动审核、申诉工作流、私信与系统推送不在第一版范围。宠物提醒目前显示在应用内。
