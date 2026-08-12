import fs from 'node:fs'
import * as store from '../components/store.js'
import * as qqbot from '../components/qqbot.js'
import * as downloader from '../components/downloader.js'
import * as server from '../components/server.js'

store.init()
const bots = qqbot.init()
console.log('[test] 机器人数量:', bots.length, bots.map(b => ({ uin: b.uin, appid: String(b.appid).slice(0, 4) + '***' })))
downloader.setBroadcaster(() => {})
await server.start()

const cfg = store.getConfig()
console.log('[test] 面板端口:', cfg.port, 'token 前4位:', cfg.token.slice(0, 4) + '***')

const login = await fetch(`http://127.0.0.1:${cfg.port}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cfg.token })
}).then(r => r.json())
console.log('[test] 登录:', login.ok ? 'OK' : 'FAIL')

const unauth = await fetch(`http://127.0.0.1:${cfg.port}/api/tasks`).then(r => r.status)
console.log('[test] 未授权状态码(期望401):', unauth)

const url = process.env.TEST_URL || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
const created = await fetch(`http://127.0.0.1:${cfg.port}/api/tasks`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
  body: JSON.stringify({ url })
}).then(r => r.json())
const id = created.task.id
console.log('[test] 已创建任务 #' + id, url)

const deadline = Date.now() + 10 * 60 * 1000
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 3000))
  const { task } = await fetch(`http://127.0.0.1:${cfg.port}/api/tasks/${id}`, { headers: { Authorization: 'Bearer ' + cfg.token } }).then(r => r.json())
  const pct = Math.round(task.progress || 0)
  console.log(`[test] #${id} ${task.status} ${pct}% ${(task.downloaded_size / 1048576).toFixed(1)}MB ${task.speed ? (task.speed / 1048576).toFixed(2) + 'MB/s' : ''}`)
  if (task.status === 'done') {
    console.log('[test] ✅ 完成:', task.file_name, (task.file_size / 1048576).toFixed(1) + 'MB')
    console.log('[test] 文件存在:', fs.existsSync(task.file_path))
    const probe = JSON.parse(await import('node:child_process').then(p => p.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', task.file_path]).toString()))
    console.log('[test] ffprobe 时长:', probe.format?.duration, '秒')
    process.exit(0)
  }
  if (task.status === 'failed') {
    console.log('[test] ❌ 失败:', task.error)
    process.exit(1)
  }
}
console.log('[test] ⏰ 超时')
process.exit(2)
