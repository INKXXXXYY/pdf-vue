# PDF Viewer/Annotator (Vue 3 + PDF.js)

功能概览
- PDF 预览、分页、缩放、旋转、缩略图与书签
- 搜索与页内高亮
- 注释：文本/高亮矩形/矩形，选择拖动，撤销/重做
- 注释持久化（localStorage）、JSON 导入/导出
- 客户端导出：将注释扁平化到新 PDF（pdf-lib）

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

开源许可
- 本项目建议使用 MIT 许可证（LICENSE 文件）。
