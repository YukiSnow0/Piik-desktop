# Piik Desktop

**基于 [Piik](https://github.com/TNTcraftHIM/Piik)，借助 GPT / Codex 辅助二次开发产出的 Windows 桌面版。**

Piik Desktop 把 Piik 的分享和观看界面放进独立桌面窗口，无需打开系统浏览器。
底层屏幕采集、房间服务、语音与媒体传输继续使用原项目的官方运行时；桌面外壳通过
Electron 提供窗口、系统托盘和应用内更新等能力。

本项目是社区二次开发版本，并非 Piik 官方发布。原项目的核心功能与品牌资源归原作者及贡献者所有。

- 原项目：[TNTcraftHIM/Piik](https://github.com/TNTcraftHIM/Piik)
- 原项目国内镜像：[Gitee / TNTcraftHIM/Piik](https://gitee.com/TNTcraftHIM/Piik)
- 桌面版：[YukiSnow0/Piik-desktop](https://github.com/YukiSnow0/Piik-desktop)

## 功能

- **独立桌面窗口**：创建房间、打开朋友的完整邀请链接、分享和观看屏幕，保留 Piik 原有房间界面。
- **原生屏幕采集**：复用官方 Piik App 的 Windows 采集程序；支持的系统上可在整屏分享时排除语音软件的声音。
- **房间语音与互动**：沿用原项目的语音、聊天和支持的远程控制功能。
- **跟随上游更新**：启动时检查 Piik 正式发布版，也可手动检查、下载并重启应用更新。
- **GitHub / Gitee 更新源**：支持自动切换，或独立使用国内镜像检查与下载，并记住选择。
- **校验与恢复**：验证 SHA-256、组件完整性和候选内核启动；下载期间保留旧版，新版启动失败时回退并恢复配置。
- **系统托盘**：关闭窗口时选择隐藏到托盘、退出或取消，可记住偏好；通过托盘恢复窗口或完整退出。

当前桌面外壳版本为 **0.3.0**，初始内置 **Piik 2.5.0**。当前构建目标为 **Windows x64**。
原项目其他平台的支持情况不能直接视为本桌面外壳已支持这些平台。

## 跟随原项目更新

点击窗口顶部的 **更新**，或打开 **帮助 → 检查 Piik 更新**。

1. 选择更新源：**自动选源 / GitHub / 国内镜像**。
2. 发现新版后查看版本说明，选择 **下载更新**。
3. 下载并验证后选择 **重启并更新**，或继续使用当前版本，待下次启动应用更新。

自动模式优先 GitHub，失败后尝试 Gitee。选择国内镜像时，版本检查和下载均走 Gitee，
无需先连接 GitHub。更新不会在分享过程中强制重启；主动重启会结束当前房间、分享与语音。

**更新范围**：Piik 官方发布包中的界面、Go 房间服务、原生采集和辅助程序。

**更新边界**：不会自动编译原项目 `main` 上尚未发布的提交，也不会通过上游更新替换
这个社区桌面外壳或 Electron。外壳功能和 Electron 升级仍需安装新版桌面包。
上游若改变桌面外壳依赖的启动接口，候选验证会拒绝不兼容更新，需先升级桌面外壳。

## 使用便携版

将已构建的 Windows 压缩包**完整解压**到可写目录，运行 `Piik Desktop.exe`。
无需安装 Node.js 或 Go。请保留整个程序目录，不能只复制 EXE。

- 创建分享：选择 **本地房间** 或 **公网邀请**，进入后选择采集来源。
- 观看朋友：把完整 Piik 邀请链接粘贴到窗口顶部，点击 **加入朋友**。
- UU 联机：双方先进入同一 UU 组网房间，在 Piik 本地房间中选择 UU 虚拟 IPv4 地址。
- 房间语音：打开 **互动 → 语音**，由房主开启，成员自行加入与开麦。
- 托盘：关闭窗口时选 **隐藏到托盘**；单击或双击托盘图标恢复，右键可退出。
- 关闭偏好：通过 **窗口 → 关闭窗口选项** 或托盘右键菜单修改。

程序旁的 `Piik-Data` 保存桌面偏好、浏览器会话、原生配置和已下载的内核。
更换桌面安装包前先退出旧版，再把该文件夹保留或复制到新版程序旁。

桌面封装沿用 Piik 的网络连接机制，不会自动解决运营商 NAT、UDP 限制或组网带宽问题。

## 从源码运行与打包

需要 Windows x64、Node.js 24+ 和 npm。从仓库根目录执行：

```powershell
npm --prefix desktop ci
npm --prefix desktop run prepare:electron
npm --prefix desktop run prepare:runtime
npm run desktop:start
```

`prepare:runtime` 下载并校验固定版本的 Piik 官方 App，并准备共享色板与图标。
无需自行编译 Go、原生采集程序或原项目整个前端。

运行检查和打包：

```powershell
npm run desktop:test
npm run desktop:smoke
npm run desktop:package
```

便携程序输出至 `build/desktop-package/Piik Desktop-win32-x64`。
详细说明见 [桌面开发与使用说明](desktop/README.md)。

测试覆盖发布信息解析、GitHub/Gitee 更新、下载校验、候选启动、版本切换、配置回退、
桌面 IPC、关闭选项和托盘恢复。实际跨网分享、音视频效果和系统权限仍应在使用环境中验证。

## 仓库结构

```text
desktop/                     桌面外壳、更新器、托盘逻辑、打包脚本与测试
desktop/runtime.json         初始官方运行时的版本、地址与 SHA-256
public/favicon.svg           原 Piik 品牌图标
cmd/piik-app/piik.ico         原 Piik Windows 图标
src/client/ui/palette.css    原 Piik 共享色板
UPSTREAM.md                  上游来源与资源归属
```

本仓库聚焦桌面封装，不复制维护整个 Piik 服务端和媒体实现。
GPT / Codex 参与了桌面封装、更新机制、托盘交互及文档的辅助开发；底层能力继续来自原项目。

## 致谢与许可证

感谢 [TNTcraftHIM](https://github.com/TNTcraftHIM) 和 Piik 贡献者提供原项目。
本仓库保留原项目的 [MIT 许可证](LICENSE)，来源与复用资源见 [UPSTREAM.md](UPSTREAM.md)。
官方运行时及 Electron/Chromium 的第三方许可证和声明随构建包保留。
