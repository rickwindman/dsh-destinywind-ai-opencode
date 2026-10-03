# dsh-destinywind-ai-opencode

把本机 **OpenCode CLI** 接成 DSH 的「执行分担」工具：任务过程中主 AI 可以调用
`opencode_delegate`，把一段自包含的子任务交给 opencode 的 `build` 代理独立完成，
只用一份提示词换回一份结果，主上下文不被中间过程污染。

## 它做什么

注册**一个工具**（不注册任何模型、不改动模型选择器）：

| 工具 | 作用 |
| --- | --- |
| `opencode_delegate` | 把子任务交给本机 opencode 执行，返回结果文本 |

适合衡的场景：

- 机械但耗时的编码活：写一个模块、批量重命名、补测试、修静态检查报错
- 需要独立探查大量文件的调研（探索过程留在 opencode 那边，不污染主上下文）
- 主 AI 想并行推进的多条子线（每次调用是一个独立进程）

不适合：需要与本会话上下文紧密交互的细节决策；一句话就能答的简单问题。

## 为什么是「工具」而不是「模型」

本插件**刻意**不把 opencode 当成 LLM provider。原因是实测结论（避免后人重蹈覆辙）：

1. **opencode 免费档在服务端拒绝外部客户端**。直连 Zen 的 OpenAI 兼容端点会得到：
   `OpenCode's free tier can only be used from within OpenCode`。
2. **把 `opencode run` 当模型后端也不通**。它是黑盒 agent：提示词文本进、最终文本出，
   DSH 的工具定义在桥接层被丢弃，模型永远产不出 tool-call，agent 循环「说一句话就结束」。

正确姿势就是把它当**工具**：opencode 在自己的进程里干完整的活（它有读写文件、
执行命令的能力），干完把结果交回来。

## 安装

```powershell
gh repo clone rickwindman/dsh-destinywind-ai-opencode
```

在 DSH 插件市场里通过 GitHub 链接安装：
`github:rickwindman/dsh-destinywind-ai-opencode`

## 配置

插件配置（`config:` 段）全部可选：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `opencodeCmd` | `opencode` | opencode 可执行文件。Windows 的 npm 安装通常是 `node_modules/opencode-ai/bin/opencode.exe` |
| `agent` | `build` | 传给 `--agent` 的代理名。`build` 全权限（可改文件），`plan` 只读 |
| `cwd` | 空 | 默认工作目录；留空则用会话工作区 |
| `model` | 空 | 传给 `-m` 的模型（`provider/model`，或只给模型名自动补 `opencode/`） |
| `timeoutMs` | `600000` | 单次调用超时（10 分钟） |

## 工具参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `task` | 是 | 自包含的完整子任务指令（对方看不到会话历史） |
| `cwd` | 否 | 工作目录（绝对路径） |
| `model` | 否 | opencode 侧模型 |
| `agent` | 否 | 执行代理名 |
| `timeoutMs` | 否 | 本次调用超时 |

## 两个必须踩过的坑（已修，别再改回去）

1. **`stdin` 必须是 `'ignore'`**。`opencode run` 会一直等 stdin 结束才开始干活；
   默认的 pipe 若没人关闭，进程会静静挂死到超时（本机实测：60 秒零输出）。
2. **Windows 上必须 `shell: true`**。opencode 的入口通常是 `.cmd` / `.ps1` 包装，
   node 的 `spawn` 不做 PATHEXT 解析：裸名 `.cmd` 会 `EINVAL`，裸名 `opencode` 会 `ENOENT`。

另外 CLI **没有** `--no-color` 选项，误加会导致 exit 1 并打印帮助文本。

## 开发校验

仓库内的实现已通过两层验证（脚本在开发者的 `.probe` 下，未随包发布）：

- 契约层 34 项断言：工具定义符合宿主 `tools.register` 契约、NDJSON 提取、
  限流识别、参数校验、设置项传导与覆盖优先级
- 端到端：真实 `spawn` 调起 opencode，`task` 进、结果文本出，`ok=true` / `exitCode=0`

## License

MIT
