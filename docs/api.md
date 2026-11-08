# 接口文档

版本：0.1.0

文档更新时间：2026-11-08

后端：Supabase Auth、PostgREST、Storage、Edge Functions

迁移：以 `supabase/migrations/` 中的文件名顺序为准；兼容仓库应执行全部尚未应用的迁移，不要只复制某一版本的文件名。

## 连接与鉴权

前端从环境变量读取：

- `VITE_SUPABASE_URL`：Supabase Project URL。
- `VITE_SUPABASE_ANON_KEY`：公开的 legacy anon key 或 `sb_publishable_...` key，只能用于带 RLS 的客户端请求；新项目优先使用 publishable key。

Supabase SDK 会把 publishable/anon key 放在 `apikey` 请求头，把登录用户的 access token 放在 `Authorization: Bearer <access_token>`。不要将 API key 放入 Bearer 头。service-role/secret key 只能保存在 Edge Function 服务端环境，不得进入前端、`.env.local` 或 Git。

四个 Edge Function 均设置 `verify_jwt = true`。平台会先验证用户 JWT，函数内部再执行角色、账号状态、内容归属和业务字段校验。

邮箱注册和登录由 Supabase Auth JS SDK 调用：

| 操作 | SDK | 说明 |
|---|---|---|
| 注册 | “发送验证码”按钮调用 `auth.signUp({ email, password })`；提交注册时调用 `auth.verifyOtp({ email, token, type: 'signup' })` | 注册页按邮箱、验证码、密码、确认密码排列；密码至少 8 位且包含英文字母和数字。验证前需先创建未验证账号以触发注册验证码。验证码 10 分钟有效，每 60 秒可重发 |
| 密码登录 | `auth.signInWithPassword({ email, password })` | 仅已验证邮箱可正常登录 |
| 验证码登录/注册 | `auth.signInWithOtp({ email, options: { shouldCreateUser: true } })` 后调用 `auth.verifyOtp({ email, token, type: 'email' })` | 同一流程用于已有账号登录和新邮箱注册；Supabase Auth 自动判断并创建新用户，验证 6 位验证码后建立会话。验证码邮件使用 `magic_link` 模板 |
| 退出 | `auth.signOut()` | 清除本机 Supabase 会话 |
| 忘记密码 | `auth.resetPasswordForEmail(email)`、`auth.verifyOtp({ email, token, type: 'recovery' })`、`auth.updateUser({ password })` | 先验证 6 位邮箱验证码，再设置至少 8 位且包含英文字母和数字的新密码；验证码 10 分钟有效 |
| 设置或修改密码 | `auth.resetPasswordForEmail(session.user.email)`、`auth.verifyOtp({ email, token, type: 'recovery' })`、`auth.updateUser({ password })`、`auth.signOut()` | 账号设置页按账号状态显示“设置密码”或“修改密码”；使用 6 位邮箱验证码，密码至少 8 位且包含英文字母和数字。完成后退出会话并返回登录页。管理员本人修改密码也使用验证码；管理员重置其他管理员密码仍由服务端 Auth Admin API 执行并记录原因 |
| 重发验证码 | 验证码登录/注册重复调用 `auth.signInWithOtp(...)`；密码恢复重复调用 `auth.resetPasswordForEmail(email)`；密码注册重发调用 `auth.resend({ type: 'signup', email })` | 页面显示 60 秒倒计时后允许重新发送，并提示发送成功或失败 |

管理员登录使用 Supabase Auth 邮箱账号，只能从 `https://admin.yeecc.cn/` 登录；后台不提供注册。管理员权限唯一来源为启用 RLS 的 `public.admin_accounts` 表，普通用户没有该表的读写权限；`profiles.role` 仅作兼容字段，不能单独授予后台权限。后台忘记密码用同一 Resend 邮件发送验证码，不使用密码重置链接；后台地址保留在 Supabase Authentication → URL Configuration 的 Redirect URLs 中，以兼容现有会话与历史链接。

Auth 邮件由 Supabase Auth 生成验证码并经 Resend SMTP 投递。项目 SMTP 设置为主机 `smtp.resend.com`、端口 `465`、用户名 `resend`、发件地址 `no-reply@yeecc.cn`；Resend API key 只保存在 Supabase Auth 的 SMTP 密码配置，不放入前端环境变量或 Git。

当前 `supabase/config.toml` 声明：

- 密码至少 8 位且同时包含字母和数字。
- OTP 为 6 位数字，有效期 600 秒，发送间隔至少 60 秒。
- 注册、恢复密码、验证码登录分别使用 `confirmation.html`、`recovery.html`、`magic_link.html` 模板。
- 密码变更通知默认开启。
- 配置声明启用泄露密码保护；该能力要求 Supabase Pro 及以上套餐，免费项目是否实际生效以 Authentication 设置和安全顾问结果为准。

`npx.cmd supabase config diff` 可先比较本地与托管配置，`npx.cmd supabase config push --yes` 用于推送已声明配置。SMTP 密码属于托管凭据，不参与明文比较或提交。

## 数据访问接口

基础地址：`{VITE_SUPABASE_URL}/rest/v1`。客户端通过 Supabase SDK 访问；表权限由迁移中的 RLS 策略控制。

### 本机数据模型

个人数据通过 `src/db.ts` 写入 IndexedDB 数据库 `daily-life-local`，不会通过 REST 上传。

| Object store | 主要字段 |
|---|---|
| `checklists` | `id, title, createdAt, archivedAt?` |
| `checklistItems` | `id, checklistId, title, dueDate?, note?, done, completedAt?, createdAt` |
| `checkTemplates` | `id, title, items[], createdAt` |
| `checkRuns` | `id, templateId, title, items[{id,title,done}], createdAt, completedAt?` |
| `meters` | `id, name, kind, unit, createdAt` |
| `meterReadings` | `id, meterId, value, date, note?, createdAt` |
| `pets` | `id, name, kind, birthday?, note?, createdAt` |
| `petEvents` | `id, petId, kind, title, date, reminderDate?, note?, completed, createdAt` |

`completedAt` 仅在事项完成时写入；取消完成会清除该字段。首页按设备本地日计算进度，不直接截取 UTC 时间。历史已完成事项若没有 `completedAt`，界面回退到 `createdAt` 估算。

备份格式为 `{ schemaVersion: 1, exportedAt, data }`。导入预览会显示各数据表数量及新增/覆盖数。写入前校验版本、导出时间、各记录必填字段/类型/日期、每表 ID 唯一性、`completedAt` 时间格式，以及清单事项、表具读数、宠物事件的关联；总文件限制 20 MB。校验通过后用单个 IndexedDB read/write transaction 合并，相同 ID 覆盖，其他记录保留。校验失败不写入。

### 动态、话题与互动

| 资源 | 方法与路径 | 用途 / 权限 |
|---|---|---|
| `posts` | `GET /posts?moderation_status=eq.visible&order=created_at.desc&limit=40` | 读取可见动态；RLS 允许公开读取，普通 App 在未登录时仍显示登录引导 |
| `posts` | `POST /posts` | 登录用户以自己的 `author_id` 创建文字/图片动态；数据库默认状态为 `visible` |
| `posts` | `POST /rpc/update_own_post` | 作者原子修改自己可见动态的正文，并重新同步 `#话题`；参数为 `p_post_id`、`p_body` |
| `topics` | `GET /topics?slug=eq.{slug}` | 查找话题 |
| `topics` | `POST /topics` | 登录用户创建话题，slug/title 唯一 |
| `post_topics` | `GET /post_topics?post_id=eq.{id}` | 读取动态话题；嵌套关联 `topics(id,slug,title)` |
| `post_topics` | `POST /post_topics` | 仅能为自己的动态添加话题 |
| `comments` | `GET /comments?post_id=eq.{id}&moderation_status=eq.visible` | 读取可见评论 |
| `comments` | `POST /comments` | 登录用户评论；允许文字、表情和最多 4 张图片路径 |
| `posts/comments` | `POST /functions/v1/delete-content` | 作者删除自己的动态或评论；先隐藏，再清理图片和数据库记录 |
| `post_likes` | `POST /post_likes` | 当前用户点赞；`(post_id,user_id)` 唯一 |
| `post_likes` | `DELETE /post_likes?post_id=eq.{id}&user_id=eq.{uid}` | 取消自己的点赞 |
| `follows` | `POST /follows` | 当前用户关注其他用户；禁止关注自己 |
| `follows` | `DELETE /follows?follower_id=eq.{uid}&followee_id=eq.{id}` | 取消自己的关注 |
| `reports` | `POST /reports` | 登录用户举报动态、评论或账号，初始状态 `open` |
| `reports` | `GET /reports?reporter_id=eq.{uid}&order=created_at.desc` | 用户读取自己的举报、处理状态和 `review_reason`；RLS 限制只能读本人记录 |

举报状态为 `open`、`handled`、`dismissed`。`review_reason` 为可空文本，最多 500 字；举报被驳回时，`admin-moderate` 将后台填写的原因写入该字段，其他处理动作清空该字段。历史驳回理由从 `moderation_audit` 中按举报 ID 回填。只有举报人本人和管理员可以通过 RLS 读取对应举报记录及理由。

普通用户删除动态或评论时，前端调用 `delete-content`，而不是直接依赖表 DELETE；这样可以在删除前统一校验账号状态、内容归属并清理 Storage 图片。底层 RLS 仍保留作者和管理员的数据库删除权限作为防御边界。

动态正文最多 5,000 字；评论最多 2,000 字；动态最多 9 张图，评论最多 4 张图；每张图片最大 5 MB，MIME 仅接受 JPEG、PNG、WebP、GIF。

### 图片存储

Bucket：`community-media`（私有）。对象路径格式：`{auth.uid()}/{uuid}.{ext}`。前端 SDK 上传后把路径写入动态或评论 `image_paths`。读取可见内容时调用 `storage.from('community-media').createSignedUrls(paths, 3600)` 获取 1 小时签名 URL。RLS 只允许对象所有者，或被可见动态/评论引用的图片被读取。

头像使用 `storage.from('community-media').createSignedUrl(path, 3600)` 生成 1 小时签名 URL；数据库策略允许读取当前非注销资料所引用的头像对象。

### 用户资料

`profiles.uid` 是数据库生成的 6 位纯数字 UID，唯一且创建后不可修改；它只供后台按 UID 搜索和管理。普通 App 的资料查询不请求或展示 UID。`id` 是内部 Auth UUID 和关系外键。

| 操作 | 方法与路径 | 说明 |
|---|---|---|
| 读取公开资料 | `GET /profiles?select=id,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at&id=eq.{id}` | RLS 不公开已注销资料；邮箱不在 `profiles` 表中 |
| 读取本人资料 | `GET /profiles?select=id,username,display_name,avatar_path,bio,role,account_status,suspension_expires_at&id=eq.{auth-uuid}` | 账号设置和资料编辑使用 |
| 修改本人资料 | `PATCH /profiles?id=eq.{auth-uuid}` | 仅可更新 `username`、`display_name`、`avatar_path`、`bio` |
| 读取密码状态 | `GET /user_auth_settings?select=password_set&user_id=eq.{auth-uuid}` | 仅本人可读，用于区分“设置密码”和“修改密码” |

新账号由 `on_auth_user_created` 触发器创建 profile，生成 6 位 UID 和随机昵称；昵称不包含 UID 或邮箱前缀。用户可修改昵称和简介，不能修改 UID、角色或账号状态。`profiles.role` 仅作兼容/展示字段，后台权限只认 `admin_accounts`。

邮箱不存进公开 profile 表，也不由社区 REST 查询返回。普通用户只看到本人邮箱的掩码；完整邮箱只由 active 管理员通过 `admin-manage` 读取。`user_auth_settings` 启用 RLS，匿名不可访问，authenticated 只能读取本人记录且没有客户端更新权限。

资料编辑更新 `display_name`（1–40 字）、`bio`（最多 240 字）与 `avatar_path`。头像限 JPG/PNG/WebP、最大 2 MiB；先上传到 `{auth-uuid}/{uuid}.{ext}`，资料更新成功后才删除旧头像。失败时清理新文件并保留原资料。

## Edge Functions

以下函数启用 JWT 验证，均要求 `Authorization: Bearer <access_token>`。

### `POST /functions/v1/admin-manage`

仅 active 管理员可调用。函数校验用户会话，并要求用户 ID 同时存在于 `admin_accounts` 且 profile 状态为 `active`；仅服务端使用 service-role key 调用数据库受限 RPC 或 Auth Admin API。函数只允许 `https://admin.yeecc.cn` 与本地开发地址发起跨域请求。

请求动作：

| `action` | 请求字段 | 返回 |
|---|---|---|
| `verify` | 无 | `{ ok, actor }` |
| `list_users` | `query?`、`statusFilter?`、`sort?`、`registeredWithin?`、`limit?`、`offset?` | `{ ok, users }` |
| `list_admins` | `query?`、`limit?`、`offset?` | `{ ok, admins }` |
| `list_accounts` | 与 `list_admins` 相同 | 旧兼容入口，返回 `{ ok, accounts }` |
| `find_account` | `lookup`，6 位 UID 或完整邮箱 | `{ ok, account }` |
| `grant_admin` | `targetId`、`reason` | `{ ok: true }` |
| `revoke_admin` | `targetId`、`reason` | `{ ok: true }` |
| `reset_admin_password` | `targetId`、`newPassword`、`reason` | `{ ok: true }` |

列表查询不再将昵称作为搜索条件，只匹配 UID 或完整/部分邮箱。普通用户支持 `registeredWithin: "7d" | "30d" | "90d"`，状态筛选为 `all`、`active`、`suspended`、`banned`、`deleted`，排序为 `newest` 或 `oldest`。每页最多 100 条。

```json
{
  "action": "list_users",
  "query": "100003",
  "statusFilter": "active",
  "sort": "newest",
  "registeredWithin": "30d",
  "limit": 50,
  "offset": 0
}
```

`verify` 的成功响应中，`actor` 包含管理员 `id`、公开 `uid`、`display_name`、完整 `email` 和 `avatar_path`：

```json
{
  "ok": true,
  "actor": {
    "id": "auth-user-uuid",
    "uid": "100003",
    "display_name": "海边旅人",
    "email": "admin@example.com",
    "avatar_path": "auth-user-uuid/avatar.webp"
  }
}
```

后台前端使用 `avatar_path` 向私有 `community-media` bucket 请求短时签名 URL，在右上角显示头像；没有头像或签名失败时显示名称首字。

筛选按暂停到期后的有效状态判断。账号对象仅通过受保护后台接口返回完整邮箱。`find_account` 只查找现有普通用户。`grant_admin` 只接受状态正常且邮箱已验证的现有普通账号，并将身份写入独立的 `admin_accounts` 表；后台登录页没有注册入口。`revoke_admin` 不能移除最后一位 active 管理员。`reset_admin_password` 仅可重置另一位管理员，密码要求 8–128 位且至少包含 1 个字母和 1 个数字，原因必填。服务端先持久化重置意图，再调用 Auth Admin API 并写入结果；密码不会进入审计日志。角色授权/撤销与审计写入在同一数据库事务内完成；原因最多 500 字。

常见错误包括：`401 unauthorized`、`403 forbidden`、`404 account_not_found`、`404 target_not_admin`、`400 target_not_eligible`、`400 already_admin`、`400 last_active_admin`、`400 lookup_required`、`400 invalid_request`、`400 unsupported_action` 和 `400 admin_operation_failed`。密码已更新但审计失败时可能返回 `partial: true`。角色字段不能通过 PostgREST 客户端直接修改。

### `POST /functions/v1/admin-moderate`

仅 active 管理员可调用。Edge Function 会检查 token、独立管理员表成员资格和 profile 状态，再以服务端密钥执行动作并写 `moderation_audit`。

请求 JSON：

```json
{
  "action": "hide_post",
  "targetType": "post",
  "targetId": "uuid",
  "reportId": "optional-uuid",
  "reason": "违反社区规范",
  "suspensionHours": 24
}
```

支持动作：`hide_post`、`remove_post`、`restore_post`、`hide_comment`、`remove_comment`、`restore_comment`、`suspend_user`、`restore_user`、`ban_user`、`unban_user`、`handle_report`、`dismiss_report`。`suspend_user` 的 `suspensionHours` 必须为 `24`、`168` 或 `720`；数据库会以服务端时间判断暂停是否到期，Auth ban 同步设定期限。到期后现有会话的写操作自动恢复，管理员列表也显示恢复状态。`ban_user` 使用独立 `banned` 状态，只有 `unban_user` 能恢复。管理员账号不能被暂停或封禁。移除动态会隐藏其评论、清理动态与评论图片后标记移除；存储清理失败时内容保持隐藏并返回 `partial: true`。带 `reportId` 的成功处理会同步更新举报状态；`dismiss_report` 会将输入原因存入该举报的 `review_reason`，供举报人在“我的举报”中查看；其他处理动作将该字段清空。对已标记为 `removed` 的动态或评论再次隐藏、删除或恢复会返回 `409 content_already_removed`，已删除内容不可恢复。

后台举报详情显示举报人 UID；用户类举报显示被举报用户 UID，动态/评论举报显示内容作者 UID 和内容 ID，并展示举报内容。后台内容管理中点击动态或评论可读取详情。动态详情包含文字、图片、作者 UID、状态与时间；评论详情还包含所属动态文字与图片。隐藏、删除及恢复操作均要求填写原因并通过确认弹窗；详情、记录状态或图片签名信息不完整时操作按钮禁用。

成功：`{ "ok": true }`。常见错误：`400 invalid_request`、`400 invalid_json`、`400 invalid_suspension_duration`、`400 report_id_required`、`400 unsupported_action`、`400 permanently_banned_accounts_require_manual_unban`、`400 target_is_not_banned`、`401 unauthorized`、`403 forbidden`、`403 target_not_manageable`、`404 target_not_found`、`409 content_already_removed`。业务动作已执行但审计或举报状态同步失败时返回 `partial: true`，后台会刷新记录并提示人工核查。

### `POST /functions/v1/delete-content`

用户删除自己的动态/评论时调用。服务端校验 JWT、内容归属和账号状态，先隐藏内容，再删除相关 Storage 图片，最后删除数据库记录；删除动态时会一起处理其评论图片。媒体清理失败时内容保持隐藏，响应含 `partial: true`，客户端刷新后可见处理结果。

```json
{ "targetType": "post", "targetId": "uuid" }
```

成功：`{ "ok": true, "deletedMediaCount": 2 }`。常见错误：`400 invalid_request`、`401 unauthorized`、`403 profile_not_found`、`403 account_not_active`、`403 target_not_owned`、`500 media_cleanup_failed`、`500 content_delete_failed`。内容已先隐藏但媒体或数据库删除失败时返回 `partial: true`。其他用户、未登录用户、暂停中和封禁用户不能调用。

### `POST /functions/v1/delete-account`

要求当前用户在请求体中明确输入确认词。函数删除该用户的线上 Auth/profile、动态、评论、点赞、关注、举报和社区媒体；本机 IndexedDB 记录不会被删除。

```json
{ "confirmation": "DELETE" }
```

成功：`{ "ok": true, "localDataRetained": true }`。常见错误：`400 confirmation_required`、`401 unauthorized`、`403 admin_account_cannot_self_delete`、`500 admin_membership_check_failed`、`500 media_list_failed`、`500 media_cleanup_failed`。管理员账号不能通过此接口自助删除。

## 主要错误处理

- `23505`：唯一键冲突，例如已存在话题或重复点赞/关注；UI 对话题并发创建会重新读取已有话题。
- `42501`：RLS 或列级权限拒绝；检查会话状态和目标记录归属。
- `PGRST116`：查询结果数量与 `single()` 不符；避免在可空查询中强制 single。
- 网络错误：社区界面显示可重试错误；发布图片失败时用户可重新选择图片并重试。

## 权限摘要

| 角色 | 读取可见社区 | 发布互动 | 读取本人举报 | 审核内容/举报 | 管理账号状态 | 管理管理员/完整邮箱 | 注销本人线上账号 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 未登录 | 后端允许，应用显示登录引导 | 否 | 否 | 否 | 否 | 否 | 否 |
| 邮箱验证后普通用户 | 是 | 是 | 是 | 否 | 否 | 否 | 是 |
| 暂停中账号 | 是 | 到期前否；到期后自动恢复 | 是 | 否 | 否 | 否 | 是（已有有效会话或可重新登录时） |
| 永久封禁账号 | 是 | 否 | 是 | 否 | 否 | 否 | 是（已有有效会话时） |
| active 管理员 | 是 | 是 | 是 | 是 | 是 | 是 | 否，需先撤销管理员 |
