2025-08-12 初始化记录

- 目标：基于 Vue 3 + TypeScript + PDF.js + Stirling PDF 搭建在线 PDF 编辑器。
- 决策：采用前端渲染 + 可选后端（Stirling PDF）混合方案：
  - 客户端完成渲染、交互与轻量注释；
  - 服务端提供重处理（合并/拆分/旋转/压缩/OCR/格式转换）。

思考与方案权衡

1) 注释实现策略
- 方案 A：只用 PDF.js + 自定义 Overlay。优点：自由度高、前端即用；缺点：导出为真正可编辑注释较难，需要 `pdf-lib` 或服务端转换。
- 方案 B：依赖 Stirling PDF 提供注释落盘接口。风险：需要确认其 API 是否覆盖注释编辑/扁平化。
- 当前选择：A 起步（快），B 作为增强（若有合适 API）。

2) 导出路径
- 客户端：用 `pdf-lib` 将 Overlay 扁平化为位图或矢量，按页合成。优点：零后端；缺点：内存/性能、字体嵌入处理复杂。
- 服务端：上传原 PDF + JSON 指令到 Stirling PDF。优点：更稳定；缺点：需要部署与跨域处理。

3) Stirling PDF API 可用性
- 待确认：其是否有稳定公开的 REST 端点用于合并/拆分/旋转/水印/OCR/压缩等（多数资料显示可行，但端点命名需以官方为准）。
- 风险：端点路径、鉴权与 CORS。

已创建
- `todolist.md`：分阶段任务与 DoD。
- `cursorlog.md`：记录设计思考与坑位。

潜在坑位预警
- PDF.js Worker 路径配置在 Vite 环境下的兼容性。
- 大文件渲染与滚动性能（分页虚拟化、缩略图生成成本）。
- 注释层坐标系与缩放同步（viewport.scale）。
- 字体加载与跨域（导出矢量文本时）。
- Stirling PDF 跨域与上传体积限制。

下一步
- 初始化 Vue3+TS 项目骨架与依赖安装；搭建基础查看器。

2025-08-12 项目初始化与基础查看器

- 执行：使用 Vite 脚手架创建 Vue3+TS 项目，并安装 `pdfjs-dist` 与 `pdf-lib`。
- 变更：
  - 新增 `src/views/Viewer.vue`：集成 PDF.js，支持分页、缩放，默认加载 `/sample.pdf`，新增本地文件上传以 `ArrayBuffer` 方式加载。
  - 新增 `src/router/index.ts`，在 `src/main.ts` 中挂载路由；将 `src/App.vue` 改为渲染 `<router-view />`。
  - 修改 `vite.config.ts`：增加可选代理 `/stirling`，读取 `VITE_STIRLING_BASE_URL`；为后续对接 Stirling PDF 做准备。
  - 放置占位 `public/sample.pdf`（空文件，开发者需替换为真实样例）。

实现细节与坑

- PDF.js Worker：采用 `pdf.worker?worker&url` 的方式设置 `GlobalWorkerOptions.workerSrc`，避免 Vite 构建路径问题。
- 文件读取：使用 `File.arrayBuffer()` 直接传入 `getDocument({ data })`，避免跨域与临时 URL 清理问题。
- UI：最小可行的工具栏（分页/缩放/上传）。后续会加入缩略图、搜索、旋转等。
- 路由类型导入坑：浏览器报错 `does not provide an export named 'RouteRecordRaw'`，原因是运行时并无该命名导出。修复：`import type { RouteRecordRaw } from 'vue-router'`，将其作为纯类型导入在构建时擦除。
- 空 PDF 报错：默认示例 `public/sample.pdf` 是占位空文件，触发 `InvalidPDFException: The PDF file is empty`。修复：移除默认加载，改为仅在用户上传后再调用 `loadPdf`，并加入 try/catch 错误显示。

待办联动
- 完成 `todolist.md` 第 2 阶段核心项：缩略图、旋转、适配宽度/整页、页码跳转、搜索（页级）、书签大纲；
- 下一步进入第 3 阶段注释层雏形（文本框/高亮矩形）。

2025-08-12 基础查看器完善

- 新增功能：
  - 缩略图侧栏：渲染每页 120px 宽缩略图，点击跳转；
  - 旋转：支持左右 90° 旋转，基于 `viewport({ rotation })` 重渲；
  - 适配：宽度/整页自适应，读取容器尺寸计算 scale；
  - 页码跳转：输入框跳转并校验范围；
  - 搜索：提取文本内容做简单包含匹配，列出命中页并提供上一条/下一条导航；
  - 页内高亮与定位：构建 `hl-overlay` 叠加层，按文本项变换矩阵计算矩形，高亮所有命中；全局线性匹配列表 `flatMatches` 支持逐条跳转与居中定位。
  - 书签大纲：调用 `getOutline()` 渲染，点击跳转至目的页（通过 `getDestination` + `getPageIndex`）。
- 坑位与注意：
  - 缩略图性能：大页多文档会慢，当前串行生成，后续可懒加载或节流；
  - 搜索仅页级命中：未做文本坐标高亮；后续结合 `textContent` 字项位置信息可实现；
  - 高亮坐标：PDF.js 文本项的 `transform` 与 `viewport.transform` 需矩阵相乘得到画布空间；不同 PDF 字体度量下 `width/height` 不稳定，已做保守 fallback；旋转时需用 `rotation` 参与 `viewport`。
  - 旋转与适配：旋转后需重新计算视口尺寸再求 scale；
  - 书签目的地：有的条目无 `dest`，需判空；
  - 事件抖动：频繁渲染可加 loading/节流，当前先保守处理。



