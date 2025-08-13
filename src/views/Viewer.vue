<script setup lang="ts">
import { onMounted, ref, watch, computed, nextTick } from 'vue'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// @ts-ignore - vite can bundle this entry as worker
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker?worker&url'

GlobalWorkerOptions.workerSrc = pdfWorkerSrc

const canvasRef = ref<HTMLCanvasElement | null>(null)
const stageRef = ref<HTMLDivElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const errorMessage = ref<string>('')

const scale = ref(1.0)
const rotation = ref(0) // 0/90/180/270
const pageNum = ref(1)
const numPages = ref(0)
let pdfDoc: PDFDocumentProxy | null = null

// thumbnails
const thumbnails = ref<Array<{ page: number; dataUrl: string }>>([])
// outline (bookmarks)
type OutlineItem = { title: string; dest?: any; items?: OutlineItem[] }
const outline = ref<OutlineItem[] | null>(null)

// search & highlight
const searchQuery = ref('')
const searchMatches = ref<number[]>([]) // pages that have matches
const currentMatchIndex = ref(0) // index in flatMatches
const hasSearched = ref(false)
const pageToCount = ref<Record<number, number>>({})
const flatMatches = ref<Array<{ page: number; rectIndex: number }>>([])
function onChangePage(e: Event) {
  const input = e.target as HTMLInputElement
  jumpTo(input.value)
}

// === Annotations (文本/高亮矩形/矩形) ===
type AnnotationType = 'text' | 'highlight' | 'rect'
type Annotation = {
  id: string
  page: number
  type: AnnotationType
  x: number // PDF 坐标（以 PDF 点为单位，rotation=0 的坐标系）
  y: number
  w: number
  h: number
  text?: string
  color?: string
  fontSize?: number
  // 视口锚点（用于首次渲染保障与点击点像素级一致）
  vx?: number
  vy?: number
  _scale?: number
  _rotation?: number
}
const annotations = ref<Record<number, Annotation[]>>({})
const editingAnnoId = ref<string | null>(null)
type ToolMode = 'select' | 'text' | 'highlight' | 'rect'
const toolMode = ref<ToolMode>('select')
const strokeColor = ref('#facc15')
const textColor = ref('#111827')
const textFontSize = ref(14)
const isDrawing = ref(false)
let drawingStartPdf: { x: number; y: number } | null = null
let draggingAnnoId: string | null = null
let draggingStartPdf: { x: number; y: number } | null = null
let draggingOriginPdf: { x: number; y: number } | null = null
const lastViewport: any = ref(null)
// keep original PDF bytes for export
let originalPdfBytes: ArrayBuffer | null = null
// persistence helpers
const autoSaveEnabled = ref(true)
let saveTimer: any = null
let currentDocKey: string | null = null
// 编辑模式下强制整页适配并锁定缩放/旋转
const isEditingMode = computed(() => toolMode.value !== 'select')
// const lockFitPage = ref(false)
let lastMoveLogTs = 0
 let lastOverlayPoint: { x: number; y: number } | null = null
 let lastViewportPoint: { x: number; y: number } | null = null
 let lastPdfPoint: { x: number; y: number } | null = null
function getOverlayMetrics() {
  const overlay = document.getElementById('anno-overlay') as HTMLDivElement | null
  const canvas = canvasRef.value
  if (!overlay || !canvas || !lastViewport.value) return null
  const rect = overlay.getBoundingClientRect()
  const vw = lastViewport.value.width
  const vh = lastViewport.value.height
  const sx = rect.width > 0 ? rect.width / vw : 1
  const sy = rect.height > 0 ? rect.height / vh : 1
  return { overlay, rect, sx, sy, vw, vh }
}

function viewportPointToOverlayPoint(vx: number, vy: number): { x: number; y: number } {
  const m = getOverlayMetrics()
  if (!m) return { x: vx, y: vy }
  return { x: vx * m.sx, y: vy * m.sy }
}

function overlayPointToViewportPoint(ox: number, oy: number): { x: number; y: number } {
  const m = getOverlayMetrics()
  if (!m) return { x: ox, y: oy }
  return { x: ox / m.sx, y: oy / m.sy }
}
// 撤销/重做
const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])
function snapshot() {
  undoStack.value.push(JSON.stringify(annotations.value))
  redoStack.value = []
}
function undo() {
  const prev = undoStack.value.pop()
  if (!prev) return
  const cur = JSON.stringify(annotations.value)
  redoStack.value.push(cur)
  annotations.value = JSON.parse(prev)
  renderPage()
  scheduleAutoSave()
}
// 保留原重做逻辑备用（未在 UI 暴露）
/* function redo() {
  const next = redoStack.value.pop()
  if (!next) return
  const cur = JSON.stringify(annotations.value)
  undoStack.value.push(cur)
  annotations.value = JSON.parse(next)
  renderPage()
} */

async function loadPdf(urlOrData: string | ArrayBuffer) {
  try {
    errorMessage.value = ''
    let loadingTask
    if (typeof urlOrData === 'string') {
      loadingTask = getDocument(urlOrData)
      // capture original bytes for later export
      try {
        const resp = await fetch(urlOrData)
        originalPdfBytes = await resp.arrayBuffer()
      } catch { originalPdfBytes = null }
    } else {
      // keep a safe copy for export; pass the original to PDF.js (which may detach it)
      const dataAb = urlOrData as ArrayBuffer
      try { originalPdfBytes = dataAb.slice(0) } catch { originalPdfBytes = dataAb }
      loadingTask = getDocument({ data: dataAb })
    }
    pdfDoc = await loadingTask.promise
    numPages.value = pdfDoc.numPages
    pageNum.value = 1
    rotation.value = 0
    await renderPage()
    await Promise.all([renderThumbnails(), loadOutline()])
    // persistence: derive doc key and try load annotations
    try {
      currentDocKey = await deriveDocKey(urlOrData)
      await loadAnnotationsFromStorage()
      await renderPage()
    } catch {}
    // reset search state on new file
    searchMatches.value = []
    currentMatchIndex.value = 0
    hasSearched.value = false
  } catch (err: any) {
    console.error(err)
    errorMessage.value = err?.message || '加载 PDF 失败'
    pdfDoc = null
    numPages.value = 0
    pageNum.value = 0
    thumbnails.value = []
    outline.value = null
    if (canvasRef.value) {
      const ctx = canvasRef.value.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
    }
  }
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const buf = await file.arrayBuffer()
  await loadPdf(buf)
}

async function renderPage() {
  if (!pdfDoc || !canvasRef.value) return
  const page = await pdfDoc.getPage(pageNum.value)
  // fit modes may override scale
  const currentScale = scale.value
  const viewport = page.getViewport({ scale: currentScale, rotation: rotation.value })
  const canvas = canvasRef.value
  const ctx = canvas.getContext('2d')!
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await page.render({ canvasContext: ctx, viewport, canvas }).promise
  lastViewport.value = viewport
  // sync overlays to the actual rendered canvas size on screen
  const rect = canvas.getBoundingClientRect()
  const hl = document.getElementById('hl-overlay') as HTMLDivElement | null
  const anno = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (hl) {
    hl.style.width = `${rect.width}px`
    hl.style.height = `${rect.height}px`
    hl.style.left = `0px`
    hl.style.top = `0px`
  }
  if (anno) {
    anno.style.width = `${rect.width}px`
    anno.style.height = `${rect.height}px`
    anno.style.left = `0px`
    anno.style.top = `0px`
  }
  await renderHighlightsForCurrentPage(page)
  await renderAnnotationsForCurrentPage(page)
}

function zoomIn() {
  if (isEditingMode.value) return
  scale.value = Math.min(scale.value + 0.25, 4)
  renderPage()
}
function zoomOut() {
  if (isEditingMode.value) return
  scale.value = Math.max(scale.value - 0.25, 0.25)
  renderPage()
}
function fitWidth() {
  if (!pdfDoc || !stageRef.value) return
  pdfDoc.getPage(pageNum.value).then((page) => {
    const viewport = page.getViewport({ scale: 1, rotation: rotation.value })
    const stageWidth = stageRef.value!.clientWidth - 24 // padding
    scale.value = Math.max(0.1, stageWidth / viewport.width)
    // 编辑时避免与拖动操作并发刷新画布
    if (!isEditingMode.value) renderPage()
  })
}
function fitPage() {
  if (!pdfDoc || !stageRef.value) return
  pdfDoc.getPage(pageNum.value).then((page) => {
    const viewport = page.getViewport({ scale: 1, rotation: rotation.value })
    const stageWidth = stageRef.value!.clientWidth - 24
    const stageHeight = stageRef.value!.clientHeight - 24
    const scaleX = stageWidth / viewport.width
    const scaleY = stageHeight / viewport.height
    scale.value = Math.max(0.1, Math.min(scaleX, scaleY))
    if (!isEditingMode.value) renderPage()
  })
}
function rotateClockwise() {
  if (isEditingMode.value) return
  rotation.value = (rotation.value + 90) % 360
  renderPage()
}
function rotateCounterClockwise() {
  if (isEditingMode.value) return
  rotation.value = (rotation.value + 270) % 360
  renderPage()
}
function nextPage() {
  if (pageNum.value < numPages.value) {
    pageNum.value += 1
    renderPage()
  }
}
function prevPage() {
  if (pageNum.value > 1) {
    pageNum.value -= 1
    renderPage()
  }
}
function jumpTo(input: string | number) {
  const n = typeof input === 'number' ? input : parseInt(input as string, 10)
  if (Number.isFinite(n) && n >= 1 && n <= numPages.value) {
    pageNum.value = n
    renderPage()
  }
}

async function renderThumbnails() {
  if (!pdfDoc) return
  const results: Array<{ page: number; dataUrl: string }> = []
  const maxWidth = 120
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p)
    const vp = page.getViewport({ scale: 1 })
    const scaleThumb = maxWidth / vp.width
    const viewport = page.getViewport({ scale: scaleThumb })
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvasContext: ctx, viewport, canvas }).promise
    results.push({ page: p, dataUrl: canvas.toDataURL('image/png') })
  }
  thumbnails.value = results
}

async function loadOutline() {
  if (!pdfDoc) return
  const ol = await pdfDoc.getOutline()
  outline.value = (ol as any) || null
}

async function goToOutlineDest(dest: any) {
  if (!pdfDoc) return
  try {
    const explicitDest = await pdfDoc.getDestination(dest)
    if (!explicitDest) return
    const [ref] = explicitDest
    const pageIndex = await pdfDoc.getPageIndex(ref)
    pageNum.value = pageIndex + 1
    renderPage()
  } catch (e) {
    console.warn('无法跳转到书签目的地', e)
  }
}

async function runSearch() {
  if (!pdfDoc) return
  const q = searchQuery.value.trim()
  if (!q) {
    searchMatches.value = []
    currentMatchIndex.value = 0
    hasSearched.value = false
    pageToCount.value = {}
    flatMatches.value = []
    return
  }
  hasSearched.value = true
  const hits: number[] = []
  const counts: Record<number, number> = {}
  const lower = q.toLowerCase()
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p)
    const textContent = await page.getTextContent()
    const items = textContent.items as any[]
    let count = 0
    for (const it of items) {
      const s = (it.str || '').toLowerCase()
      if (s && s.includes(lower)) count++
    }
    if (count > 0) {
      hits.push(p)
      counts[p] = count
    }
  }
  searchMatches.value = hits
  pageToCount.value = counts
  // flatten to global match list
  const flattened: Array<{ page: number; rectIndex: number }> = []
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const c = counts[p] || 0
    for (let i = 0; i < c; i++) flattened.push({ page: p, rectIndex: i })
  }
  flatMatches.value = flattened
  currentMatchIndex.value = 0
  if (flattened.length > 0) {
    const first = flattened[0]
    pageNum.value = first.page
    await renderPage()
    scrollToCurrentMatch()
  }
}

// ===== Export / Save =====
function serializeAnnotations(): Record<number, any[]> {
  return annotations.value
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function saveAnnotationsJson() {
  const data = serializeAnnotations()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  saveBlob(blob, `annotations-page${pageNum.value}.json`)
}

function triggerImportJson() {
  const el = document.getElementById('import-json') as HTMLInputElement | null
  if (el) el.click()
}

function onImportJsonFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  file.text().then((text) => {
    try {
      const obj = JSON.parse(text)
      annotations.value = obj || {}
      renderPage()
    } catch (err) {
      alert('无效的 JSON 文件')
    }
  })
  ;(e.target as HTMLInputElement).value = ''
}

async function exportPdf() {
  if (!pdfDoc) return alert('请先加载 PDF 文件')
  if (!originalPdfBytes) return alert('无法获取源 PDF 字节，无法导出。请通过上传或 URL 方式加载。')
  // 逐页将注释层扁平化到新 PDF
  const newPdf = await PDFDocument.create()
  const srcPdf = await PDFDocument.load(originalPdfBytes)
  const helv = await newPdf.embedFont(StandardFonts.Helvetica)
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    // 将原始页面嵌入
    const embedded = (await newPdf.copyPages(srcPdf, [p - 1]))[0]
    newPdf.addPage(embedded)
    const target = newPdf.getPage(p - 1)
    const list = annotations.value[p] || []
    // 渲染注释到该页
    for (const a of list) {
      if (a.type === 'text') {
        const size = a.fontSize || 14
        const color = a.color || '#111827'
        const rgbColor = hexToRgb(color)
        target.drawText(a.text || '', {
          x: a.x,
          // align exported text visually with overlay top-left anchor
          y: a.y - size,
          size,
          font: helv,
          color: rgb(rgbColor.r, rgbColor.g, rgbColor.b),
        })
      } else if (a.type === 'highlight') {
        const color = a.color || '#facc15'
        const c = hexToRgb(color)
        target.drawRectangle({
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
        target.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, borderColor: rgb(c.r, c.g, c.b), borderWidth: 2, borderOpacity: 1, color: undefined })
      }
    }
  }
  const pdfBytes = await newPdf.save()
  saveBlob(new Blob([pdfBytes], { type: 'application/pdf' }), 'exported.pdf')
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  const bigint = parseInt(h, 16)
  const r = (bigint >> 16) & 255
  const g = (bigint >> 8) & 255
  const b = bigint & 255
  return { r: r / 255, g: g / 255, b: b / 255 }
}

async function exportPdfServer() {
  if (!pdfDoc) return alert('请先加载 PDF 文件')
  const form = new FormData()
  const url = (pdfDoc as any).url as string | undefined
  if (url) {
    form.append('url', url)
  } else if (originalPdfBytes) {
    const blob = new Blob([originalPdfBytes], { type: 'application/pdf' })
    form.append('file', blob, 'source.pdf')
  } else {
    return alert('缺少源 PDF 数据，无法服务端导出')
  }
  form.append('annotations', JSON.stringify(annotations.value))
  const resp = await fetch('/api/annotate/flatten', { method: 'POST', body: form })
  if (!resp.ok) {
    const txt = await resp.text()
    return alert('服务端导出失败: ' + txt)
  }
  const bytes = await resp.arrayBuffer()
  saveBlob(new Blob([bytes], { type: 'application/pdf' }), 'exported-server.pdf')
}
function nextMatch() {
  if (flatMatches.value.length === 0) return
  currentMatchIndex.value = (currentMatchIndex.value + 1) % flatMatches.value.length
  const cur = flatMatches.value[currentMatchIndex.value]
  pageNum.value = cur.page
  renderPage().then(scrollToCurrentMatch)
}
function prevMatch() {
  if (flatMatches.value.length === 0) return
  currentMatchIndex.value = (currentMatchIndex.value - 1 + flatMatches.value.length) % flatMatches.value.length
  const cur = flatMatches.value[currentMatchIndex.value]
  pageNum.value = cur.page
  renderPage().then(scrollToCurrentMatch)
}

onMounted(() => {
  // 不默认加载占位文件；请通过上传或后续提供 URL 加载
  // 初次进入或每次进入编辑模式时，保持整页适配，降低缩放差异带来的定位误差
  watch(isEditingMode, async (v) => {
    if (v) {
      await nextTick()
      fitPage()
    }
  }, { immediate: false })
})

// ===== In-page highlight helpers =====
function multiply(m1: number[], m2: number[]) {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

function rectFromTransform(transform: number[], width: number, height: number) {
  const x = transform[4]
  const y = transform[5]
  const wx = transform[0] * width
  const wy = transform[1] * width
  const hx = transform[2] * height
  const hy = transform[3] * height
  const pts = [
    [x, y],
    [x + wx, y + wy],
    [x + wx + hx, y + wy + hy],
    [x + hx, y + hy],
  ]
  const xs = pts.map(p => p[0])
  const ys = pts.map(p => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000
}

// === Persistence helpers ===
async function deriveDocKey(urlOrData: string | ArrayBuffer): Promise<string> {
  if (typeof urlOrData === 'string') return 'url:' + urlOrData
  const data = new Uint8Array(urlOrData)
  let hash = 0x811c9dc5 >>> 0
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i]
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return 'buf:' + hash.toString(16)
}

function scheduleAutoSave() {
  if (!autoSaveEnabled.value) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveAnnotationsToStorage()
  }, 300)
}

function saveAnnotationsToStorage() {
  try {
    if (!currentDocKey) return
    localStorage.setItem('pdf-annotations:' + currentDocKey, JSON.stringify(annotations.value))
  } catch {}
}

async function loadAnnotationsFromStorage() {
  try {
    if (!currentDocKey) return
    const raw = localStorage.getItem('pdf-annotations:' + currentDocKey)
    if (raw) {
      const obj = JSON.parse(raw)
      annotations.value = obj || {}
    } else {
      annotations.value = {}
    }
  } catch {
    annotations.value = {}
  }
}

async function getRectsForPage(page: any, queryLower: string) {
  const rects: Array<{ x: number; y: number; w: number; h: number }> = []
    const textContent = await page.getTextContent()
  const items = textContent.items as any[]
  const viewport = page.getViewport({ scale: scale.value, rotation: rotation.value })
  const vp = (viewport as any).transform as number[]
  items.forEach((it: any) => {
    const s = (it.str || '').toLowerCase()
    if (!s || !s.includes(queryLower)) return
    const t = it.transform as number[]
    const combined = multiply(vp, t)
    const w = typeof it.width === 'number' ? it.width * (scale.value / (t[0] || 1)) : Math.max(5, s.length * 5)
    const h = typeof it.height === 'number' ? Math.abs(it.height) : Math.abs(t[3] || 10)
    rects.push(rectFromTransform(combined, w, h))
  })
  return rects
}

async function renderHighlightsForCurrentPage(page: any) {
  const overlay = document.getElementById('hl-overlay') as HTMLDivElement | null
  if (!overlay || !canvasRef.value) return
  const rect = canvasRef.value.getBoundingClientRect()
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
  overlay.innerHTML = ''
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return
  const rects = await getRectsForPage(page, q)
  rects.forEach((r, idx) => {
    const div = document.createElement('div')
    div.className = 'hl' + (isCurrentRect(idx) ? ' current' : '')
    div.style.left = `${r.x}px`
    div.style.top = `${r.y}px`
    div.style.width = `${r.w}px`
    div.style.height = `${r.h}px`
    overlay.appendChild(div)
  })
}

function isCurrentRect(localIndex: number) {
  const cur = flatMatches.value[currentMatchIndex.value]
  if (!cur) return false
  return cur.page === pageNum.value && cur.rectIndex === localIndex
}

function scrollToCurrentMatch() {
  const overlay = document.getElementById('hl-overlay') as HTMLDivElement | null
  const stage = stageRef.value
  if (!overlay || !stage) return
  const cur = flatMatches.value[currentMatchIndex.value]
  if (!cur || cur.page !== pageNum.value) return
  const el = overlay.querySelectorAll<HTMLDivElement>('.hl')[cur.rectIndex]
  if (!el) return
  const rect = el.getBoundingClientRect()
  const host = stage.getBoundingClientRect()
  const dx = rect.left - host.left + rect.width / 2 - stage.clientWidth / 2
  const dy = rect.top - host.top + rect.height / 2 - stage.clientHeight / 2
  stage.scrollBy({ left: dx, top: dy, behavior: 'smooth' })
}

// ===== Annotation helpers =====
function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
function ensurePageArray(p: number) {
  if (!annotations.value[p]) annotations.value[p] = []
}
function viewportToPdf(xOverlay: number, yOverlay: number): { x: number; y: number } {
  if (!lastViewport.value) return { x: xOverlay, y: yOverlay }
  const m = getOverlayMetrics()
  if (!m) return { x: xOverlay, y: yOverlay }
  const vx = xOverlay / m.sx
  const vy = yOverlay / m.sy
  const pdf = lastViewport.value.convertToPdfPoint(vx, vy)
  return { x: pdf[0], y: pdf[1] }
}
function pdfRectToViewportRect(pdfRect: { x: number; y: number; w: number; h: number }) {
  if (!lastViewport.value) return pdfRect
  const m = getOverlayMetrics()
  const r = [pdfRect.x, pdfRect.y, pdfRect.x + pdfRect.w, pdfRect.y + pdfRect.h]
  const out = lastViewport.value.convertToViewportRectangle(r)
  const xV = Math.min(out[0], out[2])
  const yV = Math.min(out[1], out[3])
  const wV = Math.abs(out[2] - out[0])
  const hV = Math.abs(out[3] - out[1])
  if (!m) return { x: xV, y: yV, w: wV, h: hV }
  return { x: xV * m.sx, y: yV * m.sy, w: wV * m.sx, h: hV * m.sy }
}
async function renderAnnotationsForCurrentPage(_page: any) {
  const overlay = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (!overlay || !canvasRef.value) return
  const rect = canvasRef.value.getBoundingClientRect()
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
  overlay.innerHTML = ''
  const list = annotations.value[pageNum.value] || []
  for (const a of list) {
    const div = document.createElement('div')
    div.className = `anno ${a.type}`
    div.dataset.id = a.id
    div.style.position = 'absolute'
      if (a.type !== 'text') {
      const r = pdfRectToViewportRect(a)
      div.style.left = `${r.x}px`
      div.style.top = `${r.y}px`
      div.style.width = `${r.w}px`
      div.style.height = `${r.h}px`
      if (a.type === 'highlight') {
        // match export: semi-transparent fill + subtle border
        const fill = a.color || '#facc15'
        const c = hexToRgb(fill)
        div.style.background = `rgba(${Math.round(c.r*255)}, ${Math.round(c.g*255)}, ${Math.round(c.b*255)}, 0.35)`
        div.style.outline = `1px solid rgba(${Math.round(c.r*255)}, ${Math.round(c.g*255)}, ${Math.round(c.b*255)}, 0.6)`
      } else if (a.type === 'rect') {
        div.style.border = `2px solid ${a.color || '#f59e0b'}`
        div.style.background = 'transparent'
      }
    } else {
      // text: first render after creation uses stored viewport anchor to avoid timing drift
      let vx: number, vy: number
      const fontPx = (a.fontSize || 14) * (scale.value)
      if (typeof a.vx === 'number' && typeof a.vy === 'number' && a._scale === scale.value && a._rotation === rotation.value) {
        vx = a.vx
        vy = a.vy
      } else {
        const vpt = lastViewport.value?.convertToViewportPoint(a.x, a.y) || [a.x, a.y]
        const ov = viewportPointToOverlayPoint(vpt[0], vpt[1])
        vx = ov.x
        vy = ov.y
        a.vx = vx
        a.vy = vy
        a._scale = scale.value
        a._rotation = rotation.value
      }
      const leftPx = round3(vx)
      const topPx = round3(vy)
      div.style.left = `${leftPx}px`
      div.style.top = `${topPx}px`
      div.style.color = a.color || '#111827'
      div.style.fontSize = `${fontPx}px`
      div.textContent = a.text || ''
      // debug logs removed
      div.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        startEditAnnotation(a.id)
      })
    }
    overlay.appendChild(div)
  }
}
function onAnnoMouseDown(ev: MouseEvent) {
  if (!lastViewport.value) return
  const target = ev.target as HTMLElement
  const overlay = ev.currentTarget as HTMLElement
  const bounds = overlay.getBoundingClientRect()
  const canvasRect = canvasRef.value?.getBoundingClientRect()
  const baseLeft = canvasRect ? canvasRect.left : bounds.left
  const baseTop = canvasRect ? canvasRect.top : bounds.top
  const x = ev.clientX - baseLeft
  const y = ev.clientY - baseTop
  const pdf = viewportToPdf(x, y)
  if (toolMode.value === 'select') {
    if (target.classList.contains('anno')) {
      draggingAnnoId = target.dataset.id || null
      if (draggingAnnoId) {
        draggingStartPdf = pdf
        const a = (annotations.value[pageNum.value] || []).find(i => i.id === draggingAnnoId)!
        draggingOriginPdf = { x: a.x, y: a.y }
      }
    }
    return
  }
  if (toolMode.value === 'text') {
    ensurePageArray(pageNum.value)
    const id = genId()
    // 使用最近一次 mousemove 记录的坐标，避免 click 事件坐标抖动
    const useOverlay = lastOverlayPoint || { x, y }
    const useViewport = lastViewportPoint || overlayPointToViewportPoint(useOverlay.x, useOverlay.y)
    const pdfFromCache = lastPdfPoint
    const pdfPt = pdfFromCache ? [pdfFromCache.x, pdfFromCache.y] : lastViewport.value.convertToPdfPoint(useViewport.x, useViewport.y)
    const anno: Annotation = {
      id,
      page: pageNum.value,
      type: 'text',
      x: pdfPt[0],
      y: pdfPt[1],
      w: 0,
      h: 0,
      text: '',
      color: textColor.value,
      fontSize: textFontSize.value,
      vx: useOverlay.x,
      vy: useOverlay.y,
      _scale: scale.value,
      _rotation: rotation.value,
    }
    // debug log removed: [text:add]
    annotations.value[pageNum.value].push(anno)
    editingAnnoId.value = id
    renderPage().then(() => openTextEditor(id))
    return
  }
  // rect / highlight draw start
  isDrawing.value = true
  drawingStartPdf = pdf
}
function onAnnoMouseMove(ev: MouseEvent) {
  if (!lastViewport.value) return
  const overlay = ev.currentTarget as HTMLElement
  const bounds = overlay.getBoundingClientRect()
  const canvasRect = canvasRef.value?.getBoundingClientRect()
  const baseLeft = canvasRect ? canvasRect.left : bounds.left
  const baseTop = canvasRect ? canvasRect.top : bounds.top
  const x = ev.clientX - baseLeft
  const y = ev.clientY - baseTop
  const pdf = viewportToPdf(x, y)
  // 调试：鼠标移动时输出 overlay / viewport / pdf 坐标（节流 100ms）
  const now = performance.now()
  if (now - lastMoveLogTs > 100) {
    const vp = overlayPointToViewportPoint(x, y)
    const pdfPt = lastViewport.value.convertToPdfPoint(vp.x, vp.y)
    if (toolMode.value === 'text') {
      // debug log removed: [text:move]
      lastMoveLogTs = now
    }
    ;(lastPdfPoint as any) = { x: pdfPt[0], y: pdfPt[1] }
  }
  // 缓存最近一次移动位置（overlay/viewport 坐标），点击时直接使用，避免 click 抖动
  const vpCache = overlayPointToViewportPoint(x, y)
  ;(lastOverlayPoint as any) = { x, y }
  ;(lastViewportPoint as any) = { x: vpCache.x, y: vpCache.y }
  if (lastViewport.value) {
    const pdfFromCache = lastViewport.value.convertToPdfPoint(vpCache.x, vpCache.y)
    ;(lastPdfPoint as any) = { x: pdfFromCache[0], y: pdfFromCache[1] }
  }
  if (draggingAnnoId && draggingStartPdf && draggingOriginPdf) {
    const dx = pdf.x - draggingStartPdf.x
    const dy = pdf.y - draggingStartPdf.y
    const list = annotations.value[pageNum.value] || []
    const a = list.find(i => i.id === draggingAnnoId)
    if (a) {
      a.x = (draggingOriginPdf.x + dx)
      a.y = (draggingOriginPdf.y + dy)
      // 清空文本锚点，确保文本在拖动时根据 PDF 坐标实时转换
      if (a.type === 'text') {
        a.vx = undefined
        a.vy = undefined
      }
      // 仅重绘注释覆盖层，避免触发 PDF 画布的并发渲染
      renderAnnotationsForCurrentPage(null as any)
      scheduleAutoSave()
    }
    return
  }
  if (!isDrawing.value || !drawingStartPdf) return
  // draw preview by updating a temp element
  const temp = document.getElementById('anno-preview') as HTMLDivElement | null
  const overlayDiv = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (!overlayDiv) return
  const startV = lastViewport.value.convertToViewportPoint(drawingStartPdf.x, drawingStartPdf.y)
  const curV = [x, y]
  const rx = Math.min(startV[0], curV[0])
  const ry = Math.min(startV[1], curV[1])
  const rw = Math.abs(curV[0] - startV[0])
  const rh = Math.abs(curV[1] - startV[1])
  let el = temp
  if (!el) {
    el = document.createElement('div')
    el.id = 'anno-preview'
    el.className = 'anno preview'
    el.style.position = 'absolute'
    overlayDiv.appendChild(el)
  }
  el.style.left = `${rx}px`
  el.style.top = `${ry}px`
  el.style.width = `${rw}px`
  el.style.height = `${rh}px`
  el.style.border = '1px dashed #3b82f6'
  el.style.background = toolMode.value === 'highlight' ? 'rgba(250, 204, 21, 0.25)' : 'transparent'
}
function onAnnoMouseUp(ev: MouseEvent) {
  if (!lastViewport.value) return
  if (draggingAnnoId) {
    draggingAnnoId = null
    draggingStartPdf = null
    draggingOriginPdf = null
    snapshot()
    return
  }
  if (!isDrawing.value || !drawingStartPdf) return
  isDrawing.value = false
  const overlay = ev.currentTarget as HTMLElement
  const bounds = overlay.getBoundingClientRect()
  const canvasRect = canvasRef.value?.getBoundingClientRect()
  const baseLeft = canvasRect ? canvasRect.left : bounds.left
  const baseTop = canvasRect ? canvasRect.top : bounds.top
  const x = ev.clientX - baseLeft
  const y = ev.clientY - baseTop
  const endPdf = viewportToPdf(x, y)
  const x0 = Math.min(drawingStartPdf.x, endPdf.x)
  const y0 = Math.min(drawingStartPdf.y, endPdf.y)
  const w = Math.abs(endPdf.x - drawingStartPdf.x)
  const h = Math.abs(endPdf.y - drawingStartPdf.y)
  const type: AnnotationType = toolMode.value === 'highlight' ? 'highlight' : 'rect'
  if (w < 1 || h < 1) return
  ensurePageArray(pageNum.value)
  snapshot()
  annotations.value[pageNum.value].push({
    id: genId(),
    page: pageNum.value,
    type,
    x: x0,
    y: y0,
    w,
    h,
    color: strokeColor.value,
  })
  // remove preview
  const temp = document.getElementById('anno-preview')
  if (temp?.parentElement) temp.parentElement.removeChild(temp)
  // 完成绘制后仅刷新注释层，避免触发 PDF 并发渲染
  renderAnnotationsForCurrentPage(null as any)
  scheduleAutoSave()
}

function startEditAnnotation(id: string) {
  editingAnnoId.value = id
  renderPage().then(() => openTextEditor(id))
}

function openTextEditor(id: string) {
  const overlay = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (!overlay || !lastViewport.value) return
  const list = annotations.value[pageNum.value] || []
  const a = list.find(i => i.id === id)
  if (!a) return
      const [vx0, vy0] = lastViewport.value.convertToViewportPoint(a.x, a.y)
      const ov = viewportPointToOverlayPoint(vx0, vy0)
      // 以 overlay 的内容盒为定位上下文
      const overlayRect = (document.getElementById('anno-overlay') as HTMLDivElement)?.getBoundingClientRect()
      const canvasRect = canvasRef.value?.getBoundingClientRect()
      if (overlayRect && canvasRect) {
        // 若 overlay 未对齐画布，修正其相对定位偏差
        const dx = round3(canvasRect.left - overlayRect.left)
        const dy = round3(canvasRect.top - overlayRect.top)
        ov.x = round3(ov.x + dx)
        ov.y = round3(ov.y + dy)
      }
  const input = document.createElement('textarea')
  input.id = 'anno-editor'
  input.value = a.text || ''
  input.style.position = 'absolute'
  input.style.left = `${ov.x}px`
  input.style.top = `${ov.y}px`
  input.style.minWidth = '120px'
  input.style.fontSize = `${(a.fontSize || 14) * (scale.value)}px`
  input.style.lineHeight = '1.2'
  input.style.padding = '0 4px'
  input.style.border = '1px solid #3b82f6'
  input.style.background = 'transparent'
  input.style.resize = 'none'
  input.style.overflow = 'hidden'
  input.style.height = '1.4em'
  input.style.minHeight = '0'
  input.style.maxHeight = '1.4em'
  input.style.zIndex = '10'
  overlay.appendChild(input)
  input.focus()
  autoResizeTextarea(input)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commitTextEditor()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelTextEditor()
    }
  })
  input.addEventListener('blur', () => {
    // 避免与 keydown Enter 竞争导致重复提交/渲染过程中节点已被移除
    setTimeout(() => commitTextEditor(), 0)
  })
  input.addEventListener('input', () => autoResizeTextarea(input))
}

function commitTextEditor() {
  const input = document.getElementById('anno-editor') as HTMLTextAreaElement | null
  if (!input || !input.parentElement) return
  const list = annotations.value[pageNum.value] || []
  const a = list.find(i => i.id === editingAnnoId.value)
  const val = input.value.trim()
  if (a) {
    if (val) {
      snapshot()
      a.text = val
      // 将当前输入框的 overlay 位置反算为 PDF 坐标，确保提交后位置与所见一致
      const left = parseFloat(input.style.left || '0')
      const top = parseFloat(input.style.top || '0')
      if (Number.isFinite(left) && Number.isFinite(top) && lastViewport.value) {
        const vp = overlayPointToViewportPoint(left, top)
        const pdfPt = lastViewport.value.convertToPdfPoint(vp.x, vp.y)
        a.x = pdfPt[0]
        a.y = pdfPt[1]
        a.vx = left
        a.vy = top
        a._scale = scale.value
        a._rotation = rotation.value
      }
    } else {
      // empty -> remove
      snapshot()
      const idx = list.findIndex(i => i.id === a.id)
      if (idx >= 0) list.splice(idx, 1)
    }
  }
  input.remove()
  editingAnnoId.value = null
  renderPage()
  scheduleAutoSave()
}

function cancelTextEditor() {
  const input = document.getElementById('anno-editor') as HTMLTextAreaElement | null
  if (input) input.remove()
  // if it was a new empty annotation, remove it
  const list = annotations.value[pageNum.value] || []
  if (editingAnnoId.value) {
    const a = list.find(i => i.id === editingAnnoId.value)
    if (a && !a.text) {
      const idx = list.findIndex(i => i.id === a.id)
      if (idx >= 0) list.splice(idx, 1)
    }
  }
  editingAnnoId.value = null
  renderPage()
}

function clearAllEdits() {
  // 关闭可能存在的文本编辑器
  const input = document.getElementById('anno-editor') as HTMLTextAreaElement | null
  if (input) input.remove()
  // 快照当前状态，便于撤销恢复
  snapshot()
  // 清空所有页的注释
  annotations.value = {}
  editingAnnoId.value = null
  // 仅重绘注释层，避免触发 PDF 并发渲染
  renderAnnotationsForCurrentPage(null as any)
}

function autoResizeTextarea(el: HTMLTextAreaElement) {
  // 单行自适应：先重置高度，再按滚动高度设置，同时限制为 1 行高
  el.style.height = '1px'
  const line = el.scrollHeight
  el.style.height = `${line}px`
}
</script>

<template>
  <div class="viewer">
    <div class="toolbar">
      <input ref="fileInputRef" type="file" accept="application/pdf" @change="onFileChange" />
      <div class="sep" />
      <button @click="prevPage">上一页</button>
      <span>{{ pageNum }} / {{ numPages }}</span>
      <button @click="nextPage">下一页</button>
      <input style="width:80px" type="number" :max="numPages" :min="1" :value="pageNum" @change="onChangePage" />
      <div class="sep" />
      <button @click="zoomOut" :disabled="isEditingMode">缩小</button>
      <button @click="zoomIn" :disabled="isEditingMode">放大</button>
      <button @click="fitWidth" :disabled="isEditingMode">适配宽度</button>
      <button @click="fitPage">整页适配</button>
      <div class="sep" />
      <button @click="rotateCounterClockwise" :disabled="isEditingMode">左旋转</button>
      <button @click="rotateClockwise" :disabled="isEditingMode">右旋转</button>
      <div class="sep" />
      <input placeholder="搜索文本" v-model="searchQuery" @keyup.enter="runSearch" />
      <button @click="runSearch">搜索</button>
      <button :disabled="!searchMatches.length" @click="prevMatch">上一个</button>
      <button :disabled="!searchMatches.length" @click="nextMatch">下一个</button>
      <span v-if="hasSearched">{{ searchMatches.length ? (currentMatchIndex+1) : 0 }}/{{ searchMatches.length }}</span>
      <div class="sep" />
      <label>工具:</label>
      <select v-model="toolMode">
        <option value="select">选择</option>
        <option value="text">文本</option>
        <option value="highlight">高亮矩形</option>
        <option value="rect">矩形</option>
      </select>
      <input type="color" v-model="strokeColor" title="颜色" />
      <label>字体:</label>
      <input style="width:60px" type="number" v-model.number="textFontSize" min="8" max="72" />
      <button @click="undo">撤销</button>
      <button @click="clearAllEdits">重做</button>
      <div class="sep" />
      <button @click="exportPdf">导出PDF</button>
      <button @click="exportPdfServer">服务端导出</button>
      <button @click="saveAnnotationsJson">导出JSON</button>
      <button @click="triggerImportJson">导入JSON</button>
      <input id="import-json" type="file" accept="application/json" style="display:none" @change="onImportJsonFile" />
    </div>
    <div class="content">
      <aside class="sidebar">
        <div class="thumbs">
          <div v-for="t in thumbnails" :key="t.page" class="thumb" :class="{active: t.page===pageNum}" @click="jumpTo(t.page)">
            <img :src="t.dataUrl" :alt="'p'+t.page" />
            <span>{{ t.page }}</span>
          </div>
        </div>
        <div class="outline" v-if="outline?.length">
          <details open>
            <summary>书签</summary>
            <ul class="ol">
              <li v-for="(item, idx) in outline" :key="idx">
                <button class="link" @click="goToOutlineDest(item.dest)" v-if="item.dest">{{ item.title }}</button>
                <span v-else>{{ item.title }}</span>
                <ul v-if="item.items?.length">
                  <li v-for="(child, cidx) in item.items" :key="cidx">
                    <button class="link" @click="goToOutlineDest(child.dest)" v-if="child.dest">{{ child.title }}</button>
                    <span v-else>{{ child.title }}</span>
                  </li>
                </ul>
              </li>
            </ul>
          </details>
        </div>
      </aside>
      <div class="stage" ref="stageRef">
        <div class="canvas-wrap">
          <canvas ref="canvasRef"></canvas>
          <div id="hl-overlay" class="hl-overlay"></div>
          <div id="anno-overlay" class="anno-overlay" @mousedown="onAnnoMouseDown" @mousemove="onAnnoMouseMove" @mouseup="onAnnoMouseUp"></div>
        </div>
      </div>
    </div>
    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
  </div>
  
</template>

<style scoped>
.viewer { display: flex; flex-direction: column; height: 100vh; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px; border-bottom: 1px solid #eee; }
.toolbar .sep { width: 1px; height: 20px; background: #e5e7eb; margin: 0 4px; }
.content { display: flex; min-height: 0; flex: 1; }
.sidebar { width: 220px; border-right: 1px solid #eee; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 12px; }
.thumbs { display: grid; grid-template-columns: 1fr; gap: 8px; }
.thumb { cursor: pointer; border: 1px solid #e5e7eb; border-radius: 4px; padding: 4px; display: grid; grid-template-rows: auto 20px; justify-items: center; background: #fff; }
.thumb.active { outline: 2px solid #3b82f6; }
.thumb img { width: 100%; height: auto; display: block; }
.thumb span { font-size: 12px; color: #555; }
.outline .ol { list-style: none; padding-left: 12px; }
.outline .link { background: none; border: none; color: #2563eb; cursor: pointer; padding: 0; }
.stage { flex: 1; overflow: auto; display: grid; place-items: center; background: #f6f7fb; padding: 12px; }
canvas { background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.08); display: block; }
.canvas-wrap { position: relative; }
.hl-overlay { position: absolute; inset: 0; pointer-events: none; left: 0; top: 0; }
.hl { position: absolute; background: rgba(250, 204, 21, 0.35); outline: 1px solid rgba(234, 179, 8, 0.6); }
.hl.current { background: rgba(59, 130, 246, 0.35); outline-color: rgba(59, 130, 246, 0.7); }
.anno-overlay { position: absolute; inset: 0; cursor: crosshair; left: 0; top: 0; }
.anno { position: absolute; }
.anno#anno-editor { position: absolute; }
.anno.text { pointer-events: auto; user-select: none; background: transparent; }
.anno.rect { background: transparent; }
.anno.preview { pointer-events: none; }
.error { color: #c62828; padding: 8px 12px; }
</style>

