# Research — HTTP 缓存机制入门（讲义版）

> 主题为公开、稳定的 Web 标准（RFC + MDN），事实可长期溯源。本 example 用于示范
> `delivery_purpose=document`（近读讲义）档：正文最长、每页承载最密，且全部事实有真实来源。

## 检索问题与发现

### Q1 现行标准是什么？
- **RFC 9111（2022）** 是现行 HTTP Caching 标准，取代 RFC 7234；统一定义共享缓存（CDN/代理）与
  私有缓存（浏览器）的存储/复用规则。→ F1
- 校验器与条件请求的语义由 **RFC 9110（HTTP Semantics）** 承载。→ F6

### Q2 强缓存（新鲜度）怎么判定？
- `Cache-Control: max-age=N` = 响应 N 秒内新鲜，期间直接复用不回源。→ F2
- `no-store` = 完全不存储；`no-cache` = 可存但每次复用前必须回源验证（**易被误读为「不缓存」**）。→ F3 / F4
- `s-maxage` 只对共享缓存生效并覆盖 max-age；`public/private` 控制哪类缓存可存。→ F10
- 无 max-age/Expires 时缓存可用启发式新鲜度（约 Last-Modified 时长的 10%）。→ F12

### Q3 协商缓存（重新验证）怎么工作？
- 过期后客户端发条件请求：`If-None-Match: <ETag>`；未变则 **304 Not Modified 无响应体**，复用本地副本、省带宽。→ F5
- **ETag**（服务器生成的强/弱校验器，如内容哈希/版本号）优先于 **Last-Modified**（日期、秒级分辨率、同秒多改不可分）。→ F6 / F7

### Q4 陈旧内容的容错扩展？
- **RFC 5861**：`stale-while-revalidate=N` 先返回陈旧响应、后台异步重新验证，隐藏延迟；
  `stale-if-error=N` 在源站出错（5xx/网络/DNS）时返回陈旧响应而非硬错误。→ F8 / F9

### Q5 内容协商与缓存变体？
- `Vary` 声明哪些请求头会导致响应不同，缓存据此区分变体；`Vary: *` 表示每次都必须回源验证。→ F11

## 容量估算（§5.1）
- 档位 = `document`；正文页 5 页 × 每页 3–6 要点 × 每点 ≤42 视觉宽 → 可承载约 20+ 条独立事实。
- research 侧 5 轮检索得 12 条可溯源事实（facts.json），略少于渲染容量 → 选最强证据、每页 ≥3 evidence，
  未在门禁上白白饱和。所有数据为真实标准、非 scenario。
