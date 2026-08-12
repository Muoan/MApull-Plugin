const $ = s => document.querySelector(s)
function readToken () {

  return localStorage.getItem('mapull_token') || (document.cookie.match(/(?:^|;\s*)mapull_token=([^;]*)/) || [])[1] || ''
}
let TOKEN = readToken()
let TASKS = []
let FILES = []
let ws = null

async function api (path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers, body: opts.body ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)) : undefined })
  let data = null
  try { data = await res.json() } catch {  }
  if (res.status === 401) { showLogin(); throw new Error('未授权') }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

let toastTimer = null
function toast (msg, isErr = false) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden', 'err')
  if (isErr) el.classList.add('err')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000)
}

function fmtSize (n) {
  if (!n) return '-'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}
function fmtSpeed (n) { return n ? fmtSize(n) + '/s' : '' }
function fmtTime (ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function showLogin () {
  $('#mainView').classList.add('hidden')
  $('#loginView').classList.remove('hidden')
  TOKEN = ''
  localStorage.removeItem('mapull_token')
  document.cookie = 'mapull_token=; Max-Age=0; path=/'
}
async function doLogin () {
  const token = $('#tokenInput').value.trim()
  if (!token) return
  try {
    const data = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).then(r => r.json())
    if (!data.ok) throw new Error(data.error || '登录失败')
    TOKEN = data.token
    try { localStorage.setItem('mapull_token', TOKEN) } catch {  }
    document.cookie = `mapull_token=${TOKEN}; path=/; max-age=${60 * 60 * 24 * 30}`
    $('#appTitle').textContent = data.title
    enterMain()
  } catch (err) { $('#loginError').textContent = String(err.message || err) }
}
$('#loginBtn').addEventListener('click', doLogin)
$('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
$('#logoutBtn').addEventListener('click', showLogin)

async function enterMain () {
  $('#loginView').classList.add('hidden')
  $('#mainView').classList.remove('hidden')
  connectWs()
  refreshAll()
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'))
    $('#tab-' + tab.dataset.tab).classList.remove('hidden')
    if (tab.dataset.tab === 'files') loadFiles()
    if (tab.dataset.tab === 'settings') loadConfig()
  })
})

async function refreshAll () {
  try {
    const [t, v] = await Promise.all([api('/api/tasks?limit=60'), api('/api/auth/verify')])
    TASKS = t.tasks || []
    renderTasks()
    $('#appTitle').textContent = v.title
  } catch (err) { toast(err.message, true) }
}

function renderTasks () {
  const list = $('#taskList')
  if (!TASKS.length) { list.innerHTML = '<div class="empty">暂无任务，粘贴链接开始下载</div>'; return }
  const stName = { done: '完成', failed: '失败', downloading: '下载中', merging: '合并中', queued: '排队中', canceled: '已取消' }
  list.innerHTML = TASKS.map(t => {
    const pct = Math.round(t.progress || 0)
    const cleaned = t.file_deleted === 1
    const name = esc(t.file_name || t.title || t.url.replace(/^https?:\/\//, '').slice(0, 50))
    const canDl = t.status === 'done' && t.file_path && !cleaned
    const canRetry = ['failed', 'canceled'].includes(t.status)
    const stText = cleaned ? '已清理' : (stName[t.status] || esc(t.status))
    const stCls = cleaned ? 'done' : esc(t.status)
    return `<div class="task-card" data-id="${t.id}">
      <div class="task-head">
        <span class="task-id">#${t.id}</span>
        <span class="task-name">${name}</span>
        <span class="kind ${esc(t.kind)}">${esc(t.kind === 'm3u8' ? 'm3u8' : t.kind === 'page' ? '网页' : '直链')}</span>
        <span class="st ${stCls}">${stText}</span>
      </div>
      <div class="url">${esc(t.url)}</div>
      ${t.status === 'downloading' || t.status === 'merging' || t.status === 'queued'
        ? `<div class="task-progress"><div style="width:${pct}%"></div></div>`
        : `<div class="task-progress"><div style="width:${pct}%;${pct === 100 ? 'background:var(--ok)' : ''}"></div></div>`}
      <div class="task-meta">
        <span>${pct}%</span>
        <span>${fmtSize(t.downloaded_size)} / ${fmtSize(t.total_size || t.file_size)}</span>
        <span>${fmtSpeed(t.speed)}</span>
        <span>${fmtTime(t.created_at)}</span>
        ${cleaned ? '<span class="cleaned-tag">🗑 已回传并自动清理</span>' : ''}
      </div>
      ${t.error ? `<div class="task-err">${esc(t.error)}</div>` : ''}
      <div class="task-actions">
        ${canDl ? `<button class="btn sm" onclick="downloadFile(${t.id})">⬇ 下载文件</button>` : ''}
        ${canDl ? `<button class="btn sm" onclick="previewFile(${t.id})">👁 预览</button>` : ''}
        ${canRetry ? `<button class="btn sm" onclick="retryTask(${t.id})">🔄 重试</button>` : ''}
        ${t.status === 'queued' || t.status === 'downloading' || t.status === 'merging' ? `<button class="btn sm danger" onclick="cancelTask(${t.id})">✕ 取消</button>` : ''}
        <button class="btn sm danger" onclick="deleteTask(${t.id})">🗑 删除</button>
      </div>
    </div>`
  }).join('')
}

$('#addTaskBtn').addEventListener('click', addTask)
$('#urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') addTask() })

async function addTask () {
  const url = $('#urlInput').value.trim()
  if (!/^https?:\/\/\S+$/i.test(url)) return toast('请输入 http(s) 链接', true)
  try {
    const data = await api('/api/tasks', { method: 'POST', body: { url } })
    $('#urlInput').value = ''
    toast(`已加入队列 #${data.task.id}`)
    refreshAll()
  } catch (err) { toast(err.message, true) }
}

async function downloadFile (id) { window.open(`/api/files/${id}/download?token=${encodeURIComponent(TOKEN)}`, '_blank') }

function mediaKind (name) {
  const n = String(name || '').toLowerCase()
  if (/\.(mp4|mkv|webm|mov|m4v|avi|ts|flv)$/.test(n)) return 'video'
  if (/\.(jpg|jpeg|png|gif|webp|bmp|avif)$/.test(n)) return 'image'
  if (/\.(mp3|aac|wav|flac|m4a|ogg)$/.test(n)) return 'audio'
  return 'other'
}
function previewFile (id) {
  const list = [...TASKS, ...FILES]
  const f = list.find(x => x.id === id)
  if (!f) return toast('找不到该文件', true)
  if (f.file_deleted === 1) return toast('文件已清理，无法预览', true)
  const name = f.file_name || f.title || 'file'
  const kind = mediaKind(name)
  const src = `/api/files/${id}/download?token=${encodeURIComponent(TOKEN)}&inline=1`
  $('#previewTitle').textContent = name
  const body = $('#previewBody')
  if (kind === 'image') {
    body.innerHTML = `<img class="pv-media" src="${src}" alt="${esc(name)}">`
  } else if (kind === 'video') {
    body.innerHTML = `<video class="pv-media" src="${src}" controls autoplay playsinline></video>`
  } else if (kind === 'audio') {
    body.innerHTML = `<audio class="pv-media" src="${src}" controls autoplay></audio>`
  } else {
    body.innerHTML = `<div class="pv-other">该类型暂不支持在线预览（仅图片/视频/音频），请点击下载查看。</div>`
  }
  $('#previewModal').classList.remove('hidden')
}
function closePreview () {
  const body = $('#previewBody')
  body.innerHTML = ''
  $('#previewModal').classList.add('hidden')
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePreview() })
async function retryTask (id) { try { await api(`/api/tasks/${id}/retry`, { method: 'POST' }); toast('已重新入队'); refreshAll() } catch (err) { toast(err.message, true) } }
async function cancelTask (id) { try { await api(`/api/tasks/${id}/cancel`, { method: 'POST' }); refreshAll() } catch (err) { toast(err.message, true) } }
async function deleteTask (id) { if (!confirm(`确认删除任务 #${id}（含已下载文件）？`)) return; try { await api(`/api/tasks/${id}`, { method: 'DELETE' }); refreshAll(); loadFiles() } catch (err) { toast(err.message, true) } }

async function loadFiles () {
  try {
    const data = await api('/api/files')
    FILES = data.files || []
    const body = $('#fileBody')
    if (!FILES.length) { body.innerHTML = '<tr><td colspan="5" class="empty">暂无已完成文件</td></tr>'; return }
    body.innerHTML = FILES.map(f => `<tr>
      <td>#${f.id}</td>
      <td style="word-break:break-all">${esc(f.file_name)}</td>
      <td>${fmtSize(f.file_size)}</td>
      <td>${f.bot_appid ? (f.target_type === 'group' ? '群聊' : '私聊') : '面板'}</td>
      <td>
        <button class="btn sm" onclick="downloadFile(${f.id})">⬇ 下载</button>
        <button class="btn sm" onclick="previewFile(${f.id})">👁 预览</button>
      </td>
    </tr>`).join('')
  } catch (err) { toast(err.message, true) }
}
$('#refreshFilesBtn').addEventListener('click', loadFiles)

async function loadConfig () {
  try {
    const { config } = await api('/api/config')
    $('#setTitle').value = config.title
    $('#setPort').value = config.port
    $('#setActive').value = config.max_active
    $('#setConc').value = config.max_concurrency
    $('#setAutoSend').value = config.max_auto_send_mb
    $('#setMaxFile').value = config.max_file_mb
    $('#setCleanup').value = config.cleanup_minutes
    $('#tokenBox').textContent = config.token
  } catch (err) { toast(err.message, true) }
}
$('#saveConfigBtn').addEventListener('click', async () => {
  try {
    const body = {
      title: $('#setTitle').value,
      port: Number($('#setPort').value),
      max_active: Number($('#setActive').value),
      max_concurrency: Number($('#setConc').value),
      max_auto_send_mb: Number($('#setAutoSend').value),
      max_file_mb: Number($('#setMaxFile').value),
      cleanup_minutes: Number($('#setCleanup').value)
    }
    const { port_changed } = await api('/api/config', { method: 'PUT', body })
    $('#configMsg').textContent = port_changed ? '已保存，端口切换中（约1-2秒），页面可能短暂断开' : '已保存'
    setTimeout(() => $('#configMsg').textContent = '', 3000)
    if (port_changed) setTimeout(() => { location.href = `http://${location.hostname}:${body.port}/` }, 1500)
  } catch (err) { toast(err.message, true) }
})
$('#resetTokenBtn').addEventListener('click', async () => {
  if (!confirm('重置后旧 token 立即失效，确认？')) return
  try {
    const { token } = await api('/api/config/reset-token', { method: 'POST' })
    $('#tokenBox').textContent = token
    localStorage.setItem('mapull_token', token)
    TOKEN = token
    toast('token 已重置')
  } catch (err) { toast(err.message, true) }
})

function connectWs () {
  if (ws) { try { ws.close() } catch {  } }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`)
  ws.onmessage = ev => {
    let msg = null
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.type === 'task' && msg.task) {
      const i = TASKS.findIndex(t => t.id === msg.task.id)
      if (i >= 0) TASKS[i] = msg.task
      else TASKS.unshift(msg.task)
      renderTasks()
    }
  }
  ws.onclose = () => { setTimeout(connectWs, 3000) }
  ws.onerror = () => { try { ws.close() } catch {  } }
}

(async function init () {
  if (TOKEN) {
    try { await api('/api/auth/verify'); enterMain(); return }
    catch {  }
  }
  showLogin()
})()
