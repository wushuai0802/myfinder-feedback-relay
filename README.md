# MyFinder 反馈中转服务

接收 MyFinder Device Battery 的程序内反馈，在 `wushuai0802/myfinder-device-battery` 创建带有 `in-app-feedback` 标签的**公开 GitHub issue**。用户不需要 GitHub 账号，令牌只留在服务端。

## 接口

- `GET /health`：200，`{"ok":true}`。仅表示服务可响应，不会检查令牌或访问 GitHub。
- `POST /feedback`：使用 `Content-Type: application/json`（允许 `charset=utf-8`），请求体最多 **32768 字节**。声明的 `Content-Length` 和实际流式读取的字节数都会检查。
- `POST /feedback/replies`：批量读取公开回复，请求体最多 **2048 字节**，不需要反馈凭证或配置 GitHub 令牌。
- `POST /feedback/supplement`：凭反馈密钥追加补充，请求体最多 **32768 字节**。两个新接口也要求 `Content-Type: application/json`。
- `GET /device-pack/v1/<文件名>`（也支持 `HEAD`）：只读型号数据包镜像，见下文。
- 其他路径返回 404；已知路径不支持的方法返回 405。服务不提供 CORS 头，面向桌面程序调用。

反馈请求字段必须恰好如下，不能缺少或添加字段：

```json
{
  "schema": 1,
  "category": "device",
  "description": "这里填写具体问题和复现步骤",
  "diagnostics": null,
  "appVersion": "1.3.5-beta.6"
}
```

| 字段 | 限制 |
| --- | --- |
| `schema` | 数字 `1`；启用补充凭证时为 `2`，并且仅额外添加 `replyKey` 字段 |
| `category` | `device` 设备不识别、`battery` 电量或 DPI 不对、`ui` 界面或操作、`other` 其他 |
| `description` | 字符串，去除首尾空白后 5–2000 个 Unicode 码点 |
| `diagnostics` | `null` 或最多 20000 个 Unicode 码点的字符串；无内容时不生成诊断折叠段 |
| `appVersion` | 最多 32 个字符，匹配 `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$` |

成功返回 201，例如 `{"number":123,"url":"https://github.com/wushuai0802/myfinder-device-battery/issues/123"}`。链接只根据配置的仓库和 GitHub 返回的正整数 issue 编号生成。

`schema: 1` 的字段、正文和响应保持不变。新客户端可使用 `schema: 2`，在上述字段外添加 `replyKey`：客户端随机生成 32 字节并编码为无填充的 base64url，必须是 43 个字符，匹配 `^[A-Za-z0-9_-]{43}$` 且解码为 32 字节。客户端须自行保管密钥和返回的 issue 编号，服务不会返回或恢复密钥。成功响应为 `{"number":123,"url":"https://github.com/wushuai0802/myfinder-device-battery/issues/123","replyAccess":true}`。

schema 2 的 issue 正文最后两行固定为（之后没有正文或换行）：

```text
<!-- 程序内反馈凭证摘要，请勿删除下一行 -->
<!-- myfinder-reply:v1 sha256=<64 位小写十六进制摘要> -->
```

摘要为字符串 `"myfinder/reply/v1\0" + replyKey` 的 UTF-8 字节的 SHA-256，其中 `\0` 是一个 NUL 字符。密钥原文不会发送给 GitHub，也不写入日志。

错误体统一为 `{"error":"代码"}`：

| HTTP 状态 | 代码 | 含义 |
| --- | --- | --- |
| 400（以及路由的 404、405） | `invalid` | 请求格式、字段、路径或方法不符合要求 |
| 413 | `too_large` | 声明或实际请求体超过字节上限 |
| 403 | `denied` | 补充目标不存在、是 PR、无反馈标签，或末行凭证摘要缺失／不匹配 |
| 409 | `closed` | 补充目标已关闭、锁定，或评论数达到 100 |
| 429 | `rate_limited` | 达到限流阈值，响应有以秒为单位的 `Retry-After` |
| 503 | `disabled` | 未配置令牌，或已停用提交 |
| 503 | `unavailable` | GitHub 熔断期间暂停写入或回复读取；回复接口会在读取地址额度前立即返回，响应包含以秒为单位的 `Retry-After` |
| 502 | `unavailable` | GitHub 搜索、补充读取、创建或型号包下载失败、响应异常或超时；批量回复读取按条目报告错误 |

## 读取公开回复

向 `POST /feedback/replies` 发送且仅发送 `{"schema":1,"numbers":[123,124]}`。`numbers` 必须包含 1–10 个不重复的正安全整数。响应为 200，`items` 与请求顺序一致：

```json
{
  "schema": 1,
  "items": [{
    "number": 123,
    "status": "ok",
    "state": "open",
    "locked": false,
    "canSupplement": true,
    "comments": [{
      "id": "123456789",
      "createdAt": "2026-11-05T08:30:00Z",
      "updatedAt": "2026-11-05T08:30:00Z",
      "author": "maintainer",
      "text": "请提供复现步骤。",
      "truncated": false
    }]
  }, {"number": 124, "status": "unavailable"}]
}
```

不存在、是 PR 或缺少 `in-app-feedback` 标签的条目为 `unavailable`；单条上游失败为 `{"number":123,"status":"error"}`，不会使整批失败。`canSupplement` 仅表示 issue 处于 open、未锁定、评论数少于 100 且末行存在格式有效的凭证摘要；它不证明客户端持有正确密钥，也不检查补充频率额度。

只展示维护者（默认数字用户 ID `50058348`）的评论，排除以 `<!-- myfinder-supplement:v1 ` 开头的程序内补充；自动分诊机器人（默认数字用户 ID `41898282`）仅在正文以 `<!-- myfinder-triage:v1 -->` 开头时展示，返回 `author: "automation"` 并去除该标记及其换行。用户名不参与认证。每条文本最多 4000 个 Unicode 码点，超出时 `truncated: true`，不会拆开代理对；保留所读取评论中最新的 50 条，按时间从旧到新排列。

每个 issue 的评论以 `per_page=100` 获取，最多读取 3 页，只跟随 HTTPS、精确 `api.github.com` 主机和当前 issue 评论路径的 `Link rel="next"`。非法下一页链接会使该条目失败，不请求该链接；超过 3 页的评论不再读取。批次内顺序访问上游。

issue 与各评论页一起缓存 10 分钟，进程内最多 500 个 issue，满时淘汰最早存入的条目；读取命中不延长有效期。刷新分别携带各资源已保存的 `ETag` 作为 `If-None-Match`，304 复用该资源的旧数据；issue 的 304 不会跳过评论刷新。刷新失败返回条目错误，不延长旧缓存有效期。成功追加补充会使该 issue 缓存失效。

读取接口独立按可信地址的 SHA-256 哈希限制为滑动一小时 **30 次请求**（按批次计数，含缓存命中和上游失败），超限返回 429 和 `Retry-After`；未知地址共用桶，地址表最多 10000 项。未配置令牌或 `FEEDBACK_DISABLED=1` 时仍可读取公开回复。

进程内所有回复读取共用一个 GitHub 上游读取预算，默认滑动一小时 **1200 次 API 请求**，可通过构造选项 `replyReadBudget` 调整。每次 issue 读取和每个评论页分别计数，包括 304 和失败的调用，调用前预留且不释放；预算耗尽后，未命中的剩余条目直接返回 `{"number":123,"status":"error"}`，不再访问 GitHub，仍可返回有效缓存。

服务记录所有 GitHub API 响应中最新的有效数字 `X-RateLimit-Remaining`。低于 **1000** 且对应 `X-RateLimit-Reset`（Unix 秒）尚未到期时，回复缓存命中仍返回，缓存未命中条目返回 `error` 且不访问 GitHub；没有有效恢复时间时保持该限制，直到后续响应报告恢复的数字额度。缺失或非数字的剩余额度头不会清除上次记录。此水位和回复读取预算仅限制回复接口，创建反馈和补充仍按原有额度及熔断器处理。

## 追加补充

向 `POST /feedback/supplement` 发送以下全部字段，不允许额外字段：

```json
{
  "schema": 1,
  "number": 123,
  "replyKey": "<创建反馈时保管的 43 字符密钥>",
  "requestId": "12345678-1234-4234-8234-123456789abc",
  "description": "这里补充具体复现步骤",
  "diagnostics": null,
  "appVersion": "1.3.5-beta.6"
}
```

`number` 为正安全整数，`replyKey` 规则与创建相同，`requestId` 必须是小写 UUID v4。描述、诊断和版本规则与创建相同：描述去除首尾空白后 5–2000 个 Unicode 码点，诊断为 `null` 或最多 20000 个码点，版本最多 32 字符且匹配上表规则。完整验证后才访问 GitHub。

服务先检查 issue 的标签、类型、状态、锁定和评论数，再对 `body.trimEnd()` 的**最后一行**严格匹配凭证摘要，并使用 Web Crypto 的 HMAC 校验进行恒定时间比较。用户描述、代码围栏或其他位置的伪造标记均无效；错误密钥不会进入评论读取和创建步骤。验证通过后按相同的分页规则读取评论；若维护者的评论已以 `<!-- myfinder-supplement:v1 request=<requestId> -->` 开头，返回 200 `{"number":123,"commentId":"456","duplicate":true}`，不再写入，也不占用新的成功写入额度，但仍消耗一次预认证尝试。客户端重试同一次补充时应保留原 `requestId`。

每个 issue 过去滑动 24 小时最多允许 **3 条**维护者发布的补充标记评论；请求在第一次 GitHub 调用前还会按地址哈希预留一次尝试，滑动一小时最多 **30 次**，失败、错误密钥和重复请求也计数且不会释放，超限立即返回 429 和 `Retry-After`。此外进程内按地址最多 **10 条 / 24 小时**，全局最多 **20 条 / 小时**。写入前预留地址和全局额度，确定未写入的 HTTP 失败会释放；网络异常、超时、5xx 或成功响应无法解析时结果不确定，保留额度，随后用相同 `requestId` 查询重复结果。同一进程内对同一 issue 的补充顺序处理。额度与缓存不跨实例共享，GitHub 评论检查不提供跨实例原子保证。

新评论以补充标记开头，接着是 `来自程序内补充 · 版本 <appVersion>`、描述代码块，以及非 `null` 时的诊断折叠段（空字符串也生成诊断代码块）。围栏长度和控制字符处理沿用创建反馈规则。成功返回 201 `{"number":123,"commentId":"456","duplicate":false}`。停用或缺少令牌时返回 503 `disabled`。

## GitHub 上游保护

所有 GitHub API 读写调用共用进程内熔断器。遇到携带 `Retry-After` 或 `X-RateLimit-Remaining: 0` 的 403／429 时，按 `Retry-After` 秒数或 HTTP 日期、额度耗尽时的 `X-RateLimit-Reset` 恢复时间暂停调用；两者都有效时采用较晚时间，最多暂停一小时。没有有效恢复时间时保守等待一小时。熔断期间 `/feedback/replies` 在预留地址读取额度前立即返回 503 `{"error":"unavailable"}` 和 `Retry-After`，包括请求的条目已有有效缓存时。若熔断在批次处理中开启，后续条目返回 `error`；创建反馈和补充仍返回带 `Retry-After` 的 503。到期后自动允许调用。

带令牌的 API 请求使用 `redirect: "manual"`，不跟随重定向；评论分页另做精确主机和路径校验。每次调用（包括读取响应）仍限时 10 秒。型号数据包镜像使用独立、无令牌的下载路径，不受此熔断器影响。

## 型号数据包只读镜像

`GET /device-pack/v1/<文件名>` 和 `HEAD /device-pack/v1/<文件名>` 仅接受完全匹配 `^device-pack-v1-(latest|[1-9][0-9]{0,9})\.json(\.sig)?$` 的文件名，且 `latest` 不允许带 `.sig`。例如 `device-pack-v1-latest.json`、`device-pack-v1-1.json`、`device-pack-v1-1.json.sig`。其他名称一律 404，不对路径中的编码字符做二次解码；合法名称的其他方法返回 405。HEAD 与 GET 执行相同的下载校验和缓存流程，但响应没有正文（包括错误响应）。

上游固定为 `https://github.com/wushuai0802/myfinder-device-battery/releases/download/device-pack/<文件名>`，不受 `FEEDBACK_REPO` 影响。传入的查询参数被忽略，不转发请求头、Authorization、Cookie 或令牌；`If-None-Match` 只在本地比较。下载使用 `redirect: "follow"`，最终 URL 必须为 HTTPS，主机仅允许 `github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`，不允许非默认端口。每次下载（含读取正文）限时 10 秒；latest 和签名各限 4096 字节，版本数据包限 262144 字节，同时检查声明长度和实际读取字节数。上游 404 返回 404，其他失败、非法跳转、超时或超限均返回 502，不缓存失败结果。镜像独立于反馈令牌及 `FEEDBACK_DISABLED`，不创建 issue。

JSON 响应使用 `Content-Type: application/json`，签名使用 `text/plain`，并设置 `X-Content-Type-Options: nosniff`，不添加 CORS 头。latest 的 `Cache-Control` 为 `public, max-age=300`，带版本号的 JSON 和签名为 `public, max-age=86400, immutable`。进程内缓存采用相同有效期，最多 64 个文件，超过时淘汰最早存入的文件，读取不会延长有效期或改变淘汰顺序。成功响应保留上游 `ETag`，匹配的 `If-None-Match` 返回无正文的 304（支持弱标签、标签列表及 `*`）；过期后先重新下载再比较。

镜像单独按地址的 SHA-256 哈希限流：滑动一分钟内最多 60 次合法 GET/HEAD，包括缓存命中、304 和下载失败；超限返回带 `Retry-After` 的 429。使用与反馈相同的可信地址来源，不读取转发头；缺少地址时共用未知桶，地址表最多 10000 项，过期后回收。缓存和限流均只属于当前进程，重启清空，多实例不共享。镜像只传递文件字节，**客户端仍须使用内置公钥校验型号数据包签名**。

## 限流、文字处理与隐私

先验证完整请求，再做限流和网络调用。创建反馈时，每个地址在滑动一小时内最多 **3 次成功提交**；并发请求预留名额，失败后释放。没有地址的请求共用同一个未知桶。内存表最多 10000 项，请求到来时清理过期项，清理后仍满会拒绝新地址。读取回复、追加补充和型号包镜像各有独立额度；回复还有默认 1200 次/小时的进程级 GitHub API 读取预算，补充有 30 次/小时/地址的不可释放预认证尝试额度。

创建 issue 前，分别搜索该仓库中带 `in-app-feedback` 标签、过去一小时及过去 24 小时创建的 issue，达到 **10 / 小时**或 **40 / 24 小时**即拒绝。任一搜索失败均返回 502，不会放行。每次 GitHub 调用（包括读取响应）有 10 秒超时。

两条全局限流查询均使用 `repo:<repo> is:issue label:in-app-feedback created:>=<时间>`。GitHub 对细粒度令牌的 issue 搜索要求显式包含 `is:issue` 或 `is:pull-request`，否则返回 422；本服务只统计 issue，因此使用 `is:issue`。普通令牌下不带这一限定符可能仍能成功，不能据此判断细粒度令牌兼容性。

这些限制依赖单个服务实例的内存和 GitHub 搜索：重启会清空地址额度，多实例不共享地址表，GitHub 搜索索引可能延迟，因此全局搜索阈值不构成跨实例的原子计数。429 的等待时间为当前地址最早记录的剩余时间，或保守的窗口时长；仅有处理中请求时为 60 秒。

标题会清除控制字符、截断首行，把 `@` 和 `#` 替换为全角字符；描述和诊断各放入长度足以容纳原文反引号的代码围栏，避免内容跳出代码块变成链接、图片或提及。CRLF 统一为 LF，仅保留换行和制表符这两类控制字符。

**反馈、补充和回复都会公开显示在 GitHub。** 请勿提交密码、令牌、个人身份信息等敏感内容；发送前检查描述和诊断。读取回复是公开数据访问，不需要密钥。密钥仅以带域前缀的 SHA-256 摘要保存在公开 issue 正文中，服务不持久化密钥；拥有密钥的人可追加补充，应由客户端安全保管。维护者编辑 issue 正文删除末行摘要即可撤销补充权限，补充接口每次都会重新读取正文；回复缓存中的 `canSupplement` 最多延迟 10 分钟更新。

GitHub 是唯一持久存储，不增加数据库或服务端 secret。服务只在进程内短期缓存公开 issue、评论和 ETag，并保存地址的 SHA-256 哈希、额度时间戳和处理中计数；不保存原始地址，不记录请求内容、地址、令牌或密钥。缓存、地址额度及熔断状态在重启后清空，多实例不共享。地址哈希不是完全匿名化；GitHub 和部署平台可能另有自己的数据保留策略。

上游失败只记录 `relay_error stage=create status=403 kind=http` 形式的安全日志。原有阶段为 `search_hour`、`search_day`、`create`、`device_pack`、`unexpected`；新增 `replies_issue`、`replies_comments`、`supplement_issue`、`supplement_comments`、`supplement_create`。状态码为 GitHub HTTP 状态码（未收到则为 `0`），类型为 `timeout`、`network`、`http`、`bad_body`、`redirect`、`too_large`、`paused`、`read_budget`、`watermark` 或 `unexpected`。单条回复错误也会记录其阶段；预先被熔断拒绝的请求不重复记录日志。日志不含请求头、请求体、用户文字、地址、令牌、密钥、GitHub 正文或异常消息。

## 部署步骤（Deno Deploy）

1. 在 GitHub 的 Settings → Developer settings → Personal access tokens → Fine-grained tokens 创建令牌。资源所有者选择目标仓库所有者，仓库范围选 **Only select repositories**，只选择 **myfinder-device-battery**；仓库权限仅开启 **Issues: Read and write**（**Metadata: Read-only** 会自动附带）。设置到期时间，并把到期提醒写进自己的日历。不要把令牌写进仓库或桌面程序。
2. 登录 <https://console.deno.com>，新建应用并连接 **myfinder-feedback-relay** 仓库，入口文件选 **main.js**。
3. 在应用环境变量中添加 **FEEDBACK_GITHUB_TOKEN**，类型选择 **secret**，环境选择 **Production**。默认目标仓库为 `wushuai0802/myfinder-device-battery`；仅在确有需要时配置 `FEEDBACK_REPO=owner/repo`，并相应调整令牌的仓库范围。
4. 部署后打开 `<地址>/health`，应返回 `{"ok":true}`。把服务地址告诉程序维护者写进程序；提交路径为 `<地址>/feedback`。健康检查不证明 GitHub 写入权限有效，首次端到端提交需要在获准后另外验证。
5. 收到垃圾提交时，设置 **FEEDBACK_DISABLED=1** 并让配置在生产部署生效，立即停用创建和补充（健康检查、公开回复读取及型号包镜像仍可用）。令牌泄露时，先在 GitHub 撤销，再重建令牌并更新服务端 secret。

入口仅使用 `info.remoteAddr.hostname` 传入地址，不读取 `X-Forwarded-For` 等可伪造头。**尚未在 Deno Deploy 验证该值是否为真实客户端地址**；若平台给出代理地址，多名用户可能共用额度；未给出地址则进入未知桶。上线验收需核实平台当前行为。

## 本地验证与移植

安装 Node 24 后，在项目目录运行 `npm test`（或 `node --test`）。无依赖，测试全部使用假的 fetch，不访问 GitHub。导入 `main.js` 不会在 Node 下启动服务。

`handler.js` 导出 `createHandler({ token, repo, fetch, now, disabled, log, maintainerId, triageBotId, replyReadBudget })`，其中 `repo` 默认上述仓库、`fetch` 默认全局 fetch、`now` 默认 `Date.now`、`log` 默认 `console.error`，两个数字身份默认分别为 `50058348` 和 `41898282`，`replyReadBudget` 默认 `1200`（设为 `0` 时仅允许缓存回复），可在构造时覆盖（例如测试或移植到其他仓库）。入口读取令牌和 handler 接收令牌时都会去除首尾空白。返回的异步函数接收标准 `Request` 和客户端 hostname 字符串（也支持 Deno 的 `{ remoteAddr: { hostname } }`），返回标准 `Response`。其他 Fetch 运行时可自行适配可信地址来源；应保证 Web Crypto、atob、AbortController 和流式 Fetch API 可用。
