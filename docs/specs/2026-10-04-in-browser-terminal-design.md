# omp-web 浏览器内终端设计（In-browser Terminal）

- 日期：2026-10-04
- 状态：待用户审阅
- 范围：新增终端子系统（PTY 进程、SSE/POST 通道、xterm.js 前端、Docker 原生模块构建）

## 1. 背景与目标

omp-web 目前没有任何终端能力：仓库内无 `node-pty`、无 `xterm.js`、无 WebSocket handler。用户只能通过 agent 的 `bash` 工具间接执行命令，那是非交互式的——不能跑 `vim`/`top`/`less`，Ctrl-C 无效，不能调整窗口尺寸。

目标：让用户在自己的 workspace 里开一个**真正的交互式 shell**，且不扩大已有的安全边界。

**非目标（本次不做）**：多标签终端、终端分屏、会话录制/回放、终端内文件管理器、tmux 集成、远程主机。

## 2. 已确认的决策

| 决策点 | 结论 | 依据 |
|---|---|---|
| PTY 实现 | `node-pty`（原生模块） | `child_process.spawn` 无 PTY：不能跑 `vim`/`top`，Ctrl-C 无效，不能 resize |
| 允许的目录 | 仅限已通过 allowlist 的 cwd | 复用 `lib/file-access.ts` 的 `isExistingPathWithinRoots`，与 `/api/files` 同一边界，不新增权限面 |
| 界面位置 | TabBar 中的 pinned tab | 与 Explorer / Git tab 同款；`Tab` 类型是 file-centric（`filePath` 必填），不改成变体联合类型 |
| 传输方式 | SSE（输出）+ POST（输入、resize） | **被部署方式所迫**，见 §3 |
| 鉴权 | 未设置 `OMP_WEB_PASSWORD` 时拒绝启动 | 见 §5，这是本设计唯一的风险升级 |
| 原生模块构建 | 本次一并修改 Dockerfile | node-pty 必须为 amd64 与 arm64 分别编译 |

## 3. 传输：为什么不能用 WebSocket

这是**部署方式决定的**，不是偏好：

- `package.json` 的 `start` 是 `next start`，经 `bin/omp-web.js` 启动；仓库内无 `server.ts`/`server.js` 等自定义 server。
- Next 的内置 server 不处理 HTTP `Upgrade`，所以 `new WebSocketServer({ server })` 这类挂载拿不到 upgrade 请求。
- 引入自定义 server 会改变整个部署模型（`bin/omp-web.js`、Dockerfile CMD、健康检查都要重写），代价与本特性不成比例。

因此采用仓库已在两处验证过的模式：

- `GET /api/agent/[id]/events`（SSE 出站）+ `POST /api/agent/[id]`（入站命令）
- `GET /api/auth/login/[provider]`（SSE）+ `POST`（提交粘贴的 code）

终端沿用同一形状，命名与之对齐。

## 4. 架构

### 4.1 服务端

```
lib/terminal/pty-registry.ts     globalThis 注册表 + 生命周期（无 React、无 Next 依赖）
app/api/terminal/stream/route.ts GET  ?cwd=  → SSE，只出不进
app/api/terminal/input/route.ts  POST { data } | { cols, rows }
app/api/terminal/close/route.ts  POST → 立即结束 PTY
components/TerminalPanel.tsx     xterm.js + fit addon
```

**`pty-registry.ts`** 职责（这是唯一有状态的部分，其余都是薄路由）：

- 注册表挂在 `globalThis` 上，key 为 normalized cwd。理由与 `lib/rpc-manager.ts` 相同：模块级 `Map` 在 Next 开发态热重载后会丢，重连会泄漏孤儿进程。
- 懒启动：第一个 `stream` 连接到达时才 spawn `node-pty`。
- 空闲回收：N 分钟无客户端后 kill，沿用 `lib/omp/rpc-utility.ts` 里 `IDLE_KILL_MS = 300_000` 的做法。
- 并发上限：全局最多 M 个 PTY，超出返回 429。防止打开很多 workspace 就spawn 一堆 shell 常驻。
- 每个 PTY 缓存最近 K 行输出（环形缓冲），供重连时回放。
- 进程退出钩子里清理表项，避免 `globalThis` 留下死条目。

### 4.2 前端

- `TerminalPanel` 用 `@xterm/xterm` + `@xterm/addon-fit`。
- `ResizeObserver` → debounce → POST `cols`/`rows`。
- 挂载时先 POST `open` 语义（实际由 stream 首连触发），再连 SSE，把回放缓冲写进终端，之后增量追加。
- 切换 workspace/cwd 时：旧流 `close()`，重置终端，重连新 cwd。
- 关闭 tab 时不 kill PTY（它按空闲回收），避免用户误关 tab 就丢会话。

## 5. 安全：唯一必须点名的地方

`OMP_WEB_PASSWORD` 是**可选**的。看 `proxy.ts`：该变量为空时，中间件不拦截任何请求，包括 `/api/*`。

当前无密码部署的最坏情况是读写 session 文件。加入终端后，同样的部署变成**未认证的远程 shell**。这是本设计唯一的风险升级。

已确认的处理：**未设置 `OMP_WEB_PASSWORD` 时，终端 API 返回 503，UI 显示如何设置该环境变量**。

注意这是终端路由**自己**的守卫，与 `proxy.ts` 现有的 401（`code: "password_required"`）并存且不冲突：设了密码时 401 先在中间件拦下，根本到不了这里；没设密码时中间件放行，才由终端路由用 503 明确拒绝——否则用户只会看到一个解释不了的空终端。

另外三点由现有机制顺带覆盖，不额外写代码：

- `proxy.ts` 的 `isApiRequestOriginAllowed` 已经对 `/api/*` 做来源检查，终端的 POST 端点自动受保护。
- cwd 必须通过 `isExistingPathWithinRoots`，越界返回 403。
- shell 以普通用户身份运行，不提权。

**明确不做**：多用户隔离（当前应用是单用户模型）、审计日志、命令白名单。多用户模型出现时这一节必须重写。

## 6. 错误处理

| 情况 | 行为 |
|---|---|
| 未设 password | 503 + `code: "terminal_auth_required"`，UI 显示配置指引 |
| cwd 不在 allowlist | 403 + `code: "access_denied"` |
| cwd 不存在 | 404 |
| 超出并发上限 | 429（本仓库首个使用该状态码之处；语义上正确，但属新约定） |
| spawn 失败（shell 不存在） | 500，SSE 先发一条 error 帧再关闭 |
| 客户端断线 | 不立即 kill；进入空闲回收倒计时 |

## 7. 测试

- **纯单元**：`pty-registry` 的注册表语义——同 cwd 复用同一 PTY、并发上限、空闲回收、回放缓冲、条目清理。这些不需要真 PTY，用注入的 spawn 函数。
- **路由**：`stream`/`input`/`close` 的校验与错误码（400/403/404/429/503），沿用本仓库既有做法——alias `@/lib/file-access` 与注册表模块，用假对象驱动，不 spawn 真进程。
- **前端**：`TerminalPanel` 的 resize→POST、cwd 切换→重连、以及 503 时渲染指引。
- **真实验证**：本地手工开一次 PTY，确认 `vim` 能进、Ctrl-C 有效、resize 生效。不进自动化套件（CI 无 PTY 环境差异）。

## 8. 依赖与构建

新增：`node-pty`、`@xterm/xterm`、`@xterm/addon-fit`。

`node-pty` 是原生模块，Dockerfile 必须为每个架构编译。当前 CI 已是"每个架构在各自 native runner 上构建"（amd64 与 arm64 各自原生），因此只需在 Dockerfile 里加一步 `npm rebuild node-pty --build-from-source` 或等价做法，并确认 arm64 镜像里 `.node` 文件确实是 arm64。

**风险**：若 arm64 编译失败，整个镜像构建失败。已确认：失败会先上报再 push。

## 9. 实施顺序

1. `pty-registry.ts` + 单元测试（纯逻辑，可独立验证）
2. 三个路由 + 路由测试
3. `TerminalPanel` + TabBar pinned tab + 前端测试
4. Dockerfile 与依赖，`tsc --noEmit`、`npm run lint`、全量 `npm test`
5. 本地真机验证 PTY 交互
6. 推分支、走 CI、确认多架构镜像构建

每步独立可验证；第 4 步之前不碰 Docker，避免把代码 bug 与构建问题混在一起排查。