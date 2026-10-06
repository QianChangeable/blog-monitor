# Hexo 控制台（hexo-blog-widget）

给 [~/Coding/Hexo](../../Hexo) 这一个博客用的迷你桌面小窗口，Windows / macOS 通用。

## 功能

| 功能 | 行为 |
|---|---|
| **打开线上博客** | 用系统默认浏览器打开 `https://qianchangeable.github.io/` |
| **本地预览开关** | 开：在 Hexo 目录跑 `hexo server -p 4000`，端口就绪后**自动用 Edge 打开** `http://localhost:4000/`；关：结束该服务 |
| **创建文章** | 按模板生成 `source/_posts/<目录>/<标题>.md`（目录可选，含 `LeetCode/hot100` 这类二级目录），写完交给系统默认程序打开 |
| **发布到线上** | `hexo clean` → `hexo generate` → `hexo deploy`，成功后打开线上地址；发布前自动停本地预览，发布后自动拉起 |
| **源码备份** | `git add -A` → `git commit -m "<提交信息>"` → `git push`，把 source 推到 `hexo-source` |

## 运行

```bash
cd ~/Coding/blog-widget     # Windows: F:\blog-widget
npm install                 # 只装 electron（+ 可选 electron-builder）
npm start
```

## 打包

```bash
npm run pack:mac     # → dist/Hexo 控制台.app
```

脚本用本地已装好的 `node_modules/electron/dist/Electron.app` 手工组包，**不引入
electron-builder**（它会为每个目标平台再下一份 Electron，还要拉 app-builder 二进制）。
本项目没有任何运行时依赖，所以包体只带自己的代码，不含 `node_modules`。

脚本做的事：复制 Electron.app（`rsync -a`，Framework 里的符号链接跟丢了就打不开）→ 改可执行
文件名 → 放入应用代码 → 由 `app-icon-mac.png` 生成 `.icns` → 写 `Info.plist` → 清隔离属性并
**重新 ad-hoc 签名**（改过包体后原签名已失效，不重签起不来）。

注意：

- 包约 282MB（Electron 框架本身），`dist/` 已在 `.gitignore` 里
- 是 **ad-hoc 签名**，本机双击可用；发给别人需要对方右键 →「打开」，或
  `xattr -dr com.apple.quarantine`。要正式分发得用开发者证书签名 + 公证
- 打包版与开发版**共用同一份 userData**（`~/Library/Application Support/hexo-blog-widget`），
  设置是通的；也共用单实例锁 —— 两个都开时，后启动的那个会自己退出
- Windows：`npm run dist:win`（需先 `npm i -D electron-builder`），或在 Windows 上照
  `scripts/build-mac-app.sh` 的思路组包。electron-builder 不能跨系统出包

## 创建文章的表单

| 字段 | 说明 |
|---|---|
| 标题 | **必填**；同时决定文件名（空格转 `-`，`\ / : * ? " < > \|` 转为 `-`，中文原样保留） |
| 日期 | 可留空 = 当前时间；接受 `2026-10-4`、`2026/10/04 9:5` 等写法，统一输出 `YYYY-MM-DD HH:mm:ss` |
| 目录 | 下拉列出 `source/_posts` 下的所有目录（递归到 4 层，如 `blog`、`LeetCode/hot100`、`diary/202609`）；选 `自定义…` 可手填还不存在的目录（如下个月的 `diary/202610`），创建时自动建好。选择会被记住，下一篇默认落在同一目录 |
| 分类 / 标签 | 逗号、中文逗号、`、`、分号分隔，可多个 |
| 置顶 sticky | 留空 = 不写该字段（不置顶）；数字越大越靠前，Fluid 主题按它降序排并显示图钉 |
| 摘要 | 不填则写入 `可花谢花开，终有梦醒时分.` |

生成结果（与仓库里现有文章的写法一致）：

```markdown
---
title: Git使用
date: 2026-10-05 14:03:22
categories:
- Git
tags:
- Git
sticky: 99
---

可花谢花开，终有梦醒时分.

<!--more-->
```

同名文件已存在时**拒绝覆盖**，会提示改名。目录名会做校验：`..`、绝对路径、Windows 非法字符一律拒绝，最终路径必须落在 `source/_posts` 之内。

展开「新建文章」卡片时会重新扫描一次目录，所以在编辑器或 Finder 里新建的文件夹不用重启就能出现在下拉里。

## 设置

底部齿轮打开设置面板，分「站点 / 外观 / 行为」三张折叠卡，右侧摘要常显当前状态。

顶部是一条**打字机标语**（对标 token-monitor 的 TOTAL TOKENS 位置）：文案、打印速度、光标字符、是否循环都在「标语」卡片里改，**纯本地、不联网**。打印速度与光标字符的语义和你 Hexo 主题 `_config.fluid.yml` 的 `fun_features.typing` 一致（`typeSpeed` 越大越慢、`cursorChar` 是光标字符、`loop` 关掉则打完最后一条停下）；多条内容每行一条，会依次打完再回删。

底栏左侧是分区胶囊（点击跳下一个分区，箭头展开菜单），中间是状态文字，右侧是刷新按钮（重读设置、预览状态、文章目录与背景图）和设置齿轮。

**改动即保存，没有保存按钮**：文本框防抖 700ms 后落盘，开关和滑块在松手时落盘。
保存失败（比如 Hexo 目录不存在）只在底栏状态行显示红字，不弹提示——否则在输入框里打字时会被错误提示刷屏。

配置存在 `userData/settings.json`：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/hexo-blog-widget/settings.json` |
| Windows | `%APPDATA%\hexo-blog-widget\settings.json` |

默认 Hexo 目录：macOS `~/Coding/Hexo`，Windows `F:\Hexo`（可在设置里改）。

## 行为约定

- **关闭窗口不会停掉预览**：`hexo server` 是分离进程，窗口只是个遥控器。重新打开窗口开关会显示为「开」，关掉它才会结束服务。
- **只杀自己人**：停止预览时只会结束命令行里含 `hexo`（或该 Hexo 目录）的监听进程；`:4000` 上如果是别的程序，会明确提示并跳过，不会误杀。
- 启动日志写在 `userData/preview.log`，启动失败时会把最后几行直接显示在窗口里。
- 预览默认开在 4000 端口，和仓库里的 `shell/preview.sh` 一致，不会打架。

## 目录结构

```
main.js            Electron 主进程：窗口、IPC、编排
preload.js         contextBridge 白名单（渲染层无 Node 权限）
lib/config.js      设置读写与校验
lib/posts.js       front-matter 生成与落盘
lib/preview.js     hexo server 启停、端口探测、进程回收
lib/hexo.js        启动 hexo CLI 的统一方式（预览与发布共用同一份）
lib/background.js  背景图导入（缩放后存成 userData 下的 PNG）
lib/deploy.js      发布流水线（clean/generate/deploy）与源码备份
lib/browser.js     Edge / 默认浏览器
renderer/          小窗口界面（原生 HTML/CSS/JS，无框架）
renderer/icons/    行首、底栏与设置卡片图标（自绘 + Lucide，见 icons/THIRD_PARTY_NOTICES.md）
scripts/build-mac-app.sh  用本地 Electron 手工组装 .app
scripts/memory-bench.sh   内存基准（隔离 userData 起一个实例，按进程采样）
```

## 内存

这是个常驻的小窗口，值得盯一下占用。`scripts/memory-bench.sh` 会把 app 跑在一个
隔离的 userData 目录里（不碰你正在用的那个实例），按进程采样 macOS 的
`phys_footprint`（就是活动监视器"内存"那一列）：

```bash
npm run bench:memory                      # 本仓库源码，30 秒
bash scripts/memory-bench.sh dist/QianChang.app 打包产物 30
```

两点细节，不然数字没法比：

- **窗口是不是在最前会被记下来。** Chromium 判定窗口被遮挡后会停掉合成、把 surface
  还回去，GPU 进程能掉一半以上。脚本按"窗口在最前"的采样单独给一份中位数。
- **`--no-sandbox`。** 从已经被沙箱包着的宿主（编辑器、自动化）里跑时，Chromium
  自己的沙箱进程起不来；测试实例统一关掉，两边口径一致。

### 目前的口径（macOS，窗口在最前，各进程稳定态中位数）

下面这一组全部来自 `npm run bench:memory`（仓库源码、隔离 userData、窗口在最前），
口径一致、随时可复现：

| | main | GPU | renderer | network | 合计 |
|---|---|---|---|---|---|
| 最初的样子 | 84 | 153 | 37 | 7 | **280 MB** |
| 现在 · 光标不闪 | 50 | 53 | 35 | 7 | **145 MB** |
| 现在 · 光标闪烁（**当前默认**） | 50 | 144 | 36 | 7 | **~237 MB** |
| token-monitor（同机器同口径） | 157 | 67 | 132 | 7 | 363 MB |

打包产物 `dist/QianChang.app` 用同样的采样方式、跑在真实设置下：最初 **325 MB**
（main 83 / GPU 191 / renderer 45 / network 6），把下面第 2–4 条改完之后 **178 MB**
（59 / 58 / 55 / 6）。那一次的 191MB GPU 里同样含着光标闪烁。

### 地板在哪

用同一套口径跑一个**空窗口**（一个 `BrowserWindow` + 一页空白 HTML，没有 preload、
没有内容）作对照：

| | main | GPU | renderer | network | 合计 |
|---|---|---|---|---|---|
| 空 Electron 窗口（不透明） | 39 | 12 | 16 | 7 | **74 MB** |
| 空 Electron 窗口（`transparent` + `frame:false`，同本项目的窗口配置） | 39 | 12 | 16 | 7 | **74 MB** |
| 本项目（光标不闪 / 光标闪） | 50 | 53 / 144 | 35 | 7 | 145 / 237 MB |

也就是说：**74MB 是 Electron 的入场费，本项目这套界面本身再花 ~70MB（光标不闪）
到 ~160MB（光标闪）**。
`transparent` / `frame:false` 那一组窗口配置一分钱都不多花。想再往下压就得换掉
Electron（原生 Swift/AppKit 做同样的事大约 30–60MB）。

### 唯一没省的一处：光标闪烁

打字机的 `loop` 是 false —— 打完最后一条就只剩光标一直闪，这个 `infinite` 动画会跟着
窗口开一整天。只要它在跑，渲染层就一直在出帧，GPU 进程的 surface 池永远不退，值
**~90MB**（同一个窗口 53MB ↔ 144MB）。

这是**唯一一处"知道能省、但选择留着"**的地方：省掉它光标就不闪了。为确认没有便宜的
替代，试过三种写法，全都不省 —— 350ms 定时器切 class（每秒 ~3 帧而不是 60 帧）、把窗口
改成不透明、只在逐字时闪（那样打完就不闪，正是要避免的）。所以这 ~90MB 买的是
"光标会闪"本身，跟帧率和透明窗口都无关。哪天不想要了，把 `styles.css` 里
`.typed-cursor` 的 `animation` 改回 `none` 即可。

### 真正省下来的三处（按贡献排序）

1. **内层控件上的 backdrop-filter（~70MB GPU）。** `.shell` 已经 blur 过一次桌面，
   长在它里面的 `.icon-button` / `.tabs` / `.activity-tooltip` / `.view-switcher-menu`
   / `.refresh-button` 再模糊一次看不出来，但每一个都要自己的一张合成 surface。
   **现在全窗口只有 `.shell` 和 `.toast` 两层真模糊**（`.toast` 是 `.shell` 的兄弟节点，
   那层是有意义的）。新加控件时默认不要写 backdrop-filter。
2. **Dock 图标按 1024×1024 解码（~33MB main）。** Dock 最大只画到 128pt，Retina 下
   256px 就够；原图解码出来的位图会一直挂在主进程里。现在 `app.dock.setIcon` 之前先
   `resize` 到 256（`DOCK_ICON_PX`），1024 的原图仍然留给打包脚本生成 `.icns`。
   另外 `BrowserWindow` 的 `icon` 在 macOS 上是被忽略的，传进去照样解码，所以
   `windowIconOption()` 只在 Windows 上挂。
3. **玻璃拉到 100 之后还在 blur（~16MB GPU）。** `glassOpacity` = 100 时 `.shell` 的
   底色已经完全盖住背后，那层 blur 一点都透不出来。`applyGlass()` 现在会在
   `opacity >= 100` 时把 `--glass-filter` 换成 `none`（模糊参数留在 CSS 的
   `--glass-blur` 里，JS 不复制一份），拉回 99 或更低就自动装回去。

还有一处**看起来反直觉但实测无关**的：窗口的 `transparent: true` 对内存没有影响 ——
光标闪烁开着时，透明窗口 237MB 和把它改成不透明后的 234–245MB 拉不开差距。

`backgroundThrottling: false`（三个窗口上都写着，为的是躲开切回窗口时那一两帧未模糊
的"灰"，以及被压住的提示框定时器）**曾经被怀疑是主因，实测不是**：把上面几条改完
之后，这一行开着和关掉都是 ~53MB GPU、总量 145MB 上下（不含光标闪烁），差别落在
噪声里。所以它照旧留着 —— 遮挡时不挂起合成，就不会有灰闪，也不再为它付出内存代价。


## 发布与备份

「发布与备份」卡片里三个动作：

| 动作 | 做什么 |
|---|---|
| 发布到线上 | `hexo clean` → `hexo generate` → `hexo deploy`，成功后打开线上地址 |
| 提交并推送源码 | `git add -A` → `git commit -m "<提交信息>"` → `git push`，备份到 `hexo-source` |
| 发布 + 备份 | 上面两步连着做；发布失败就不备份 |

输出实时打在卡片里的日志区，可以选中复制，只保留最近 400 行。

**发布前自动停本地预览，发布成功后自动拉起**。这不是洁癖：`hexo server` 默认不是纯静态服务，它会 `watch()` 源码并持续往 `public/` 里重新生成（见 `hexo-server/lib/server.js`），而 `hexo clean` 正好删掉 `public/`。两个进程同时写一个目录时，`hexo deploy` 可能把生成到一半的站点推上线。仓库里原有的 `shell/deploy.sh` 第一行就是停预览，同一个原因。

### 发布通道必须可达

发布走 `_config.yml` 里 `deploy.repository` 那个地址。本机实测：

| 通道 | 用途 | 结果 |
|---|---|---|
| `ssh git@github.com` | 源码备份 push | 3/3 成功，免密 |
| `https://github.com/...` | `hexo deploy` | 10/10 超时（443 被拦） |

所以在这台 Mac 上不挂代理直接点「发布」，`git push` 会静默挂住。控件的处理是：

1. **发布前预检**：先用 `git ls-remote` 探一次通道，12s 没响应就直接中止，并提示开代理、或临时把 `deploy.repository` 换成 SSH 地址。不会白跑一遍 `clean` + `generate`。
2. **空闲超时**：万一预检被跳过（比如解析不出 deploy 地址），每一步还有 60s 的空闲超时——没有任何输出就判定卡死，杀掉整个进程组并报出来。

git 相关步骤统一带 `GIT_TERMINAL_PROMPT=0` 和 `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`，所以凭据缺失或密钥需要输密码时会**立刻报错，而不是弹不出框地挂住**。Windows 上如果 443 正常，什么都不用改。

## 常见问题

**点「本地预览」后，Dock 里多出一个写着 `exec` 的图标**

那是 macOS 给"没有图标资源的可执行文件"用的通用占位图标。原因是 `process.execPath` 指向
`.app` 包内的 Electron 二进制：即使加上 `ELECTRON_RUN_AS_NODE=1` 让它确实跑成 Node
（进程表里 comm 是 `hexo`、日志里自称 `(node:pid)`、也没有任何 Helper 子进程），macOS 仍会把
这个进程登记成一个应用，并因此给它一个 Dock 图标。

所以 `lib/hexo.js` 会按 `npm_node_execpath → PATH → /opt/homebrew → /usr/local → nvm 最新版`
的顺序找一个**真正的 node**（进程不在 `.app` 包内，macOS 不会给它 Dock 图标）；只有全都找不到时
才退回上面那种方式 —— 功能一样正常，代价就是这个多出来的图标。


**macOS 上 `npm start` 直接闪退，报 `exited with signal SIGKILL`**

Electron 官方二进制是 adhoc 签名。如果解压后带着 `com.apple.quarantine` 隔离标记，Gatekeeper 会直接杀掉进程。清一次即可：

```bash
xattr -dr com.apple.quarantine node_modules/electron/dist/Electron.app
```

手动下载 zip 解压才会带这个标记；走 `npm install` 的 postinstall 不带。

**`npm install` 跑完了，但 `node_modules/electron/dist` 不存在**

npm 11 的 `allowScripts` 策略会拦住 electron 的 postinstall，二进制根本没下载（`path.txt` 也不会有）。手动补：

```bash
cd node_modules/electron
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
```

GitHub releases 在部分网络下取不到包，走上面的 npmmirror 镜像即可。也可以自己下载
`https://npmmirror.com/mirrors/electron/<版本>/electron-v<版本>-darwin-arm64.zip`
后解压到 `node_modules/electron/dist/`，并写入 `path.txt`：

```bash
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
```

注意 `path.txt` **不能带结尾换行**，electron 读取时不 trim。

**npm 报 `EPERM: mkdir ~/.npm/_cacache`**

`~/.npm` 权限或缓存目录不可写。`sudo chown -R $(id -u):$(id -g) ~/.npm` 修一次即可。
