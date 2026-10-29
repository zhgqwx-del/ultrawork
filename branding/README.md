# 品牌发行配置

无参数构建仍使用默认 Ultrawork。定制发行版需要稳定的 brandId、productName 和本地图标：

```bash
bun run brand:inspect --brand branding/mywork/brand.json
bun run release --brand branding/mywork/brand.json
bun run tauri:build --brand branding/mywork/brand.json
bun run release --brand-id local-demo --name 'Local Demo' --icon /path/to/icon.png
```

首期 productName 使用可打印 ASCII，确保 Tauri 原生 Linux 包名也合法；素材路径可含中文。

先用 `brand:inspect` 检查派生身份。品牌文件素材相对该文件，临时参数路径相对调用目录。只有名称或只有图标不会创建不完整的独立品牌。显式配置错误时构建失败，不回退默认。

`identity.json` 固定正式发行的 ID 和名称；修改图标允许，修改同一 ID 的发行名称会被拒绝。临时品牌在持锁准备构建时也会原子登记到 `.brand-build/identity-ledger.json`；已有成功产物的 manifest 同样参与冲突检查。纯 `brand:inspect` 只读，不登记身份。定制版的二进制名、identifier、数据 namespace 和 MSI upgradeCode 按稳定 ID 派生。品牌之间的数据不自动导入。

构建文件写入被忽略的 `.brand-build/`，默认的源码图标和 Tauri 配置不被改写。一个 checkout 同时只允许一个构建或开发会话；使用另一 checkout 可以并行。`--skip-sidecar` 不跳过品牌协议/二进制校验，需要先重新编译四个 sidecar。

MyWork 原图来自美柚官网标明的 App Store 产品（634896669），由 Apple 官方 CDN 提供 1024px PNG，来源和摘要见 `mywork/assets/source.json`。构建过程中不下载图标。商标和图标权利归原权利人，预设不改变签名证书主体或工程版权署名。

预置实际使用 `meiyou-app-rounded.png`：保留官方原图，按默认 Ultrawork 1024px 主图的 alpha 通道裁出相同圆角和透明轮廓。`bun run --bun scripts/gen-mywork-icon.ts` 可复现派生图，追加 `--check` 只读检查。真实 Tauri icon 测试逐像素核对 PNG、ICNS、ICO 的尺寸和 alpha；不同画面压缩后的文件字节数可以不同。托盘使用独立的单色素材。

macOS 应用/Dock 使用单独的 `icon-macos.icns`：按实心主体的 alpha 边界，将超过画布 824/1024 的图形缩小并居中；两预置在 1024px 中为 824px 主体、四边 100px 透明留白。已含适当留白的输入不重复缩小，SVG 保留字体解析。应用内 Logo、通用 PNG、Windows ICO、Linux 和托盘仍走各自原素材。默认专用资产由 `bun run --bun scripts/gen-macos-icon.ts` 生成，追加 `--check` 验证；旧 `icon.icns` 保留为原始模板，当前 Tauri 配置指向新 ICNS。自定义品牌自动派生对应 ICNS，算法内容纳入 stage digest，Cargo 跟踪最终图标变化。

已有 MyWork dev 会话会保留启动时的品牌 overlay；修改图标后完整退出原开发会话，再运行 `./setup.sh --dev --brand branding/mywork/brand.json`。只刷新页面不能重新准备品牌配置。
