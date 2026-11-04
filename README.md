# MyFinder 反馈中转服务

接收 MyFinder Device Battery 的程序内反馈，在 `wushuai0802/myfinder-device-battery` 创建带有 `in-app-feedback` 标签的**公开 GitHub issue**。用户不需要 GitHub 账号，令牌只留在服务端。

## 接口

- `GET /health`：200，`{"ok":true}`。仅表示服务可响应，不会检查令牌或访问 GitHub。
- `POST /feedback`：使用 `Content-Type: application/json`（允许 `charset=utf-8`），请求体最多 **32768 字节**。声明的 `Content-Length` 和实际流式读取的字节数都会检查。
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
| `schema` | 数字 `1` |
| `category` | `device` 设备不识别、`battery` 电量或 DPI 不对、`ui` 界面或操作、`other` 其他 |
| `description` | 字符串，去除首尾空白后 5–2000 个 Unicode 码点 |
| `diagnostics` | `null` 或最多 20000 个 Unicode 码点的字符串；无内容时不生成诊断折叠段 |
| `appVersion` | 最多 32 个字符，匹配 `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$` |

成功返回 201，例如 `{"number":123,"url":"https://github.com/wushuai0802/myfinder-device-battery/issues/123"}`。链接只根据配置的仓库和 GitHub 返回的正整数 issue 编号生成。

错误体统一为 `{"error":"代码"}`：

| HTTP 状态 | 代码 | 含义 |
| --- | --- | --- |
| 400（以及路由的 404、405） | `invalid` | 请求格式、字段、路径或方法不符合要求 |
| 413 | `too_large` | 声明或实际请求体超过字节上限 |
| 429 | `rate_limited` | 达到限流阈值，响应有以秒为单位的 `Retry-After` |
| 503 | `disabled` | 未配置令牌，或已停用提交 |
| 502 | `unavailable` | GitHub 搜索、创建或型号包下载失败、响应异常或超时 |

## 型号数据包只读镜像

`GET /device-pack/v1/<文件名>` 和 `HEAD /device-pack/v1/<文件名>` 仅接受完全匹配 `^device-pack-v1-(latest|[1-9][0-9]{0,9})\.json(\.sig)?$` 的文件名，且 `latest` 不允许带 `.sig`。例如 `device-pack-v1-latest.json`、`device-pack-v1-1.json`、`device-pack-v1-1.json.sig`。其他名称一律 404，不对路径中的编码字符做二次解码；合法名称的其他方法返回 405。HEAD 与 GET 执行相同的下载校验和缓存流程，但响应没有正文（包括错误响应）。

上游固定为 `https://github.com/wushuai0802/myfinder-device-battery/releases/download/device-pack/<文件名>`，不受 `FEEDBACK_REPO` 影响。传入的查询参数被忽略，不转发请求头、Authorization、Cookie 或令牌；`If-None-Match` 只在本地比较。下载使用 `redirect: "follow"`，最终 URL 必须为 HTTPS，主机仅允许 `github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`，不允许非默认端口。每次下载（含读取正文）限时 10 秒；latest 和签名各限 4096 字节，版本数据包限 262144 字节，同时检查声明长度和实际读取字节数。上游 404 返回 404，其他失败、非法跳转、超时或超限均返回 502，不缓存失败结果。镜像独立于反馈令牌及 `FEEDBACK_DISABLED`，不创建 issue。

JSON 响应使用 `Content-Type: application/json`，签名使用 `text/plain`，并设置 `X-Content-Type-Options: nosniff`，不添加 CORS 头。latest 的 `Cache-Control` 为 `public, max-age=300`，带版本号的 JSON 和签名为 `public, max-age=86400, immutable`。进程内缓存采用相同有效期，最多 64 个文件，超过时淘汰最早存入的文件，读取不会延长有效期或改变淘汰顺序。成功响应保留上游 `ETag`，匹配的 `If-None-Match` 返回无正文的 304（支持弱标签、标签列表及 `*`）；过期后先重新下载再比较。

镜像单独按地址的 SHA-256 哈希限流：滑动一分钟内最多 60 次合法 GET/HEAD，包括缓存命中、304 和下载失败；超限返回带 `Retry-After` 的 429。使用与反馈相同的可信地址来源，不读取转发头；缺少地址时共用未知桶，地址表最多 10000 项，过期后回收。缓存和限流均只属于当前进程，重启清空，多实例不共享。镜像只传递文件字节，**客户端仍须使用内置公钥校验型号数据包签名**。

## 限流、文字处理与隐私

先验证完整请求，再做限流和网络调用。每个地址在滑动一小时内最多 **3 次成功提交**；并发请求预留名额，失败后释放。没有地址的请求共用同一个未知桶。内存表最多 10000 项，请求到来时清理过期项，清理后仍满会拒绝新地址。

创建 issue 前，分别搜索该仓库中带 `in-app-feedback` 标签、过去一小时及过去 24 小时创建的 issue，达到 **10 / 小时**或 **40 / 24 小时**即拒绝。任一搜索失败均返回 502，不会放行。每次 GitHub 调用（包括读取响应）有 10 秒超时。

两条全局限流查询均使用 `repo:<repo> is:issue label:in-app-feedback created:>=<时间>`。GitHub 对细粒度令牌的 issue 搜索要求显式包含 `is:issue` 或 `is:pull-request`，否则返回 422；本服务只统计 issue，因此使用 `is:issue`。普通令牌下不带这一限定符可能仍能成功，不能据此判断细粒度令牌兼容性。

这些限制依赖单个服务实例的内存和 GitHub 搜索：重启会清空地址额度，多实例不共享地址表，GitHub 搜索索引可能延迟，因此全局搜索阈值不构成跨实例的原子计数。429 的等待时间为当前地址最早记录的剩余时间，或保守的窗口时长；仅有处理中请求时为 60 秒。

标题会清除控制字符、截断首行，把 `@` 和 `#` 替换为全角字符；描述和诊断各放入长度足以容纳原文反引号的代码围栏，避免内容跳出代码块变成链接、图片或提及。CRLF 统一为 LF，仅保留换行和制表符这两类控制字符。

**反馈会公开显示在 GitHub。** 请勿提交密码、令牌、个人身份信息等敏感内容；发送前检查描述和诊断。服务不持久化保存反馈内容，只在处理请求时转发；仅在内存中短期保存地址的 SHA-256 哈希、成功时间和处理中计数用于限流，不保存原始地址，不记录请求内容、地址或令牌。哈希不是完全匿名化；GitHub 和部署平台可能另有自己的数据保留策略。

每次返回 502 时，服务只记录一行 `relay_error stage=create status=403 kind=http` 形式的日志：阶段为 `search_hour`、`search_day`、`create`、`device_pack` 或 `unexpected`，状态码为 GitHub HTTP 状态码（未收到则为 `0`），类型为 `timeout`、`network`、`http`、`bad_body`、`redirect`、`too_large` 或 `unexpected`。日志不含请求头、请求体、用户文字、地址、令牌、GitHub 正文或异常消息；其他响应不记录日志。

## 部署步骤（Deno Deploy）

1. 在 GitHub 的 Settings → Developer settings → Personal access tokens → Fine-grained tokens 创建令牌。资源所有者选择目标仓库所有者，仓库范围选 **Only select repositories**，只选择 **myfinder-device-battery**；仓库权限仅开启 **Issues: Read and write**（**Metadata: Read-only** 会自动附带）。设置到期时间，并把到期提醒写进自己的日历。不要把令牌写进仓库或桌面程序。
2. 登录 <https://console.deno.com>，新建应用并连接 **myfinder-feedback-relay** 仓库，入口文件选 **main.js**。
3. 在应用环境变量中添加 **FEEDBACK_GITHUB_TOKEN**，类型选择 **secret**，环境选择 **Production**。默认目标仓库为 `wushuai0802/myfinder-device-battery`；仅在确有需要时配置 `FEEDBACK_REPO=owner/repo`，并相应调整令牌的仓库范围。
4. 部署后打开 `<地址>/health`，应返回 `{"ok":true}`。把服务地址告诉程序维护者写进程序；提交路径为 `<地址>/feedback`。健康检查不证明 GitHub 写入权限有效，首次端到端提交需要在获准后另外验证。
5. 收到垃圾提交时，设置 **FEEDBACK_DISABLED=1** 并让配置在生产部署生效，立即停用提交（健康检查仍可用）。令牌泄露时，先在 GitHub 撤销，再重建令牌并更新服务端 secret。

入口仅使用 `info.remoteAddr.hostname` 传入地址，不读取 `X-Forwarded-For` 等可伪造头。**尚未在 Deno Deploy 验证该值是否为真实客户端地址**；若平台给出代理地址，多名用户可能共用额度；未给出地址则进入未知桶。上线验收需核实平台当前行为。

## 本地验证与移植

安装 Node 24 后，在项目目录运行 `npm test`（或 `node --test`）。无依赖，测试全部使用假的 fetch，不访问 GitHub。导入 `main.js` 不会在 Node 下启动服务。

`handler.js` 导出 `createHandler({ token, repo, fetch, now, disabled, log })`，其中 `repo` 默认上述仓库、`fetch` 默认全局 fetch、`now` 默认 `Date.now`、`log` 默认 `console.error`。入口读取令牌和 handler 接收令牌时都会去除首尾空白。返回的异步函数接收标准 `Request` 和客户端 hostname 字符串（也支持 Deno 的 `{ remoteAddr: { hostname } }`），返回标准 `Response`。其他 Fetch 运行时可自行适配可信地址来源；应保证 Web Crypto、AbortController 和流式 Fetch API 可用。
