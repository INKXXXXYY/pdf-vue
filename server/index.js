const express = require('express')
const multer = require('multer')
const cors = require('cors')
const fetch = require('node-fetch')
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib')

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

app.post('/api/annotate/flatten', upload.single('file'), async (req, res) => {
  try {
    const annotationsJson = req.body.annotations || '{}'
    const annotations = JSON.parse(annotationsJson)
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
    const helv = await outPdf.embedFont(StandardFonts.Helvetica)

    const numPages = srcPdf.getPageCount()
    for (let p = 0; p < numPages; p++) {
      const embedded = (await outPdf.copyPages(srcPdf, [p]))[0]
      outPdf.addPage(embedded)
      const page = outPdf.getPage(p)
      const list = annotations[p + 1] || []
      for (const a of list) {
        if (a.type === 'text') {
          const size = a.fontSize || 14
          const color = a.color || '#111827'
          const c = hexToRgb(color)
          page.drawText(a.text || '', {
            x: a.x,
            y: a.y - size,
            size,
            font: helv,
            color: rgb(c.r, c.g, c.b),
          })
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


