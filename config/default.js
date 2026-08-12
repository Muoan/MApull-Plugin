export const DEFAULT_CONFIG = {
  port: 3006,                 // 面板服务端口
  token: '',                  // 面板登录 token（首次启动随机生成）
  title: '墨安拉取面板',       // 面板标题
  public_url: '',             // 面板公网地址（http://IP:端口），大文件回传用直链上传
  max_active: 2,              // 同时下载的任务数（其余排队）
  max_concurrency: 8,         // m3u8 分片并行下载数
  max_auto_send_mb: 90,       // 完成后自动回传 QQ 的文件大小上限(MB)，超过只保留面板下载
  max_file_mb: 500,           // 单文件下载大小上限(MB)
  task_timeout_min: 30,       // 单任务超时时间(分钟)
  cleanup_minutes: 10,        // 回传成功后自动删除文件的等待时间(分钟)
  verify_browser_only: true   // 直链下载需浏览器验证（临时 key，时长与清理时长一致；微信/QQ 内置浏览器拦截）
}
