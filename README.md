# PDF Viewer/Annotator (Vue 3 + PDF.js)

功能概览
- PDF 预览、分页、缩放、旋转、缩略图与书签
- 搜索与页内高亮
- 注释：文本/高亮矩形/矩形，选择拖动，撤销/重做
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

# （可选）.env 设置前端代理目标
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

开源许可
- 本项目建议使用 MIT 许可证（LICENSE 文件）。
