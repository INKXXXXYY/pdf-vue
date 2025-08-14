<script setup lang="ts">
import { onMounted, ref, watch, computed, nextTick } from 'vue'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'
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
  const n = parseInt(input.value, 10)
  // 这里的 n 为"视觉顺序索引"，需映射到实际页码
  if (Number.isFinite(n) && n >= 1 && n <= numPages.value) {
    const actual = pageOrder.value[n - 1] || n
    pageNum.value = actual
    renderPage()
  }
}

// === Annotations (文本/高亮矩形/矩形/遮罩/路径/椭圆/直线/箭头/多边形) ===
type AnnotationType = 'text' | 'highlight' | 'rect' | 'image' | 'mask' | 'path' | 'ellipse' | 'line' | 'arrow' | 'polygon'
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
  src?: string // for image
  rotationDeg?: number
  // 视口锚点（用于首次渲染保障与点击点像素级一致）
  vx?: number
  vy?: number
  _scale?: number
  _rotation?: number
  // for auto-sizing from overlay rect (optional)
  _ow?: number
  _oh?: number
  // 绘图路径
  pts?: Array<{ x: number; y: number }>
  strokeWidth?: number
  _tool?: string
}
const annotations = ref<Record<number, Annotation[]>>({})
const editingAnnoId = ref<string | null>(null)
type ToolMode = 'textSelect' | 'select' | 'text' | 'highlight' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'image' | 'draw' | 'eraser'
const toolMode = ref<ToolMode>('textSelect')
// Replace Text inputs (暂时隐藏功能)
// const replaceFrom = ref('')
// const replaceTo = ref('')
const strokeColor = ref('#facc15')
const textColor = ref('#111827')
const textFontSize = ref(14)
const drawWidth = ref(2)
const isDrawing = ref(false)
let drawingStartPdf: { x: number; y: number } | null = null
// 橡皮擦
const eraserRadius = ref(12)
let isErasing = false
let erasedIdsThisDrag = new Set<string>()
let draggingAnnoId: string | null = null
let draggingStartPdf: { x: number; y: number } | null = null
const lastViewport: any = ref(null)
// keep original PDF bytes for export
let originalPdfBytes: ArrayBuffer | null = null
// pending image to place
const pendingImage = ref<{ src: string; naturalWidth: number; naturalHeight: number } | null>(null)
// persistence helpers
const autoSaveEnabled = ref(true)
let saveTimer: any = null
let currentDocKey: string | null = null
// 编辑模式：绘制/编辑图形时才锁定，文本选择与编辑选择均视为非编辑
const isEditingMode = computed(() => !['select'].includes(toolMode.value))
// const lockFitPage = ref(false)
let lastMoveLogTs = 0
 let lastOverlayPoint: { x: number; y: number } | null = null
 let lastViewportPoint: { x: number; y: number } | null = null
 let lastPdfPoint: { x: number; y: number } | null = null
const selectedAnnoId = ref<string | null>(null)
const selectedAnnoIds = ref<string[]>([])
let draggingOriginsById: Record<string, { x: number; y: number }> = {}
let isBoxSelecting = false
let boxSelectStart: { x: number; y: number } | null = null
let resizingHandle: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | null = null
let resizingStartRect: { x: number; y: number; w: number; h: number } | null = null
let resizingStartOverlay: { x: number; y: number; w: number; h: number; hx: number; hy: number } | null = null
let rotating = false
let rotateCenterOverlay: { x: number; y: number } | null = null
let rotateStartAngle = 0
let drawingPathPts: Array<{ x: number; y: number }> | null = null
let drawMoveListener: ((e: MouseEvent) => void) | null = null
let drawUpListener: ((e: MouseEvent) => void) | null = null
let polygonDblListener: ((e: MouseEvent) => void) | null = null
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
    // 初始化页面顺序为自然顺序
    pageOrder.value = Array.from({ length: numPages.value }, (_, i) => i + 1)
    rotation.value = 0
    await renderPage()
    await Promise.all([renderThumbnails(), loadOutline()])
    // persistence: derive doc key and try load annotations
    try {
      currentDocKey = await deriveDocKey(urlOrData)
      await loadAnnotationsFromStorage()
      await loadPageOrderFromStorage()
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
  // 启用原生文本层以允许选择 PDF 文本
  try {
    console.log('[textLayer] init start', { page: pageNum.value, vw: viewport.width, vh: viewport.height, scale: (viewport as any).scale })
    const textLayerDivId = 'text-layer'
    let textLayerDiv = document.getElementById(textLayerDivId) as HTMLDivElement | null
    const host = canvas.parentElement as HTMLElement | null
    if (host) {
      if (!textLayerDiv) {
        textLayerDiv = document.createElement('div')
        textLayerDiv.id = textLayerDivId
        textLayerDiv.className = 'textLayer'
        textLayerDiv.style.position = 'absolute'
        textLayerDiv.style.inset = '0'
        textLayerDiv.style.left = '0px'
        textLayerDiv.style.top = '0px'
        textLayerDiv.style.pointerEvents = 'auto'
        textLayerDiv.style.userSelect = 'text'
        textLayerDiv.style.zIndex = '5'
        textLayerDiv.addEventListener('mousedown', (e) => {
          const el = e.target as HTMLElement
          if (el && el.tagName === 'SPAN') {
            const hostRect = host.getBoundingClientRect()
            const br = el.getBoundingClientRect()
            const css = { left: br.left - hostRect.left, top: br.top - hostRect.top, width: br.width, height: br.height }
            const data = {
              x: parseFloat(el.dataset.x || 'NaN'),
              y: parseFloat(el.dataset.y || 'NaN'),
              w: parseFloat(el.dataset.w || 'NaN'),
              h: parseFloat(el.dataset.h || 'NaN'),
            }
            console.log('[textLayer:hit]', { text: el.textContent, styleLeft: el.style.left, styleTop: el.style.top, dataRect: data, cssRect: css })
          } else {
            console.log('[textLayer] mousedown on', el?.className)
          }
        })
        host.appendChild(textLayerDiv)
        console.log('[textLayer] created and appended to host')
      }
      const rectCss = canvas.getBoundingClientRect()
      // 内部尺寸按 viewport（画布像素），通过 transform 缩放到 CSS 尺寸
      textLayerDiv.style.width = `${viewport.width}px`
      textLayerDiv.style.height = `${viewport.height}px`
      textLayerDiv.style.transformOrigin = '0 0'
      const tlScaleX = rectCss.width / viewport.width
      const tlScaleY = rectCss.height / viewport.height
      ;(textLayerDiv as any)._scaleX = tlScaleX
      ;(textLayerDiv as any)._scaleY = tlScaleY
      textLayerDiv.style.transform = `scale(${tlScaleX}, ${tlScaleY})`
      // 清空旧层
      textLayerDiv.innerHTML = ''
      const textContent = await page.getTextContent()
      console.log('[textLayer] textContent items:', (textContent.items || []).length)
      // Build a minimal selectable text layer without importing pdf_viewer to avoid module resolution errors
      const vp = (viewport as any).transform as number[]
      const items = (textContent.items || []) as any[]
      let count = 0
      for (const it of items) {
        const s = it.str || ''
        if (!s) continue
        const t = it.transform as number[]
        const combined = multiply(vp, t)
        // 将 PDF 文本宽高换算为视口像素：沿用搜索高亮的计算方式
        const w = typeof it.width === 'number' ? it.width * (scale.value / (t[0] || 1)) : Math.max(5, s.length * 5)
        const h = typeof it.height === 'number' ? Math.abs(it.height) : Math.abs(t?.[3] || 10)
        const r = rectFromTransform(combined, w, h)
        const span = document.createElement('span')
        span.style.position = 'absolute'
        // 不设置固定宽高，避免整块；控制较小的可选中高亮高度
        span.style.whiteSpace = 'pre'
        span.style.display = 'inline-block'
        // 使用固定较小的视觉字号/行高，避免选区高度过大
        const fontCssPx = 12
        span.style.left = `${r.x}px`
        // 许多 PDF 文本矩形的 y 为块的底边；将高亮条顶部放在 (y + h - 行高)
        span.style.top = `${r.y + Math.max(0, r.h - fontCssPx)}px`
        span.style.fontSize = `${fontCssPx}px`
        span.style.lineHeight = `${fontCssPx}px`
        span.style.height = `${fontCssPx}px`
        span.style.overflow = 'hidden'
        span.style.color = 'transparent'
        ;(span.style as any)["-webkit-text-fill-color"] = 'transparent'
        span.style.caretColor = 'transparent'
        span.style.background = 'transparent'
        span.style.userSelect = 'text'
        span.textContent = s
        span.dataset.x = String(r.x)
        span.dataset.y = String(r.y)
        span.dataset.w = String(r.w)
        span.dataset.h = String(r.h)
        textLayerDiv.appendChild(span)
        count++
      }
      console.log('[textLayer] manual layer built; spans:', count)
    }
  } catch {}
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
    // 在文本选择工具下，允许穿透空白区域到文本层，实现原生文本选择
    if (toolMode.value === 'textSelect') {
      // 只让注释元素可点，空白穿透
      anno.style.pointerEvents = 'auto'
      ;(anno.style as any).setProperty('--anno-events', 'auto')
      // 给注释元素统一 class 以控制命中区域
      // 已有 .anno 元素设置 pointer-events: auto
      anno.style.cursor = 'text'
    } else {
      anno.style.pointerEvents = 'auto'
      anno.style.cursor = 'crosshair'
    }
  }
  await renderHighlightsForCurrentPage(page)
  await renderAnnotationsForCurrentPage(page)
}

// 替换当前页上的文本注释内容：基于提取到的现有注释中 type==='text' 的项
/*
async function runReplaceInPage() {
  const from = replaceFrom.value
  if (!from) return alert('请输入要查找的文本')
  const to = replaceTo.value ?? ''
  const list = annotations.value[pageNum.value] || []
  let changed = 0
  list.forEach(a => {
    if (a.type === 'text' && a.text) {
      const n = a.text.split(from).length - 1
      if (n > 0) {
        a.text = a.text.split(from).join(to)
        changed += n
      }
    }
  })
  if (changed > 0) {
    snapshot()
    renderAnnotationsForCurrentPage(null as any)
    scheduleAutoSave()
    alert(`已替换 ${changed} 处。`)
  } else {
    alert('未找到可替换的文本（仅作用于当前页的文本注释）。')
  }
}

// 用遮罩+新文本注释覆盖 PDF 原生文字（不修改原 PDF 字节，导出时会被扁平化）
async function runReplaceNativeInPage() {
  if (!lastViewport.value) return
  const from = replaceFrom.value.trim()
  const to = replaceTo.value ?? ''
  if (!from) return alert('请输入要查找的文本')
  const page = await pdfDoc!.getPage(pageNum.value)
  const textContent = await page.getTextContent()
  const items = textContent.items as any[]
  const viewport = page.getViewport({ scale: scale.value, rotation: rotation.value })
  const vp = (viewport as any).transform as number[]
  const m = getOverlayMetrics()
  if (!m) return
  let hits = 0
  ensurePageArray(pageNum.value)
  for (const it of items) {
    const s = (it.str || '')
    if (!s) continue
    if (!s.includes(from)) continue
    const t = it.transform as number[]
    const combined = multiply(vp, t)
    const w = typeof it.width === 'number' ? it.width * (scale.value / (t[0] || 1)) : Math.max(5, s.length * 5)
    const h = typeof it.height === 'number' ? Math.abs(it.height) : Math.abs(t?.[3] || 10)
    const rV = rectFromTransform(combined, w, h)
    const r = { x: rV.x * m.sx, y: rV.y * m.sy, w: rV.w * m.sx, h: rV.h * m.sy }
    console.log('[replace:hit]', { text: s, viewportRect: rV, overlayScale: { sx: m.sx, sy: m.sy }, overlayRect: r })
    // 生成遮罩（白底矩形）覆盖原文字
    const idMask = genId()
    annotations.value[pageNum.value].push({
      id: idMask,
      page: pageNum.value,
      type: 'mask',
      x: r.x,
      y: r.y,
      w: r.w,
      h: Math.max(10, r.h),
      color: '#ffffff'
    } as any)
    // 在遮罩位置放置新文本注释
    const idText = genId()
    annotations.value[pageNum.value].push({
      id: idText,
      page: pageNum.value,
      type: 'text',
      x: r.x,
      y: r.y,
      w: 0,
      h: 0,
      text: s.replaceAll(from, to),
      color: textColor.value,
      fontSize: Math.max(8, r.h / (scale.value || 1)),
      vx: r.x,
      vy: r.y,
      _scale: scale.value,
      _rotation: rotation.value,
      _ow: r.w,
      _oh: r.h,
    })
    console.log('[replace:created]', { mask: { id: idMask, r }, textAnno: { id: idText, x: r.x, y: r.y } })
    hits++
  }
  if (hits > 0) {
    snapshot()
    renderAnnotationsForCurrentPage(null as any)
    scheduleAutoSave()
    alert(`已用遮罩+新文本覆盖 ${hits} 处 PDF 原文字。导出时将扁平化到新 PDF。`)
  } else {
    alert('未在当前页原文字中找到匹配内容。')
  }
}

// 将当前页的 PDF 原文字项全部转为"可编辑"的覆盖文本：为每个文本 item 生成遮罩 + 文本注释，并把编辑选择设为激活
async function startReplaceEditForPage() {
  if (!pdfDoc || !lastViewport.value) return
  const page = await pdfDoc.getPage(pageNum.value)
  const textContent = await page.getTextContent()
  const items = textContent.items as any[]
  const viewport = page.getViewport({ scale: scale.value, rotation: rotation.value })
  const vp = (viewport as any).transform as number[]
  const m = getOverlayMetrics()
  if (!m) return
  ensurePageArray(pageNum.value)
  let created = 0
  for (const it of items) {
    const s = (it.str || '')
    if (!s) continue
    const t = it.transform as number[]
    const combined = multiply(vp, t)
    const w = typeof it.width === 'number' ? it.width * (scale.value / (t[0] || 1)) : Math.max(5, s.length * 5)
    const h = typeof it.height === 'number' ? Math.abs(it.height) : Math.abs(t?.[3] || 10)
    const rV = rectFromTransform(combined, w, h)
    const r = { x: rV.x * m.sx, y: rV.y * m.sy, w: rV.w * m.sx, h: rV.h * m.sy }
    console.log('[editable:hit]', { text: s, viewportRect: rV, overlayScale: { sx: m.sx, sy: m.sy }, overlayRect: r })
    const idMask = genId()
    annotations.value[pageNum.value].push({
      id: idMask,
      page: pageNum.value,
      type: 'mask',
      x: r.x,
      y: r.y,
      w: r.w,
      h: Math.max(10, r.h),
      color: '#ffffff'
    } as any)
    const idText = genId()
    annotations.value[pageNum.value].push({
      id: idText,
      page: pageNum.value,
      type: 'text',
      x: r.x,
      y: r.y,
      w: 0,
      h: 0,
      text: s,
      color: textColor.value,
      fontSize: Math.max(8, r.h / (scale.value || 1)),
      vx: r.x,
      vy: r.y,
      _scale: scale.value,
      _rotation: rotation.value,
      _ow: r.w,
      _oh: r.h,
    })
    console.log('[editable:created]', { mask: { id: idMask, r }, textAnno: { id: idText, x: r.x, y: r.y } })
    created++
  }
  if (created > 0) {
    snapshot()
    toolMode.value = 'select'
    renderAnnotationsForCurrentPage(null as any)
    scheduleAutoSave()
    alert(`已将 ${created} 个原文字段转为可编辑文本。你可以直接双击修改内容，并导出为新 PDF。`)
  } else {
    alert('未在当前页检测到可转换的原文字。')
  }
}
*/

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
  const idx = pageOrder.value.indexOf(pageNum.value)
  if (idx >= 0 && idx < pageOrder.value.length - 1) {
    pageNum.value = pageOrder.value[idx + 1]
    renderPage()
  }
}
function prevPage() {
  const idx = pageOrder.value.indexOf(pageNum.value)
  if (idx > 0) {
    pageNum.value = pageOrder.value[idx - 1]
    renderPage()
  }
}
function jumpTo(input: string | number) {
  const n = typeof input === 'number' ? input : parseInt(input as string, 10)
  // 这里的 n 视为"实际页码"
  if (Number.isFinite(n) && n >= 1 && n <= numPages.value) {
    pageNum.value = n
    renderPage()
  }
}

async function renderThumbnails() {
  if (!pdfDoc) return
  const results: Array<{ page: number; dataUrl: string }> = []
  const maxWidth = 120
  const order = pageOrder.value.length ? pageOrder.value : Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1)
  for (const p of order) {
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
      } else if (a.type === 'mask') {
        const c = hexToRgb(a.color || '#ffffff')
        target.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: rgb(c.r, c.g, c.b) })
      } else if (a.type === 'image' && a.src) {
        try {
          const pngBytes = dataUrlToBytes(a.src)
          const png = await newPdf.embedPng(pngBytes).catch(async () => await newPdf.embedJpg(pngBytes))
          const rot = (a.rotationDeg || 0)
          const rad = rot * Math.PI / 180
          const cx = a.x + a.w / 2
          const cy = a.y + a.h / 2
          const cos = Math.cos(rad)
          const sin = Math.sin(rad)
          // compute four corners after rotation around center
          const corners = [
            { x: -a.w/2, y: -a.h/2 },
            { x:  a.w/2, y: -a.h/2 },
            { x:  a.w/2, y:  a.h/2 },
            { x: -a.w/2, y:  a.h/2 },
          ].map(p => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }))
          const xs = corners.map(c => c.x)
          const ys = corners.map(c => c.y)
          const minX = Math.min(...xs)
          const minY = Math.min(...ys)
          const maxX = Math.max(...xs)
          const maxY = Math.max(...ys)
          // draw unrotated image inside its axis-aligned bounding box as approximation
          target.drawImage(png, { x: minX, y: minY, width: maxX - minX, height: maxY - minY })
        } catch {}
      } else if (a.type === 'path' && a.pts?.length) {
        // 近似为折线段
        const col = hexToRgb(a.color || '#f59e0b')
        for (let i=1;i<a.pts.length;i++) {
          const p0 = a.pts[i-1]
          const p1 = a.pts[i]
          target.drawLine({ start: { x: p0.x, y: p0.y }, end: { x: p1.x, y: p1.y }, thickness: a.strokeWidth || 2, color: rgb(col.r, col.g, col.b) })
        }
        // 若原始工具为箭头，则在终点绘制一个简单箭头（等腰三角形近似）
        if ((a as any)._tool === 'arrow' && a.pts.length >= 2) {
          const p0 = a.pts[a.pts.length - 2]
          const p1 = a.pts[a.pts.length - 1]
          const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x)
          const size = 6
          const left = { x: p1.x - size * Math.cos(angle - Math.PI / 6), y: p1.y - size * Math.sin(angle - Math.PI / 6) }
          const right = { x: p1.x - size * Math.cos(angle + Math.PI / 6), y: p1.y - size * Math.sin(angle + Math.PI / 6) }
          target.drawLine({ start: { x: p1.x, y: p1.y }, end: { x: left.x, y: left.y }, thickness: a.strokeWidth || 2, color: rgb(col.r, col.g, col.b) })
          target.drawLine({ start: { x: p1.x, y: p1.y }, end: { x: right.x, y: right.y }, thickness: a.strokeWidth || 2, color: rgb(col.r, col.g, col.b) })
        }
      } else if (a.type === 'ellipse') {
        const col = hexToRgb(a.color || '#f59e0b')
        // pdf-lib 没有直接椭圆 API，使用贝塞尔近似：这里简单用矩形边界画空心矩形代替（可后续改为 bezier）
        target.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, borderColor: rgb(col.r, col.g, col.b), borderWidth: 2 })
      } else if (a.type === 'polygon' && a.pts?.length) {
        const col = hexToRgb(a.color || '#f59e0b')
        for (let i=1;i<a.pts.length;i++) {
          const p0 = a.pts[i-1]
          const p1 = a.pts[i]
          target.drawLine({ start: { x: p0.x, y: p0.y }, end: { x: p1.x, y: p1.y }, thickness: a.strokeWidth || 2, color: rgb(col.r, col.g, col.b) })
        }
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
// === Eraser helpers ===
function renderEraserCursor(ev: MouseEvent) {
  const overlayDiv = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (!overlayDiv) return
  const rect = overlayDiv.getBoundingClientRect()
  const x = ev.clientX - rect.left
  const y = ev.clientY - rect.top
  let cur = document.getElementById('eraser-preview') as HTMLDivElement | null
  if (!cur) {
    cur = document.createElement('div')
    cur.id = 'eraser-preview'
    cur.style.position = 'absolute'
    cur.style.pointerEvents = 'none'
    cur.style.border = '1px solid rgba(239,68,68,0.9)'
    cur.style.borderRadius = '50%'
    cur.style.background = 'rgba(239,68,68,0.12)'
    overlayDiv.appendChild(cur)
  }
  const r = eraserRadius.value
  cur.style.left = `${x - r}px`
  cur.style.top = `${y - r}px`
  cur.style.width = `${r * 2}px`
  cur.style.height = `${r * 2}px`
}

function eraseAtEvent(ev: MouseEvent) {
  if (!lastViewport.value) return
  const overlayDiv = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (!overlayDiv) return
  const rect = overlayDiv.getBoundingClientRect()
  const ox = ev.clientX - rect.left
  const oy = ev.clientY - rect.top
  const m = getOverlayMetrics()
  if (!m) return
  const vp = overlayPointToViewportPoint(ox, oy)
  const pdfPt = lastViewport.value.convertToPdfPoint(vp.x, vp.y)
  const radiusPdf = (eraserRadius.value / m.sx) * (lastViewport.value.scale || 1)
  const list = annotations.value[pageNum.value] || []
  const removed: string[] = []
  for (const a of list) {
    if (erasedIdsThisDrag.has(a.id)) continue
    if (a.type === 'path' && a.pts && a.pts.length >= 2) {
      // 线/箭头/自由画：点到线段最短距离
      if (hitAnySegment(a.pts, { x: pdfPt[0], y: pdfPt[1] }, radiusPdf)) {
        removed.push(a.id)
      }
    } else if (a.type === 'polygon' && a.pts && a.pts.length >= 2) {
      if (hitAnySegment(a.pts, { x: pdfPt[0], y: pdfPt[1] }, radiusPdf)) {
        removed.push(a.id)
      }
    } else if (a.type === 'text') {
      const approxW = Math.max(10, (a.text?.length || 1) * (a.fontSize || 14) * 0.6)
      const approxH = (a.fontSize || 14)
      const rx = a.x
      const ry = a.y - approxH
      if (circleRectIntersect(pdfPt[0], pdfPt[1], radiusPdf, rx, ry, approxW, approxH)) {
        removed.push(a.id)
      }
    } else {
      // 矩形类（rect/highlight/mask/image/ellipse 以外接矩形近似）
      if (circleRectIntersect(pdfPt[0], pdfPt[1], radiusPdf, a.x, a.y, a.w || 0, a.h || 0)) {
        removed.push(a.id)
      }
    }
  }
  if (removed.length > 0) {
    const arr = annotations.value[pageNum.value]
    if (arr) {
      annotations.value[pageNum.value] = arr.filter(it => !removed.includes(it.id))
      removed.forEach(id => erasedIdsThisDrag.add(id))
      renderAnnotationsForCurrentPage(null as any)
    }
  }
}

function hitAnySegment(pts: Array<{ x: number; y: number }>, p: { x: number; y: number }, tol: number) {
  for (let i = 1; i < pts.length; i++) {
    const d = pointToSegmentDistance(p, pts[i - 1], pts[i])
    if (d <= tol) return true
  }
  return false
}
function pointToSegmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const wx = p.x - a.x
  const wy = p.y - a.y
  const c1 = vx * wx + vy * wy
  if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const c2 = vx * vx + vy * vy
  if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y)
  const t = c1 / c2
  const px = a.x + t * vx
  const py = a.y + t * vy
  return Math.hypot(p.x - px, p.y - py)
}
function circleRectIntersect(cx: number, cy: number, r: number, rx: number, ry: number, rw: number, rh: number) {
  const nearestX = Math.max(rx, Math.min(cx, rx + rw))
  const nearestY = Math.max(ry, Math.min(cy, ry + rh))
  const dx = cx - nearestX
  const dy = cy - nearestY
  return (dx * dx + dy * dy) <= r * r
}
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const parts = dataUrl.split(',')
  const base64 = parts[1] || ''
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// reserved helper for potential future precise conversions

function triggerPickImage() {
  const el = document.getElementById('img-file') as HTMLInputElement | null
  if (el) el.click()
}
function onPickImageFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    // 使用原始文件二进制生成 object URL，避免 base64 膨胀和质量损失
    const blob = new Blob([file], { type: file.type || 'image/*' })
    const src = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      // place to page center immediately
      if (!lastViewport.value) return
      const m = getOverlayMetrics()
      if (!m) return
      const centerOv = { x: m.rect.width / 2, y: m.rect.height / 2 }
      const vp = overlayPointToViewportPoint(centerOv.x, centerOv.y)
      const pdfPt = lastViewport.value.convertToPdfPoint(vp.x, vp.y)
      ensurePageArray(pageNum.value)
      const id = genId()
      const defaultW = Math.min(200, img.naturalWidth)
      const defaultH = Math.round(defaultW * (img.naturalHeight / img.naturalWidth))
      annotations.value[pageNum.value].push({
        id,
        page: pageNum.value,
        type: 'image',
        x: pdfPt[0],
        y: pdfPt[1],
        w: defaultW,
        h: defaultH,
        src,
        rotationDeg: 0,
      })
      selectedAnnoId.value = id
      toolMode.value = 'select'
      renderPage()
      scheduleAutoSave()
    }
    img.src = src
  }
  reader.readAsArrayBuffer(file)
  input.value = ''
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
  window.addEventListener('keydown', onKeyDownGlobal)
})

watch(toolMode, (mode) => {
  const anno = document.getElementById('anno-overlay') as HTMLDivElement | null
  const textLayer = document.getElementById('text-layer') as HTMLDivElement | null
  if (anno) {
    if (mode === 'textSelect') {
      // 选择：overlay 空白穿透，注释元素依然可交互
      anno.style.pointerEvents = 'none'
      anno.style.cursor = 'text'
      // 恢复子元素交互
      const nodes = anno.querySelectorAll<HTMLElement>('.anno, .resize-h, .del-btn')
      nodes.forEach(n => n.style.pointerEvents = 'auto')
    } else {
      // 其他工具：overlay 接管事件
      anno.style.pointerEvents = 'auto'
      anno.style.cursor = (mode === 'select') ? 'default' : (mode === 'eraser' ? 'none' : 'crosshair')
      if (mode === 'eraser') anno.classList.add('eraser'); else anno.classList.remove('eraser')
    }
  }
  if (textLayer) {
    // 文本选择工具：文本层可交互；其他工具禁用文本层
    textLayer.style.pointerEvents = (mode === 'textSelect') ? 'auto' : 'none'
    textLayer.style.userSelect = (mode === 'textSelect') ? 'text' : 'none'
  }
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

function movePageUp(thumbIndex: number) {
  if (!pdfDoc) return
  const fromVisual = thumbIndex
  const toVisual = Math.max(0, fromVisual - 1)
  if (fromVisual === toVisual) return
  // thumbnails 顺序已与 pageOrder 同步，因此可按可视索引交换 pageOrder
  const order = pageOrder.value.slice()
  const movingPage = order[fromVisual]
  order.splice(fromVisual, 1)
  order.splice(toVisual, 0, movingPage)
  pageOrder.value = order
  // 若当前显示页被移动，更新 pageNum 为同一实际页（不变）
  // 重建 thumbnails 顺序并刷新
  renderThumbnails()
  savePageOrderToStorage()
}
function movePageDown(thumbIndex: number) {
  if (!pdfDoc) return
  const fromVisual = thumbIndex
  const toVisual = Math.min(thumbnails.value.length - 1, fromVisual + 1)
  if (fromVisual === toVisual) return
  const order = pageOrder.value.slice()
  const movingPage = order[fromVisual]
  order.splice(fromVisual, 1)
  order.splice(toVisual, 0, movingPage)
  pageOrder.value = order
  renderThumbnails()
  savePageOrderToStorage()
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
  // 文本选择工具下：为避免占满整层的空白挡住文本层，把 overlay 置为 pointer-events:none，子元素保持可交互
  if (toolMode.value === 'textSelect') {
    overlay.style.pointerEvents = 'none'
    // 但让实际注释元素可交互
    const annoNodes = overlay.querySelectorAll<HTMLElement>('.anno, .resize-h, .del-btn')
    annoNodes.forEach(n => { n.style.pointerEvents = 'auto' })
  } else {
    overlay.style.pointerEvents = 'auto'
  }
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
// 保留备用：overlay 矩形转换为 PDF 矩形（导出或命中扩展时可用）
// function overlayRectToPdfRect(ox: number, oy: number, ow: number, oh: number): { x: number; y: number; w: number; h: number } {
//   const p1 = viewportToPdf(ox, oy)
//   const p2 = viewportToPdf(ox + ow, oy + oh)
//   const x = Math.min(p1.x, p2.x)
//   const y = Math.min(p1.y, p2.y)
//   const w = Math.abs(p2.x - p1.x)
//   const h = Math.abs(p2.y - p1.y)
//   return { x, y, w, h }
// }
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
      if (a.type === 'image') {
      const r = pdfRectToViewportRect(a)
      const img = document.createElement('img')
      img.src = a.src || ''
      img.style.position = 'absolute'
      img.style.left = `${r.x}px`
      img.style.top = `${r.y}px`
      img.style.width = `${r.w}px`
      img.style.height = `${r.h}px`
      const rot = a.rotationDeg || 0
      if (rot) img.style.transform = `rotate(${rot}deg)`
      img.draggable = false
      img.className = 'anno image'
      img.dataset.id = a.id
      // selection outline + handles
      if (selectedAnnoId.value === a.id) {
        const box = document.createElement('div')
        box.style.position = 'absolute'
        box.style.left = `${r.x}px`
        box.style.top = `${r.y}px`
        box.style.width = `${r.w}px`
        box.style.height = `${r.h}px`
        box.style.border = '1px dashed #3b82f6'
        box.style.pointerEvents = 'none'
        box.className = 'sel-box'
        box.dataset.id = a.id
        overlay.appendChild(box)
        ;['n','s','e','w','se'].forEach((pos) => {
          const handle = document.createElement('div')
          handle.className = `resize-h ${pos}`
          handle.style.position = 'absolute'
          const size = pos==='n'||pos==='s'||pos==='e'||pos==='w' ? 8 : 10
          handle.style.width = `${size}px`
          handle.style.height = `${size}px`
          handle.style.background = '#3b82f6'
          handle.style.borderRadius = '2px'
          handle.style.pointerEvents = 'auto'
          handle.style.zIndex = '10'
          if (pos==='se'){ handle.style.left = `${r.x + r.w - 5}px`; handle.style.top = `${r.y + r.h - 5}px`; handle.style.cursor = 'nwse-resize' }
          if (pos==='n'){ handle.style.left = `${r.x + r.w/2 - 4}px`; handle.style.top = `${r.y - 4}px`; handle.style.cursor = 'ns-resize' }
          if (pos==='s'){ handle.style.left = `${r.x + r.w/2 - 4}px`; handle.style.top = `${r.y + r.h - 4}px`; handle.style.cursor = 'ns-resize' }
          if (pos==='e'){ handle.style.left = `${r.x + r.w - 4}px`; handle.style.top = `${r.y + r.h/2 - 4}px`; handle.style.cursor = 'ew-resize' }
          if (pos==='w'){ handle.style.left = `${r.x - 4}px`; handle.style.top = `${r.y + r.h/2 - 4}px`; handle.style.cursor = 'ew-resize' }
          handle.style.zIndex = '15'
          handle.dataset.id = a.id
          handle.addEventListener('mousedown', (ev) => {
            ev.stopPropagation()
            selectedAnnoId.value = a.id
            resizingHandle = pos as any
            resizingStartRect = { x: a.x, y: a.y, w: a.w, h: a.h }
            // 记录开始时 overlay 坐标与把手起点（用于与鼠标位移一比一）
            const ovEl = document.getElementById('anno-overlay') as HTMLDivElement | null
            const ob = ovEl?.getBoundingClientRect()
            const startHx = ob ? ev.clientX - ob.left : (r.x + r.w)
            const startHy = ob ? ev.clientY - ob.top : (r.y + r.h)
            resizingStartOverlay = { x: r.x, y: r.y, w: r.w, h: r.h, hx: startHx, hy: startHy }
          })
          overlay.appendChild(handle)
        })
        // delete button (右上角)
        const del = document.createElement('div')
        del.style.position = 'absolute'
        del.style.left = `${r.x + r.w - 12}px`
        del.style.top = `${r.y - 12}px`
        del.style.width = '20px'
        del.style.height = '20px'
        del.style.background = 'rgba(239,68,68,0.9)'
        del.style.color = '#fff'
        del.style.borderRadius = '50%'
        del.style.display = 'grid'
        del.style.placeItems = 'center'
        del.style.cursor = 'pointer'
        del.style.zIndex = '20'
        del.style.pointerEvents = 'auto'
        del.textContent = '×'
        del.className = 'del-btn'
        del.dataset.id = a.id
        del.addEventListener('mousedown', (ev) => {
          ev.stopPropagation()
          const list = annotations.value[pageNum.value] || []
          const idx = list.findIndex(i => i.id === a.id)
          if (idx >= 0) { snapshot(); list.splice(idx,1); selectedAnnoId.value=null; renderAnnotationsForCurrentPage(null as any); scheduleAutoSave() }
        })
        overlay.appendChild(del)
      }
      overlay.appendChild(img)
      continue
    }
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
      } else if (a.type === 'mask') {
        div.style.border = 'none'
        div.style.background = a.color || '#ffffff'
      } else if (a.type === 'ellipse') {
        div.style.border = `2px solid ${a.color || '#f59e0b'}`
        div.style.borderRadius = '50%'
        div.style.background = 'transparent'
      }
      } else {
      // text: first render after creation uses stored viewport anchor to avoid timing drift
      let vx: number, vy: number
      const fontPx = (a.fontSize || 14) * (scale.value)
      // 若存在覆盖生成时记录的原始 overlay 高度，按其近似还原字号
      const inferred = (a as any)._oh ? Math.max(8, ((a as any)._oh) / (scale.value || 1)) : null
      const finalFontPx = inferred || fontPx
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
      div.style.fontSize = `${finalFontPx}px`
      div.textContent = a.text || ''
      // debug logs removed
      div.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        startEditAnnotation(a.id)
      })
    }
    // 绘图路径渲染（使用 SVG）
    if (a.type === 'path' && a.pts?.length) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '100%')
      svg.setAttribute('height', '100%')
      svg.style.position = 'absolute'
      svg.style.left = '0'
      svg.style.top = '0'
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const d = a.pts.map((p, i) => {
        const v = lastViewport.value!.convertToViewportPoint(p.x, p.y)
        const ov = viewportPointToOverlayPoint(v[0], v[1])
        return `${i===0?'M':'L'} ${ov.x} ${ov.y}`
      }).join(' ')
      path.setAttribute('d', d)
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', a.color || strokeColor.value)
      path.setAttribute('stroke-width', String(a.strokeWidth || 2))
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
      // 如果是箭头工具绘制的路径，在终点添加箭头头部（两条短线）
      if ((a as any)._tool === 'arrow' && a.pts.length >= 2) {
        const p0 = a.pts[a.pts.length - 2]
        const p1 = a.pts[a.pts.length - 1]
        const v0 = lastViewport.value!.convertToViewportPoint(p0.x, p0.y)
        const v1 = lastViewport.value!.convertToViewportPoint(p1.x, p1.y)
        const o0 = viewportPointToOverlayPoint(v0[0], v0[1])
        const o1 = viewportPointToOverlayPoint(v1[0], v1[1])
        const angle = Math.atan2(o1.y - o0.y, o1.x - o0.x)
        const headSize = Math.max(6, (a.strokeWidth || 2) * 3)
        const leftPt = {
          x: o1.x - headSize * Math.cos(angle - Math.PI / 6),
          y: o1.y - headSize * Math.sin(angle - Math.PI / 6),
        }
        const rightPt = {
          x: o1.x - headSize * Math.cos(angle + Math.PI / 6),
          y: o1.y - headSize * Math.sin(angle + Math.PI / 6),
        }
        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        line1.setAttribute('x1', String(o1.x))
        line1.setAttribute('y1', String(o1.y))
        line1.setAttribute('x2', String(leftPt.x))
        line1.setAttribute('y2', String(leftPt.y))
        line1.setAttribute('stroke', a.color || strokeColor.value)
        line1.setAttribute('stroke-width', String(a.strokeWidth || 2))
        line1.setAttribute('stroke-linecap', 'round')
        const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        line2.setAttribute('x1', String(o1.x))
        line2.setAttribute('y1', String(o1.y))
        line2.setAttribute('x2', String(rightPt.x))
        line2.setAttribute('y2', String(rightPt.y))
        line2.setAttribute('stroke', a.color || strokeColor.value)
        line2.setAttribute('stroke-width', String(a.strokeWidth || 2))
        line2.setAttribute('stroke-linecap', 'round')
        svg.appendChild(line1)
        svg.appendChild(line2)
      }
      overlay.appendChild(svg)
      continue
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
  if (toolMode.value === 'textSelect') {
    // 文本选择模式：不处理注释交互，交给文本层
    return
  }
  if (toolMode.value === 'eraser') {
    isErasing = true
    erasedIdsThisDrag = new Set<string>()
    renderEraserCursor(ev)
    eraseAtEvent(ev)
    return
  }
  if (toolMode.value === 'select') {
    if (target.classList.contains('anno')) {
      const id = target.dataset.id || null
      const isShift = (ev as MouseEvent).shiftKey
      draggingAnnoId = id
      resizingHandle = null
      rotating = false
      if (!isShift) {
        selectedAnnoIds.value = id ? [id] : []
        selectedAnnoId.value = id
      } else if (id) {
        if (selectedAnnoIds.value.includes(id)) {
          selectedAnnoIds.value = selectedAnnoIds.value.filter(i => i !== id)
        } else {
          selectedAnnoIds.value = [...selectedAnnoIds.value, id]
        }
        selectedAnnoId.value = selectedAnnoIds.value[0] || null
      }
      if (selectedAnnoIds.value.length > 0) {
        draggingStartPdf = pdf
        draggingOriginsById = {}
        const list = annotations.value[pageNum.value] || []
        selectedAnnoIds.value.forEach(selId => {
          const a = list.find(i => i.id === selId)
          if (a) draggingOriginsById[selId] = { x: a.x, y: a.y }
        })
      }
    } else {
      // 空白处：开始框选以便多选编辑
      isBoxSelecting = true
      const vp = overlayPointToViewportPoint(x, y)
      const ov = viewportPointToOverlayPoint(vp.x, vp.y)
      boxSelectStart = { x: ov.x, y: ov.y }
      const overlayDiv = document.getElementById('anno-overlay') as HTMLDivElement | null
      if (overlayDiv && !document.getElementById('box-select')) {
        const el = document.createElement('div')
        el.id = 'box-select'
        el.style.position = 'absolute'
        el.style.border = '1px dashed #10b981'
        el.style.background = 'rgba(16,185,129,0.15)'
        overlayDiv.appendChild(el)
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
  if (toolMode.value === 'draw') {
    // 开始记录路径（overlay 坐标）
    drawingPathPts = []
    const ovPt = { x, y }
    drawingPathPts.push(ovPt)
    // 创建一个临时 SVG 覆盖层用于预览
    const overlayDiv = document.getElementById('anno-overlay') as HTMLDivElement | null
    if (overlayDiv && !document.getElementById('path-preview')) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('id', 'path-preview')
      svg.setAttribute('width', overlayDiv.style.width || '100%')
      svg.setAttribute('height', overlayDiv.style.height || '100%')
      svg.style.position = 'absolute'
      svg.style.left = '0'
      svg.style.top = '0'
      svg.style.pointerEvents = 'none'
      overlayDiv.appendChild(svg)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('id', 'path-preview-d')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', strokeColor.value)
      path.setAttribute('stroke-width', String(drawWidth.value))
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      path.setAttribute('d', `M ${ovPt.x} ${ovPt.y}`)
      svg.appendChild(path)
    }
    // 绑定全局监听，保证路径连续
    const overlayDiv2 = document.getElementById('anno-overlay') as HTMLDivElement | null
    if (overlayDiv2) {
      const hostRect = overlayDiv2.getBoundingClientRect()
      drawMoveListener = (ev2: MouseEvent) => {
        if (!drawingPathPts) return
        const px = ev2.clientX - hostRect.left
        const py = ev2.clientY - hostRect.top
        drawingPathPts.push({ x: px, y: py })
        const path = document.getElementById('path-preview-d') as SVGPathElement | null
        if (path) {
          const d = path.getAttribute('d') || ''
          path.setAttribute('d', `${d} L ${px} ${py}`)
        }
      }
      drawUpListener = (ev2: MouseEvent) => {
        window.removeEventListener('mousemove', drawMoveListener!)
        window.removeEventListener('mouseup', drawUpListener!)
        // 触发 overlay 的 mouseup 逻辑收尾
        const evt = new MouseEvent('mouseup', ev2)
        overlayDiv2.dispatchEvent(evt)
      }
      window.addEventListener('mousemove', drawMoveListener)
      window.addEventListener('mouseup', drawUpListener)
    }
    return
  }
  if (toolMode.value === 'polygon') {
    // 多边形：单击添加点，双击结束
    if (!drawingPathPts) drawingPathPts = []
    drawingPathPts.push({ x, y })
    const overlayDiv = document.getElementById('anno-overlay') as HTMLDivElement | null
    if (overlayDiv) {
      let svg = document.getElementById('poly-preview') as SVGSVGElement | null
      if (!svg) {
        const created = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
        created.setAttribute('id', 'poly-preview')
        created.setAttribute('width', overlayDiv.style.width || '100%')
        created.setAttribute('height', overlayDiv.style.height || '100%')
        created.style.position = 'absolute'; created.style.left='0'; created.style.top='0'; created.style.pointerEvents='none'
        overlayDiv.appendChild(created)
        polygonDblListener = () => {
          if (!drawingPathPts || drawingPathPts.length < 3) return
          const ptsPdf = drawingPathPts.map(p => {
            const vp = overlayPointToViewportPoint(p.x, p.y)
            const pdf = lastViewport.value!.convertToPdfPoint(vp.x, vp.y)
            return { x: pdf[0], y: pdf[1] }
          })
          ensurePageArray(pageNum.value)
          annotations.value[pageNum.value].push({ id: genId(), page: pageNum.value, type: 'polygon', x:0,y:0,w:0,h:0, color: strokeColor.value, pts: ptsPdf, strokeWidth: 2 })
          const pv = document.getElementById('poly-preview')
          if (pv?.parentElement) pv.parentElement.removeChild(pv)
          drawingPathPts = null
          snapshot(); renderAnnotationsForCurrentPage(null as any); scheduleAutoSave()
        }
        created.addEventListener('dblclick', polygonDblListener)
        svg = created
      }
      let poly = document.getElementById('poly-preview-p') as SVGPolylineElement | null
      if (!poly) {
        poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline') as SVGPolylineElement
        poly.setAttribute('id', 'poly-preview-p')
        poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', strokeColor.value); poly.setAttribute('stroke-width', String(2))
        ;(svg as SVGSVGElement).appendChild(poly)
      }
      const ptsAttr = drawingPathPts.map(p => `${p.x},${p.y}`).join(' ')
      ;(poly as SVGPolylineElement).setAttribute('points', ptsAttr)
    }
    return
  }
  if (toolMode.value === 'image' && pendingImage.value) {
    ensurePageArray(pageNum.value)
    const id = genId()
    const img = pendingImage.value
    const defaultW = Math.min(200, img.naturalWidth)
    const defaultH = Math.round(defaultW * (img.naturalHeight / img.naturalWidth))
    const anno: Annotation = {
      id,
      page: pageNum.value,
      type: 'image',
      x: pdf.x,
      y: pdf.y,
      w: defaultW,
      h: defaultH,
      src: img.src,
    }
    annotations.value[pageNum.value].push(anno)
    pendingImage.value = null
    renderPage()
    return
  }
  // 非绘制工具下不应开始新绘制，仅在对应工具才进入绘制态
  if (toolMode.value === 'highlight' || toolMode.value === 'rect' || toolMode.value === 'ellipse' || toolMode.value === 'line' || toolMode.value === 'arrow') {
    isDrawing.value = true
    drawingStartPdf = pdf
    console.log('[shape:start]', { tool: toolMode.value, startPdf: drawingStartPdf })
  }
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
  // 橡皮擦：移动时更新预览并清除命中
  if (toolMode.value === 'eraser') {
    renderEraserCursor(ev)
    if (isErasing) {
      eraseAtEvent(ev)
    }
    return
  }
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
  if (draggingAnnoId && draggingStartPdf && Object.keys(draggingOriginsById).length > 0) {
    const dx = pdf.x - draggingStartPdf.x
    const dy = pdf.y - draggingStartPdf.y
    const list = annotations.value[pageNum.value] || []
    selectedAnnoIds.value.forEach(id => {
      const a = list.find(i => i.id === id)
      const origin = draggingOriginsById[id]
      if (a && origin) {
        a.x = origin.x + dx
        a.y = origin.y + dy
        if (a.type === 'text') { a.vx = undefined; a.vy = undefined }
      }
    })
    renderAnnotationsForCurrentPage(null as any)
    scheduleAutoSave()
    return
  }
  // resizing image
  if (resizingHandle && resizingStartOverlay && resizingStartRect) {
    const list = annotations.value[pageNum.value] || []
    const a = list.find(i => i.id === selectedAnnoId.value)
    if (a && a.type === 'image') {
      // 使用 overlay 坐标系进行计算，避免 Y 轴方向混淆
      const overlay = ev.currentTarget as HTMLElement
      const bounds = overlay.getBoundingClientRect()
      const curX = ev.clientX - bounds.left
      const curY = ev.clientY - bounds.top
      const dxPx = curX - resizingStartOverlay.hx
      const dyPx = curY - resizingStartOverlay.hy
      const m = getOverlayMetrics()
      if (!m) return
      // 起始矩形（overlay 坐标）
      const r0 = pdfRectToViewportRect(resizingStartRect)
      let left = r0.x
      let top = r0.y
      let width = r0.w
      let height = r0.h
      if (resizingHandle === 'se') {
        width = Math.max(10, r0.w + dxPx)
        height = Math.max(10, r0.h + dyPx)
      } else if (resizingHandle === 'e') {
        width = Math.max(10, r0.w + dxPx)
      } else if (resizingHandle === 's') {
        height = Math.max(10, r0.h + dyPx)
      } else if (resizingHandle === 'n') {
        const newTop = r0.y + dyPx
        const newHeight = Math.max(10, r0.h - dyPx)
        top = newTop
        height = newHeight
      } else if (resizingHandle === 'w') {
        const newLeft = r0.x + dxPx
        const newWidth = Math.max(10, r0.w - dxPx)
        left = newLeft
        width = newWidth
      }
      const right = left + width
      const bottom = top + height
      // overlay -> viewport
      const vLeft = left / m.sx
      const vTop = top / m.sy
      const vRight = right / m.sx
      const vBottom = bottom / m.sy
      // viewport -> pdf
      const p1 = lastViewport.value.convertToPdfPoint(vLeft, vTop)
      const p2 = lastViewport.value.convertToPdfPoint(vRight, vBottom)
      const px1 = p1[0], py1 = p1[1]
      const px2 = p2[0], py2 = p2[1]
      a.x = Math.min(px1, px2)
      a.y = Math.min(py1, py2)
      a.w = Math.max(10, Math.abs(px2 - px1))
      a.h = Math.max(10, Math.abs(py2 - py1))
      // 局部更新：仅更新选中图片与辅助 UI，避免整层闪烁
      const ov = document.getElementById('anno-overlay') as HTMLDivElement | null
      if (ov) {
        const imgEl = Array.from(ov.querySelectorAll('img.anno.image')).find(el => (el as HTMLElement).dataset.id === a.id)
        if (imgEl) {
          const rUpd = pdfRectToViewportRect(a)
          ;(imgEl as HTMLElement).style.left = `${rUpd.x}px`
          ;(imgEl as HTMLElement).style.top = `${rUpd.y}px`
          ;(imgEl as HTMLElement).style.width = `${rUpd.w}px`
          ;(imgEl as HTMLElement).style.height = `${rUpd.h}px`
        } else {
          renderAnnotationsForCurrentPage(null as any)
        }
        const box = ov.querySelector('div.sel-box') as HTMLDivElement | null
        if (box) {
          const rUpd = pdfRectToViewportRect(a)
          box.style.left = `${rUpd.x}px`
          box.style.top = `${rUpd.y}px`
          box.style.width = `${rUpd.w}px`
          box.style.height = `${rUpd.h}px`
        }
        const rUpdAll = pdfRectToViewportRect(a)
        const handles = Array.from(ov.querySelectorAll('div.resize-h')).filter(el => (el as HTMLElement).dataset.id === a.id) as HTMLDivElement[]
        if (handles.length) {
          handles.forEach((h) => {
            if (h.classList.contains('se')) {
              h.style.left = `${rUpdAll.x + rUpdAll.w - 5}px`
              h.style.top = `${rUpdAll.y + rUpdAll.h - 5}px`
            } else if (h.classList.contains('n')) {
              h.style.left = `${rUpdAll.x + rUpdAll.w/2 - 4}px`
              h.style.top = `${rUpdAll.y - 4}px`
            } else if (h.classList.contains('s')) {
              h.style.left = `${rUpdAll.x + rUpdAll.w/2 - 4}px`
              h.style.top = `${rUpdAll.y + rUpdAll.h - 4}px`
            } else if (h.classList.contains('e')) {
              h.style.left = `${rUpdAll.x + rUpdAll.w - 4}px`
              h.style.top = `${rUpdAll.y + rUpdAll.h/2 - 4}px`
            } else if (h.classList.contains('w')) {
              h.style.left = `${rUpdAll.x - 4}px`
              h.style.top = `${rUpdAll.y + rUpdAll.h/2 - 4}px`
            }
          })
        }
        const delBtn = ov.querySelector('div.del-btn') as HTMLDivElement | null
        if (delBtn) {
          const rUpd = pdfRectToViewportRect(a)
          delBtn.style.left = `${rUpd.x + rUpd.w - 12}px`
          delBtn.style.top = `${rUpd.y - 12}px`
        }
      } else {
        renderAnnotationsForCurrentPage(null as any)
      }
    }
    return
  }
  // rotating image
  if (rotating && rotateCenterOverlay) {
    const overlay = ev.currentTarget as HTMLElement
    const bounds = overlay.getBoundingClientRect()
    const cx = rotateCenterOverlay.x + bounds.left
    const cy = rotateCenterOverlay.y + bounds.top
    const dx = ev.clientX - cx
    const dy = ev.clientY - cy
    const ang = Math.atan2(dy, dx) - rotateStartAngle
    const deg = Math.round((ang * 180 / Math.PI))
    const list = annotations.value[pageNum.value] || []
    const a = list.find(i => i.id === selectedAnnoId.value)
    if (a && a.type === 'image') {
      a.rotationDeg = deg
      renderAnnotationsForCurrentPage(null as any)
    }
    return
  }
  if (!isDrawing.value || !drawingStartPdf || !(toolMode.value === 'highlight' || toolMode.value === 'rect' || toolMode.value === 'ellipse' || toolMode.value === 'line' || toolMode.value === 'arrow')) return
  // draw preview by updating a temp element
  const temp = document.getElementById('anno-preview') as HTMLDivElement | null
  const overlayDiv = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (!overlayDiv) return
  // 箭头/直线预览：在 overlay 上画一条预览线（避免只显示虚框）
  const ensureLinePreview = () => {
    let svg = document.getElementById('line-preview') as SVGSVGElement | null
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
      svg.setAttribute('id', 'line-preview')
      svg.setAttribute('width', overlayDiv!.style.width || '100%')
      svg.setAttribute('height', overlayDiv!.style.height || '100%')
      svg.style.position = 'absolute'
      svg.style.left = '0'
      svg.style.top = '0'
      svg.style.pointerEvents = 'none'
      overlayDiv!.appendChild(svg)
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('id', 'line-preview-main')
      line.setAttribute('stroke', strokeColor.value)
      line.setAttribute('stroke-width', '2')
      line.setAttribute('stroke-linecap', 'round')
      svg.appendChild(line)
      const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line'); l1.setAttribute('id', 'line-preview-head-1'); l1.setAttribute('stroke', strokeColor.value); l1.setAttribute('stroke-width', '2'); l1.setAttribute('stroke-linecap', 'round'); svg.appendChild(l1)
      const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line'); l2.setAttribute('id', 'line-preview-head-2'); l2.setAttribute('stroke', strokeColor.value); l2.setAttribute('stroke-width', '2'); l2.setAttribute('stroke-linecap', 'round'); svg.appendChild(l2)
    }
    return svg
  }
  if (isBoxSelecting && boxSelectStart) {
    const el = document.getElementById('box-select') as HTMLDivElement | null
    const vp = overlayPointToViewportPoint(x, y)
    const ov = viewportPointToOverlayPoint(vp.x, vp.y)
    const rx = Math.min(boxSelectStart.x, ov.x)
    const ry = Math.min(boxSelectStart.y, ov.y)
    const rw = Math.abs(ov.x - boxSelectStart.x)
    const rh = Math.abs(ov.y - boxSelectStart.y)
    if (el) {
      el.style.left = `${rx}px`
      el.style.top = `${ry}px`
      el.style.width = `${rw}px`
      el.style.height = `${rh}px`
    }
  }
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
  if (toolMode.value === 'line' || toolMode.value === 'arrow') {
    // 直线无需虚线辅助，隐藏预览框
    el.style.display = 'none'
    const svg = ensureLinePreview()
    if (svg) {
      const main = document.getElementById('line-preview-main') as SVGLineElement | null
      if (main) {
        main.setAttribute('x1', String(startV[0]))
        main.setAttribute('y1', String(startV[1]))
        main.setAttribute('x2', String(curV[0]))
        main.setAttribute('y2', String(curV[1]))
      }
      // 箭头头部
      const h1 = document.getElementById('line-preview-head-1') as SVGLineElement | null
      const h2 = document.getElementById('line-preview-head-2') as SVGLineElement | null
      if (toolMode.value === 'arrow' && h1 && h2) {
        const angle = Math.atan2(curV[1] - startV[1], curV[0] - startV[0])
        const headSize = 12
        const left = { x: curV[0] - headSize * Math.cos(angle - Math.PI/6), y: curV[1] - headSize * Math.sin(angle - Math.PI/6) }
        const right = { x: curV[0] - headSize * Math.cos(angle + Math.PI/6), y: curV[1] - headSize * Math.sin(angle + Math.PI/6) }
        h1.setAttribute('x1', String(curV[0])); h1.setAttribute('y1', String(curV[1]))
        h1.setAttribute('x2', String(left.x)); h1.setAttribute('y2', String(left.y))
        h2.setAttribute('x1', String(curV[0])); h2.setAttribute('y1', String(curV[1]))
        h2.setAttribute('x2', String(right.x)); h2.setAttribute('y2', String(right.y))
        h1.style.display = ''
        h2.style.display = ''
      } else {
        if (h1) h1.style.display = 'none'
        if (h2) h2.style.display = 'none'
      }
    }
  } else {
    el.style.border = '1px dashed #3b82f6'
    el.style.background = toolMode.value === 'highlight' ? 'rgba(250, 204, 21, 0.25)' : 'transparent'
    if (toolMode.value === 'ellipse') {
      el.style.borderRadius = '50%'
    } else {
      el.style.borderRadius = '0'
    }
  }
}
function onAnnoMouseUp(ev: MouseEvent) {
  if (!lastViewport.value) return
  if (isBoxSelecting) {
    const overlayDiv = document.getElementById('anno-overlay') as HTMLDivElement | null
    const el = document.getElementById('box-select')
    if (overlayDiv && el && boxSelectStart) {
      overlayDiv.removeChild(el)
      // 计算选择范围（overlay 坐标）
      const rect = el.getBoundingClientRect()
      const host = overlayDiv.getBoundingClientRect()
      const rx = rect.left - host.left
      const ry = rect.top - host.top
      const rw = rect.width
      const rh = rect.height
      // 命中测试
      const list = annotations.value[pageNum.value] || []
      const hit: string[] = []
      list.forEach(a => {
        const r = pdfRectToViewportRect(a)
        const overlap = !(r.x + r.w < rx || r.x > rx + rw || r.y + r.h < ry || r.y > ry + rh)
        if (overlap) hit.push(a.id)
      })
      selectedAnnoIds.value = hit
      selectedAnnoId.value = hit[0] || null
    }
    isBoxSelecting = false
    boxSelectStart = null
    snapshot()
    return
  }
  if (draggingAnnoId) {
    draggingAnnoId = null
    draggingStartPdf = null
    draggingOriginsById = {}
    snapshot()
    return
  }
  if (resizingHandle) {
    resizingHandle = null
    resizingStartRect = null
    resizingStartOverlay = null
    snapshot()
    scheduleAutoSave()
    return
  }
  if (rotating) {
    rotating = false
    rotateCenterOverlay = null
    snapshot()
    scheduleAutoSave()
    return
  }
  // 橡皮擦结束
  if (toolMode.value === 'eraser') {
    isErasing = false
    const cur = document.getElementById('eraser-preview')
    if (cur?.parentElement) cur.parentElement.removeChild(cur)
    if (erasedIdsThisDrag.size > 0) { snapshot(); scheduleAutoSave() }
    return
  }
  if (toolMode.value === 'polygon' && drawingPathPts) {
    // 右键或 Esc 取消
    // 在此不收尾，双击 poly svg 已处理提交
    return
  }
  if (toolMode.value === 'draw' && drawingPathPts) {
    // 结束绘制：关闭预览并保存
    if (drawMoveListener) window.removeEventListener('mousemove', drawMoveListener)
    if (drawUpListener) window.removeEventListener('mouseup', drawUpListener)
    drawMoveListener = null
    drawUpListener = null
    const overlay = ev.currentTarget as HTMLElement
    const bounds = overlay.getBoundingClientRect()
    const canvasRect = canvasRef.value?.getBoundingClientRect()
    const baseLeft = canvasRect ? canvasRect.left : bounds.left
    const baseTop = canvasRect ? canvasRect.top : bounds.top
    const ptOverlay = { x: ev.clientX - baseLeft, y: ev.clientY - baseTop }
    drawingPathPts.push(ptOverlay)
    const prev = document.getElementById('path-preview')
    if (prev?.parentElement) prev.parentElement.removeChild(prev)
    const m = getOverlayMetrics()
    if (m) {
      ensurePageArray(pageNum.value)
      const id = genId()
      const ptsPdf = drawingPathPts.map(p => {
        const vp = overlayPointToViewportPoint(p.x, p.y)
        const pdf = lastViewport.value!.convertToPdfPoint(vp.x, vp.y)
        return { x: pdf[0], y: pdf[1] }
      })
      annotations.value[pageNum.value].push({ id, page: pageNum.value, type: 'path', x:0,y:0,w:0,h:0, color: strokeColor.value, strokeWidth: drawWidth.value, pts: ptsPdf })
      snapshot()
      drawingPathPts = null
      renderAnnotationsForCurrentPage(null as any)
      scheduleAutoSave()
    }
    return
  }
  if (toolMode.value === 'polygon' && drawingPathPts) {
    // 移动时更新最后一个点为当前鼠标位置（仅用于预览）
    const poly = document.getElementById('poly-preview-p') as SVGPolylineElement | null
    if (poly && drawingPathPts.length) {
      const overlay = ev.currentTarget as HTMLElement
      const bounds = overlay.getBoundingClientRect()
      const canvasRect = canvasRef.value?.getBoundingClientRect()
      const baseLeft = canvasRect ? canvasRect.left : bounds.left
      const baseTop = canvasRect ? canvasRect.top : bounds.top
      const ox = ev.clientX - baseLeft
      const oy = ev.clientY - baseTop
      const tempPts = drawingPathPts.concat([{ x: ox, y: oy }])
      poly.setAttribute('points', tempPts.map(p => `${p.x},${p.y}`).join(' '))
    }
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
  let type: AnnotationType = 'rect'
  if (toolMode.value === 'highlight') type = 'highlight'
  else if (toolMode.value === 'ellipse') type = 'ellipse'
  else if (toolMode.value === 'rect') type = 'rect'
  else if (toolMode.value === 'line') type = 'line'
  else if (toolMode.value === 'arrow') type = 'arrow'
  if (type !== 'line' && (w < 1 || h < 1)) return
  ensurePageArray(pageNum.value)
  snapshot()
  if (type === 'line' || type === 'arrow') {
    // 直线存储为 path，两点
    annotations.value[pageNum.value].push({
      id: genId(),
      page: pageNum.value,
      type: 'path', // 箭头也先存为路径，两点，渲染/导出加箭头头部
      x: 0, y: 0, w: 0, h: 0,
      color: strokeColor.value,
      strokeWidth: 2,
      pts: [ { x: drawingStartPdf.x, y: drawingStartPdf.y }, { x: endPdf.x, y: endPdf.y } ],
      // 标记来源工具
      _tool: type,
    })
  } else {
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
  }
  // remove preview
  const temp = document.getElementById('anno-preview')
  if (temp?.parentElement) temp.parentElement.removeChild(temp)
  const linePrev = document.getElementById('line-preview')
  if (linePrev?.parentElement) linePrev.parentElement.removeChild(linePrev)
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
  // 若已有编辑器，先移除，避免出现多个输入框
  const existed = document.getElementById('anno-editor') as HTMLTextAreaElement | null
  if (existed && existed.parentElement) existed.parentElement.removeChild(existed)
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
  // 编辑期间隐藏原来的文本展示节点，避免与输入框重叠
  const textNode = overlay.querySelector(`.anno.text[data-id="${id}"]`) as HTMLElement | null
  if (textNode) textNode.style.display = 'none'
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
  // 切换到编辑选择工具并聚焦输入框
  toolMode.value = 'select'
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
  // 仅重绘注释层避免 PDF 重渲；并确保文本层被禁用，避免仍是文本光标
  renderAnnotationsForCurrentPage(null as any)
  // 恢复原文本节点可见
  const ov = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (ov && a) {
    const node = ov.querySelector(`.anno.text[data-id="${a.id}"]`) as HTMLElement | null
    if (node) node.style.display = ''
  }
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
  renderAnnotationsForCurrentPage(null as any)
  // 恢复原文本节点可见
  const ov = document.getElementById('anno-overlay') as HTMLDivElement | null
  if (ov) {
    const node = ov.querySelector(`.anno.text[data-id]`) as HTMLElement | null
    if (node) node.style.display = ''
  }
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

function onKeyDownGlobal(e: KeyboardEvent) {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const ids = selectedAnnoIds.value.length ? selectedAnnoIds.value : (selectedAnnoId.value ? [selectedAnnoId.value] : [])
    if (!ids.length) return
    const list = annotations.value[pageNum.value] || []
    e.preventDefault()
    snapshot()
    ids.forEach(id => {
      const idx = list.findIndex(i => i.id === id)
      if (idx >= 0) list.splice(idx, 1)
    })
    selectedAnnoIds.value = []
    selectedAnnoId.value = null
    renderAnnotationsForCurrentPage(null as any)
    scheduleAutoSave()
  }
}

// 页面顺序：元素为实际页码（1..numPages）。pageNum 始终表示"实际页码"。
const pageOrder = ref<number[]>([])
const currentVisualIndex = computed(() => {
  const idx = pageOrder.value.indexOf(pageNum.value)
  return idx >= 0 ? (idx + 1) : pageNum.value
})

async function loadPageOrderFromStorage() {
  try {
    if (!currentDocKey) return
    const raw = localStorage.getItem('pdf-pageOrder:' + currentDocKey)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length === numPages.value && arr.every((n: any) => Number.isInteger(n))) {
        pageOrder.value = arr as number[]
      }
    }
  } catch {}
}
function savePageOrderToStorage() {
  try {
    if (!currentDocKey) return
    localStorage.setItem('pdf-pageOrder:' + currentDocKey, JSON.stringify(pageOrder.value))
  } catch {}
}
</script>

<template>
  <div class="viewer">
    <div class="toolbar">
      <input ref="fileInputRef" type="file" accept="application/pdf" @change="onFileChange" />
      <div class="sep" />
      <button @click="prevPage">上一页</button>
      <span>{{ currentVisualIndex }} / {{ numPages }}</span>
      <button @click="nextPage">下一页</button>
      <input style="width:80px" type="number" :max="numPages" :min="1" :value="currentVisualIndex" @change="onChangePage" />
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
        <option value="textSelect">文本选择</option>
        <option value="select">编辑选择</option>
        <option value="text">文本</option>
        <option value="highlight">高亮矩形</option>
        <option value="rect">矩形</option>
        <option value="ellipse">椭圆</option>
        <option value="line">直线</option>
        <option value="arrow">箭头</option>
        <option value="polygon">多边形</option>
        <option value="draw">绘图</option>
        <option value="eraser">橡皮擦</option>
      </select>
      <template v-if="toolMode==='draw'">
        <input style="width:60px" type="number" min="1" max="20" v-model.number="drawWidth" title="画笔粗细" />
      </template>
      <template v-if="toolMode==='eraser'">
        <label>半径</label>
        <input style="width:60px" type="number" min="6" max="48" v-model.number="eraserRadius" title="橡皮擦半径(px)" />
      </template>
      
      <input type="color" v-model="strokeColor" title="颜色" />
      <label>字体:</label>
      <input style="width:60px" type="number" v-model.number="textFontSize" min="8" max="72" />
      <button @click="undo">撤销</button>
      <button @click="clearAllEdits">重做</button>
      <div class="sep" />
      <button @click="exportPdf">导出PDF</button>
      <div class="sep" />
      <input id="img-file" type="file" accept="image/*" style="display:none" @change="onPickImageFile" />
      <button @click="triggerPickImage">添加图片</button>
      <button @click="exportPdfServer">服务端导出</button>
      <button @click="saveAnnotationsJson">导出JSON</button>
      <button @click="triggerImportJson">导入JSON</button>
      <input id="import-json" type="file" accept="application/json" style="display:none" @change="onImportJsonFile" />
    </div>
    <div class="content">
      <aside class="sidebar">
        <div class="thumbs">
          <div v-for="(t, idx) in thumbnails" :key="t.page" class="thumb" :class="{active: t.page===pageNum}" @click="jumpTo(t.page)">
            <img :src="t.dataUrl" :alt="'p'+t.page" />
            <span>{{ t.page }}</span>
            <div style="display:flex; gap:4px; margin-top:4px;">
              <button @click.stop="movePageUp(idx)" :disabled="idx===0">上移</button>
              <button @click.stop="movePageDown(idx)" :disabled="idx===thumbnails.length-1">下移</button>
            </div>
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
  .anno-overlay.eraser { cursor: none; }
.anno { position: absolute; }
/* 显示手工文本层的文本选中高亮 */
#text-layer ::selection { background: rgba(59,130,246,0.35); }
.anno#anno-editor { position: absolute; }
.anno.text { pointer-events: auto; user-select: none; background: transparent; }
.anno.rect { background: transparent; }
.anno.preview { pointer-events: none; }
.error { color: #c62828; padding: 8px 12px; }
</style>


