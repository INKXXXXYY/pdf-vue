# PDF Viewer/Annotator (Vue 3 + PDF.js)

功能概览
- PDF 预览、分页、缩放、旋转、缩略图与书签
- 搜索与页内高亮
- 注释：文本/高亮矩形/矩形，编辑选择拖动/删除，撤销/重做
- 图片注释：插入/删除/拖动/缩放/旋转；把手随缩放同步，底边把手仅调整底边（已修复）
- 注释持久化（localStorage）、JSON 导入/导出
- 客户端导出：将注释扁平化到新 PDF（pdf-lib）
- 服务端导出：Node/Express 接口扁平化注释并返回 PDF

本地开发（局域网可访问）
```bash
npm install
npm run dev
```
默认端口 5173，Vite 已配置 `host: true`，同网段设备可通过你的电脑 IP 访问：
http://<你的局域网IP>:5173

生产预览（局域网可访问）
```bash
npm run build
npm run preview
```
默认端口 4173，同样可通过：
http://<你的局域网IP>:4173

可在 `.env` 中自定义端口：
```
VITE_PORT=5173
VITE_PREVIEW_PORT=4173
```

服务端导出（Node + Express）
```bash
# 启动后端（默认 3000）
npm run server

# （可选）.env 设置前端代理目标（缺省回落到 http://localhost:3000）
# VITE_API_BASE_URL=http://localhost:3000

# 前端开发（默认 5173）
npm run dev
```

接口说明
- POST `/api/annotate/flatten`
  - form-data 参数（二选一）
    - `file`: application/pdf 原始 PDF（上传）
    - `url`: 原始 PDF 的可访问 URL
  - 以及：
    - `annotations`: 前端注释 JSON（与运行时结构一致）
  - 返回：application/pdf（扁平化后的新 PDF）

注意
- 预览/生产环境不走 Vite 代理。请使用完整地址调用后端 `http://<后端IP>:3000/api/...` 或配置反向代理。
- 服务器默认放开 CORS（可通过环境变量 `ALLOW_ORIGIN` 自行限制）。

近期更新
- 新增：文本选择与编辑选择工具拆分
  - 文本选择（Text Select）：原生选中文本，复制粘贴；选择时禁用自定义框选，overlay 空白穿透。
  - 编辑选择（Edit Select）：选择/多选/拖动/删除已有注释；禁止新建图形，避免误触。
- 新增：手工文本层（兼容构建环境无法直接使用 TextLayerBuilder）
  - 绝对定位的轻量 span，按 PDF 矩阵换算位置与宽度；外层 transform 缩放与画布 CSS 尺寸对齐。
  - 透明文字 + `#text-layer ::selection` 显示高亮，可视化选区。
- 修复/优化：
  - 图片注释把手同步、底边把手仅调整底边；
  - 文本编辑流程（避免双层文本；打开时隐藏原节点，提交/取消后恢复；只重绘注释层）；
  - 选择模式下禁用绘制，绘制仅在高亮/矩形/绘图工具生效。
  - 新增绘图（自由画笔）：SVG 预览、折线导出，颜色/粗细可调。
- 新增 Shapes：椭圆、直线、箭头（预览含箭头头部、渲染/导出含箭头）与多边形。
- 新增 橡皮擦：可调半径，拖动命中即删（矩形类用外接矩形，path/多边形用点到线段距离，文本用近似宽高）。

版本快照
- 稳定标签：`stable-5f18acd`、`stable-arrow-head`、`stable-eraser`
- 快照分支：`snapshot-5f18acd`、`snapshot-arrow-head`、`snapshot-eraser`

开源许可
- 本项目建议使用 MIT 许可证（LICENSE 文件）。
