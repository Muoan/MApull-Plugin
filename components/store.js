import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_CONFIG } from '../config/default.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_DIR = path.resolve(__dirname, '..')
export const DATA_DIR = path.join(PLUGIN_DIR, 'data')
export const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads')
export const TMP_DIR = path.join(DATA_DIR, 'tmp')
export const WEB_DIR = path.join(PLUGIN_DIR, 'web')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const DB_PATH = path.join(DATA_DIR, 'mapull.db')

let db = null
let config = null

export function randomToken () {
  return crypto.randomBytes(12).toString('base64url')
}

export function getConfig () {
  if (config) return config
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch {  }
  config = { ...DEFAULT_CONFIG, ...saved }
  if (!config.token) {
    config.token = randomToken()
    saveConfig({})
  }
  return config
}

export function saveConfig (patch = {}) {
  getConfig()
  Object.assign(config, patch)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  return config
}

export function init () {
  getConfig()
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })
  db = new DatabaseSync(DB_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      kind TEXT DEFAULT 'auto',
      title TEXT DEFAULT '',
      status TEXT DEFAULT 'queued',
      progress REAL DEFAULT 0,
      downloaded_size INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      speed REAL DEFAULT 0,
      file_path TEXT DEFAULT '',
      file_name TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      error TEXT DEFAULT '',
      bot_appid TEXT DEFAULT '',
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      sender_id TEXT DEFAULT '',
      sender_name TEXT DEFAULT '',
      self_id TEXT DEFAULT '',
      created_at INTEGER,
      finished_at INTEGER DEFAULT 0,
      sent_at INTEGER DEFAULT 0,
      file_deleted INTEGER DEFAULT 0
    )
  `)

  const cols = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name))
  if (!cols.has('sent_at')) db.exec('ALTER TABLE tasks ADD COLUMN sent_at INTEGER DEFAULT 0')
  if (!cols.has('file_deleted')) db.exec('ALTER TABLE tasks ADD COLUMN file_deleted INTEGER DEFAULT 0')
  if (!cols.has('self_id')) db.exec('ALTER TABLE tasks ADD COLUMN self_id TEXT DEFAULT \'\'')
}

export function createTask (data) {
  const now = Date.now()
  const info = db.prepare(`
    INSERT INTO tasks (url, kind, title, status, bot_appid, target_type, target_id, sender_id, sender_name, self_id, created_at)
    VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(data.url || ''), String(data.kind || 'auto'), String(data.title || ''),
    String(data.bot_appid || ''), String(data.target_type || ''), String(data.target_id || ''),
    String(data.sender_id || ''), String(data.sender_name || ''), String(data.self_id || ''), now
  )
  return getTask(Number(info.lastInsertRowid))
}

export function getTask (id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id)) || null
}

export function listTasks (limit = 50) {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 50, 200))
}

export function updateTask (id, patch) {
  const keys = Object.keys(patch).filter(k => k !== 'id')
  if (!keys.length) return getTask(id)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const vals = keys.map(k => patch[k])
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...vals, Number(id))
  return getTask(id)
}

export function deleteTask (id) {
  const t = getTask(id)
  if (!t) return false
  if (t.file_path && fs.existsSync(t.file_path)) {
    try { fs.rmSync(t.file_path, { force: true }) } catch {  }
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id))
  return true
}

export function clearFinished () {
  const rows = db.prepare("SELECT * FROM tasks WHERE status IN ('done','failed','canceled')").all()
  for (const r of rows) deleteTask(r.id)
  return rows.length
}

export function markSent (id) {
  return updateTask(id, { sent_at: Date.now() })
}

export function cleanupExpired (ttlMin = 10) {
  if (!db) return 0
  const cutoff = Date.now() - (Number(ttlMin) || 10) * 60 * 1000
  const rows = db.prepare("SELECT id, file_path FROM tasks WHERE status = 'done' AND sent_at > 0 AND file_deleted = 0 AND file_path != '' AND sent_at < ?").all(cutoff)
  let n = 0
  for (const r of rows) {
    if (r.file_path && fs.existsSync(r.file_path)) {
      try { fs.rmSync(r.file_path, { force: true }) } catch {  }
    }
    updateTask(r.id, { file_deleted: 1 })
    n++
  }
  if (n) console.log(`[MApull] 自动清理 ${n} 个已回传文件`)
  return n
}

export function listDoneFiles () {
  return db.prepare("SELECT id, url, kind, title, file_path, file_name, file_size, status, created_at, finished_at, sent_at, file_deleted FROM tasks WHERE status = 'done' AND file_path != '' AND file_deleted = 0 ORDER BY finished_at DESC").all()
}
