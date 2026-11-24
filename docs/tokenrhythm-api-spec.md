# TokenRhythm 接口规格报告（调研自 RefRepo/opensquilla）

来源文件：
- `desktop/electron/src/tokenrhythm-account.ts`（OAuth 登录、账户/钱包/托管 Key、会话撤销）
- `desktop/electron/src/tokenrhythm-environment.ts`（origin 常量）
- `desktop/electron/src/tokenrhythm-model-proxy.ts`（模型 API 代理）
- `desktop/electron/src/local-account-secrets.ts`（本地凭据加密存储）
- `src/opensquilla/provider/tokenrhythm_catalog.py`（模型目录/计费）
- `src/opensquilla/provider/presets/tokenrhythm.toml`（模型分层预设）
- `src/opensquilla/desktop_account.py`（Python 侧凭据/桥接）

## 0. 关键常量

| 项 | 值 |
|---|---|
| 默认 origin | `https://tokenrhythm.studio`（可用打包元数据/环境变量覆盖，必须 https、无凭据、path=/） |
| OAuth client_id | `opensquilla-desktop` |
| OAuth scope | `profile.read wallet.read managed_key.read managed_key.obtain session.revoke offline_access` |
| 集成 API 前缀 | `{origin}/api/v1/integrations/opensquilla/` |
| OAuth 端点 | `{origin}/api/oauth/authorize`、`{origin}/api/oauth/token` |
| 模型 API base（OpenAI 兼容） | `https://tokenrhythm.studio/v1` |
| 公开模型目录 | `GET {origin}/api/models`（无需鉴权） |
| 设备头（可选） | `X-TokenRhythm-Device-Name`、`X-TokenRhythm-Device-OS` |
| 应用归属头（模型 API） | `HTTP-Referer: https://opensquilla.ai`、`X-Title: OpenSquilla`（opensquilla 专用；插件应换成自己的应用名或省略） |

**重要约束**：托管 Key 接口校验 `app_id === 'opensquilla'`，`client_id` 固定为 `opensquilla-desktop`。TokenRhythm 后端按 app 注册托管 Key —— magpie 插件若要走 `managed-key` 体系，需要 TokenRhythm 为插件注册独立 client_id/app_id；否则只能复用 opensquilla 桌面端已签发的凭据（不现实）。需与 TokenRhythm 方确认插件 client 注册方式。

## 1) 登录流程（OAuth2 Authorization Code + PKCE）

无密码/短信登录，唯一方式是浏览器 OAuth。

1. 本地起 HTTP server（`127.0.0.1:<随机端口>`，仅接受 `GET /oauth/callback`，校验 `state` 单值且匹配）。
2. `state`、`code_verifier` 各为 32 字节随机 base64url；`code_challenge = base64url(sha256(verifier))`（S256）。
3. 打开浏览器：
   ```
   GET {origin}/api/oauth/authorize
     ?response_type=code
     &client_id=opensquilla-desktop
     &redirect_uri=http://127.0.0.1:{port}/oauth/callback
     &state={state}
     &code_challenge={challenge}
     &code_challenge_method=S256
     &scope=profile.read wallet.read managed_key.read managed_key.obtain session.revoke offline_access
     &installation_id={uuid}
   ```
4. 回调：`GET http://127.0.0.1:{port}/oauth/callback?code={code}&state={state}`（拒绝时 `?error=...&state=...`）。服务端 303 到无敏感参数的收据页。
5. 换 token：
   ```
   POST {origin}/api/oauth/token
   Content-Type: application/x-www-form-urlencoded
   X-TokenRhythm-Device-Name: ...   (可选)
   X-TokenRhythm-Device-OS: ...     (可选)

   client_id=opensquilla-desktop
   &grant_type=authorization_code
   &code={code}
   &redirect_uri=http://127.0.0.1:{port}/oauth/callback
   &code_verifier={verifier}
   ```
   响应（裸 JSON，非 {code,data} 信封）：
   `{access_token, refresh_token, expires_in(<=86400), token_type:"Bearer", scope, account_id, session_id, client_id?}`
   校验：必须含全部 scope；`expires_in>0 且 <=86400`。
6. 刷新（access 过期前 30s 自动）：同端点 `grant_type=refresh_token&refresh_token=...`，须保持 account_id/session_id 不变（否则 ACCOUNT_IDENTITY_MISMATCH）。refresh token 旋转：新 refresh_token 必须持久化，旧的不能复用。
7. 登出/撤销：`DELETE {API}session`（Bearer access_token）；离线待撤销会话存 `pending[]` 重试。终止错误码：`ACCOUNT_SESSION_REVOKED`、`ACCOUNT_SESSION_EXPIRED`、`invalid_grant`、HTTP 401。

超时：登录总超时默认 300s；所有 API 请求 `AbortSignal.timeout(20s)`、`redirect:'error'`、`cache:'no-store'`。

## 2) 集成 API（账户域）

前缀 `{origin}/api/v1/integrations/opensquilla/`，鉴权 `Authorization: Bearer {access_token}`。

信封：成功 `{code:0, data:{...}}`（`code!==0` → 错误）；204 → 空。错误体取 `body.error` 或 `body.code`（须匹配 `^[a-zA-Z][a-zA-Z0-9_]{0,95}$`），否则 `ACCOUNT_HTTP_{status}`。

| 方法+路径 | 说明 | 响应 data 字段 |
|---|---|---|
| `GET account` | 资料+会话校验 | `account_id, session_id, display_name, masked_phone, links:{account,usage,recharge}`（links 为站内相对/同源 URL） |
| `GET wallet` | 余额 | `account_id, currency, balances:{available,recharge,bonus,debt,frozen}, as_of`；balances 为十进制字符串 `/^-?\d+(\.\d{1,16})?$/` |
| `GET managed-key` | 托管 Key 元数据 | `account_id, app_id("opensquilla"), status("active"), key_id, generation` |
| `POST managed-key/credential` | 签发/轮换模型密钥 | `{account_id, app_id, status, generation, key_id, secret}` —— `secret` 即模型 API 的 Bearer key |
| `DELETE session` | 撤销当前会话 | 204 |

Key 生命周期：先 GET managed-key 元数据，与本地 `key_id+generation` 一致则复用；否则 POST credential 换新 secret。模型 API 返回 401 → 丢弃本地 key 并重新 obtain。

## 3) 模型 API（推理）

Base `https://tokenrhythm.studio/v1`，鉴权 `Authorization: Bearer {managed-key secret}`（注意：用的是 managed-key 的 secret，不是 OAuth access_token）。

允许路由（opensquilla 代理白名单，可作插件参照）：
- `GET /v1/models`、`GET /api/models`
- `POST /v1/chat/completions`、`POST /v1/images/generations`、`POST /v1/videos/generations`
- `GET /v1/videos/{id}`（轮询视频任务）

模型目录：
- 公开：`GET {origin}/api/models` 无需鉴权，返回发布目录（name/providerDisplayName/type/status/modalities/contextWindow/maxOutputTokens/reasoning*/capabilities/responses/pricing{currency,billingMode,billingUnit,standard/discount/effective 价格桶}）。
- 认证：`GET /v1/models`（Bearer secret）返回该 key 可用的声明模型。
- opensquilla 预设分层：c0 `qwen3.7-flash`、c1 `deepseek-v4-flash-0731`、c2/default `deepseek-v4-pro-0813`、c3 `kimi-k3`（动态目录为准）。

计费：余额扣的是 wallet.balances.available（字符串金额）；目录 pricing 带 standard/discount/effective 价格。

## 4) 凭据存储（opensquilla 桌面端做法，插件可借鉴）

- 目录：Electron `userData`（`account.local.enc` + `account.local.key` + `logged-out` 墓碑标记）。
- 加密：AES-256-GCM，key 为 32 字节随机数存 `account.local.key`；IV 12B；AAD `opensquilla-desktop-account-v1`；密文格式 `local-v1:<base64(iv|tag|ct)>`。
- 存储 JSON（SavedAccount v1）：`{tokens:{accessToken,refreshToken,expiresAt,accountId,sessionId}|null, key:{secret,keyId,generation,accountId}|null, source, selectedAccountId, mediaSources, mediaAccountIds, videoJobs, pending:LoginTokens[]}`。
- 注意：key 文件与密文同目录，防的是其他用户/低权限进程，非防同用户进程。JS 插件建议：access/refresh token 与 managed-key secret 分开存，secret 尤其要避免落盘明文。

## 5) JS/TS 插件可复用的 HTTP 细节

```ts
const ORIGIN = 'https://tokenrhythm.studio' // 需可配置
const CLIENT_ID = 'opensquilla-desktop'      // ⚠ 需 TokenRhythm 为插件注册新 client_id
const SCOPES = 'profile.read wallet.read managed_key.read managed_key.obtain session.revoke offline_access'
const API = '/api/v1/integrations/opensquilla/'

// 1) 授权 URL（PKCE S256）
const verifier = base64url(randomBytes(32))
const challenge = base64url(sha256(verifier))
const authUrl = new URL('/api/oauth/authorize', ORIGIN)
authUrl.search = new URLSearchParams({
  response_type: 'code', client_id: CLIENT_ID,
  redirect_uri: 'http://127.0.0.1:PORT/oauth/callback',
  state, code_challenge: challenge, code_challenge_method: 'S256',
  scope: SCOPES, installation_id: crypto.randomUUID(),
}).toString()

// 2) 换/刷新 token —— form-urlencoded，注意不是 JSON
await fetch(ORIGIN + '/api/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: CLIENT_ID, grant_type, /* code+redirect_uri+code_verifier 或 refresh_token */ }),
})

// 3) 账户域 API —— {code:0,data:{...}} 信封
await fetch(ORIGIN + API + 'wallet', { headers: { Authorization: 'Bearer ' + accessToken } })
//   → data.balances.available 是字符串金额

// 4) 托管 Key
await fetch(ORIGIN + API + 'managed-key', { headers: auth })            // 元数据
await fetch(ORIGIN + API + 'managed-key/credential', { method: 'POST', headers: auth }) // → data.secret

// 5) 模型推理 —— Bearer 用 managed-key secret（不是 access_token）
await fetch('https://tokenrhythm.studio/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + managedKeySecret, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-v4-pro-0813', messages: [...] }),
})
```

## 6) 待确认事项（阻塞插件独立落地）

1. **client_id/app_id 注册**：opensquilla 硬编码 `opensquilla-desktop`/`opensquilla`。magpie 插件需要 TokenRhythm 后台为其注册独立 OAuth client 与 app_id，否则 managed-key/credential 会被拒（后端校验 app_id）。
2. **redirect_uri 限制**：后端是否白名单 redirect_uri？opensquilla 用随机端口 loopback，需确认 TokenRhythm 接受任意 `http://127.0.0.1:{port}`。
3. **installation_id 语义**：是否必填、是否要与 opensquilla 格式一致（UUIDv4）。
4. **公开目录 `/api/models` 的鉴权要求**：opensquilla 代码显示无需 key，但 `fetch_tokenrhythm_declared` 对官方 base 会附带本地凭据 —— 插件可先匿名拉取。
