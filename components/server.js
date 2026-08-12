import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as store from './store.js'
import * as downloader from './downloader.js'

const execFileAsync = promisify(execFile)
const wsClients = new Set()
let app = null

function verify (token) {
  if (!token) return false
  return token === store.getConfig().token
}

export function broadcast (msg) {
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
  for (const ws of wsClients) {
    try { ws.send(text) } catch {  }
  }
}

export async function start () {
  if (app) return app
  app = await buildApp()
  try {
    await app.listen({ host: '0.0.0.0', port: store.getConfig().port })
    console.log(`[MApull] 面板已启动: http://0.0.0.0:${store.getConfig().port}`)
  } catch (err) {
    console.error(`[MApull] 端口 ${store.getConfig().port} 启动失败:`, err?.message)
    if (err?.code === 'EADDRINUSE') {
      console.error('[MApull] 端口被占用，可修改 data/config.json 里的 port 后重启云崽')
    }
  }
  return app
}

const fileKeys = new Map()

function createFileKey (id) {
  const cfg = store.getConfig()
  const ttlMs = (cfg.cleanup_minutes || 10) * 60 * 1000
  const key = crypto.randomBytes(16).toString('hex')
  const expireAt = Date.now() + ttlMs
  fileKeys.set(String(id), { key, expireAt })
  return { key, expireAt }
}

function checkFileKey (id, key) {
  const rec = fileKeys.get(String(id))
  if (!rec || !key || rec.key !== String(key) || Date.now() > rec.expireAt) return false
  return true
}

const BLOCKED_UA = /MicroMessenger|MQQBrowser| QQ\//i

function isBlockedBrowser (ua) {
  return BLOCKED_UA.test(String(ua || ''))
}

function tokenFromReq (req) {
  let t = String(req.headers.authorization || req.query.token || '').replace(/^Bearer\s+/i, '')
  if (!t) {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)mapull_token=([^;]*)/)
    if (m) t = m[1]
  }
  return t
}

const BLOCK_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>请使用浏览器打开</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#eef4ff,#f7faff);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(37,99,235,.12);padding:36px 28px;max-width:420px;width:100%;text-align:center;border-top:4px solid #2563eb}h1{font-size:20px;color:#1e3a8a;margin-bottom:14px}p{font-size:14px;color:#475569;line-height:1.8}</style></head><body><div class="card"><h1>🔒 请在浏览器中打开</h1><p>微信 / QQ 内无法访问本链接。<br>请点击右上角「在浏览器打开」，<br>或复制链接到手机 / 电脑浏览器访问。</p></div></body></html>`

const VERIFY_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>墨安拉取 · 文件验证</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#eef4ff,#f7faff);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(37,99,235,.12);padding:32px 28px;max-width:420px;width:100%;text-align:center;border-top:4px solid #2563eb}h1{font-size:20px;color:#1e3a8a;margin-bottom:18px}#status{color:#2563eb;font-size:15px;padding:24px 0}#fileInfo{display:none}.fname{font-size:16px;color:#1e293b;font-weight:600;word-break:break-all;margin-bottom:8px}.fmeta{font-size:13px;color:#64748b;margin-bottom:22px}.btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.btn{display:inline-block;padding:11px 22px;border-radius:10px;font-size:15px;text-decoration:none;font-weight:600}.btn.primary{background:#2563eb;color:#fff}.btn.primary:hover{background:#1d4ed8}.btn.ghost{border:1px solid #93c5fd;color:#2563eb;background:#eff6ff}.btn.ghost:hover{background:#dbeafe}.disc{margin-top:22px;font-size:11px;color:#94a3b8;line-height:1.6}.spin{display:inline-block;width:18px;height:18px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:sp 1s linear infinite;vertical-align:-3px;margin-right:8px}@keyframes sp{to{transform:rotate(360deg)}}.err{color:#dc2626;font-size:14px;padding:16px 0}</style></head><body><div class="card"><h1>📥 墨安拉取 · 文件验证</h1><div id="status"><span class="spin"></span>正在验证，请稍候…</div><div id="fileInfo"><p class="fname" id="fname"></p><p class="fmeta" id="fmeta"></p><div class="btns"><a id="dlBtn" class="btn primary" target="_blank" rel="noopener">下载文件</a><a id="pvBtn" class="btn ghost" style="display:none" target="_blank" rel="noopener">在线预览</a></div></div><p class="disc">本页仅提供拉取下载与短期预览，对内容不做审查，不记录使用者信息，如有问题概不负责</p></div><script>(function(){var id=location.pathname.split('/').pop();var s=document.getElementById('status');fetch('/api/files/'+id+'/verify').then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error||'验证失败')});return r.json()}).then(function(d){s.style.display='none';document.getElementById('fileInfo').style.display='block';document.getElementById('fname').textContent=d.fileName;document.getElementById('fmeta').textContent=(d.fileSize/1048576).toFixed(1)+' MB'+(d.canPreview?' · 支持在线预览':'');var key=encodeURIComponent(d.key);document.getElementById('dlBtn').href='/api/files/'+id+'/download?key='+key;if(d.canPreview){var pv=document.getElementById('pvBtn');pv.href='/api/files/'+id+'/download?key='+key+'&inline=1';pv.style.display='inline-block'}}).catch(function(e){s.innerHTML='<span class="err">验证失败：'+(e.message||'请重试')+'</span>'})})()</script></body></html>`

async function buildApp () {
  const a = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 })
  await a.register(fastifyCors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] })
  await a.register(fastifyWebsocket)
  await a.register(fastifyStatic, {
    root: store.WEB_DIR,
    cacheControl: false,
    setHeaders (res) { res.setHeader('Cache-Control', 'no-store') }
  })

  a.addHook('preHandler', (req, reply, done) => {
    const url = req.url.split('?')[0]
    if (url === '/api/auth/login') return done()
    if (/^\/api\/files\/\d+\/(verify|meta|download)$/.test(url)) return done()
    if (!url.startsWith('/api/') && url !== '/ws') return done()

    let token = String(req.headers.authorization || req.query.token || '').replace(/^Bearer\s+/i, '')
    if (!token) {
      const m = String(req.headers.cookie || '').match(/(?:^|;\s*)mapull_token=([^;]*)/)
      if (m) token = m[1]
    }
    if (!verify(token)) return reply.code(401).send({ error: '未授权，请先登录' })
    done()
  })

  a.post('/api/auth/login', async (req, reply) => {
    const { token } = req.body || {}
    const cfg = store.getConfig()
    if (!token || token !== cfg.token) return reply.code(401).send({ error: 'token 错误' })
    return { ok: true, token: cfg.token, title: cfg.title }
  })

  a.get('/api/auth/verify', async () => {
    const cfg = store.getConfig()
    return { ok: true, title: cfg.title }
  })

  a.get('/api/tasks', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    return { tasks: store.listTasks(limit) }
  })

  a.get('/api/tasks/:id', async (req, reply) => {
    const t = store.getTask(req.params.id)
    if (!t) return reply.code(404).send({ error: '任务不存在' })
    return { task: t }
  })

  a.post('/api/tasks', async (req, reply) => {
    const { url } = req.body || {}
    const u = String(url || '').trim()
    if (!/^https?:\/\/\S+$/i.test(u)) return reply.code(400).send({ error: '请输入 http(s) 链接' })
    const task = store.createTask({ url: u, kind: 'auto', title: '' })
    downloader.submit(task)
    return { task: store.getTask(task.id) }
  })

  a.delete('/api/tasks/:id', async (req, reply) => {
    downloader.cancel(Number(req.params.id))
    const ok = store.deleteTask(Number(req.params.id))
    if (!ok) return reply.code(404).send({ error: '任务不存在' })
    return { ok: true }
  })

  a.post('/api/tasks/:id/retry', async (req, reply) => {
    const t = downloader.retry(Number(req.params.id))
    if (!t) return reply.code(404).send({ error: '任务不存在' })
    return { task: store.getTask(t.id) }
  })

  a.post('/api/tasks/:id/cancel', async (req, reply) => {
    const ok = downloader.cancel(Number(req.params.id))
    if (!ok) return reply.code(400).send({ error: '任务无法取消' })
    return { ok: true }
  })

  a.post('/api/tasks/:id/send-qq', async (req, reply) => {
    const t = store.getTask(req.params.id)
    if (!t) return reply.code(404).send({ error: '任务不存在' })
    if (t.status !== 'done' || !t.file_path || !fs.existsSync(t.file_path)) {
      return reply.code(400).send({ error: '任务无可用文件' })
    }
    if (!t.bot_appid || !t.target_type || !t.target_id) {
      return reply.code(400).send({ error: '该任务不是从 QQ 发起的，无法回传' })
    }
    try {
      const ok = await downloader.sendDoneLink(t)
      if (!ok) return reply.code(500).send({ error: '发送失败：通用通道与官方通道均不可用' })
      store.markSent(t.id)
      return { ok: true }
    } catch (err) {
      return reply.code(500).send({ error: '发送失败: ' + (err?.message || err) })
    }
  })

  a.get('/v/:id', async (req, reply) => {
    const t = store.getTask(req.params.id)
    if (!t || !t.file_path || !fs.existsSync(t.file_path)) return reply.code(404).send({ error: '文件不存在或已清理' })
    const cfg = store.getConfig()
    if (cfg.verify_browser_only && isBlockedBrowser(req.headers['user-agent'])) {
      return reply.type('text/html; charset=utf-8').send(BLOCK_PAGE)
    }
    return reply.type('text/html; charset=utf-8').send(VERIFY_PAGE)
  })

  a.get('/api/files/:id/verify', async (req, reply) => {
    const t = store.getTask(req.params.id)
    if (!t || !t.file_path || !fs.existsSync(t.file_path)) return reply.code(404).send({ error: '文件不存在或已清理' })
    const cfg = store.getConfig()
    if (cfg.verify_browser_only && isBlockedBrowser(req.headers['user-agent'])) {
      return reply.code(403).send({ error: '请使用手机或电脑浏览器打开（微信/QQ 内无法验证）' })
    }
    const { key, expireAt } = createFileKey(req.params.id)
    const ext = path.extname(t.file_name || '').toLowerCase()
    const previewExts = ['.mp4', '.mov', '.webm', '.m4v', '.avi', '.ts', '.flv', '.mp3', '.aac', '.wav', '.flac', '.ogg', '.m4a', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']
    return { key, expireAt, fileName: t.file_name, fileSize: t.file_size, canPreview: previewExts.includes(ext) }
  })

  a.get('/api/files/:id/meta', async (req, reply) => {
    const t = store.getTask(req.params.id)
    if (!t || !t.file_path || !fs.existsSync(t.file_path)) return reply.code(404).send({ error: '文件不存在或已清理' })
    if (!checkFileKey(req.params.id, req.query.key)) return reply.code(401).send({ error: '验证失败或已过期，请重新打开链接' })
    return { fileName: t.file_name, fileSize: t.file_size, status: t.status, title: t.title }
  })

  a.get('/api/files', async () => ({ files: store.listDoneFiles() }))

  a.get('/api/files/:id/download', async (req, reply) => {
    const t = store.getTask(req.params.id)
    if (!t || !t.file_path || !fs.existsSync(t.file_path)) return reply.code(404).send({ error: '文件不存在' })
    const cfg = store.getConfig()
    const keyOk = checkFileKey(req.params.id, req.query.key)
    const tokenOk = verify(tokenFromReq(req))
    if (cfg.verify_browser_only && !keyOk && !tokenOk) return reply.code(401).send({ error: '请先通过浏览器验证' })
    if (cfg.verify_browser_only && !tokenOk && isBlockedBrowser(req.headers['user-agent'])) return reply.code(403).send({ error: '请使用手机或电脑浏览器打开' })
    const stat = await fs.promises.stat(t.file_path)
    const size = stat.size
    const inline = req.query.inline === '1'

    const ext = path.extname(t.file_name || '').toLowerCase()
    const mimeMap = {
      '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.flv': 'video/x-flv',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
      '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac',
      '.m4a': 'audio/mp4', '.ogg': 'audio/ogg'
    }
    const contentType = mimeMap[ext] || 'application/octet-stream'
    const disposition = inline
      ? `inline; filename*=UTF-8''${encodeURIComponent(t.file_name)}`
      : `attachment; filename*=UTF-8''${encodeURIComponent(t.file_name)}`

    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(String(range))
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1
      if (Number.isNaN(start)) start = 0
      if (Number.isNaN(end) || end >= size) end = size - 1
      if (start > end) {
        return reply.code(416).header('Content-Range', `bytes */${size}`).send()
      }
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', end - start + 1)
        .header('Content-Type', contentType)
        .header('Content-Disposition', disposition)
        .send(fs.createReadStream(t.file_path, { start, end }))
    }

    return reply
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', size)
      .header('Content-Disposition', disposition)
      .header('Content-Type', contentType)
      .send(fs.createReadStream(t.file_path))
  })

  a.get('/api/config', async () => {
    const cfg = store.getConfig()
    return { config: { ...cfg } }
  })

  a.put('/api/config', async (req, reply) => {
    const { title, port, max_active, max_concurrency, max_auto_send_mb, max_file_mb, task_timeout_min } = req.body || {}
    const oldCfg = store.getConfig()
    const patch = {}
    if (title !== undefined) patch.title = String(title).slice(0, 50)
    if (port !== undefined) {
      const p = Number(port)
      if (!Number.isInteger(p) || p < 1000 || p > 65535) return reply.code(400).send({ error: '端口需为 1000-65535' })
      patch.port = p
    }
    if (max_active !== undefined) patch.max_active = Math.max(1, Math.min(10, Number(max_active) || 2))
    if (max_concurrency !== undefined) patch.max_concurrency = Math.max(1, Math.min(32, Number(max_concurrency) || 8))
    if (max_auto_send_mb !== undefined) patch.max_auto_send_mb = Math.max(1, Math.min(100, Number(max_auto_send_mb) || 90))
    if (max_file_mb !== undefined) patch.max_file_mb = Math.max(1, Math.min(2048, Number(max_file_mb) || 500))
    if (task_timeout_min !== undefined) patch.task_timeout_min = Math.max(1, Math.min(240, Number(task_timeout_min) || 30))
    const cfg = store.saveConfig(patch)
    const portChanged = patch.port && patch.port !== oldCfg.port
    if (portChanged) {
      setTimeout(() => restartListen(patch.port, oldCfg.port), 1200)
    }
    return { config: { ...cfg }, port_changed: portChanged }
  })

  a.post('/api/config/reset-token', async (req, reply) => {
    const cfg = store.saveConfig({ token: store.randomToken() })
    return { token: cfg.token }
  })
  a.get('/ws', { websocket: true }, (socket, req) => {
    let token = String(req.query?.token || req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!token) {
      const m = String(req.headers.cookie || '').match(/(?:^|;\s*)mapull_token=([^;]*)/)
      if (m) token = m[1]
    }
    if (!verify(token)) {
      try { socket.send(JSON.stringify({ type: 'error', error: '未授权' })) } catch {  }
      return socket.close()
    }
    wsClients.add(socket)
    try { socket.send(JSON.stringify({ type: 'hello', ts: Date.now() })) } catch {  }
    socket.on('close', () => wsClients.delete(socket))
    socket.on('error', () => wsClients.delete(socket))
  })

  return a
}

export async function restartListen (newPort, oldPort) {
  try {
    const old = app
    if (old) { try { await old.close() } catch {  } }
    app = await buildApp()
    await app.listen({ host: '0.0.0.0', port: newPort })
    console.log(`[MApull] 端口已切换: ${oldPort} -> ${newPort}`)
  } catch (err) {
    console.error('[MApull] 端口切换失败，回滚:', err?.message)
    try { store.saveConfig({ port: oldPort }) } catch {  }
    try {
      app = await buildApp()
      await app.listen({ host: '0.0.0.0', port: oldPort })
      console.log(`[MApull] 已回滚到端口 ${oldPort}`)
    } catch (e2) { console.error('[MApull] 回滚监听失败:', e2?.message) }
  }
}
