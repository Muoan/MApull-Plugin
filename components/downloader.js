import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as store from './store.js'

const execFileAsync = promisify(execFile)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

let broadcastFn = () => {}
export function setBroadcaster (fn) { broadcastFn = fn }

const running = new Set()
const queue = []
let workerActive = false
const lastBcast = new Map()

export function submit (task) {
  queue.push(task)
  kickWorker()
  return task
}

export function retry (id) {
  const t = store.getTask(id)
  if (!t) return null
  const fresh = store.updateTask(id, {
    status: 'queued', progress: 0, downloaded_size: 0, total_size: 0, speed: 0,
    error: '', file_path: '', file_name: '', file_size: 0, finished_at: 0
  })
  submit(fresh)
  return fresh
}

export function cancel (id) {
  const t = store.getTask(id)
  if (!t) return false
  if (['done', 'failed', 'canceled'].includes(t.status)) return false
  running.delete(id)
  store.updateTask(id, { status: 'canceled', finished_at: Date.now() })
  bcast(t)
  return true
}

function kickWorker () {
  if (workerActive) return
  workerActive = true
  ;(async () => {
    try {
      while (queue.length) {
        const cfg = store.getConfig()
        if (running.size >= (cfg.max_active || 2)) break
        const task = queue.shift()
        if (!task) continue
        const fresh = store.getTask(task.id)
        if (!fresh || fresh.status === 'canceled') continue
        runTask(fresh).catch(err => {
          console.error(`[MApull] 任务 #${fresh.id} 异常:`, err?.message || err)
          store.updateTask(fresh.id, { status: 'failed', error: String(err?.message || err), finished_at: Date.now() })
          bcast(store.getTask(fresh.id))
        }).finally(() => {
          running.delete(fresh.id)
          kickWorker()
        })
        running.add(fresh.id)
      }
    } finally {
      workerActive = false
    }
  })()
}

function bcast (task, force = false) {
  if (!task) return
  const now = Date.now()
  const last = lastBcast.get(task.id) || 0
  if (!force && now - last < 800) return
  lastBcast.set(task.id, now)
  try { broadcastFn({ type: 'task', task }) } catch {  }
}

function replyText (task, text) {
  const e = taskEvents.get(String(task?.id || ''))
  if (e?.reply) {
    try { return Promise.resolve(e.reply(text)) } catch (err) {}
  }
  return sendViaYunzai(task, text)
}

async function runTask (task) {
  store.updateTask(task.id, { status: 'downloading' })
  bcast(store.getTask(task.id), true)
  try {
    if (/[\u2026]|%E2%80%A6/i.test(task.url)) {
      throw new Error('链接不完整：中间含省略号(…)——长链接被聊天软件截断了。请到视频页面按 F12 → Network → 筛选 m3u8 → 右键 Copy link address 复制完整链接后再试')
    }
    const kind = await detectKind(task.url)
    if (kind === 'm3u8') {
      store.updateTask(task.id, { kind: 'm3u8' })
      await downloadM3u8(task)
    } else if (kind === 'page') {
      store.updateTask(task.id, { kind: 'page' })
      const found = await extractMediaUrl(task.url)
      if (!found) throw new Error('网页里没提取到 m3u8 / mp4 直链（可能是 JS 动态加载，抓包拿真实地址更靠谱）')
      store.updateTask(task.id, { url: found.url, kind: found.kind, title: task.title || found.title })
      bcast(store.getTask(task.id), true)
      if (found.kind === 'm3u8') await downloadM3u8(store.getTask(task.id))
      else await downloadDirect(store.getTask(task.id))
    } else {
      store.updateTask(task.id, { kind: 'direct' })
      await downloadDirect(task)
    }
    const done = store.getTask(task.id)
    if (done && done.status !== 'canceled') {
      store.updateTask(done.id, { status: 'done', progress: 100, finished_at: Date.now() })
      bcast(store.getTask(done.id), true)
      await autoSend(done)
    }
  } catch (err) {
    const msg = String(err?.message || err)
    store.updateTask(task.id, { status: 'failed', error: msg.slice(0, 500), finished_at: Date.now() })
    bcast(store.getTask(task.id), true)
    await replyText(store.getTask(task.id), `❌ 下载失败 #${task.id}\n${msg.slice(0, 200)}`)
  }
}

async function detectKind (url) {
  if (/\.m3u8(\?|#|$)/i.test(url)) return 'm3u8'
  const res = await fetchWithTimeout(url, { method: 'GET' })
  const ct = String(res.headers.get('content-type') || '')
  if (ct.includes('mpegurl') || ct.includes('application/vnd.apple')) return 'm3u8'
  const buf = Buffer.from(await res.arrayBuffer())
  const head = buf.slice(0, 1024).toString('latin1')
  if (head.trimStart().startsWith('#EXTM3U')) return 'm3u8'
  if (ct.includes('text/html')) return 'page'
  return 'direct'
}

async function downloadDirect (task) {
  const cfg = store.getConfig()
  const res = await fetchWithTimeout(task.url)
  const ct = String(res.headers.get('content-type') || '')
  const total = Number(res.headers.get('content-length') || 0)
  const maxBytes = (cfg.max_file_mb || 500) * 1024 * 1024
  if (total > maxBytes) throw new Error(`文件过大(${(total / 1048576).toFixed(1)}MB)，超过限制 ${cfg.max_file_mb}MB`)

  const disp = parseContentDisposition(res.headers.get('content-disposition'))
  const ext = extFromContentType(ct) || extFromUrl(task.url) || '.bin'
  const baseName = safeName(disp || basename(task.url) || `mapull_${task.id}`)
  const finalName = ensureExt(baseName, ext)
  const tmpFile = path.join(store.TMP_DIR, `task_${task.id}_${Date.now()}${ext}`)
  store.updateTask(task.id, { title: task.title || finalName, total_size: total })

  const ws = fs.createWriteStream(tmpFile)
  let done = 0
  let lastT = Date.now()
  let lastBytes = 0
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader()
    for (;;) {
      const { value, done: isDone } = await reader.read()
      if (isDone) break
      if (!ws.write(value)) await onceDrain(ws)
      done += value.length
      const now = Date.now()
      if (now - lastT >= 800) {
        const speed = (done - lastBytes) / ((now - lastT) / 1000)
        lastT = now; lastBytes = done
        store.updateTask(task.id, { downloaded_size: done, speed, progress: total ? Math.min(99, done / total * 100) : 0 })
        bcast(store.getTask(task.id))
      }
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer())
    ws.write(buf); done = buf.length
  }
  ws.end()
  await onceClose(ws)

  if (done > maxBytes) { fs.rmSync(tmpFile, { force: true }); throw new Error(`文件过大，超过限制 ${cfg.max_file_mb}MB`) }
  const finalPath = path.join(store.DOWNLOAD_DIR, `${task.id}_${finalName}`)
  fs.renameSync(tmpFile, finalPath)
  store.updateTask(task.id, {
    downloaded_size: done, total_size: done, speed: 0, progress: 100,
    file_path: finalPath, file_name: finalName, file_size: done
  })
  bcast(store.getTask(task.id), true)
}

async function downloadM3u8 (task) {
  const cfg = store.getConfig()
  const playlist = await fetchPlaylist(task.url)
  const workDir = path.join(store.TMP_DIR, `m3u8_${task.id}_${Date.now()}`)
  fs.mkdirSync(workDir, { recursive: true })
  try {
    const base = new URL(playlist.url)
    const segs = parseSegments(playlist.text, base)
    if (!segs.list.length) throw new Error('播放列表里没有分片')
    const maxBytes = (cfg.max_file_mb || 500) * 1024 * 1024

    let keyInfo = null
    if (segs.key && segs.key.method === 'AES-128') {
      let keyBuf
      if (/^file:\/\//i.test(segs.key.uri)) {

        keyBuf = fs.readFileSync(segs.key.uri.slice('file://'.length))
      } else {
        const keyUrl = new URL(segs.key.uri, base).href
        const keyRes = await fetchWithTimeout(keyUrl)
        keyBuf = Buffer.from(await keyRes.arrayBuffer())
      }
      if (!keyBuf.length) throw new Error('密钥下载失败')
      const keyFile = path.join(workDir, 'key.bin')
      fs.writeFileSync(keyFile, keyBuf)
      keyInfo = { file: keyFile, iv: segs.key.iv || '0x00000000000000000000000000000000' }
    } else if (segs.key && segs.key.method && segs.key.method !== 'NONE') {
      throw new Error(`不支持的加密方式: ${segs.key.method}（DRM 加密无法下载）`)
    }

    const total = segs.list.length
    let doneCount = 0
    let bytesDone = 0
    let lastT = Date.now()
    let lastBytes = 0
    const conc = Math.max(1, cfg.max_concurrency || 8)
    const dl = async (idx) => {
      const seg = segs.list[idx]
      const segUrl = new URL(seg, base).href
      const buf = await fetchWithResume(segUrl)
      if (!buf.length) throw new Error(`分片 ${idx} 下载为空`)
      bytesDone += buf.length
      if (bytesDone > maxBytes) throw new Error(`总大小超过限制 ${cfg.max_file_mb}MB`)
      fs.writeFileSync(path.join(workDir, `seg_${String(idx).padStart(5, '0')}.ts`), buf)
      doneCount++
      const now = Date.now()
      if (now - lastT >= 800) {
        const speed = (bytesDone - lastBytes) / ((now - lastT) / 1000)
        lastT = now; lastBytes = bytesDone
        store.updateTask(task.id, { downloaded_size: bytesDone, speed, progress: Math.min(99, doneCount / total * 100) })
        bcast(store.getTask(task.id))
      }
    }
    let pos = 0
    const workers = Array.from({ length: Math.min(conc, total) }, async () => {
      while (pos < total) {
        const idx = pos++
        await dl(idx)
      }
    })
    await Promise.all(workers)

    const localList = path.join(workDir, 'local.m3u8')
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:8', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
    if (keyInfo) {
      lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="file://${keyInfo.file}",IV=${keyInfo.iv}`)
    }
    for (let i = 0; i < total; i++) {
      lines.push('#EXTINF:8,', path.join(workDir, `seg_${String(i).padStart(5, '0')}.ts`))
    }
    lines.push('#EXT-X-ENDLIST')
    fs.writeFileSync(localList, lines.join('\n'))

    store.updateTask(task.id, { status: 'merging', progress: 99, speed: 0 })
    bcast(store.getTask(task.id), true)
    const outFile = path.join(workDir, 'out.mp4')
    await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL', '-i', localList, '-c', 'copy', outFile], { timeout: 15 * 60 * 1000 })

    const probe = await ffprobe(outFile)
    if (!probe || probe.duration <= 0 || probe.video === false) {

      const tmp2 = path.join(workDir, 'out2.mp4')
      await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL', '-i', localList, '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp2], { timeout: 20 * 60 * 1000 })
      fs.renameSync(tmp2, outFile)
    }
    const size = fs.statSync(outFile).size
    if (!size) throw new Error('合并结果为空')

    const title = (task.title || safeName(basename(task.url)) || `mapull_${task.id}`).replace(/\.m3u8$/i, '')
    const finalName = ensureExt(title, '.mp4')
    const finalPath = path.join(store.DOWNLOAD_DIR, `${task.id}_${finalName}`)
    fs.renameSync(outFile, finalPath)
    store.updateTask(task.id, {
      downloaded_size: bytesDone, total_size: bytesDone, progress: 100, speed: 0,
      file_path: finalPath, file_name: finalName, file_size: size, title: finalName
    })
    bcast(store.getTask(task.id), true)
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {  }
  }
}

async function fetchPlaylist (url) {
  const res = await fetchWithTimeout(url)
  const text = await res.text()
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('不是有效的 m3u8 播放列表')

  if (text.includes('#EXT-X-STREAM-INF')) {
    const variants = parseVariants(text, new URL(url))
    if (!variants.length) throw new Error('master 列表解析失败')
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
    const sub = variants[0]
    const subRes = await fetchWithTimeout(sub.url)
    const subText = await subRes.text()
    if (!subText.trimStart().startsWith('#EXTM3U')) throw new Error('子播放列表无效')
    return { url: sub.url, text: subText }
  }
  return { url, text }
}

function parseVariants (text, base) {
  const lines = text.split(/\r?\n/)
  const out = []
  let bandwidth = 0
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('#EXT-X-STREAM-INF')) {
      const m = /BANDWIDTH=(\d+)/i.exec(t)
      bandwidth = m ? Number(m[1]) : 0
    } else if (t && !t.startsWith('#')) {
      out.push({ url: new URL(t, base).href, bandwidth })
      bandwidth = 0
    }
  }
  return out
}

function parseSegments (text, base) {
  const lines = text.split(/\r?\n/)
  const list = []
  let key = null
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('#EXT-X-KEY:')) {
      key = parseKey(t)
    } else if (t && !t.startsWith('#')) {
      list.push(t)
    }
  }
  return { list, key }
}

function parseKey (line) {
  const out = { method: '', uri: '', iv: '' }
  const mm = /METHOD=([^,]+)/i.exec(line); if (mm) out.method = mm[1].trim().toUpperCase()
  const um = /URI="([^"]*)"/i.exec(line); if (um) out.uri = um[1]
  const ivm = /IV=(0x[0-9a-fA-F]+)/i.exec(line); if (ivm) out.iv = ivm[1].toUpperCase()
  return out
}

async function extractMediaUrl (url) {
  const res = await fetchWithTimeout(url)
  const html = (await res.text()).slice(0, 2 * 1024 * 1024)
  const patterns = [
    /https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/gi,
    /https?:\/\/[^"'\s<>\\]+\.mp4[^"'\s<>\\]*/gi,
    /https?:\/\/[^"'\s<>\\]+\.flv[^"'\s<>\\]*/gi
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m.length) {
      const u = m[0].replace(/\\\//g, '/').replace(/&amp;/g, '&')
      return { url: u, kind: /\.m3u8/i.test(u) ? 'm3u8' : 'direct', title: '' }
    }
  }
  const og = /<meta[^>]+property=["']og:video[^>]+content=["']([^"']+)["']/i.exec(html)
  if (og) return { url: og[1], kind: /\.m3u8/i.test(og[1]) ? 'm3u8' : 'direct', title: '' }
  return null
}

async function autoSend (task) {
  if (!task.file_path || !fs.existsSync(task.file_path)) {
    console.log(`[MApull] 跳过回传 #${task.id}: 文件不存在`)
    return
  }
  if (!task.bot_appid || !task.target_type || !task.target_id) {
    console.log(`[MApull] 跳过回传 #${task.id}: 缺会话信息`)
    return
  }
  const ok = await sendDoneLink(task)
  if (ok) {
    store.markSent(task.id)
    console.log(`[MApull] 任务 #${task.id} 已发送直链`)
  } else {
    console.log(`[MApull] 回传 #${task.id}: 全部通道失败`)
  }
}

async function sendViaYunzai (task, text) {
  try {
    const B = globalThis.Bot
    if (!B || !globalThis.segment) return false
    let b = null
    if (B instanceof Map) b = B.get(String(task.self_id)) || B.get(Number(task.self_id))
    else if (Array.isArray(B)) b = B.find(x => String(x.uin) === String(task.self_id))
    else if (typeof B === 'object') b = String(B.uin) === String(task.self_id) ? B : null
    if (!b) return false

    const gid = task.target_type === 'group' ? String(task.target_id || '') : ''
    const uid = task.target_type === 'group' ? '' : String(task.sender_id || task.target_id || '')
    const target = gid ? b.pickGroup?.(gid) : b.pickUser?.(uid)
    if (!target?.sendMsg) return false
    await target.sendMsg([globalThis.segment.text(String(text || ''))])
    console.log(`[MApull] 任务 #${task.id} 已通过云崽通用通道回传文本`)
    return true
  } catch (err) {
    console.error(`[MApull] 云崽通用回传失败 #${task.id}:`, err?.message || err)
    return false
  }
}

export const taskEvents = new Map()

export function registerTaskEvent (id, e) {
  if (e) taskEvents.set(String(id), e)
}

export async function sendDoneLink (task) {
  const cfg = store.getConfig()
  const sizeMb = (task.file_size / 1048576).toFixed(1)
  const link = cfg.public_url ? `${cfg.public_url}/v/${task.id}` : ''
  const text = `✅ 下载完成 #${task.id}：${task.file_name}（${sizeMb}MB）\n${link ? `点击查看/下载（请用浏览器打开，微信/QQ 内无效）：\n${link}` : '请到面板下载'}`
  const e = taskEvents.get(String(task.id))
  if (e?.reply) {
    try {
      await e.reply(text)
      return true
    } catch (err) {
      console.log(`[MApull] 回传 #${task.id} 原事件回复失败:`, err?.message || err)
    }
  }
  return sendViaYunzai(task, text)
}

const FETCH_MAX_ATTEMPTS = 3
const SEG_ATTEMPT_TIMEOUT = 60000

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithResume (url, timeoutMs = SEG_ATTEMPT_TIMEOUT, maxAttempts = FETCH_MAX_ATTEMPTS) {
  const chunks = []
  let have = 0
  for (let n = 1; n <= maxAttempts; n++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const headers = { 'User-Agent': UA, Referer: url }
      if (have > 0) headers.Range = `bytes=${have}-`
      const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal })
      if (res.status === 416) {
        break
      }
      if (res.status === 200 && have > 0) {
        chunks.length = 0
        have = 0
      }
      if (res.status === 206 || (res.status === 200 && have === 0)) {
        const reader = res.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.length) {
            chunks.push(Buffer.from(value))
            have += value.length
          }
        }
        return Buffer.concat(chunks)
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.min(500 * 2 ** (n - 1), 3000))
        continue
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    } catch (err) {
      const isHttpError = err instanceof Error && /^HTTP \d/.test(err.message)
      if (!isHttpError && n < maxAttempts) {
        await sleep(Math.min(500 * 2 ** (n - 1), 3000))
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  return Buffer.concat(chunks)
}

function fetchWithTimeout (url, opts = {}) {
  return attemptFetch(1)

  async function attemptFetch (n) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: { 'User-Agent': UA, Referer: url, ...(opts.headers || {}) },
        redirect: 'follow',
        signal: ctrl.signal
      })
      if ((res.status === 429 || res.status >= 500) && n < FETCH_MAX_ATTEMPTS) {
        await sleep(Math.min(500 * 2 ** (n - 1), 3000))
        return attemptFetch(n + 1)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return res
    } catch (err) {
      const isHttpError = err instanceof Error && /^HTTP \d/.test(err.message)
      if (!isHttpError && n < FETCH_MAX_ATTEMPTS) {
        await sleep(Math.min(500 * 2 ** (n - 1), 3000))
        return attemptFetch(n + 1)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

function onceDrain (ws) {
  return new Promise((resolve) => ws.once('drain', resolve))
}
function onceClose (ws) {
  return new Promise((resolve) => ws.once('close', resolve))
}

async function ffprobe (file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', file])
    const data = JSON.parse(stdout)
    const duration = Number(data?.format?.duration || 0)
    const streams = data?.streams || []
    return { duration, video: streams.some(s => s.codec_type === 'video') }
  } catch {
    return null
  }
}

function parseContentDisposition (v) {
  if (!v) return ''
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(v)
  return m ? decodeURIComponent(m[1].trim()) : ''
}

function extFromContentType (ct) {
  if (!ct) return ''
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
    'application/octet-stream': ''
  }
  const base = ct.split(';')[0].trim().toLowerCase()
  return map[base] || ''
}

function extFromUrl (url) {
  const m = /\.([a-z0-9]{2,5})(\?|$)/i.exec(url)
  if (!m) return ''
  const ext = m[1].toLowerCase()
  return /^(mp4|mkv|flv|webm|mov|avi|jpg|jpeg|png|gif|webp|bmp|mp3|m4a|aac|flac|wav|zip|rar|7z|pdf|txt|json|srt|ass)$/.test(ext) ? '.' + ext : ''
}

function basename (url) {
  try {
    const p = new URL(url).pathname
    const b = p.split('/').filter(Boolean).pop() || ''
    return b.includes('.') ? b : ''
  } catch { return '' }
}

function safeName (name) {
  return String(name || 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'file'
}

function ensureExt (name, ext) {
  const e = ext || '.bin'
  return /\.(mp4|mkv|flv|webm|mov|avi|jpg|jpeg|png|gif|webp|bmp|mp3|m4a|aac|flac|wav|zip|rar|7z|pdf|txt|bin)$/i.test(name) ? name : name + e
}
