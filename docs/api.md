# 接口文档

版本：0.1.0  
后端：Supabase Auth、PostgREST、Storage、Edge Functions  
迁移：按顺序执行 `supabase/migrations/202611080001_initial_community.sql`、`supabase/migrations/202611080002_profile_avatar_policy.sql`

## 连接与鉴权

前端从环境变量读取：

- `VITE_SUPABASE_URL`：Supabase Project URL。
- `VITE_SUPABASE_ANON_KEY`：公开 anon/publishable key，只能用于带 RLS 的客户端请求。

私密操作使用 Supabase 登录会话的 Bearer access token。service-role key 只能保存在 Supabase Edge Function 的服务端环境中。

邮箱注册和登录由 Supabase Auth JS SDK 调用：

| 操作 | SDK | 说明 |
|---|---|---|
| 注册 | `auth.signUp({ email, password })` | 默认要求邮件验证；验证邮件由 Supabase Auth 邮件配置发送 |
| 登录 | `auth.signInWithPassword({ email, password })` | 未验证邮箱通常不能获得可用会话 |
| 退出 | `auth.signOut()` | 清除本机 Supabase 会话 |
| 忘记密码 | `auth.resetPasswordForEmail(email, { redirectTo })` | 重置链接返回应用后，登录态可调用 `auth.updateUser({ password })` 设置新密码 |
| 修改密码 | 先用 `auth.signInWithPassword({ email, password: currentPassword })` 验证当前密码，再调用 `auth.updateUser({ password: newPassword })` | 新密码至少 8 位，页面要求再次确认 |
| 重发验证 | `auth.resend({ type: 'signup', email })` | 注册成功但未收到验证邮件时使用 |

## 数据访问接口

基础地址：`{VITE_SUPABASE_URL}/rest/v1`。客户端通过 Supabase SDK 访问；表权限由迁移中的 RLS 策略控制。

### 本机数据模型

个人数据通过 `src/db.ts` 写入 IndexedDB 数据库 `daily-life-local`，不会通过 REST 上传。

| Object store | 主要字段 |
|---|---|
| `checklists` | `id, title, createdAt, archivedAt?` |
| `checklistItems` | `id, checklistId, title, dueDate?, note?, done, createdAt` |
| `checkTemplates` | `id, title, items[], createdAt` |
| `checkRuns` | `id, templateId, title, items[{id,title,done}], createdAt, completedAt?` |
| `meters` | `id, name, kind, unit, createdAt` |
| `meterReadings` | `id, meterId, value, date, note?, createdAt` |
| `pets` | `id, name, kind, birthday?, note?, createdAt` |
| `petEvents` | `id, petId, kind, title, date, reminderDate?, note?, completed, createdAt` |

备份格式为 `{ schemaVersion: 1, exportedAt, data }`。导入前校验所有个人 store 为数组、每条记录含字符串 `id`；验证成功后用单个 IndexedDB read/write transaction 合并。

### 动态、话题与互动

| 资源 | 方法与路径 | 用途 / 权限 |
|---|---|---|
| `posts` | `GET /posts?moderation_status=eq.visible&order=created_at.desc&limit=40` | 读取可见动态；未登录可读 |
| `posts` | `POST /posts` | 登录用户以自己的 `author_id` 创建文字/图片动态；数据库默认状态为 `visible` |
| `posts` | `PATCH /posts?id=eq.{id}` | 作者修改自己可见动态的 `body` 和 `image_paths` |
| `posts` | `DELETE /posts?id=eq.{id}` | 作者删除自己的动态；关联评论、话题关系由外键级联 |
| `topics` | `GET /topics?slug=eq.{slug}` | 查找话题 |
| `topics` | `POST /topics` | 登录用户创建话题，slug/title 唯一 |
| `post_topics` | `GET /post_topics?post_id=eq.{id}` | 读取动态话题；嵌套关联 `topics(id,slug,title)` |
| `post_topics` | `POST /post_topics` | 仅能为自己的动态添加话题 |
| `comments` | `GET /comments?post_id=eq.{id}&moderation_status=eq.visible` | 读取可见评论 |
| `comments` | `POST /comments` | 登录用户评论；允许文字、表情和最多 4 张图片路径 |
| `comments` | `DELETE /comments?id=eq.{id}` | 作者删除自己的评论 |
| `post_likes` | `POST /post_likes` | 当前用户点赞；`(post_id,user_id)` 唯一 |
| `post_likes` | `DELETE /post_likes?post_id=eq.{id}&user_id=eq.{uid}` | 取消自己的点赞 |
| `follows` | `POST /follows` | 当前用户关注其他用户；禁止关注自己 |
| `follows` | `DELETE /follows?follower_id=eq.{uid}&followee_id=eq.{id}` | 取消自己的关注 |
| `reports` | `POST /reports` | 登录用户举报动态、评论或账号，初始状态 `open` |

动态正文最多 5,000 字；评论最多 2,000 字；动态最多 9 张图，评论最多 4 张图；每张图片最大 5 MB，MIME 仅接受 JPEG、PNG、WebP、GIF。

### 图片存储

Bucket：`community-media`（私有）。对象路径格式：`{auth.uid()}/{uuid}.{ext}`。前端 SDK 上传后把路径写入动态或评论 `image_paths`。读取可见内容时调用 `storage.from('community-media').createSignedUrls(paths, 3600)` 获取 1 小时签名 URL。RLS 只允许对象所有者，或被可见动态/评论引用的图片被读取。

头像使用 `storage.from('community-media').createSignedUrl(path, 3600)` 生成 1 小时签名 URL；数据库策略允许读取当前非注销资料所引用的头像对象。

### 用户资料

`profiles` 可公开读取公开资料字段。用户只可更新自己的 `username`、`display_name`、`avatar_path`、`bio`；角色和账号状态不能由客户端修改。邮箱不存进公开 profile 表。资料编辑通过 `PATCH /rest/v1/profiles?id=eq.{uid}` 更新 `display_name`（1–40 字）、`bio`（最多 240 字）与 `avatar_path`。头像限 JPG/PNG/WebP、最大 2 MiB；先上传到 `{uid}/{uuid}.{ext}`，资料更新成功后才删除旧头像。失败时清理新文件并保留原资料。头像为社区可见资料。

## Edge Functions

以下函数启用 JWT 验证，均要求 `Authorization: Bearer <access_token>`。

### `POST /functions/v1/admin-moderate`

仅 active 管理员可调用。Edge Function 会再次检查 token 与 profile role，再以服务端密钥执行动作并写 `moderation_audit`。

请求 JSON：

```json
{
  "action": "hide_post",
  "targetType": "post",
  "targetId": "uuid",
  "reportId": "optional-uuid",
  "reason": "违反社区规范"
}
```

支持动作：`hide_post`、`remove_post`、`restore_post`、`hide_comment`、`remove_comment`、`restore_comment`、`suspend_user`、`restore_user`、`handle_report`、`dismiss_report`。账号角色为 admin 的目标不能被暂停。若传 `reportId` 且动作是内容处理，会将该举报标记为 handled。

成功：`{ "ok": true }`。常见错误：`401 unauthorized`、`403 forbidden`、`400 unsupported_action`、`400 invalid_request`。

### `POST /functions/v1/delete-account`

要求当前用户在请求体中明确输入确认词。函数删除该用户的线上 Auth/profile、动态、评论、点赞、关注、举报和社区媒体；本机 IndexedDB 记录不会被删除。

```json
{ "confirmation": "DELETE" }
```

成功：`{ "ok": true, "localDataRetained": true }`。管理员账号不能通过此接口自助删除。

## 主要错误处理

- `23505`：唯一键冲突，例如已存在话题或重复点赞/关注；UI 对话题并发创建会重新读取已有话题。
- `42501`：RLS 或列级权限拒绝；检查会话状态和目标记录归属。
- `PGRST116`：查询结果数量与 `single()` 不符；避免在可空查询中强制 single。
- 网络错误：社区界面显示可重试错误；发布图片失败时用户可重新选择图片并重试。

## 权限摘要

| 角色 | 浏览公开社区 | 发布互动 | 管理举报/内容 | 修改账号状态 |
|---|---:|---:|---:|---:|
| 未登录 | 是 | 否 | 否 | 否 |
| 已验证普通用户 | 是 | 是 | 否 | 否 |
| 暂停账号 | 公开读取 | 否 | 否 | 否 |
| 管理员 | 是 | 是 | 是 | 通过受保护 Edge Function |
