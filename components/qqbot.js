import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_DIR } from './store.js'

let bots = []

export function readQQBotYamlTokens () {
  const candidates = [
    path.join(PLUGIN_DIR, '..', 'config', 'QQBot.yaml'),
    path.join(PLUGIN_DIR, '..', 'config', 'qqbot.yaml'),
    path.join(process.cwd(), 'config', 'QQBot.yaml'),
    path.join(process.cwd(), 'config', 'qqbot.yaml'),
    '/QQBOT/Yunzai/config/QQBot.yaml',
    '/QQBOT/Yunzai/config/qqbot.yaml'
  ]
  const seen = new Set()
  for (const p of candidates) {
    const abs = path.resolve(p)
    if (seen.has(abs) || !fs.existsSync(abs)) continue
    seen.add(abs)
    const s = fs.readFileSync(abs, 'utf8')
    const m = s.match(/token:\s*\n((?:\s*-\s*\S+\n?)+)/)
    if (!m) continue
    const out = []
    for (const line of m[1].split('\n')) {
      const t = line.trim().replace(/^-/, '').trim()
      if (!t) continue
      const parts = t.split(':')
      if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
        out.push({ uin: parts[0], appid: parts[1], secret: parts[2] })
      }
    }
    if (out.length) return out
  }
  return []
}

export function init () {
  bots = readQQBotYamlTokens()
  if (!bots.length) {
    console.warn('[MApull] 未从 QQBot.yaml 读取到机器人 token，QQ 回传功能不可用（面板功能不受影响）')
  }
  return bots
}

export function list () { return bots }

export function findBySelfId (selfId) {
  const sid = String(selfId || '')
  if (sid) {
    for (const b of bots) {
      if (String(b.uin) === sid) return b
    }
  }
  return bots[0] || null
}

export function findByAppid (appid) {
  for (const b of bots) {
    if (String(b.appid) === String(appid)) return b
  }
  return bots[0] || null
}
