import fs from 'node:fs'

global.logger = {
  debug: (...a) => console.log('[debug]', ...a),
  info: (...a) => console.log('[info]', ...a),
  mark: (...a) => console.log('[mark]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  green: (s) => s, red: (s) => s, yellow: (s) => s, blue: (s) => s
}
global.segment = { image: (b) => ({ type: 'image', file: b }) }
global.redis = {
  set: async () => 'OK',
  get: async () => null,
  del: async () => 1,
  expire: async () => 1
}

process.chdir('/QQBOT/Yunzai')

const rendererFn = (await import('/QQBOT/Yunzai/renderers/puppeteer/index.js')).default
const renderer = rendererFn({})
if (!renderer?.render) { console.error('无可用渲染器'); process.exit(1) }
console.log('渲染器:', renderer.id)

const groups = [
  { name: '下载', list: [
    { key: '#拉取下载 <链接>', desc: '下载直链 / 图片 / 视频 / m3u8' },
    { key: '#拉取 <链接>', desc: '快捷下载（同上）' }
  ]},
  { name: '查询', list: [
    { key: '#拉取列表', desc: '查看最近任务列表' },
    { key: '#拉取状态', desc: '面板地址 + 登录 token' }
  ]},
  { name: '管理（仅主人）', list: [
    { key: '#拉取删除 <id>', desc: '删除任务及文件' },
    { key: '#拉取清空', desc: '清空已结束任务' },
    { key: '#拉取重置token', desc: '重置面板登录 token' }
  ]}
]

const out = await renderer.render('mapull/help', {
  tplFile: '/QQBOT/Yunzai/plugins/MApull-Plugin/resources/help/help.html',
  saveId: 'test',
  imgType: 'png',
  groups
})
if (!out || !out.length) { console.error('渲染返回空'); process.exit(1) }
const buf = Buffer.isBuffer(out) ? out : (Array.isArray(out) ? out[0] : out)
if (!Buffer.isBuffer(buf)) { console.error('返回类型异常:', typeof out); process.exit(1) }
fs.writeFileSync('/tmp/mapull_help_test.png', buf)
console.log('渲染成功:', (buf.length / 1024).toFixed(1) + 'KB → /tmp/mapull_help_test.png')
process.exit(0)
