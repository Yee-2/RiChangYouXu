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

1. 创建 Supabase 项目，并在 SQL Editor 按文件名顺序执行 `supabase/migrations/` 中的迁移。已执行旧迁移的项目只补执行尚未应用的迁移，包括新增管理员表迁移 `20261108093526_separate_admin_accounts_and_filters.sql`。
2. 复制 `.env.example` 为 `.env.local`，填入 Project URL 和 anon/publishable key。
3. 部署 Edge Functions：`admin-moderate`、`admin-manage`、`delete-account` 与 `delete-content`。PowerShell 请在项目目录使用 `npx.cmd`（避免执行策略拦截 `npx.ps1`）：依次执行 `npx.cmd supabase login`、`npx.cmd supabase link --project-ref obyqyzgycivgituobdzm`，再对四个函数分别执行 `npx.cmd supabase functions deploy <function-name> --use-api`。本配置已启用 JWT 校验；`--use-api` 部署不需要本地 Docker。
4. 在 Supabase Authentication 中启用邮箱验证并设置 Site URL / Redirect URLs，加入后台密码恢复地址 `https://admin.yeecc.cn/`。
5. 在 Cloudflare 将 `admin.yeecc.cn` 作为现有 `richangyouxu` Worker 的另一个 Custom Domain 绑定。
6. 首次管理员先正常注册并验证邮箱，再由项目拥有者在 SQL Editor 执行：

```sql
with target as (
  select u.id, lower(u.email) as email from auth.users u
  where lower(u.email) = lower('你的管理员邮箱') and u.email_confirmed_at is not null
)
insert into public.admin_accounts(user_id, email, created_by)
select id, email, id from target
on conflict (user_id) do update set email = excluded.email;

update public.profiles set role = 'admin'
where id = (select id from auth.users where lower(email) = lower('你的管理员邮箱'));
```

确认只有可信任的账号被提升为管理员。不要把 service-role key 放入 `.env.local` 或前端环境变量。

后台只在 `https://admin.yeecc.cn/` 提供邮箱密码登录和忘记密码，没有注册入口。管理员之后可在“管理员账号”页通过弹窗，按 6 位 UID 或邮箱添加已验证的现有账号为管理员。

## 常用命令

```bash
npm run build
npm run preview
```

## Cloudflare Worker 发布

根目录 `wrangler.toml` 配置了 `daily.yeecc.cn` 与 `admin.yeecc.cn` 两个生产自定义域名，以及 `dist` 单页应用资源。

连接 Cloudflare Workers Builds 后，生产分支设为 `main`、根目录设为 `/`，构建命令使用 `npm run build`，部署命令使用 `npx wrangler deploy`。Cloudflare 首次连接仓库时需要安装 GitHub App 并授权读取 `Yee-2/RiChangYouXu`；完成后推送 `main` 会发布两个域名共用的新前端。

手动发布时，在项目目录完成 `npx wrangler login`，然后执行 `npm run build` 和 `npx wrangler deploy`。

部署细节见 [产品使用与部署指南](docs/product-guide.md)，接口见 [接口文档](docs/api.md)。隐私、服务协议和社区规范目前是运营草稿，公开上线前需要填写真实运营主体、联系方式和服务商信息。
