<p align="center">
  <img src="https://raw.githubusercontent.com/lvxianchao/dsh-web-guard/main/docs/logo.svg" width="96" height="96" alt="DSH Web Guard">
</p>

<h1 align="center">DSH Web Guard</h1>

<p align="center">
  给 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>（DSH）Web UI 加一道<strong>密码闸门</strong>——
  一个插件同时解决四件部署上的麻烦事，并提供原生的设置页。
</p>

<p align="center"><a href="README.md">English</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@lvxianchao/dsh-web-guard"><img src="https://img.shields.io/npm/v/@lvxianchao/dsh-web-guard?color=0ab887" alt="npm 版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@lvxianchao/dsh-web-guard" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/node/v/@lvxianchao/dsh-web-guard" alt="Node.js >= 22.19">
  <img src="https://img.shields.io/badge/runtime_dependencies-0-brightgreen" alt="零运行时依赖">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek_Harness-plugin-0e7490" alt="DeepSeek Harness 插件"></a>
  <img src="https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.1%20%3C0.3.0-0e7490" alt="DSH >= 0.2.2-rc.1">
</p>

| 麻烦 | 原生表现 | dsh-web-guard |
|---|---|---|
| 没有人类登录 | 只有进程启动时打印的 `?token=`，重启就换 | 一个访问密码 + 可吊销会话 |
| 反代一律 403 | `/api` 栅栏要求 `Host` 原样转发，NPM/Caddy 通常会改写 | 代理把 `Host`/`Origin` 改写成回环 authority 并丢掉 `Referer`，栅栏和做回环校验的插件都放行 |
| token 要挖日志 | `journalctl \| grep token` 才能进站 | 进程内自动兑换，浏览器永远见不到 token |
| 明文 HTTP 功能报错 | 非安全上下文下 `crypto.randomUUID is not a function` | 注入 polyfill 兜底 |

零运行时依赖（只用 Node 标准库）。npm 包里是预构建好的 JavaScript，所以 `dsh plugin add` 不需要任何工具链；从源码 checkout 构建是维护者命令（`npm run build`）。

要求 **DeepSeek Harness `0.2.2-rc.1` 或更新版本**（`engines.dsh: >=0.2.2-rc.1 <0.3.0`）。宿主版本不匹配时整个 bundle 会被跳过——对一道前门来说等于闸门不启动，所以请升级 DSH，而不是删掉插件。

## 截图

<p align="center">
  <img src="https://raw.githubusercontent.com/lvxianchao/dsh-web-guard/main/docs/login.png" width="47%" alt="登录页">
  &nbsp;
  <img src="https://raw.githubusercontent.com/lvxianchao/dsh-web-guard/main/docs/logout.png" width="47%" alt="退出页">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/lvxianchao/dsh-web-guard/main/docs/settings.png" width="92%" alt="原生安全设置页">
</p>

<p align="center"><sub>登录页 &nbsp;·&nbsp; 退出确认页 &nbsp;·&nbsp; DSH 设置面板里的原生 DSH Web Guard 页（跟随 DSH 明暗主题）</sub></p>

## 它怎么工作

```
浏览器 ──HTTP(S)──> dsh-web-guard :3081 ──> DSH 监听器 (回环)
                        │
                        ├─ 未登录：/login
                        ├─ 已登录：转发，Host/Origin 改写为回环 authority，丢弃 Referer
                        └─ 注入 DSH cookie（浏览器不可见）
```

DSH 的 `/api` 栅栏接受回环 authority；代理让每个上游请求都看起来来自回环，所以不再 403。密码验证发生在代理里，**不是前端遮罩**——没有 cookie 的请求在进入 DSH 之前就被挡下。

浏览器半（`dsh.client`）只负责把管理页挂进 DSH 的设置面板；闸门本身完全在服务端，即使浏览器半加载失败也照常工作。

## 安装

```bash
# npm
dsh plugin --profile web add @lvxianchao/dsh-web-guard

# 从 GitHub 安装
dsh plugin --profile web add "github:lvxianchao/dsh-web-guard"

# 从本地目录安装
dsh plugin --profile web add /path/to/dsh-web-guard
```

`main` 只放已发布的代码（开发在 `dev` 分支），所以这条命令装到的就是最新稳定版。装完即挂载——包内声明了 `dsh.bundle`，guard 行会自动叠加。重启 `dsh`。

**首次启动会自动生成一个密码**，打印在终端并保存到 `<profile>/data/dsh-web-guard.json`（0600）。
想固定密码就在 `~/.dsh/profiles/web/cordis.patch.yml` 里加一行覆盖（profile patch 优先于 bundle 默认值）：

```yaml
- id: guard
  config:
    listenHost: '0.0.0.0'
    listenPort: 3081
```

注意 profile patch 会整体替换 `config`，要改的键都得重写一遍。

**从 v2 升级**：右下角的浮动盾牌和 `/__guard/admin` 已移除，管理入口改为 **设置 → DSH Web Guard**。重新安装（或升级到 `3.0.0`）并重启 DSH 即可；密码哈希、会话缓存和设置文件格式不变，升级不会把人踢下线，原有配置也会保留。

> 前提：DSH 自己必须绑回环（默认就是 `127.0.0.1`）。如果它绑在局域网 IP 上，客户端可以绕过闸门直连——插件启动时会检测并告警。

## ⚠️ 这是入口，不是可以随手关掉的插件

装上之后，**dsh-web-guard 就是唯一入口**：它监听 3081，把请求转给只听回环的 DSH（3080）。插件一旦不加载，3081 就不再监听，**内网和外网会同时打不开**——而 DSH 本体还活着，会话和数据都在，只是你够不着它。

特别提醒：**如果你把这个地址开放到了外网，这一条要格外当心。** 关掉插件等于把门焊死，而你正站在门外。

所以请记住三件事：

1. **不要卸载它，也不要让它被禁用。** 具体是：不要执行 `dsh plugin --profile web remove @lvxianchao/dsh-web-guard`；不要从 profile 的 `package.json` 里删掉 `dsh.profile.bundles` 中的这一项；也不要在 `cordis.patch.yml` 里给它加 `disabled: true`。
2. **DSH 的「设置 → 插件」页是只读清单**，只有状态标签（已启用 / 未启用 / 加载失败），没有开关。别去那里找关闭按钮——也正因为没有开关，误关基本只发生在命令行里。
3. 升级、改配置、`systemctl restart dsh-web` 都是安全的；只有"让它不加载"才危险。

### 不小心关掉了，怎么救

先别慌：**DSH 本体一直在 `127.0.0.1:3080` 跑着，会话、工作区、密码都没丢**，丢的只是门口那一层。恢复只要两条命令，而且**完全不依赖这个插件本身**：

```bash
# 1) 重新装回（本地目录装的就用 file:，没装过就用 GitHub）
dsh plugin --profile web add file:/path/to/dsh-web-guard
# 或：dsh plugin --profile web add github:lvxianchao/dsh-web-guard

# 2) 重启，3081 会重新监听
sudo systemctl restart dsh-web
```

如果当初是加了 `disabled: true` 弄没的，把那一行删掉再重启即可。**密码不用重设**——哈希存在 `<profile>/data/dsh-web-guard.json`，只要没删这个文件就还在。

**真正的坑不在这两条命令，而在于：此刻你已经连不上这台机器了。**

闸门只代理 DSH 的 HTTP 入口，不碰 SSH；但如果你把远程访问都收在这一个域名上，那插件一没，你就只剩一条路——**一条不经过这个插件的后路**。至少准备一条，并且**现在就验证它真的能用**（别等出事才发现自己没配）：

- 宿主控制台（PVE / ESXi / 云厂商 VNC）→ 进容器或虚机 → 执行上面两条命令；
- 或者一条独立的 SSH 通道（内网直连、跳板机、VPN）。


最后一句：**别把这两条恢复命令只存在这台机器上。** 它挂的时候你也看不到它，抄一份到你能从外面打开的地方。

## 三种部署拓扑

**1. 直接暴露（没有反代）** —— 让插件自己终结 TLS：

```yaml
config:
  listenHost: '0.0.0.0'
  listenPort: 8443
  tls:
    certFile: /path/fullchain.pem
    keyFile: /path/privkey.pem
```

浏览器访问 `https://<host>:8443`，会话 cookie 自动带 `Secure`。DNS 指过来、只开一个端口即可。

**2. 反代之后（NPM / Caddy / Traefik）** —— 反代只做 TLS，认证交给插件：

反代上游填 `http://<dsh-host>:3081`，开启 WebSocket。**不需要**任何 Host 改写配置——这正是本插件要消掉的那部分。

**3. 纯局域网** —— 明文 HTTP + 密码，最简单，也最不安全（会话 cookie 可被嗅探）。

## 语言

登录页与设置页面跟随 DSH 的语言设置：插件读取 profile patch 文件
（`~/.dsh/profiles/web/cordis.patch.yml`）里 `locale` 行的 `preference`，
也就是 DSH 设置界面写入的同一个位置。目前支持中文和英文。没有显式偏好时，
按浏览器的 `Accept-Language` 回退。

## 主题

原生设置页属于 DSH 的一部分，直接跟随 DSH 的明暗设置。

登录页和退出页是 DSH 页面出现之前独立渲染的文档，所以服务端会从 profile patch 里读取 DSH 的选择（`- id: ui-theme` → `config.preference`，也就是「外观」控件写入的那一行），在首屏绘制前强制使用对应配色。优先级：`?theme=light|dark` → DSH 设置 → 系统（`prefers-color-scheme`，仅当 DSH 设为「跟随系统」或从未设置）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `listenHost` | `0.0.0.0` | 闸门监听地址 |
| `listenPort` | `3081` | 闸门端口，不能与 DSH 端口相同 |
| `password` | — | 明文密码（启动时哈希） |
| `passwordHash` | — | `scrypt$N$r$p$salt$key`，优先于 `password` |
| `sessionDays` | `7` | 会话时长；`0` = 关浏览器即失效 |
| `maxAttempts` | `5` | 连续失败次数，超过临时锁定 |
| `lockMinutes` | `5` | 锁定时长 |
| `polyfill` | `true` | 注入 `crypto.randomUUID` 兜底 |
| `title` | `DSH Web Guard` | 登录页标题 |
| `repo` | 本项目仓库 | 登录页底部的链接 |
| `tls` | `null` | `{certFile, keyFile}`，启用 HTTPS |

生成密码哈希：

```bash
node -e "import('./lib/auth.js').then(m=>console.log(m.hashPassword(process.argv[1])))" 'your-password'
```

## 安全模型

- 密码用 scrypt（随机盐）哈希；明文只在"自动生成密码"那一行日志里出现一次。
- 会话 token 服务端只存 SHA-256 摘要；cookie 是 `HttpOnly` + `SameSite=Lax`，启用 TLS 时加 `Secure`。
- 登录 POST 校验 `Origin` 的 hostname 与请求 `Host` 一致（只比 hostname，因为反代常剥端口）。CSRF 的第一道防线仍是 `SameSite`。
- 同一 IP 连续失败会临时锁定（内存计数，重启清零）。
- **会话表现在会落盘**（`<profile>/data/dsh-web-guard-sessions-<port>.json`，`0600`，临时文件 + rename 原子写入），所以**重启 DSH 不会把已登录的浏览器踢下线**。文件里存的同样是 SHA-256 摘要，不是 token——拿到这个文件或内存 dump 都无法伪造 cookie。文件名带监听端口，影子实例不会覆盖正式实例。
- `/logout` 只退当前浏览器。要全部吊销（比如怀疑泄露），用设置页的**退出所有设备**：**重启不再等于吊销**。

**这不是多用户系统**：一个密码，一个权限级别。DSH 的 agent 本身能执行代码，任何登录者都拥有该机器的执行权限——这是产品设计，不是闸门的缺陷。

## 掉线之后

会话没了（改过密码、点了退出所有设备、或超过 `sessionDays` 没活动）时，已经开着的标签页不会卡在"重新连接中"：

- 切回标签页、网络恢复、WebSocket 断开、以及每 30 秒，页面都会向 `/__guard/session` 探一次
- 只有拿到明确的 **401** 才跳转（断网导致的请求失败不会误判）
- 跳转目标带 `?next=`，登录后回到原来那个地址

需要重启（升级、改配置）则完全无感：会话表会从磁盘恢复，页面自己重连回来。

## 设置页

管理入口现在是 DSH 自己的一部分：**设置 → DSH Web Guard**（与「通用设置 / 模型 / 内置插件」同一个面板，导航项直接显示插件名，带盾牌图标）。

- 修改登录密码（必须验证当前密码）
- 会话有效期、失败锁定次数与时长 —— **保存即生效**
- 监听地址/端口 —— 标注「重启后生效」
- 活跃会话列表（来源 IP、浏览器、最后活动）：可以只退出本设备、踢掉其他设备，或一键退出所有设备

这个页面渲染在 DSH 的 React 树里，因此直接继承宿主的明暗主题、滚动、焦点和移动端布局；窄屏下自动收成单列。现在已经没有浮动按钮，也没有独立的管理页地址——设置页是唯一的管理入口。

**为什么 v3 把设置页做成原生的**：服务端仍然负责全部鉴权与转发，但页面变成了 `dsh.client` 前端包——一个手写的 React 模块（用户侧不需要打包，React 由宿主模块表提供），注册进 `settings.section` 槽。DSH 没有向 React 树注入 HTML 的官方途径，想要一等公民入口只有这一条路。代价是要声明 `engines.dsh`、且浏览器半在未来的宿主上可能被跳过；但服务端（鉴权、转发、闸门本身）从不依赖浏览器半。

## 排障

| 现象 | 原因 |
|---|---|
| `502 upstream unreachable` | DSH 没起，或 `listenPort` 撞了 |
| 一直跳 `/login` | 浏览器没带 cookie；检查是否混用了 HTTP/HTTPS 两个地址（cookie 不共享） |
| 登录后立刻弹回 | 客户端与主机时间偏差导致会话判定过期 |
| 界面报 `randomUUID` | 把 `polyfill` 关掉了 |
| 局域网能直连 DSH 端口 | DSH 绑的不是回环，见启动告警 |
| 某插件自己的 `/api/...` 返回 403「只接受本机同源」，guard 日志里同样是 403 | **3.0.2 之前**代理原样转发 `Referer`，插件按 `Origin \|\| Referer` 判同源时看到的是公网 authority | 升级到 `>=3.0.2`：`Referer` 现在和 `Host`/`Origin` 一样被丢弃 |
| 设置里找不到 DSH Web Guard | 宿主跳过了 bundle：版本低于 `0.2.2-rc.1`，或页面加载失败。查 `journalctl -u dsh-web \| grep dsh-web-guard`，并升级 DSH |

日志统一带 `[dsh-web-guard]` 前缀，与 DSH 自身日志在同一个 journal 里。成功请求不记录（Web UI 会持续轮询），只记失败和慢请求。

## 开发

```bash
npm ci --ignore-scripts        # TypeScript + esbuild，仅构建期依赖
npm run typecheck              # 服务端 + 客户端类型检查
npm run build                  # src/ → lib/（tsc + 一次 esbuild 打包）；lib/ 入库

# 影子实例：用真实 profile 跑这份 checkout，但不改动它。
# 用独立的 DSH_HOME 隔离，避免影子闸门读写线上 profile 的 guard 状态。
cp -a ~/.dsh/profiles/web /tmp/dsh-shadow-home/profiles/web
cp dev.yml dev.local.yml       # 把 `name:` 指向本仓库的 lib/index.js
DSH_HOME=/tmp/dsh-shadow-home dsh --profile web --patch ./dev.local.yml --host 127.0.0.1 --port 3099 --no-open

# 对运行中的闸门跑 e2e（dev.yml 的闸门监听 3100）
GUARD_URL=http://127.0.0.1:3100 GUARD_PASSWORD=dev-only-password node test/e2e.mjs
```

插件只用公开的宿主 API：服务端用 `webServer.tapIndex`、`webServer.getOrigin`、`connection.authenticatedUrl`；客户端用文档化的 `ctx.slots` / `ctx.locale` 服务。没有 monkey-patching，也不改宿主源码。

`lib/client.js` 是一个 classic script，通过 `window.__ModuleLoader__.load()` 注册惰性工厂；React 从宿主共享模块表解析，不会被重复打包。`lib/` 与源码不一致时 CI 会失败。

## 配套插件

DSH 自带的文档预览放不了视频——在侧边栏点开 `.mp4` 只会提示格式不支持。[dsh-video-preview](https://github.com/lvxianchao/dsh-video-preview) 给同一个侧边栏补上流式视频渲染器：`mp4` / `webm` / `mov`，支持字节范围拖动、没有大小上限。

```bash
dsh plugin --profile web add @lvxianchao/dsh-video-preview
```

两个插件互相独立，可以只装一个，也可以都装。

## 赞助

如果这个插件帮你省了点折腾的时间，欢迎请我喝杯咖啡：

- ☕ **[爱发电](https://afdian.com/a/lvxianchao)** —— 国内，微信 / 支付宝
- 🌍 **[Ko-fi](https://ko-fi.com/lvxianchao)** —— 国际，PayPal

<details>
<summary>微信赞赏码</summary>

<p align="center"><img src="https://raw.githubusercontent.com/lvxianchao/dsh-web-guard/main/docs/wechat.jpg" width="220" alt="微信赞赏码"></p>

</details>

## License

MIT
