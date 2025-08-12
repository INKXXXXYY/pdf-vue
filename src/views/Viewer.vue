<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getDocument, GlobalWorkerOptions, PDFDocumentProxy } from 'pdfjs-dist'
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

async function loadPdf(urlOrData: string | ArrayBuffer) {
  try {
    errorMessage.value = ''
    const loadingTask =
      typeof urlOrData === 'string' ? getDocument(urlOrData) : getDocument({ data: urlOrData })
    pdfDoc = await loadingTask.promise
    numPages.value = pdfDoc.numPages
    pageNum.value = 1
    rotation.value = 0
    await renderPage()
    await Promise.all([renderThumbnails(), loadOutline()])
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
  await page.render({ canvasContext: ctx, viewport }).promise
  await renderHighlightsForCurrentPage(page)
}

function zoomIn() {
  scale.value = Math.min(scale.value + 0.25, 4)
  renderPage()
}
function zoomOut() {
  scale.value = Math.max(scale.value - 0.25, 0.25)
  renderPage()
}
function fitWidth() {
  if (!pdfDoc || !stageRef.value) return
  pdfDoc.getPage(pageNum.value).then((page) => {
    const viewport = page.getViewport({ scale: 1, rotation: rotation.value })
    const stageWidth = stageRef.value!.clientWidth - 24 // padding
    scale.value = Math.max(0.1, stageWidth / viewport.width)
    renderPage()
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
    renderPage()
  })
}
function rotateClockwise() {
  rotation.value = (rotation.value + 90) % 360
  renderPage()
}
function rotateCounterClockwise() {
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
    await page.render({ canvasContext: ctx, viewport }).promise
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
    const textContent = await page.getTextContent({ normalizeWhitespace: true })
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

async function getRectsForPage(page: any, queryLower: string) {
  const rects: Array<{ x: number; y: number; w: number; h: number }> = []
  const textContent = await page.getTextContent({ normalizeWhitespace: true })
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
  overlay.style.width = `${canvasRef.value.width}px`
  overlay.style.height = `${canvasRef.value.height}px`
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
      <button @click="zoomOut">缩小</button>
      <button @click="zoomIn">放大</button>
      <button @click="fitWidth">适配宽度</button>
      <button @click="fitPage">整页适配</button>
      <div class="sep" />
      <button @click="rotateCounterClockwise">左旋转</button>
      <button @click="rotateClockwise">右旋转</button>
      <div class="sep" />
      <input placeholder="搜索文本" v-model="searchQuery" @keyup.enter="runSearch" />
      <button @click="runSearch">搜索</button>
      <button :disabled="!searchMatches.length" @click="prevMatch">上一个</button>
      <button :disabled="!searchMatches.length" @click="nextMatch">下一个</button>
      <span v-if="hasSearched">{{ searchMatches.length ? (currentMatchIndex+1) : 0 }}/{{ searchMatches.length }}</span>
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
.hl-overlay { position: absolute; inset: 0; pointer-events: none; }
.hl { position: absolute; background: rgba(250, 204, 21, 0.35); outline: 1px solid rgba(234, 179, 8, 0.6); }
.hl.current { background: rgba(59, 130, 246, 0.35); outline-color: rgba(59, 130, 246, 0.7); }
.error { color: #c62828; padding: 8px 12px; }
</style>

