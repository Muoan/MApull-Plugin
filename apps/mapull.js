import os from 'node:os'
import * as store from '../components/store.js'
import * as qqbot from '../components/qqbot.js'
import * as downloader from '../components/downloader.js'
import * as server from '../components/server.js'

let started = false

export async function boot () {
  if (started) return
  started = true
  try {
    store.init()
    const bots = qqbot.init()
    if (bots.length) logger.mark(`[MApull] 识别到 ${bots.length} 个机器人: ${bots.map(b => b.uin).join(', ')}`)
    downloader.setBroadcaster(server.broadcast)
    await server.start()
    logger.mark('[MApull] 服务启动完成')

    setInterval(() => {
      try {
        const ttl = Number(store.getConfig().cleanup_minutes || 10)
        store.cleanupExpired(ttl)
      } catch {  }
    }, 60 * 1000)
    logger.mark(`[MApull] 自动清理已启用：回传成功后 ${store.getConfig().cleanup_minutes} 分钟删除文件`)
  } catch (err) {
    logger.error('[MApull] 启动失败:', err)
  }
}

function getLocalIps () {
  const list = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) list.push(info.address)
    }
  }
  return list
}

function helpGroups () {
  return [
    {
      name: '下载',
      list: [
        { key: '#拉取下载 <链接>', desc: '下载直链 / 图片 / 视频 / m3u8' },
        { key: '#拉取 <链接>', desc: '快捷下载（同上）' }
      ]
    },
    {
      name: '查询',
      list: [
        { key: '#拉取列表', desc: '查看最近任务列表' },
        { key: '#拉取状态', desc: '面板地址 + 登录 token' }
      ]
    },
    {
      name: '管理（仅主人）',
      list: [
        { key: '#拉取设置 <键> <值>', desc: '改配置：token/port/title/cleanup 等' },
        { key: '#拉取删除 <id>', desc: '删除任务及文件' },
        { key: '#拉取清空', desc: '清空已结束任务' },
        { key: '#拉取重置token', desc: '重置面板登录 token' }
      ]
    }
  ]
}

async function renderHelpImage (e) {
  try {
    const mod = await import('../../../lib/puppeteer/puppeteer.js')
    const puppeteer = mod.default || mod
    if (!puppeteer || typeof puppeteer.screenshot !== 'function') {
      logger?.error?.('[MApull] puppeteer 模块异常，keys:', Object.keys(mod))
      return null
    }
    const img = await puppeteer.screenshot('mapull/help', {
      tplFile: `${store.PLUGIN_DIR}/resources/help/help.html`,
      saveId: 'help',
      imgType: 'png',
      groups: helpGroups()
    })
    if (!img) logger?.error?.('[MApull] 帮助图片渲染返回空（screenshot 返回 false）')
    return img || null
  } catch (err) {
    logger?.error?.('[MApull] 帮助图片渲染失败:', err?.stack || err?.message || err)
    return null
  }
}

export function helpHandler (e) {

  renderHelpImage(e).then(img => {
    if (img) e.reply(img)
  })
  return true
}

export function fallbackHandler (e) {
  e.reply('没看懂这条命令…发 #拉取 查看帮助面板')
  return true
}

export function downloadHandler (e, url) {
  const u = String(url || '').trim()
  if (!/^https?:\/\/\S+$/i.test(u)) {
    e.reply('格式不对，示例：\n#拉取下载 <直链/m3u8/网页链接>\n或 #拉取 <链接>')
    return true
  }

  const bot = qqbot.findBySelfId(String(e.self_id || ''))
  if (!bot) {
    e.reply('❌ 未在 QQBot.yaml 找到机器人配置，无法回传文件')
    return true
  }
  const isGroup = e.message_type === 'group' || !!e.group_openid

  const targetId = isGroup ? String(e.group_id || '').replace(/^\d+:/, '') : String(e.user_id || '')
  const senderId = String(e.sender?.user_id || e.user_id || '').replace(/^\d+:/, '')
  const senderName = String(e.sender?.card || e.sender?.nickname || '')
  if (!targetId) {
    e.reply('❌ 无法识别会话 ID')
    return true
  }
  const task = store.createTask({
    url: u,
    kind: 'auto',
    title: '',
    bot_appid: bot.appid,
    target_type: isGroup ? 'group' : 'friend',
    target_id: targetId,
    sender_id: senderId,
    sender_name: senderName,
    self_id: String(e.self_id || '')
  })
  downloader.registerTaskEvent(task.id, e)
  downloader.submit(task)
  e.reply(`⏳ 已加入下载队列 #${task.id}\n${u}\n完成后会自动把文件发到这里`)
  return true
}

export function listHandler (e) {
  const tasks = store.listTasks(10)
  if (!tasks.length) {
    e.reply('还没有下载任务，试试 #拉取下载 <链接>')
    return true
  }
  const icon = { done: '✅', failed: '❌', downloading: '⏳', merging: '🔄', queued: '⏸', canceled: '🚫' }
  const lines = ['—— MApull 最近任务 ——']
  for (const t of tasks) {
    const pct = Math.round(t.progress || 0)
    const size = t.file_size ? ` ${(t.file_size / 1048576).toFixed(1)}MB` : t.total_size ? ` ${(t.total_size / 1048576).toFixed(1)}MB` : ''
    const name = t.file_name || t.title || t.url.replace(/^https?:\/\//, '').slice(0, 40)
    lines.push(`${icon[t.status] || '•'} #${t.id} [${t.status}] ${pct}%${size} ${name}`)
  }
  e.reply(lines.join('\n'))
  return true
}

export function statusHandler (e) {
  const cfg = store.getConfig()
  const lines = ['—— MApull 下载面板 ——', `标题: ${cfg.title}`, `端口: ${cfg.port}`, `token: ${cfg.token}`]
  for (const ip of getLocalIps()) lines.push(`内网: http://${ip}:${cfg.port}`)
  lines.push('浏览器打开后输入上方 token 登录')
  const bots = qqbot.list()
  if (bots.length) {
    lines.push('—— 机器人 ——')
    for (const b of bots) lines.push(`🟢 ${b.uin} (${b.appid})`)
  }
  e.reply(lines.join('\n'))
  return true
}

export function deleteHandler (e, id) {
  const n = Number(id)
  downloader.cancel(n)
  const ok = store.deleteTask(n)
  e.reply(ok ? `已删除任务 #${id}` : `任务 #${id} 不存在`)
  return true
}

export function clearHandler (e) {
  const n = store.clearFinished()
  e.reply(`已清空 ${n} 个已结束任务`)
  return true
}

export function resetTokenHandler (e) {
  const token = store.saveConfig({ token: store.randomToken() }).token
  e.reply(`已重置面板 token：\n${token}\n（旧 token 立即失效）`)
  return true
}

const SETTING_KEYS = {
  token: 'token',
  port: 'port',
  title: 'title',
  cleanup: 'cleanup_minutes',
  cleanup_minutes: 'cleanup_minutes',
  active: 'max_active',
  max_active: 'max_active',
  conc: 'max_concurrency',
  max_concurrency: 'max_concurrency',
  autosend: 'max_auto_send_mb',
  max_auto_send_mb: 'max_auto_send_mb',
  maxfile: 'max_file_mb',
  max_file_mb: 'max_file_mb',
  timeout: 'task_timeout_min',
  task_timeout_min: 'task_timeout_min'
}

const SETTING_HINTS = {
  token: '面板登录 token（可直接填自定义值）',
  port: '面板端口（1-2 秒后自动重监听，页面会短暂断开）',
  title: '面板标题',
  cleanup_minutes: '回传成功后自动删除文件的等待时间（分钟）',
  max_active: '同时下载任务数',
  max_concurrency: 'm3u8 分片并行数',
  max_auto_send_mb: '自动回传 QQ 的大小上限（MB）',
  max_file_mb: '单文件大小上限（MB）',
  task_timeout_min: '单任务超时（分钟）'
}

export function settingsHandler (e, key, value) {
  const k = SETTING_KEYS[String(key || '').toLowerCase()]
  if (!k) {
    e.reply(`不认识的配置项：${key}\n可用：token / port / title / cleanup / active / conc / autosend / maxfile / timeout`)
    return true
  }
  let v = String(value || '').trim()
  if (k === 'token') {
    if (v.length < 6) { e.reply('token 太短，至少 6 位'); return true }
    store.saveConfig({ token: v })
    e.reply(`✅ 面板 token 已更新：${v}\n（旧 token 立即失效）`)
    return true
  }
  const n = Number(v)
  if (!Number.isFinite(n)) { e.reply('请输入数字'); return true }
  const oldPort = store.getConfig().port
  store.saveConfig({ [k]: n })
  let extra = ''
  if (k === 'port') {
    extra = `\n🔄 端口切换中（约 1-2 秒），面板将改为 http://服务器IP:${n}`
    if (n !== oldPort) setTimeout(() => { try { server.restartListen(n, oldPort) } catch {  } }, 1200)
  }
  e.reply(`✅ 已设置 ${key} = ${v}${extra}`)
  return true
}
