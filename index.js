import * as ap from './apps/mapull.js'

ap.boot()

const PREFIX = '(拉取|墨安拉取|MApull|Mapull|mapull)'

export class MApullPlugin extends plugin {
  constructor () {
    super({
      name: '墨安拉取',
      dsc: '纯QQ命令 + Web 面板双通道下载：图片/视频/文件直链、m3u8 视频合并，完成后自动回传文件',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: new RegExp(`^#?${PREFIX}(帮助|help)?$`, 'i'), fnc: 'help' },
        { reg: new RegExp(`^#?${PREFIX}\\s*(下载|dl)\\s*(\\S+)$`, 'i'), fnc: 'download' },
        { reg: new RegExp(`^#?${PREFIX}\\s*https?:\\/\\/\\S+$`, 'i'), fnc: 'downloadQuick' },
        { reg: new RegExp(`^#?${PREFIX}(列表|任务|list)$`, 'i'), fnc: 'list' },
        { reg: new RegExp(`^#?${PREFIX}(状态|面板|地址)$`, 'i'), fnc: 'status' },
        { reg: new RegExp(`^#?${PREFIX}(删除|del|删)\\s+(\\d+)$`, 'i'), fnc: 'del' },
        { reg: new RegExp(`^#?${PREFIX}(清空|clear)$`, 'i'), fnc: 'clear' },
        { reg: new RegExp(`^#?${PREFIX}(设置|配置|set)\\s+(\\S+)\\s+(\\S+)$`, 'i'), fnc: 'settings' },
        { reg: new RegExp(`^#?${PREFIX}(重置|换)(token|令牌)$`, 'i'), fnc: 'resetToken' },
        { reg: new RegExp(`^#?${PREFIX}`, 'i'), fnc: 'fallback' }
      ]
    })
  }

  async help (e) { return ap.helpHandler(e) }

  async download (e) {
    const url = e.msg.replace(new RegExp(`^#?${PREFIX}\\s*(下载|dl)\\s*`, 'i'), '').trim()
    return ap.downloadHandler(e, url)
  }

  async downloadQuick (e) {
    const url = e.msg.replace(new RegExp(`^#?${PREFIX}\\s*`, 'i'), '').trim()
    return ap.downloadHandler(e, url)
  }

  async fallback (e) {
    return ap.fallbackHandler(e)
  }

  async list (e) { return ap.listHandler(e) }

  async status (e) {
    if (!e.isMaster) {
      await e.reply('暂无权限，只有主人才能操作')
      return true
    }
    return ap.statusHandler(e)
  }

  async del (e) {
    if (!e.isMaster) {
      await e.reply('暂无权限，只有主人才能操作')
      return true
    }
    return ap.deleteHandler(e, e.msg.match(/(\d+)/)?.[1])
  }

  async clear (e) {
    if (!e.isMaster) {
      await e.reply('暂无权限，只有主人才能操作')
      return true
    }
    return ap.clearHandler(e)
  }

  async settings (e) {
    if (!e.isMaster) {
      await e.reply('暂无权限，只有主人才能操作')
      return true
    }
    const m = e.msg.match(new RegExp(`^#?${PREFIX}(设置|配置|set)\\s+(\\S+)\\s+(\\S+)$`, 'i'))
    return ap.settingsHandler(e, m?.[2], m?.[3])
  }

  async resetToken (e) {
    if (!e.isMaster) {
      await e.reply('暂无权限，只有主人才能操作')
      return true
    }
    return ap.resetTokenHandler(e)
  }
}
