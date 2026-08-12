# ⬇️墨安拉取-plugin 插件说明

****
## 😍插件介绍：
**提供纯 QQ 命令 + Web 面板双通道下载功能：图片 / 视频 / 文件直链一键下载，m3u8 视频自动并行下载分片并用 ffmpeg 合并成 mp4；回传走「浏览器验证直链」，仅发链接不传文件，通用发送通道不挑适配器（QQBot / OneBot 等均可）**


****

# 😒安装插件：
<details>
  <summary>展开/收起</summary>

**github：**

`git clone --depth=1 https://github.com/Muoan/MApull-Plugin.git ./plugins/MApull-Plugin/`

**gitee：**

`git clone --depth=1 https://gitee.com/muoan/MApull-Plugin.git ./plugins/MApull-Plugin/`

**gitcode：**

`git clone --depth=1 https://gicode.com/muoan/MApull-Plugin.git ./plugins/MApull-Plugin/`

或手动将 MApull-Plugin 文件夹放入 `./plugins/` 目录下，重启云崽即可

</details>

****
# 😁安装依赖：
<details>
<summary>展开/收起</summary>

`pnpm i`

`pnpm install --filter=MApull-Plugin`


</details>

****
# 😘功能介绍
<details>
<summary>展开/收起</summary>

| 功能名称 | 功能命令 | 功能讲解 |
| ---- | ---- | ---- |
| 帮助 | `#拉取` / `#拉取帮助` | 渲染图片版帮助面板 |
| 下载 | `#拉取下载+链接` / `#拉取+链接` | 下载图片/视频/文件直链、m3u8 视频（自动合并mp4）、网页链接（自动提取直链） |
| 任务列表 | `#拉取列表` | 查看最近下载任务 |
| 面板状态 | `#拉取状态` | 面板地址 + 登录 token（仅主人） |
| 删除任务 | `#拉取删除+id` | 删除任务及已下载文件（仅主人） |
| 清空任务 | `#拉取清空` | 清空已结束任务（仅主人） |
| 修改配置 | `#拉取设置+键+值` | 修改 token/端口/标题/清理时间/并发等（仅主人） |
| 重置token | `#拉取重置token` | 重置面板登录 token（仅主人） |
| 自动回传 | 自动 | QQ 发起的任务下载完成后自动把「浏览器验证直链」发回原会话：点链接进入验证页，通过后即可查看/下载（临时 key 有效期=清理时长） |
| 直链验证 | 自动 | 直链仅限浏览器打开：微信/QQ 内置浏览器拦截提示；验证页自动生成临时 key，成功才显示下载/预览按钮 |
| 自动清理 | 自动 | 文件回传成功后默认 10 分钟自动删除，可 `#拉取设置 cleanup 分钟` 调整（直链 key 有效期同步） |
| Web 面板 | 自动 | 浏览器管理：新建任务/实时进度/文件预览（图片视频音频）/配置管理 |

</details>

****
# 😍其他：

**本插件仅提供拉取下载与短期预览，对内容不做审查，不记录使用者信息，如有问题概不负责**

