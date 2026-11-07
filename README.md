# 日常有序

手机优先的生活管理 H5/PWA，包含本机生活清单、出门检查、水电燃气抄表、宠物记录，以及可选的 Supabase 在线社区与管理后台。

## 本机运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

没有 Supabase 配置时，四个个人模块照常使用；社区会显示配置提示，不会伪装为已联网。

## 启用社区

1. 创建 Supabase 项目，并在 SQL Editor 依次执行 `supabase/migrations/202611080001_initial_community.sql` 与 `supabase/migrations/202611080002_profile_avatar_policy.sql`。
2. 复制 `.env.example` 为 `.env.local`，填入 Project URL 和 anon/publishable key。
3. 部署 Edge Functions：`admin-moderate` 与 `delete-account`。在项目目录通过 `npx supabase login` 登录、运行 `npx supabase link --project-ref obyqyzgycivgituobdzm` 关联项目，然后执行 `npx supabase functions deploy admin-moderate --use-api` 与 `npx supabase functions deploy delete-account --use-api`。本配置已启用 JWT 校验；`--use-api` 部署不需要本地 Docker。
4. 在 Supabase Authentication 中启用邮箱验证并设置 Site URL / Redirect URLs。
5. 首次管理员先正常注册并验证邮箱，再由项目拥有者在 SQL Editor 执行：

```sql
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = '你的管理员邮箱');
```

确认只有可信任的账号被提升为管理员。不要把 service-role key 放入 `.env.local` 或前端环境变量。

## 常用命令

```bash
npm run build
npm run preview
```

部署细节见 [产品使用与部署指南](docs/product-guide.md)，接口见 [接口文档](docs/api.md)。隐私、服务协议和社区规范目前是运营草稿，公开上线前需要填写真实运营主体、联系方式和服务商信息。
