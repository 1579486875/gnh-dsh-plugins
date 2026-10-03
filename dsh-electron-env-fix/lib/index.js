/**
 * dsh-electron-env-fix —— 清除桌面端 host 里会被子进程继承的 ELECTRON_RUN_AS_NODE
 *
 * 【问题现象】
 * 桌面端里点「用 VS Code 打开」等外部应用，界面报「打开失败，请重试」，
 * 而同样的操作在 Web 端（dsh web + 浏览器）一切正常。
 *
 * 【根因】
 * 1. 桌面端的 shell 以 `ELECTRON_RUN_AS_NODE=1` 启动 host（Electron 的 node 模式），
 *    这个变量因此留在 host 进程的 process.env 里 —— 见 app.asar/lib/main.js:3529
 *    （desktopNodeEnvironment 显式设置，父环境无法通过配置去掉它）。
 * 2. host 启动子进程时走 @deepseek-ai/dsh-subprocess 的 scrubbedParentEnv()，
 *    而它只清洗 `KEY|PASSWORD|SECRET|TOKEN` 形状的名字和 `DSH_*` 前缀，
 *    **不会**排除 ELECTRON_RUN_AS_NODE，于是原样复制给了每一个子进程。
 * 3. DSH 的「用外部应用打开」(dsh-host-open-in-app) 启动 VS Code / Cursor /
 *    Windsurf / Zed 等 **Electron 系**程序时，对方读到这个变量会以纯 Node 模式运行：
 *    把目标文件当 JS 模块加载 → ERR_UNKNOWN_FILE_EXTENSION → 以退出码 1 结束。
 * 4. launchDetachedApp 把「启动器在观察窗口内非零退出」判定为启动失败
 *    （dsh-host-open-in-app/lib/index.js:374-379），于是前端显示「打开失败，请重试」。
 *
 * 【实测证据（修复前）】
 *   spawn('…\Microsoft VS Code\Code.exe', ['--version'])
 *   → stdout: v24.18.1（Node 的版本号！）  exit: 1
 *   清掉该变量后同样命令 → stdout: VS Code 正常启动  exit: 0
 *
 * 【为什么在这个位置删除是安全的】
 * · Electron 只在进程启动的那一瞬间读取该变量，运行期删除不影响 host 自身；
 * · DSH 中唯一「以 Electron 可执行文件启动子进程」的地方是包管理器
 *   （dsh-desktop-host 的 packageManager.env 里显式写了 ELECTRON_RUN_AS_NODE=1），
 *   它不依赖从 host 继承；
 * · 全项目 `process.execPath` 仅出现一次（app.asar/lib/main.js:11033，赋值给
 *   host 自己的启动路径，不是子进程 spawn）；
 * · 其余子进程（pwsh、MCP 服务器等）都不是 Electron 程序，本就不需要它。
 *
 * 【生效时机】
 * 本插件 inject 为空数组，apply 在 host 启动早期同步执行；而「用外部应用打开」
 * 是用户点击时才发起的，一定晚于本插件的 apply，因此必然生效。
 *
 * @module dsh-electron-env-fix
 */

/** Cordis 插件名。 */
export const name = 'electron-env-fix'

/** 不依赖任何服务：越早 apply 越好。 */
export const inject = []

export function apply() {
  if (process.env.ELECTRON_RUN_AS_NODE !== undefined) {
    delete process.env.ELECTRON_RUN_AS_NODE
    console.log(
      '[electron-env-fix] 已从 host 环境清除 ELECTRON_RUN_AS_NODE —— 「用外部应用打开」恢复正常'
    )
  }
}
