# 访问与搜索埋点接口

## 前端配置

当前后端基地址为 `https://record.tommy.xx.kg`，配置位于 `js/config.js` 的 `ANALYTICS_CONFIG.baseUrl`。事件路径分别配置在 `endpoints.home_visit` 和 `endpoints.search`。单个路径留空时停用该事件，`enabled: false` 停用全部事件。

| 事件 | 接口 | 方法 |
| --- | --- | --- |
| 首页访问 | `https://record.tommy.xx.kg/api/libre` | POST |
| 搜索提交 | `https://record.tommy.xx.kg/api/searchlist` | POST |

两个接口均发送 `Content-Type: application/json`。`track()` 发出请求后立即返回 `undefined`，不等待、不读取后端的状态或响应体，不影响页面和搜索。

前端直接请求上表中的两个接口，跨域由接收后端处理，不增加 Cloudflare Pages 转发。也支持直接在某个 `endpoints` 字段填写完整 HTTP(S) 地址。

## 请求 JSON

首页加载，发送到 `/api/libre`（每次页面加载一次，刷新会重新计数）：

```json
{
  "event": "home_visit",
  "keyword": null,
  "occurred_at": "2026-10-31T02:00:00.000Z",
  "page_path": "/",
  "device": {
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    "platform": "Windows",
    "language": "zh-CN",
    "timezone": "Asia/Shanghai",
    "screen": { "width": 1920, "height": 1080, "pixel_ratio": 1 },
    "viewport": { "width": 1280, "height": 720 }
  }
}
```

提交有效搜索，发送到 `/api/searchlist`（关键词已去除首尾空白）：

```json
{
  "event": "search",
  "keyword": "流浪地球",
  "occurred_at": "2026-10-31T02:00:05.000Z",
  "page_path": "/"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `event` | string | 仅 `home_visit`、`search` |
| `keyword` | string 或 null | 搜索事件为非空关键词，访问事件为 null |
| `occurred_at` | string | 浏览器生成的 ISO 8601 UTC 时间；后端可另存接收时间 |
| `page_path` | string | 事件发生时的页面路径，不含域名、查询串和 hash；搜索路径可能为 `/s=...` |
| `device` | object | 仅 `home_visit` 携带，字段说明见下表；搜索事件不携带 |

设备信息由浏览器直接提供，无法获取的字段为 `null`。不请求额外权限，不生成设备指纹或持久设备 ID。

| 设备字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_agent` | string 或 null | 浏览器 User-Agent，后端可据此解析浏览器及系统 |
| `platform` | string 或 null | 优先读取 User-Agent Client Hints 平台名，否则使用浏览器平台标识，如 Windows、Win32、iPhone；不是精确设备型号 |
| `language` | string 或 null | 浏览器语言，如 zh-CN |
| `timezone` | string 或 null | 浏览器报告的时区，如 Asia/Shanghai |
| `screen.width` / `screen.height` | number 或 null | 屏幕宽高，单位为 CSS 像素 |
| `screen.pixel_ratio` | number 或 null | 设备像素比 |
| `viewport.width` / `viewport.height` | number 或 null | 首页上报时的窗口视口宽高，单位为 CSS 像素 |

搜索按钮、回车、历史记录和 URL 自动搜索均经过同一搜索函数。通过密码校验、关键词非空且已选择视频源后，发一次 `search`；不随视频源数量、分页请求数增加。接口无结果或后续搜索失败也保留这次提交事件。

## IP 地址由接收后端获取

浏览器没有可靠的公网 IP API，前端不调用第三方查 IP 服务、不在请求 JSON 中声明 IP。接收接口从连接来源中获取 IP，并和事件一起入库即可满足访问 IP 与搜索关键词统计。

后端入库记录示例：

```json
{
  "event": "search",
  "keyword": "流浪地球",
  "occurred_at": "2026-10-31T02:00:05.000Z",
  "page_path": "/",
  "ip": "203.0.113.10",
  "received_at": "2026-10-31T02:00:05.100Z"
}
```

接收接口若有 CDN 或反向代理，只信任自有或已配置可信代理写入的来源 IP 头（如 `X-Forwarded-For`），否则使用连接来源 IP。用户使用代理时，接收后端通常只能获取该代理出口 IP。

## 响应与跨域

后端可返回 HTTP `204 No Content` 或其他响应。前端不读取响应状态或内容，后台只处理网络失败及清理计时器。

跨域接口需处理 OPTIONS 预检，并对站点实际 Origin 返回：

```http
Access-Control-Allow-Origin: https://你的前端域名
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Vary: Origin
```

当前后端已使用 HTTPS，可以从 Cloudflare Pages 的 HTTPS 页面直接请求；后端仍需正常返回 CORS 响应头。

## 排查请求

`ANALYTICS_CONFIG.debug: true` 时，在浏览器控制台筛选 `[Analytics]`：`发起请求` 代表调用了 fetch；`请求未完成` 代表网络、跨域或超时导致请求未完成；`无法发起请求` 代表同步异常。日志只包含事件类型、接口地址和异常类型，不包含关键词、IP 或设备信息。日志不代表后端已入库；联调完成可设为 `false`。

先打开开发者工具再刷新首页，在 Network 面板选择 All 或 Fetch/XHR，筛选 `record.tommy.xx.kg`。搜索事件只会在密码验证通过、关键词非空且至少选中一个视频源时触发。修改配置后需重新部署，强制刷新页面以更新缓存脚本。

请求不附带 Cookie 或 Authorization。若后端需要鉴权，提供接口时再约定。前端使用 `keepalive` 尽量完成页面跳转时的发送，默认 3 秒超时；失败不会影响搜索，不自动重试、不补发未配置接口时的历史事件。此统计是尽力上报，不保证每次访问都送达，也不代表按 IP 去重后的独立访客数。
