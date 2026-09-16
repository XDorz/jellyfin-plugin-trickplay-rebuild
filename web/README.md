# Jellyfin Web 单视频预览图重建

在 **Jellyfin 原有影片/单集详情页**的下载按钮旁添加「图片＋刷新」图标，使用原生
`emby-button` / `detailButton` 样式。反馈调用 Jellyfin 的 `Dashboard.alert(string)`，
使用真正的原生 toast。无需修改服务器 Web 文件，也不另做详情页。

## 安装

1. Jellyfin 服务器先安装本仓库的 **Trickplay Rebuild 1.0.1.0** 插件，适配 12.0 / 12.1。
2. 浏览器安装 Tampermonkey 或兼容的用户脚本管理器。
3. 打开 [安装脚本](https://raw.githubusercontent.com/XDorz/jellyfin-plugin-trickplay-rebuild/main/web/trickplay-rebuild.user.js)，
   在脚本管理器中确认安装，然后刷新 Jellyfin 页面。
4. 使用管理员登录，打开影片或单集详情页，点击下载按钮后面的「重建预览图」。

也可以从本仓库以 `web-v` 开头的 Release 安装 `.user.js` 文件；服务器插件包仍以
`v1.0.1-build` 开头，两者独立发布。已安装 1.0.1.0 服务端插件的用户不需要更换 DLL。

自动匹配任意域名/端口下的 `/web/`、`/web/index.html`，以及
`/jellyfin/web/` 等子路径，不需要填写服务器地址。页面还必须具有 Jellyfin 标识、
原生客户端和详情页结构才会激活。无需 Python 服务或额外端口。

## 使用行为

- 仅为管理员及单个视频显示按钮；电视剧整季、合集、音乐和未登录页面不显示。
- 多版本视频使用页面原有的视频版本选择框；不会默默替换其他版本。
- 提交、重复请求、权限不足、插件缺失/不兼容及失败均使用原生提示。
- 排队/重建时在按钮组下显示状态，完成后自动消失。
- 只在当前详情页可见且任务活跃时每 10 秒读取状态；切页、注销会停止旧请求。
- 提交超时不会自动重新提交。网络中断后的提示会说明结果尚不确定。
- 中文界面使用中文提示，其余界面使用英文；图标跟随当前主题颜色。

脚本只影响安装它的浏览器；其他浏览器需要分别安装。Findroid Android 客户端不受影响。

## 安全与兼容边界

仅使用当前 Jellyfin 已登录会话。服务器与 Web 必须同源（普通 Docker 部署及同源反向
代理符合要求），保留配置的服务器子路径。不会把 token 写入 URL、DOM、日志或新存储，
不会发送带授权的重定向请求或跨域请求。没有远程运行依赖、统计服务、`eval` 或
`GM_xmlhttpRequest` 权限。GitHub 的脚本自动更新由用户脚本管理器处理。

脚本只添加自己的 DOM 节点和事件监听，不替换 `fetch`、播放行为或任何 Jellyfin
服务。所有重建操作仍由服务端插件验证管理权限、视频归属、任务去重及限流。

Jellyfin 服务端插件的标准 Web 扩展接口提供配置页面，没有影片操作栏的标准挂载点。
本脚本依赖 Jellyfin Web 12.0 / 12.1 的现有页面结构和公开给插件使用的客户端全局入口；
未来 Web 改版可能需要适配。独立托管并连接跨域服务器的 Web、Emby、Plex 和修改过入口
路径的第三方 Web 不在当前支持范围内。

## 开发验证

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
npm test
```

也可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 使用已安装的 Chromium。
浏览器测试覆盖多版本选择、管理员权限、重复提交、错误提示、轮询终止、账号切换、
子路径和跨域阻止。真实 Jellyfin Web 的验证记录见仓库根目录 `VALIDATION.md`。

源码依据：
[详情页](https://github.com/jellyfin/jellyfin-web/blob/v12.0/src/apps/legacy/controllers/itemDetails/index.html)、
[原生提示入口](https://github.com/jellyfin/jellyfin-web/blob/v12.0/src/utils/dashboard.js)、
[服务端配置页接口](https://github.com/jellyfin/jellyfin/blob/v12.0/MediaBrowser.Model/Plugins/IHasWebPages.cs)。
匹配路径参考 [EmbyToLocalPlayer](https://github.com/kjtsune/embyToLocalPlayer/blob/main/user_script/embyToLocalPlayer.user.js)
的通用 `/web/` 规则；未复制它的播放或请求拦截逻辑。
