2025-08-12 版本管理

- 启用 Git：使用 winget 静默安装 Git（2.50.1），在 PowerShell 下使用调用运算符 `&` 执行 `C:\Program Files\Git\cmd\git.exe` 以避免 PATH 未刷新问题。
- 初始化与打标签：
  - `git init`
  - `git add -A`
  - `git -c user.name="pdf-dev" -c user.email="pdf-dev@example.com" commit -m "chore: baseline v0.1.0 ..."`
  - `git tag v0.1.0`
- CRLF/LF 提示：.gitattributes 设定 `* text=auto eol=lf`，首次提交出现 CRLF→LF 警告属正常，后续编辑器统一 LF 即可。
- 回滚指引（原因+建议）：
  - 回滚到标签但保留历史：`git checkout v0.1.0`（分离头指针，仅临时查看）→ 建议创建补丁分支：`git switch -c hotfix/from-v0.1.0`。
  - 强制回退分支到标签：`git reset --hard v0.1.0`（理由：需彻底回到稳定基线；注意：本地未提交变更会丢失，且需与远端强推一致 `git push -f`）。
  - 回退一个或多个提交但保留工作区：`git reset --soft HEAD^` 或 `git reset --mixed HEAD^^`（理由：保留改动以便重做提交）。
  - 生成反向提交：`git revert <commit>`（理由：保留历史且可安全推送到共享仓库）。
  - 推送标签与分支：`git push --tags`、`git push -u origin master`。

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

2025-08-12 注释与编辑层（第 3 阶段起步）

- 已实现：
  - 注释覆盖层 `#anno-overlay`：支持工具模式（选择/文本/高亮矩形/矩形）；
  - 文本：点击弹窗输入文本，按 PDF 坐标存储，渲染时按当前 scale 转换字号；
  - 高亮矩形/矩形：拖拽绘制，颜色可配置；
  - 选择移动：选择模式下可拖动注释，仅重绘覆盖层避免 PDF.js 同一画布并发渲染；
  - 撤销/重做：基于注释 JSON 快照；
  - 坐标转换：使用 `viewport.convertToPdfPoint`、`convertToViewportRectangle` 做 PDF ↔ 画布坐标转换，支持旋转缩放。
- 待优化/坑：
  - 文本可编辑、双击进入编辑态；
  - 注释尺寸缩放与旋转；
  - 键盘对齐/吸附、网格；
  - 本地持久化（localStorage）与跨页联动；
  - 导出时的扁平化（结合 `pdf-lib`）与字体嵌入。
  - 旋转与适配：旋转后需重新计算视口尺寸再求 scale；
  - 书签目的地：有的条目无 `dest`，需判空；
  - 事件抖动：频繁渲染可加 loading/节流，当前先保守处理。

2025-08-13 定位精度与编辑体验改进

- 目标：文本坐标与鼠标移动日志对齐；输入框可视与落点一致；拖动不触发 PDF 并发渲染报错。
- 变更：
  - 统一 `#hl-overlay`/`#anno-overlay` 尺寸为画布 CSS 尺寸，显式 `left/top:0`，以画布左上为原点。
  - 鼠标事件以画布 `getBoundingClientRect()` 为基准计算 overlay 坐标；缓存 `lastPdfPoint`，文本放置使用缓存 PDF 坐标。
  - 文本渲染采用三位小数 `round3`，日志与样式统一；强制 `.anno` 绝对定位，修复 `position: static` 导致 `left/top` 无效。
  - 文本编辑器：透明背景、单行高度自适应、不可 resize，边框可见以不遮挡底部 PDF。
  - 拖动与绘制期间仅调用 `renderAnnotationsForCurrentPage`，避免并发 `render()` 报错。
- 新增（持久化与键盘细调）：
  - 本地存储 `localStorage`：按文档键（URL 或 ArrayBuffer FNV-1a hash）保存/恢复 `annotations`，编辑时 300ms 防抖自动保存。
  - 键盘细调与对齐（预备）：添加工具变量与方法骨架（选中项、自动保存调度、网格吸附函数与像素→PDF 的增量换算）。
- 标签与分支：
  - `snapshot-eaea063` / `stable-eaea063`：文本坐标对齐版本。
  - `snapshot-6134fe5` / `stable-6134fe5`：清空重做与并发渲染优化版本。

2025-08-13 导出与保存（客户端）

- 目标：实现导出与编辑预览一致；避免空白导出与 ArrayBuffer detached 问题；提供 JSON 导入/导出。
- 实现：
  - 导出：基于 `pdf-lib`，复制源 PDF 页面后，按注释数据绘制到新 PDF。
    - 文本：统一使用 Helvetica，导出 y 轴做基线补偿（y - fontSize），与预览左上锚点对齐。
    - 高亮：0.35 填充透明度 + 0.6 边框不透明度；矩形保留 2px 边框。
  - 解决空白导出：加载时缓存一份独立的源 PDF 字节；上传文件 `ArrayBuffer` 使用 `slice(0)` 复制，避免被 PDF.js detach。
  - JSON 导入/导出：工具栏按钮 `导出JSON/导入JSON`，便于注释同步与备份。
- 待办：导出进度/大文件优化、字体嵌入与度量精细化、服务端导出路径。

2025-08-13 服务端导出路径

- 新增 `server/`（Node + Express）：
  - `POST /api/annotate/flatten`：参数支持 `file`(PDF) 或 `url` + `annotations`(JSON)。
  - 使用 `pdf-lib` 在服务端按与前端一致的规则扁平化注释（文本基线补偿、高亮透明度/边框、矩形描边）。
  - CORS 允许来自前端域；上传大小默认 50MB。
- Vite 代理：新增 `/api` 代理到 `VITE_API_BASE_URL`，缺省回落到 `http://localhost:3000`；前端新增“服务端导出”按钮。

2025-08-13 注释与图片交互修复

- 修复：`HTMLElement.dataset` 直接整体赋值引发的运行时错误，改为逐项赋值。
- 修复：图片注释缩放时把手不同步问题；统一通过 `pdfRectToViewportRect` 获取 overlay 坐标，按各方向把手重新计算位置。
- 修复：按住底边拖动时顶部移动的问题，改为仅调整底边（基于 overlay 坐标计算，避免坐标系混淆）。
- 优化：拖动/缩放期间仅更新相关 DOM 节点，避免整层重绘导致的卡顿。
- 待办：
  - 与 Stirling PDF 对接通用处理接口（合并/拆分/压缩/OCR 等）。
  - 任务制与进度上报、鉴权与限流。

2025-08-13 需求同步：编辑器功能补充规划

- 基本功能：
  - Pointer 已有（选择/拖动）。
  - Select Field：计划接入 PDF 表单字段编辑（AcroForm），优先读取/更新文本域/复选框。
  - Text：已支持添加/编辑/颜色/字号；待补齐字体族/粗细/对齐/多行与缩放旋转。
  - Replace Text：基于文本提取与定位，提供替换并回填（预留到服务端处理可选）。
  - Highlight：已实现，导出与预览一致透明度。
  - Add Image：计划插入/缩放/旋转并导出。
  - Eraser：删除选中元素，后续考虑自由擦除绘图层。
  - Shapes：扩展椭圆/箭头/线段/多边形。
  - Draw：自由画笔（颜色/粗细/压感可选）。

- 高级与格式化：
  - Underline/Strikeout：文本样式与导出。
  - Move Up/Down：页面重排（服务端或客户端 copyPages 方案）。
  - Delete：快捷键删除选中元素。

- 优化计划：
  - 键盘微调与网格吸附；
  - 大文档渲染性能与分块；
  - 搜索-替换联动；导出进度与大文件分片。

2025-08-13 文本选择与编辑选择拆分、编辑体验修复

- 文本层：因打包环境无法直接使用 `TextLayerBuilder`，实现轻量“手工文本层”（绝对定位 span），支持原生文本选择；
  - 尺寸/缩放：内部按 viewport 像素，外部按 CSS transform 与画布对齐；
  - 选区可见：透明文字并使用 `#text-layer ::selection` 显示高亮；
  - 命中修正：按 PDF 矩阵换算宽度，Y 轴不再翻转；顶部定位采用 `y + max(0, h - 行高)` 收紧对齐；
  - 调试：点击文本输出 dataRect/cssRect；
  - 兼容：禁用文本层时 pointer-events/user-select 置为 none。
- 工具拆分：
  - `textSelect`：专用于文本选择，overlay 空白穿透；
  - `select`：编辑选择（多选、拖动、删除），禁用绘制；
  - highlight/rect：仅在对应工具下进入绘制态。
- 编辑文本 UX：
  - 打开编辑器前移除旧实例；
  - 打开时隐藏原文本节点，提交/取消后恢复；
  - 提交/取消仅重绘注释层，避免 PDF 重渲与叠层；
  - 打开时切换到 `select`，提交/取消后文本层禁用，光标恢复。
- 版本快照：`stable-5f18acd` / `snapshot-5f18acd`。

2025-08-14 绘图（自由画笔）

- 新增 draw 工具：
  - 交互：按下开始记录路径，window 级 mousemove/mouseup 全局监听保障连续绘制；SVG path 实时预览；抬起保存为 path 注释（PDF 坐标）。
  - 渲染：注释层用 SVG path 映射到 overlay；导出时用 pdf-lib 近似为折线段（drawLine）。
  - 配置：颜色沿用全局 `strokeColor`，粗细 `drawWidth`。
  - 修复：预览层 pointer-events:none，避免拦截；移除重复颜色选择器。




2025-08-14 箭头形状增强（预览+渲染+导出）

- 目标：箭头绘制时实时显示箭头头部；完成后渲染为带箭头的线段；导出 PDF 中也保持箭头效果。
- 变更点：
  - 数据：线段/箭头统一存为 `type: 'path'` + `pts:[p0,p1]`，并通过 `_tool:'arrow'` 标记箭头来源，避免破坏既有 path 表示；无需新增类型，导出/渲染时按标记判断。
  - 预览：`onAnnoMouseMove` 增加 `line-preview` SVG，`line-preview-main` 为主线，`line-preview-head-1/2` 两短线作为箭头头部；`line/arrow` 时隐藏虚线框。
  - 静态渲染：`renderAnnotationsForCurrentPage` 中当 `type==='path' && _tool==='arrow'`，按末段方向添加两条短线作为箭头头部，尺寸随 `strokeWidth` 放大。
  - 导出：`exportPdf` 中检测 `_tool==='arrow'`，在 PDF 终点绘制两条短线形成箭头头部，角度 `±π/6`。
- 调试：`onAnnoMouseDown` 新增 `[shape:start]` 日志，含 tool 与起点 PDF 坐标。
- 影响范围：仅涉及 `src/views/Viewer.vue` 的注释渲染与导出逻辑，不影响文本层与图片交互。

2025-08-14 橡皮擦（Eraser）

- 目标：提供快速删除的编辑工具，避免逐个选择删除；对绘图路径提供手到即删的体验。
- 交互：
  - 工具栏新增 Eraser，可调半径；移动显示红色半透明圆形预览；按下/拖动过程中命中即删；抬起结束一次擦除，统一 snapshot + autosave。
  - overlay 光标隐藏（自绘预览圆），文本层仍按工具规则处理 pointer-events。
- 命中判定：
  - path/arrow/draw 与 polygon：点到线段最短距离 ≤ 半径（PDF 坐标）。
  - rect/highlight/mask/image/ellipse：用外接矩形与圆交叠判定。
  - text：按文本长度与字号估算宽度，基线补偿 y - fontSize，做矩形命中。
- 实现：
  - `eraserRadius` 状态；`renderEraserCursor` 绘制预览；`eraseAtEvent` 执行命中与删除；`hitAnySegment/pointToSegmentDistance/circleRectIntersect` 几何工具函数。
  - onMouseDown/Move/Up 注入 eraser 路径；watch(toolMode) 控制 overlay cursor 样式。
  - 性能：每次擦除仅重绘注释层；结束后一次性保存。

2025-08-14 页面重排（Move Up/Move Down）

- 视觉顺序状态 `pageOrder` 存储实际页码数组（1..N），`pageNum` 始终为"实际页码"。
- 翻页逻辑改为按 `pageOrder` 的邻近项移动；输入框显示/修改"视觉索引（1..N）"。
- 侧栏缩略图为 `pageOrder` 顺序渲染，并为每个页面提供"上移/下移"，交换 `pageOrder` 后刷新缩略图并持久化到 `localStorage(pdf-pageOrder:<docKey>)`。
- 注意：本地仅改变前端视觉顺序，不改变源 PDF 内部页序；导出仍按原始页序逐页扁平化。若需导出后的 PDF 也变更页序，需要服务端或客户端在导出阶段按 `pageOrder` 重排页面（后续可选实现）。

2025-08-15 下划线功能精确定位重构

**问题背景**
- 原有下划线功能存在定位不准确问题：用户选择"Tracking"文本，但下划线出现在"Time Location"位置
- 根本原因：基于文本跨度（span）检测的方法不够精确，PDF文本项可能包含多个词汇作为一个整体

**技术分析**
- PDF文本层结构：`textContent.items` 可能将多个词汇（如"time Location Tracking"）作为单个文本项
- 原方法：使用 `getCurrentSelectionSpans()` 函数通过 `Range.intersectsNode()` 检测选区与文本跨度的交集
- 问题：即使用户只选择部分文本，整个包含的文本跨度都会被认为选中

**解决方案**
1. **重构选区检测机制**
   - 摒弃基于文本跨度推测的方法
   - 改用 `Range.getClientRects()` 直接获取选区的精确像素边界
   - 为每个选区矩形单独创建下划线段

2. **实现精确坐标转换链**
   ```javascript
   // 客户端坐标 → text-layer相对坐标 → viewport坐标 → PDF坐标
   const relativeLeft = rect.left - textLayerRect.left
   const vLeft = relativeLeft / m.sx
   const pLeft = lastViewport.value.convertToPdfPoint(vLeft, vBottom)
   ```

3. **关键代码改进**
   - 移除 `getCurrentSelectionSpans()` 依赖
   - 直接使用 `selection.getRangeAt(0).getClientRects()`
   - 支持多矩形选区（跨行选择、复杂选择形状）

**技术要点**
- **坐标系转换**: 处理三个不同坐标系之间的转换（客户端、text-layer、PDF）
- **缩放适配**: 通过 `getOverlayMetrics()` 获取缩放比例进行坐标校正
- **边界处理**: 使用 `Math.min/max` 确保下划线方向一致性
- **事件时序**: 使用 `setTimeout(onSelectionEnd, 50)` 确保选择操作完成

**验证结果**
- 测试案例：选择"App Features"中的"Tracking"部分
- 改进前：下划线出现在"Time Location"位置
- 改进后：下划线精确出现在"Tracking"正下方
- 支持任意部分文本选择，不受PDF文本项分组影响

**性能和兼容性考虑**
- **性能优化**: `getClientRects()` 返回的矩形数量在复杂选择时可能较多，但通常在可接受范围内
- **浏览器兼容**: `Range.getClientRects()` 在现代浏览器中支持良好，IE9+ 兼容
- **内存管理**: 使用 `range.detach()` (在旧版本中) 清理不再需要的Range对象
- **边界情况**: 处理空选择、跨页选择等特殊情况

**潜在改进方向**
- **选择可视化**: 可考虑在下划线模式下实时显示选择预览
- **样式定制**: 支持下划线颜色、粗细、样式（实线/虚线/波浪线）的自定义
- **批量操作**: 支持一次选择多个不连续文本片段并批量添加下划线
- **删除线扩展**: 基于相同技术实现删除线（strikethrough）功能

**文档和版本管理**
- 更新README.md：添加下划线功能说明和使用方法
- 更新todolist.md：标记下划线任务完成，记录技术细节
- 创建稳定标签：`stable-underline-fix` (提交哈希: `e043e4b`)
- 提交信息：`feat: 重构下划线功能，实现精确文本选择定位`
- 推送到远端：`https://github.com/INKXXXXYY/pdf-vue.git`

2025-08-15 页面重排导出功能实现

**问题背景**
- 现有页面重排功能只影响前端视觉顺序（缩略图、翻页导航）
- 导出PDF时仍按原始页面顺序 (1, 2, 3, ...) 处理，忽略用户调整的页面顺序
- 用户期望导出的PDF能保持调整后的页面顺序

**技术分析**
- **客户端导出问题**: `exportPdf()` 函数使用固定循环 `for (let p = 1; p <= pdfDoc.numPages; p++)`
- **服务端导出问题**: `server/index.js` 使用固定循环 `for (let p = 0; p < numPages; p++)`
- **关键数据**: `pageOrder` 数组存储用户调整的页面顺序，但导出时未被使用

**解决方案**

1. **客户端导出改进**
   ```javascript
   // 改进前：按原始顺序 1, 2, 3...
   for (let p = 1; p <= pdfDoc.numPages; p++) {
     const embedded = (await newPdf.copyPages(srcPdf, [p - 1]))[0]
     // ...
   }
   
   // 改进后：按 pageOrder 顺序
   const exportOrder = pageOrder.value.length ? pageOrder.value : Array.from({...})
   for (let i = 0; i < exportOrder.length; i++) {
     const originalPageNum = exportOrder[i]
     const embedded = (await newPdf.copyPages(srcPdf, [originalPageNum - 1]))[0]
     // 注释仍按原始页码存储: annotations.value[originalPageNum]
   }
   ```

2. **服务端导出改进**
   - 前端发送额外的 `pageOrder` 参数
   - 服务端接收并使用该顺序重新排列页面
   - 保持注释与原始页码的映射关系

**关键技术点**
- **页面-注释映射**: 注释存储仍按原始页码 (`annotations[originalPageNum]`)，避免重新组织数据结构
- **索引转换**: 新PDF中的页面索引 (0-based) vs 原始页码 (1-based) 的正确转换
- **向下兼容**: 当没有 `pageOrder` 时自动生成原始顺序数组
- **调试支持**: 添加详细日志显示页面映射关系

**验证结果**
- 测试案例: 将3页PDF调整为 [3, 1, 2] 顺序
- 客户端导出: 生成的PDF页面顺序为 第3页→第1页→第2页
- 服务端导出: 同样按调整后顺序排列
- 注释正确显示在对应页面，无错位现象

**技术细节**
- **前端数据流**: `pageOrder` → `exportOrder` → 页面复制循环
- **后端API扩展**: 新增 `pageOrder` FormData 参数，向下兼容旧调用
- **错误处理**: 页面顺序数组长度不匹配时回退到原始顺序
- **性能考虑**: 页面复制顺序改变不影响性能，注释处理逻辑不变
