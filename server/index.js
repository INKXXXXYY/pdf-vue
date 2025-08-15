import express from 'express'
import multer from 'multer'
import cors from 'cors'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import fs from 'fs/promises'
import path from 'path'

const app = express()
app.use(cors({ origin: process.env.ALLOW_ORIGIN || true }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '')
  const bigint = parseInt(h, 16)
  const r = (bigint >> 16) & 255
  const g = (bigint >> 8) & 255
  const b = bigint & 255
  return { r: r / 255, g: g / 255, b: b / 255 }
}

function canEncodeWinAnsi(s) {
  if (!s) return true
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0
    if (code < 32) return false
    if (code > 255) return false
  }
  return true
}

async function tryLoadCjkFontBytes() {
  // 1) 环境变量优先
  if (process.env.CJK_FONT_FILE) {
    try {
      const p = process.env.CJK_FONT_FILE
      const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
      const buf = await fs.readFile(abs)
      console.log('[server] CJK font via env:', abs)
      return buf
    } catch (e) {
      console.warn('[server] Failed to read CJK_FONT_FILE:', e && e.message || e)
    }
  }
  // 2) 常见文件名候选
  const fixedCandidates = [
    'server/fonts/NotoSansSC-Regular.otf',
    'server/fonts/NotoSansSC-Regular.ttf',
    'server/fonts/NotoSansSC-VariableFont_wght.ttf',
    'server/fonts/SourceHanSansCN-Regular.otf',
    'server/fonts/SourceHanSansCN-Regular.ttf',
    'server/fonts/NotoSansCJKsc-Regular.otf',
    'server/fonts/NotoSansCJKsc-Regular.ttf',
    'server/fonts/SourceHanSansSC-Regular.otf',
    'server/fonts/SourceHanSansSC-Regular.ttf',
  ]
  for (const p of fixedCandidates) {
    try {
      const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
      const buf = await fs.readFile(abs)
      console.log('[server] CJK font via fixed candidate:', abs)
      return buf
    } catch {}
  }
  // 3) 扫描目录 server/fonts，优先挑选含 Noto/SourceHan 的 ttf/otf
  try {
    const fontsDir = path.resolve(process.cwd(), 'server/fonts')
    const items = await fs.readdir(fontsDir).catch(() => [])
    const files = items.filter((n) => /\.(ttf|otf)$/i.test(n))
    const prefer = files.find((n) => /(Noto|SourceHan)/i.test(n)) || files[0]
    if (prefer) {
      const abs = path.join(fontsDir, prefer)
      const buf = await fs.readFile(abs)
      console.log('[server] CJK font via directory scan:', abs)
      return buf
    }
  } catch {}
  return null
}

app.post('/api/annotate/flatten', upload.single('file'), async (req, res) => {
  try {
    const annotationsJson = req.body.annotations || '{}'
    const annotations = JSON.parse(annotationsJson)
    const pageOrderJson = req.body.pageOrder || '[]'
    const pageOrder = JSON.parse(pageOrderJson)
    console.log('[server] Received annotations for', Object.keys(annotations).length, 'pages')
    console.log('[server] Page reorder:', pageOrder.length ? pageOrder : 'none (original order)')
    
    let srcBytes = null
    if (req.file && req.file.buffer) {
      srcBytes = req.file.buffer
    } else if (req.body.url) {
      const resp = await fetch(req.body.url)
      if (!resp.ok) throw new Error('fetch source failed')
      srcBytes = Buffer.from(await resp.arrayBuffer())
    } else {
      return res.status(400).json({ error: 'missing file or url' })
    }

    const srcPdf = await PDFDocument.load(srcBytes)
    const outPdf = await PDFDocument.create()
    // 注册 fontkit 以支持自定义 TTF/OTF 字体嵌入
    try { outPdf.registerFontkit(fontkit) } catch {}
    const helv = await outPdf.embedFont(StandardFonts.Helvetica)
    // 尝试加载 CJK 字体以支持中文等非 WinAnsi 文本
    let cjkFont = null
    try {
      const cjkBytes = await tryLoadCjkFontBytes()
      if (cjkBytes) {
        // 对部分可变字体(VariableFont)子集化可能导致字符缺失，这里禁用子集化以保证完整性
        cjkFont = await outPdf.embedFont(cjkBytes, { subset: false })
        console.log('[server] CJK font loaded for export')
      } else {
        console.warn('[server] No CJK font found. Non-ASCII text will use Helvetica and may fail.')
      }
    } catch (e) {
      console.warn('[server] Failed to load/embed CJK font:', e && e.message || e)
    }

    const numPages = srcPdf.getPageCount()
    
    // 确定导出顺序：如果有有效页面顺序则使用，否则使用原始顺序
    const exportOrder = (pageOrder.length > 0 && pageOrder.length === numPages)
      ? pageOrder 
      : Array.from({ length: numPages }, (_, i) => i + 1)
    
    console.log('[server] Export order:', exportOrder)
    
    for (let i = 0; i < exportOrder.length; i++) {
      const originalPageNum = exportOrder[i] // 原始页码 (1-based)
      console.log(`[server] Processing page ${i + 1}, source: original page ${originalPageNum}`)
      
      // 将原始页面嵌入到新位置
      const embedded = (await outPdf.copyPages(srcPdf, [originalPageNum - 1]))[0]
      outPdf.addPage(embedded)
      const page = outPdf.getPage(i) // 新PDF中的页面索引 (0-based)
      const list = annotations[originalPageNum] || [] // 注释仍然按原始页码存储
      for (const a of list) {
        if (a.type === 'text') {
          const size = a.fontSize || 14
          const color = a.color || '#111827'
          const c = hexToRgb(color)
          const text = a.text || ''
          const useWinAnsi = canEncodeWinAnsi(text)
          const fontToUse = useWinAnsi ? helv : (cjkFont || helv)
          if (!useWinAnsi && !cjkFont) {
            console.warn('[server] Non-ASCII text without CJK font. Expect encoding issues:', text.slice(0, 16))
          }
          const baseY = a.y - size
          if (!useWinAnsi && cjkFont) {
            // 兼容部分可变字体一次性编码失败的问题：逐字绘制，手动推进光标
            let cursorX = a.x
            for (const ch of text) {
              const w = fontToUse.widthOfTextAtSize(ch, size)
              page.drawText(ch, { x: cursorX, y: baseY, size, font: fontToUse, color: rgb(c.r, c.g, c.b) })
              cursorX += w
            }
          } else {
            page.drawText(text, { x: a.x, y: baseY, size, font: fontToUse, color: rgb(c.r, c.g, c.b) })
          }
        } else if (a.type === 'highlight') {
          const color = a.color || '#facc15'
          const c = hexToRgb(color)
          page.drawRectangle({
            x: a.x,
            y: a.y,
            width: a.w,
            height: a.h,
            color: rgb(c.r, c.g, c.b),
            opacity: 0.35,
            borderColor: rgb(c.r, c.g, c.b),
            borderWidth: 1,
            borderOpacity: 0.6,
          })
        } else if (a.type === 'rect') {
          const color = a.color || '#f59e0b'
          const c = hexToRgb(color)
          page.drawRectangle({
            x: a.x,
            y: a.y,
            width: a.w,
            height: a.h,
            borderColor: rgb(c.r, c.g, c.b),
            borderWidth: 2,
            borderOpacity: 1,
            color: undefined,
          })
        } else if (a.type === 'mask') {
          const c = hexToRgb(a.color || '#ffffff')
          page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: rgb(c.r, c.g, c.b) })
        } else if (a.type === 'ellipse') {
          // 近似为空心矩形边框（简化）
          const c = hexToRgb(a.color || '#f59e0b')
          page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, borderColor: rgb(c.r, c.g, c.b), borderWidth: 2 })
        } else if (a.type === 'path' && Array.isArray(a.pts) && a.pts.length >= 2) {
          const c = hexToRgb(a.color || '#f59e0b')
          for (let i = 1; i < a.pts.length; i++) {
            const p0 = a.pts[i - 1]
            const p1 = a.pts[i]
            page.drawLine({ start: { x: p0.x, y: p0.y }, end: { x: p1.x, y: p1.y }, thickness: a.strokeWidth || 2, color: rgb(c.r, c.g, c.b) })
          }
          if (a._tool === 'arrow') {
            const p0 = a.pts[a.pts.length - 2]
            const p1 = a.pts[a.pts.length - 1]
            const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x)
            const size = 6
            const left = { x: p1.x - size * Math.cos(angle - Math.PI / 6), y: p1.y - size * Math.sin(angle - Math.PI / 6) }
            const right = { x: p1.x - size * Math.cos(angle + Math.PI / 6), y: p1.y - size * Math.sin(angle + Math.PI / 6) }
            page.drawLine({ start: { x: p1.x, y: p1.y }, end: { x: left.x, y: left.y }, thickness: a.strokeWidth || 2, color: rgb(c.r, c.g, c.b) })
            page.drawLine({ start: { x: p1.x, y: p1.y }, end: { x: right.x, y: right.y }, thickness: a.strokeWidth || 2, color: rgb(c.r, c.g, c.b) })
          }
        } else if (a.type === 'polygon' && Array.isArray(a.pts) && a.pts.length >= 2) {
          const c = hexToRgb(a.color || '#f59e0b')
          for (let i = 1; i < a.pts.length; i++) {
            const p0 = a.pts[i - 1]
            const p1 = a.pts[i]
            page.drawLine({ start: { x: p0.x, y: p0.y }, end: { x: p1.x, y: p1.y }, thickness: a.strokeWidth || 2, color: rgb(c.r, c.g, c.b) })
          }
          // 可选：闭合多边形
          // const first = a.pts[0], last = a.pts[a.pts.length - 1]
          // page.drawLine({ start: { x: last.x, y: last.y }, end: { x: first.x, y: first.y }, thickness: a.strokeWidth || 2, color: rgb(c.r, c.g, c.b) })
        } else if (a.type === 'underline') {
          const c = hexToRgb(a.color || '#2563eb')
          page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h || 1.5, color: rgb(c.r, c.g, c.b) })
        } else if (a.type === 'image' && a.src) {
          try {
            if (typeof a.src === 'string' && a.src.startsWith('data:')) {
              const base64 = a.src.split(',')[1] || ''
              const bytes = Buffer.from(base64, 'base64')
              let img
              try { img = await outPdf.embedPng(bytes) } catch { img = await outPdf.embedJpg(bytes) }
              page.drawImage(img, { x: a.x, y: a.y, width: a.w, height: a.h })
            }
          } catch {}
        }
      }
    }

    const bytes = await outPdf.save()
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="annotated.pdf"')
    res.send(Buffer.from(bytes))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'flatten-failed', message: String(e && e.message || e) })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})