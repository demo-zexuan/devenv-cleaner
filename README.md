# DevEnvClean

> **`dvc` — 扫描并选择性回收开发缓存、依赖与构建产物占用的磁盘空间。**

macOS / Linux 优先 · Node.js >= 22 · MIT

下面这段是**本仓库构建产物 `dist/cli.js` 的真实输出**（在一个临时目录上运行，`--no-color` 便于复制）：

```text
$ dvc scan --root /tmp/dvc-readme-demo --min-size 0
DevEnvClean scan v0.1.0
root /private/tmp/dvc-readme-demo
scanned 30 directories in 7ms (7ms wall)

total        2.2 MB
reclaimable  2.2 MB
targets      5 (0 locked) · 7 files
guards       min size 0 B · depth 6

by layer
layer           size  reclaimable  targets
------------  ------  -----------  -------
dependencies  1.5 MB       1.5 MB        2
build         600 KB       600 KB        2
cache          60 KB        60 KB        1
artifacts        0 B          0 B        0

largest targets
  size  layer         rule                   age  status  path
------  ------------  ---------------------  ---  ------  --------------------------------------------------
1.3 MB  dependencies  Node Dependencies       0d  ready   /private/tmp/dvc-readme-demo/shop-web/node_modules
420 KB  build         JS/TS Build Output      0d  ready   /private/tmp/dvc-readme-demo/shop-web/dist
260 KB  dependencies  Python Virtualenv       0d  ready   /private/tmp/dvc-readme-demo/shop-api/.venv
180 KB  build         Next.js Build Output    0d  ready   /private/tmp/dvc-readme-demo/blog/.next
 60 KB  cache         Python Bytecode Cache   0d  ready   /private/tmp/dvc-readme-demo/shop-api/__pycache__

next dvc clean --dry-run   review before deleting
```

> **项目状态（重要，先读这一段）**
>
> 已经可用的是**非交互命令行**：`scan` / `clean` / `rules` / `config` / `report` / `doctor`，45 条内置规则，JSON 与 Markdown 报告，报告 diff 增长门禁。
>
> 另外两部分**尚未接线**，本文不会把它们描述成可用功能：
>
> 1. **交互式界面**：`dvc tui`（无参数运行 `dvc` 时的默认命令）的入口 `src/tui/run.ts` 目前是占位实现，立即返回 `0`、不渲染任何界面。`src/tui/components/**` 的界面组件与主题已经写好，但没有容器消费它们。
> 2. **中英双语界面**：`src/i18n/**` 的语言检测与两套文案表已实现，并带有启动时的完整性断言；但当前没有任何渲染层读取它（`--lang` 只会改变已解析语言的值）。非交互命令的输出是英文，Markdown 报告是中文，均为硬编码。
>
> 上表与下文所有命令均为真实行为；涉及这两处时会明确标注「未接线 / 占位」。

---

## 为什么需要它

开发机的磁盘不是被文档和照片吃掉的，而是被**装完就没再用过的依赖与产物**吃掉的：

| 目录 | 单实例典型占用 | 恢复代价 |
| --- | --- | --- |
| `node_modules` | 200 MB – 2 GB | `npm / pnpm / yarn install` |
| Rust `target/` | 数 GB | 冷编译可能几十分钟 |
| 包管理器全局仓库（pnpm store、`~/.m2`、cargo registry、pip/uv cache） | 数十 GB | 重新下载 |
| Xcode `DerivedData` | 数 GB – 数十 GB | 下次构建重建索引 |
| Docker 镜像 / 容器存储 | 常常是全机最大项 | 只能 `docker system prune`，不能删文件 |

难点不在于「哪些能删」，而在于**这些目录散落在几十到几百个项目里**：用 `du` 找一遍要等很久，用 `rm -rf` 配合 glob 则是拿不可逆操作赌一条模式写对了。

**实测规模**：在一棵真实的 `~/Content` 目录树上，`dvc scan` 一次发现 **169 个项目、679 个可清理目标、合计 22 GB**，用时 **9.7 秒**。这正是「必须先看一眼再决定」而不是「一键清理」的原因。

为什么现有手段不够、以及本项目的边界，见 [docs/requirements.md](docs/requirements.md) 的「背景与问题陈述」与「边界与不做的事」两节——本文不重复。

---

## 特性

**已实现、可直接使用：**

- **规则引擎 + 可编辑配置**：45 条内置规则、14 个生态，规则与阈值都可写进 `dvc.config.json` 覆盖（`dvc rules list` / `dvc rules explain <id>` 可查）。
- **干跑预览 + 二次确认**：`dvc clean` 默认只打印预览，一行都不删；`dvc clean --yes` 才真正执行，且 `--dry-run` 可以否决 `--yes`。
- **查询 / 筛选**：`dvc clean` 支持按目标 id、层级、规则 id、未被修改天数、路径子串、最小体积六个维度组合筛选；`dvc scan --json` 输出完整机器可读报告用于二次查询。
- **JSON / Markdown 报告导出**：`dvc scan --out report.json|report.md` 或 `dvc report export --format json|markdown`，写入字节稳定的 JSON 契约。
- **报告快照对比与增长门禁**：`dvc report list` / `dvc report diff` 比较两次快照；`--fail-on-growth <bytes>` 在净增长超限时以退出码 `2` 失败，供 CI 判定「分支把磁盘撑大了」。
- **环境诊断**：`dvc doctor` 检查 Node 版本、终端能力、生效的配置文件、扫描根可读写性、路径安全性、剩余空间、规则与生态开关（9 项 + 平台信息）。
- **安全模型**：内置不可配置的拒绝列表、白名单、根目录包含性校验、删除前符号链接再校验、不可覆盖的锁定原因、无筛选条件时拒绝 `--yes`（见下文「安全模型」）。

**已实现但未接线（不要当成可用功能）：**

- **交互式多选清理**：`dvc tui`（以及无参数运行 `dvc`）指向 `src/tui/run.ts` 的占位实现，立即返回 `0`，不渲染界面、不进入选择流程。界面组件本身已完成（列表、筛选栏、汇总面板、确认对话框、执行视图、diff 视图），并由开发脚本 `scripts/frames.tsx` 渲染成文本帧，但**没有容器把它们接起来**。
- **中英双语界面**：`--lang zh` / `--lang zh-CN` / `DEV_ENV_CLEANER_LANG=zh` 都能被正确解析（`LANG` / `LC_ALL` 刻意不参与），两套文案表也完整；但目前唯一消费语言值的地方是 `tui` 入口，而它是占位实现，所以**看不到语言切换的效果**。

---

## 安装

### 1. 作为全局命令

```bash
pnpm add -g devenv-cleaner
# 或
npm i -g devenv-cleaner
```

包内提供两个等价的 bin：`dvc` 与 `devenv-cleaner`。

### 2. 不安装，直接运行

```bash
npx --yes devenv-cleaner --help
npx --yes devenv-cleaner scan --root ~/dev --min-size 0
```

> ⚠️ `npx` 按**包名**解析，所以请写 `npx devenv-cleaner`：本项目的包名是 `devenv-cleaner`，`dvc` 只是安装后提供的命令名，不是包名。

### 3. 从源码（开发用）

```bash
git clone <repo-url> devenv-cleaner
cd devenv-cleaner
pnpm install
pnpm build
pnpm link --global
dvc --version
```

### 4. 环境要求

**Node.js >= 22**（`package.json` 的 `engines.node` 就是 `>=22`）。

原因：交互层使用 **Ink 7**，它要求 Node 22 及以上；`dvc doctor` 的第一个检查项就是这一条，低于 22 会直接判 `FAIL`。非交互命令同样按此约束发布，避免出现「在 CI 里能跑、在本地 TUI 里崩」的分裂状态。

pnpm 请使用与 `pnpm-lock.yaml` 及 `pnpm-workspace.yaml` 匹配的版本（仓库用 pnpm 12 生成锁文件与 `allowBuilds` 审批，CI 亦固定该版本）。

---

## 快速开始

### 1. 无参数运行 `dvc`

```bash
dvc
```

行为取决于终端：**不是 TTY**（管道、CI）时打印帮助，并附上解析后的默认值（目录上限、平台、家目录、内置规则数量）；**是 TTY** 时会进入默认命令 `tui`。

但由于 `src/tui/run.ts` 仍是占位实现，TTY 下现在**什么界面都不会出现**，命令直接以 `0` 退出。在界面接线完成之前，请使用下面的非交互命令。

### 2. 先扫描，确认钱花在哪里

```bash
dvc scan --root ~/Content --min-size 0
```

`--min-size 0` 是为了看清全部目标（默认下限是 1 MiB）。输出会按生命周期层级汇总，并列出最大的 15 个目标。

### 3. 干跑预览，再决定

```bash
dvc clean --root ~/Content --min-size 0 --dry-run
```

真实输出（同样的临时目录）：

```text
$ dvc clean --root /tmp/dvc-readme-demo --min-size 0 --dry-run

cleanup preview 2.2 MB across 5 target(s)

  SIZE  LAYER         RULE                  PATH                                                LOCK
------  ------------  --------------------  --------------------------------------------------  ----
 60 KB  cache         Python Bytecode Cac…  /private/tmp/dvc-readme-demo/shop-api/__pycache__       
420 KB  build         JS/TS Build Output    /private/tmp/dvc-readme-demo/shop-web/dist              
180 KB  build         Next.js Build Output  /private/tmp/dvc-readme-demo/blog/.next                 
1.3 MB  dependencies  Node Dependencies     /private/tmp/dvc-readme-demo/shop-web/node_modules      
260 KB  dependencies  Python Virtualenv     /private/tmp/dvc-readme-demo/shop-api/.venv             
------  ------------  --------------------  --------------------------------------------------  ----
5 targets · 2.2 MB · 0 locked

5 targets · 2.2 MB · 0 locked

 — nothing was deleted. Re-run with --yes to delete the 5 target(s) above.
```

预览按「最不容易后悔」排序：先 `cache`，再 `build`，再 `dependencies`，最后 `artifacts`，层内按体积从大到小。

### 4. 确认之后再删

```bash
# 只清缓存层，且只清 30 天没动过的
dvc clean --root ~/Content --layer cache --older-than 30 --yes
```

提示：`--yes` 必须配合至少一个筛选条件，否则命令会拒绝执行（见「安全模型」）。

---

## 命令参考

> 全局参数可以写在子命令**之前或之后**：`dvc --config x.json scan` 与 `dvc scan --config x.json` 等价。

### 全局参数

| 参数 | 说明 |
| --- | --- |
| `-c, --config <path>` | 使用指定配置文件，跳过自动发现。相对路径按当前工作目录解析；指定的文件不存在会报错退出（`1`），而不是回退到默认值。 |
| `--color` | 强制彩色输出。 |
| `--no-color` | 关闭彩色输出。`NO_COLOR` 环境变量与非 TTY stdout 也会关闭颜色。优先级：显式参数 > `NO_COLOR` > 非 TTY。 |
| `--lang <code>` | 界面语言：`en`（默认）或 `zh`。也接受 `zh-CN` 这类标签（取主子标签）。环境变量 `DEV_ENV_CLEANER_LANG` 优先级更低；`LANG` / `LC_ALL` 不参与。 |
| `--verbose` | 打印额外诊断；出错时附带堆栈。 |
| `-v, --version` | 打印版本号。 |
| `-h, --help` | 打印帮助。 |

### `dvc scan`

测量开发缓存与依赖，并打印报告。

| 参数 | 说明 |
| --- | --- |
| `-r, --root <path...>` | 要扫描的目录；可重复。默认是家目录。 |
| `-d, --max-depth <n>` | 每个根目录下递归的深度。 |
| `-s, --min-size <bytes>` | 忽略小于该字节数的目标。 |
| `--json` | 输出机器可读报告（`ScanReport` 文档本身，非 `{ok,data}` 包装）。 |
| `-o, --out <path>` | 把报告写入文件；扩展名 `.md` 写 Markdown，其余写 JSON。 |
| `--global` | 同时探测机器级包管理器缓存（仅当扫描根是家目录时才会自动开启）。 |
| `-q, --quiet` | 不打印人类可读摘要。 |

### `dvc clean`

预览并删除清理目标；**不加 `--yes` 只预览**。

| 参数 | 说明 |
| --- | --- |
| `-r, --root <path...>` | 要扫描的目录；可重复。 |
| `-d, --max-depth <n>` | 每个根目录下递归的深度。 |
| `-s, --min-size <bytes>` | 忽略小于该字节数的目标（同时**计为一个筛选条件**）。 |
| `--target <id...>` | 只处理这些目标 id（id 每次运行都会变，请从 `dvc scan` 输出复制）。 |
| `--layer <layer...>` | 只处理这些层级：`dependencies` / `build` / `cache` / `artifacts`。 |
| `--rule <id...>` | 只处理这些规则 id。 |
| `--older-than <days>` | 只处理「最新文件」也至少这么久没被改动过的目标。 |
| `--path <substring>` | 只处理路径中包含该文本的目标。 |
| `--include-locked` | 放开**可覆盖**的锁（见「安全模型」，默认不放开）。 |
| `--yes` | 真正执行删除；没有它只预览。 |
| `--dry-run` | 即使给了 `--yes` 也只预览；`--dry-run` 优先。 |
| `--global` | 同时纳入机器级包管理器缓存。 |
| `--json` | 输出机器可读结果：`{ ok: true, data: { plan, execution } }`。 |

### `dvc rules`

查看内置规则目录。

| 子命令 | 参数 | 说明 |
| --- | --- | --- |
| `rules list`（`dvc rules` 的默认子命令） | `--json` | 输出 `{ total, active, rules: [...] }`（含每条规则的生效 risk / patterns / enabled / reportOnly）。 |
| | `--layer <layer>` | 只显示喂给该层级的规则。 |
| `rules explain <ruleId>` | 位置参数 `<ruleId>` | 解释一条规则的全部字段、匹配模式，以及覆盖它的配置写法；未知 id 会给出相近候选并以 `1` 退出。 |

### `dvc config`

查看与生成配置文件。

| 子命令 | 参数 | 说明 |
| --- | --- | --- |
| `config init` | `-o, --out <path>` | 目标路径，默认 `dvc.config.json`。 |
| | `--force` | 覆盖已存在的文件；不加则报错并以 `1` 退出。 |
| `config validate`（`dvc config` 的默认子命令） | — | 校验当前位置会生效的配置文件；没有文件时列出搜索路径并退出 `0`。 |
| `config show` | `--json` | 打印**解析后**的完整配置（含默认值），而非文件原文。 |
| `config path` | — | 按优先级打印配置搜索路径。 |

### `dvc report`

导出、列出与比较扫描报告。

| 子命令 | 参数 | 说明 |
| --- | --- | --- |
| `report export` | `-r, --root <path...>` | 要扫描的目录；可重复。 |
| | `-o, --out <path>` | 显式输出路径。 |
| | `--format <format>` | `json`（默认）或 `markdown`。 |
| | `--dir <path>` | 报告目录，默认 `.devenvclean`。 |
| | `--global` | 同时纳入机器级包管理器缓存。 |
| `report list` | `--dir <path>` | 报告目录，默认 `.devenvclean`。 |
| | `--json` | 输出 `{ ok: true, data: { directory, reports } }`。 |
| `report diff` | `--from <path>` | **必填**，较旧的报告。 |
| | `--to <path>` | **必填**，较新的报告。 |
| | `--limit <n>` | 最多打印多少行，默认 `30`。 |
| | `--fail-on-growth <bytes>` | 净增长超过该字节数时以退出码 `2` 退出。 |
| | `--json` | 输出 `{ ok: true, data: { from, to, deltaBytes, deltaHuman, entries } }`。 |

### `dvc doctor`

检查环境是否会破坏扫描或清理。

| 参数 | 说明 |
| --- | --- |
| `--json` | 输出 `{ ok: true, data: { cwd, ok, checks } }`。注意外层 `ok` 恒为 `true`；**判失败要看 `data.ok` 或 `checks[].status`**。 |

覆盖的检查项：`runtime`、`terminal`、`config`、`scan roots`、`root writability`、`path safety`、`free space`、`rules`、`ecosystems`、`platform`。

### `dvc tui`

打开交互式界面；无参数运行 `dvc` 时它是默认命令。

| 参数 | 说明 |
| --- | --- |
| `-r, --root <path...>` | 要扫描的目录；可重复。 |
| `--global` | 同时纳入机器级包管理器缓存。 |

⚠️ 当前是占位实现（立即返回 `0`，不渲染界面），见文首「项目状态」。

---

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功。包括：扫描被目录上限截断（数据仍有用，只是不完整）、`clean` 只做预览、`clean --yes` 全部删除成功、`doctor` 无 `fail`（有 `warn` 也算 0）。 |
| `1` | 用法错误、配置无效，或清理过程中有目标删除失败。具体包括：参数未知、`--config` 指向的文件不存在或 JSON/结构非法、`dvc clean --yes` 未给任何筛选条件、`dvc config init` 目标已存在且未加 `--force`、`dvc rules explain` 传入未知 rule id、`dvc report diff` 缺少 `--from`/`--to`、`dvc doctor` 存在 `fail` 检查项、执行器至少有 1 个目标删除失败（`failedCount > 0`）。 |
| `2` | 策略门禁拒绝。目前**只有** `dvc report diff --fail-on-growth` 会返回它。与 `1` 区分开，是为了让 CI 能分辨「你的分支让磁盘变大了」和「你的配置写错了」——两者需要人做完全不同的事。 |
| `130` | 被用户中断（SIGINT / Ctrl-C），遵循 shell 惯例。 |

错误信息默认走 stderr（`error: ...`）。如果 argv 中出现 `--json`，错误会以 `{ ok: false, error, code }` 形式写到 stdout，保证消费者只需要一个解析器。

---

## 配置

### 1. 搜索顺序

**只使用一个文件**——不会跨层深合并。按优先级从高到低，第一个「存在且是普通文件」的候选生效：

1. `<当前工作目录>/dvc.config.json`
2. 当前工作目录的每一级祖先目录下的 `dvc.config.json`（由近及远，直到文件系统根）
3. `${XDG_CONFIG_HOME:-~/.config}/devenvclean/config.json`
   （Windows 为 `%APPDATA%/devenvclean/config.json`）
4. `~/.dvc.config.json`

路径比较时会做去重与大小写折叠（macOS / Windows 的默认文件系统不区分大小写，否则「差一个大小写」就等于没保护住）。

用 `dvc config path` 可以打印实际搜索到的完整列表。`--config <path>` 会**完全跳过**这套发现逻辑；此时文件不存在是错误而不是回退。

### 2. 真实的脚手架

`dvc config init` 写出的就是下面这个文件（`serializeConfig` 的输出，本机实测）：

```json
{
  "schemaVersion": 1,
  "roots": [],
  "maxDepth": 6,
  "minSizeBytes": 1048576,
  "retentionDays": 0,
  "whitelist": [
    "/Users/<you>/Library/Caches/pnpm",
    "/Users/<you>/.m2/repository",
    "/Users/<you>/Library/Developer/Xcode/DerivedData",
    "/Users/<you>/Library/Developer/Xcode/Archives",
    "/Users/<you>/Library/Containers/com.docker.docker/Data/vms"
  ],
  "rules": {}
}
```

白名单是**按平台预置**的（上面的路径是 macOS 形态；Linux / Windows 会换成对应的全局缓存位置），并且只预置机器级、删了会连累其他项目或无法重建的位置。`roots` 为空表示「用家目录」，这是全机清理工具最诚实的默认值。

### 3. 逐键说明

| 键 | 默认值 | 范围 / 取值 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | 整数 | 文件针对的报告契约版本。缺失或不等于当前 `SCHEMA_VERSION`（1）只会产生**警告**，不阻断运行。 |
| `roots` | `[]` → 解析为 `[家目录]` | 字符串数组 | 扫描根。支持 `~`；相对路径按**配置文件所在目录**解析；重复项去重（保留第一个）。 |
| `maxDepth` | `6` | 钳制到 `[1, 32]`，截断为整数 | 每个根下递归深度。 |
| `minSizeBytes` | `1048576`（1 MiB） | 钳制到 `[0, +∞)`，截断为整数 | 小于它的目标会被锁上 `too-small`（仍会出现在报告里，只是不可选）。`--min-size` 可覆盖。 |
| `whitelist` | `[]` | 字符串数组 | **绝不删除**的路径前缀。支持 `~`；相对路径按配置文件目录解析。按路径组件边界匹配：写 `/a/b` 会保护 `/a/b/c`，但不会保护 `/a/bc`。 |
| `retentionDays` | `0` | 钳制到 `[0, 3650]`，截断为整数 | **保留字段，在 v1 中完全无效（inert）**：没有任何清理或回收逻辑读取它，删除就是直接 `rm`，没有回收站 / 回滚窗口。目前它只影响 `dvc config show` 的显示。 |
| `rules.<id>` | `{}` | 见下 | 按规则 id 覆盖内置规则。 |
| `limits.highRiskBytes` | `5368709120`（5 GiB） | 钳制到 `[1, +∞)`，整数 | 单个目标超过该体积时风险升级为 `high`；达到 1/4 时升级为 `medium`。 |
| `limits.lightNodeModulesEntries` | `500` | 钳制到 `[1, 100000]`，整数 | 「轻量 node_modules」的条目数阈值。 |
| `limits.concurrency` | `24` | 钳制到 `[1, 128]`，整数 | 体积扫描并发度。 |
| `limits.maxDirectories` | `400000` | 钳制到 `[1, 5000000]`，整数 | 单次扫描访问目录数的硬上限；触发后报告 `truncated: true`，总量是下界。 |
| `ecosystems.<id>.enabled` | 全部 `true`（14 个生态） | `true` / `false` | 关掉某个生态的探测，它的目标就从报告里消失。未知生态 id 会原样保留（`config show` 忠实回显）。 |
| `report.dir` | `".devenvclean"` | 任意路径 | 报告写入目录。支持 `~`；相对路径按**当前工作目录**解析（与 `roots` 不同）。 |
| `report.format` | `"json"` | `"json"` / `"markdown"` | `dvc report export` 未显式指定时的默认格式。 |

### 4. 全部写法的注释示例

> JSON 本身不支持注释；下面用 `jsonc` 展示，实际写文件时请去掉注释。

```jsonc
{
  // 报告契约版本；不确定就写 1。
  "schemaVersion": 1,

  // 扫描哪些树。支持 ~；相对路径相对本文件所在目录。空数组 = 家目录。
  "roots": ["~/Content", "~/dev"],

  // 1..32。越深越慢；monorepo 一般 6 够用。
  "maxDepth": 6,

  // 小于 1 MiB 的目标只报告不删除。默认 1048576。
  "minSizeBytes": 1048576,

  // 保留字段，v1 无效（没有回收站/回滚），写 0 即可。
  "retentionDays": 0,

  // 绝不删除的路径。支持 ~；相对路径相对本文件所在目录。
  // 只保护这里列出的前缀，不能用来"放开"内置拒绝列表。
  "whitelist": [
    "~/Library/Caches/pnpm",        // 删了会解绑所有已装 node_modules 的硬链接
    "~/.m2/repository",             // 删了离线构建直接失效
    "~/work/client-deliverables"    // 自己的目录，绝不允许被规则命中
  ],

  // 按规则 id 覆盖；id 用 `dvc rules list` 查看。未列出的键会报错（strict object）。
  "rules": {
    // 完全关掉一条规则：它不再产生任何目标，也不计入任何总量。
    "generic-logs": { "enabled": false },

    // 提高风险等级，让它默认更难被批量选中。
    "rust-target": { "risk": "high" },

    // 只对该规则提高体积门槛（不写进 limits，避免影响所有规则）。
    "node-modules": { "minSizeBytes": 10485760 },

    // 追加匹配模式（是"追加"而不是替换，原有模式仍生效）。
    "node-build-output": { "extraPatterns": ["**/.output", "**/storybook-static"] },

    // 临时把某条规则降级为"仅报告"，先观察一段时间再决定是否放开。
    "global-homebrew-cache": { "reportOnly": true }
  },

  // 数值护栏；超出范围会被钳制并打印 warning，而不是报错。
  "limits": {
    "highRiskBytes": 5368709120,      // 5 GiB；超过即升为 high
    "lightNodeModulesEntries": 500,   // "轻量 node_modules" 的条目阈值
    "concurrency": 24,                // 体积扫描并发度，1..128
    "maxDirectories": 400000          // 扫描失控上限，触发后报告标记 truncated
  },

  // 关掉不想看到的生态，它的目标会从报告里消失。
  "ecosystems": {
    "java-maven": { "enabled": false },
    "dotnet": { "enabled": false }
  },

  // 报告输出设置。
  "report": {
    "dir": ".devenvclean",            // 相对当前工作目录
    "format": "json"                  // 或 "markdown"
  }
}
```

### 5. 校验与排错

```bash
dvc config path       # 我到底会读到哪个文件？
dvc config validate   # 这个文件能用吗？有哪些警告？
dvc config show       # 解析之后真实生效的配置长什么样（含所有默认值）
```

文件里的 `roots[i]` 不存在、`whitelist[i]` 不在任何根目录内、`rules.<id>` 用了不存在的规则 id、以及任何数值被钳制，都会以 warning 形式打印。**结构错误（未知键、类型不对、JSON 语法错误）会让命令以退出码 `1` 失败**：配置里的对象都是 strict 的，因为「写错一个保护选项却被静默忽略」比直接报错危险得多。

---

## 规则引擎

### 1. 一条规则由什么构成

规则定义在 [src/rules/builtin.ts](src/rules/builtin.ts)，字段与 `CleanRule`（[src/core/types.ts](src/core/types.ts)）一一对应：

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识，也是配置里 `rules.<id>` 的键。 |
| `label` | 展示名。 |
| `description` | 一句话说明，`dvc rules explain` 会完整打印。 |
| `layer` | 生命周期层级。 |
| `kind` | 目标的物理类型（`node_modules` / `vendor` / `venv` / `build` / `cache` / `logs` / `temp` / `coverage` / `artifacts`）。 |
| `scope` | `project`（默认）或 `global`。 |
| `risk` | 初始风险（`safe` / `low` / `medium` / `high`），可被体积升级。 |
| `patterns` | glob 模式，匹配**绝对路径**。 |
| `withinEcosystem` | 生态守卫；为 `null` 表示不限。 |
| `minEntries` | 条目数守卫；为 `null` 表示不限。 |
| `olderThanDays` | 陈旧度守卫；为 `null` 表示不限。 |
| `reportOnly` | 声明「只报告，不删除」。 |
| `note` | 展示在体积旁的短提示，如 `re-installable`。 |

**词汇表**

- `layer`（用户真正据以决策的轴）：`dependencies` 可重装 → `build` 可重建 → `cache` 只损失时间 → `artifacts` 可能不可再生。
- `risk`：`safe` / `low` / `medium` / `high`。规则声明的是**下限**，不是结论：单个目标 ≥ `limits.highRiskBytes` 升为 `high`，≥ 其 1/4 升为 `medium`，升级只会往上、不会下调。
- `scope`：`project` 规则只在项目树遍历中匹配；`global` 规则由扫描器针对已知的机器级缓存位置单独探测，**不会**在项目遍历里匹配，因此不会误报。

**glob 方言**：`**` 跨分隔符、`*` 不跨、`?` 单字符、`{a,b}` 或、`[abc]` / `[!abc]` 字符类；模式锚定整条路径，点开头的目录同样参与匹配。

### 2. 三道守卫

| 守卫 | 语义 | 当前哪些规则用了 |
| --- | --- | --- |
| `withinEcosystem` | 只有在「最近的祖先项目」的生态集合（或该目录自身的 marker 集合）命中时才生效。作用：避免在一棵没有 PHP/Ruby 上下文的树里，把随便一个叫 `vendor` 的目录当成依赖删掉。 | `node-*`、`python-*`、`rust-*`、`java-gradle-build`、`php-vendor`、`ruby-bundle`、`dotnet-build`、`elixir-*`、`swift-build`、`cpp-build` |
| `minEntries` | 目标目录的直接条目数不足时不动作（锁 `too-small`）。作用：区分「真的装过」和工具留下的空占位目录。 | `node-modules` = 2；`php-vendor` = 10 |
| `olderThanDays` | 目标「最新文件的年龄」低于阈值时锁 `too-recent`。注意锚点是**最新文件**而不是目录 mtime：目录 mtime 只在增删条目时变化，所以一个天天在用、但只装过一次的 checkout 会看起来「很旧」。 | 内置规则**全部为 `null`**；单条规则可在配置里设 `olderThanDays` 打开它 |

合并规则时有一条关键设计：**最长路径优先**。`**/node_modules` 会匹配嵌套的 `node_modules`，但只保留最外层那一个，否则总量会被重复计算、并且会建议用户删除一个马上要随父目录一起消失的目录。同一个目录被两条规则命中时，保留目录中靠前的那条（结果对每次运行、每个平台都确定）。

### 3. 覆盖语义与优先级

优先级从低到高：

1. 内置规则声明（`src/rules/builtin.ts`）。
2. 规则级覆盖：配置里的 `rules.<id>`。
3. 全局阈值：`minSizeBytes`、`limits.*`。
4. CLI 参数：`--min-size`、`--max-depth`、`--root`（覆盖配置文件中的同名项）。

`rules.<id>` 支持的键及其语义：

| 键 | 语义 |
| --- | --- |
| `enabled: false` | 规则在编译阶段就被移除，不再匹配、不产生目标、不计入任何总量。 |
| `risk` | 替换初始风险（仍会被体积升级）。 |
| `minSizeBytes` | 只对该规则提高体积门槛；实际门槛取 `max(全局 minSizeBytes, 该值)`。 |
| `olderThanDays` | 打开/替换陈旧度阈值。 |
| `minEntries` | 替换条目数阈值。 |
| `extraPatterns` | **追加**到内置 `patterns`（不是替换），所以放宽规则时不必重抄内置模式。 |
| `reportOnly` | 强制打开或关闭「仅报告」。 |

覆盖**只能调整已有规则，不能新建规则**——写错 id 不会凭空造出一条删除规则。同时：`rules.<id>` 对象是 strict 的，`reportonly` 这种拼写错误会直接报错而不是静默失效；未知规则 id 会在 `dvc config validate` 里以 warning 报出。

### 4. 完整规则表

共 **45** 条（`dvc rules list` 与 `BUILTIN_RULE_COUNT` 一致）：

| id | label | layer | 默认风险 | scope | 仅报告 |
| --- | --- | --- | --- | --- | --- |
| `node-modules` | Node Dependencies | dependencies | low | project | |
| `node-next-cache` | Next.js Build Cache | cache | low | project | |
| `node-next-output` | Next.js Build Output | build | low | project | |
| `node-nuxt` | Nuxt Build Output | build | low | project | |
| `node-build-output` | JS/TS Build Output | build | low | project | |
| `node-vite-cache` | Vite / Turbopack Cache | cache | low | project | |
| `node-parcel-cache` | Parcel Cache | cache | low | project | |
| `node-swc-cache` | SWC / esbuild Cache | cache | low | project | |
| `node-storybook` | Storybook Output | build | low | project | |
| `node-tests-cache` | Test Coverage & Caches | cache | low | project | |
| `python-venv` | Python Virtualenv | dependencies | medium | project | |
| `python-pycache` | Python Bytecode Cache | cache | safe | project | |
| `python-eggs` | Python Packaging Artifacts | artifacts | low | project | |
| `python-tox` | Tox / Nox Environments | dependencies | low | project | |
| `python-pytest-cache` | Pytest / Mypy Cache | cache | low | project | |
| `python-ipynb-checkpoints` | Jupyter Checkpoints | cache | low | project | |
| `rust-target` | Rust Build Target | build | medium | project | |
| `rust-registry-cache` | Cargo Registry Cache | cache | low | project | |
| `go-build-cache` | Go Build Cache | cache | safe | project | |
| `go-mod-cache` | Go Module Cache | dependencies | low | project | |
| `java-gradle-project-cache` | Gradle Project Cache | cache | low | project | |
| `java-gradle-build` | Gradle Build Output | build | low | project | |
| `java-gradle-global-cache` | Gradle Global Caches | cache | low | global | |
| `java-maven-repo` | Maven Local Repository | dependencies | high | global | |
| `java-target` | JVM Build Output | build | low | project | |
| `php-vendor` | PHP Vendor Dependencies | dependencies | low | project | |
| `ruby-bundle` | Ruby Bundle Path | dependencies | low | project | |
| `dotnet-build` | .NET Build Output | build | low | project | |
| `elixir-deps` | Elixir Dependencies | dependencies | low | project | |
| `elixir-build` | Elixir Build Output | build | low | project | |
| `swift-build` | SwiftPM Build Directory | build | low | project | |
| `cpp-build` | CMake / Meson Build Tree | build | low | project | |
| `generic-cache` | Project Cache Directory | cache | safe | project | |
| `generic-logs` | Project Log Files | cache | low | project | |
| `generic-tmp` | Temporary Output | cache | safe | project | |
| `global-npm-cache` | npm Cache | cache | low | global | |
| `global-pnpm-store` | pnpm Content Store | dependencies | high | global | |
| `global-yarn-cache` | Yarn Cache | cache | low | global | |
| `global-pip-cache` | pip Download Cache | cache | low | global | |
| `global-uv-cache` | uv Cache | cache | low | global | |
| `global-xcode-derived-data` | Xcode DerivedData | build | medium | global | |
| `global-xcode-archives` | Xcode Archives | artifacts | high | global | ✅ |
| `global-cocoapods` | CocoaPods Cache | cache | low | global | |
| `global-homebrew-cache` | Homebrew Download Cache | cache | safe | global | |
| `global-docker-report` | Docker Data (report only) | artifacts | high | global | ✅ |

其中 14 个生态的探测 marker 定义在 [src/core/detector.ts](src/core/detector.ts)：`node`、`deno`、`bun`、`python`、`rust`、`go`、`java-maven`、`java-gradle`、`php`、`ruby`、`dotnet`、`elixir`、`swift`、`c-cpp`。

> ⚠️ **`reportOnly` 当前的实际强度**：扫描器把 `reportOnly` 目标锁成 `risk-exceeds-policy`，而该锁属于**可覆盖**集合，因此 `dvc clean --include-locked` 会把这两条规则的目标放进删除计划。不要对 `global-xcode-archives` / `global-docker-report` 使用 `--include-locked`；Docker 请用 `docker system prune`，Xcode 归档请在 Xcode 里删。

---

## 安全模型

### 1. 三步模型

1. **选择**：用筛选条件（`--target` / `--layer` / `--rule` / `--older-than` / `--path` / `--min-size`）或交互界面选定目标。
   *交互多选界面尚未接线（见文首「项目状态」），当前请使用筛选参数。*
2. **干跑预览**：`dvc clean` **默认就是预览**，逐条打印将要删除的目标、体积、层级与锁定状态，一个字节都不动。`--dry-run` 可以显式否决 `--yes`。
3. **二次确认**：只有 `--yes` 才真正执行。且 `--yes` 必须至少搭配一个筛选条件。

```bash
$ dvc clean --root ~/Content --yes
refusing to delete with no selection criteria; pass --target, --layer, --rule, --older-than, --path or --min-size (or use the interactive interface)
$ echo $?
1
```

注意 `--root` **不算**筛选条件：把扫描范围限定在一棵树并不构成「我要删哪些东西」的表达。

### 2. 路径守卫（四道，删除前重算）

每一步都在**删除发生之前**重新计算，不信任扫描时的结论：

| 守卫 | 规则 |
| --- | --- |
| `protected-path` | 内置拒绝列表，**代码硬编码、不可通过配置放宽**。 |
| `outside-root` | 必须落在 `config.roots` 内，按路径组件边界比较（因此 `/home/user2` 不算在 `/home/user` 内）。 |
| `whitelisted` | 不能落在用户白名单前缀内。 |
| `too-small` | 不能小于 `max(全局 minSizeBytes, 该规则的 minSizeBytes)`。 |

内置拒绝列表（POSIX 侧）：`/`、`/bin`、`/boot`、`/dev`、`/etc`、`/lib`、`/lib64`、`/opt`、`/proc`、`/root`、`/sbin`、`/srv`、`/sys`、`/usr`、`/var`、`/System`、`/Library`、`/Applications`、`/private`、`/Volumes`、`/cores`；另外**家目录本身**以及家目录下的用户数据目录（`Desktop`、`Documents`、`Downloads`、`Movies`、`Music`、`Pictures`、`Public`、`Library/Application Support`、`Library/Containers`、`Library/Keychains`、`Library/Mail`、`Library/Messages`、`Library/Mobile Documents`、`Library/Preferences`、`Library/Saved Application State` …）同样被拒绝。Windows 有对应的驱动器根与用户目录列表。

用户想**扩大**保护范围只能通过 `whitelist`；**无法**缩小内置拒绝列表。这是刻意的：可配置的拒绝列表等于一个能把家目录删掉的拼写错误。

### 3. 符号链接

- **测量与匹配阶段从不跟随链接**：体积遍历用 `lstat`，符号链接只计入自身大小；规则遍历直接跳过符号链接条目。跟随链接会破坏「不越出扫描根」这一前提。
- **删除前重新解析并复核**：执行器对每个目标先解析 `realpath`，如果真实路径与计划路径不同，就对真实路径**再跑一遍**上面四道守卫。这就是「扫描之后有人把目录换成指向 `/etc` 的软链」的防线。
- **两套拒绝列表判定**：`isProtectedPath` 用于用户给定的（未解析）路径，`isProtectedResolvedPath` 用于 `realpath` 之后的路径。后者对 macOS 的 `/private/tmp` 别名做了显式豁免——`/tmp` 在 macOS 上是指向 `/private/tmp` 的链接，若不做豁免，任何位于 `/tmp`、`/var/folders` 下的合法项目都会被误判为 `protected-path`，表现为「扫描能看见、删除永远拒绝」。豁免清单刻意只有一项，`/private/var/db`、`/private/var/log`、`/private/var/tmp` 都不在其中。

### 4. 锁定原因：哪些能被放开

| 锁定原因 | 可被 `--include-locked` 放开？ |
| --- | --- |
| `protected-path` | ❌ 永久 |
| `whitelisted` | ❌ 永久 |
| `outside-root` | ❌ 永久 |
| `too-small` | ❌ 永久 |
| `too-recent` | ✅ |
| `risk-exceeds-policy` | ✅ |
| `user-config` | ✅（v1 没有任何产生来源） |

判定是「白名单语义」：没有列进可覆盖集合的原因一律**默认不可覆盖**，新增锁原因时也必须显式加入才会变成可放开，属于 fail-closed。

两点实际情况需要说明：

1. 内置规则中没有任何一条声明 `olderThanDays`，且 `user-config` 在 v1 没有产生来源，所以**当前唯一实际会出现的可覆盖锁就是 `risk-exceeds-policy`，也就是 `reportOnly` 规则**（见上文的 ⚠️）。
2. 放开锁**不等于**绕过执行器：被放行的目标仍然带着 `locked: true` 与原始 `lockedReason`，预览里的锁定列照样显示，执行前的四道守卫也照样重算。

### 5. 执行器语义

- 执行器的输入**只有** `CleanPlan`，而 `CleanPlan` 只能由 planner 产出。执行器不接收报告、路径列表或谓词——否则就会出现第二条通往 `fs.rm` 的、未经确认门禁的路径。
- **删除是串行的**：所有目标争用同一块卷，并行只会把线性回收变成抖动；串行还能保证「已释放」单调递增、进度行永远指向当前真正的目标、Ctrl-C 不会留下并行启动的半删除目录。
- **每个目标删除前重新测量**体积。计划里的体积是扫描时刻的说法，直接当成「已释放」就是撒谎。若新测量与计划相差超过 **20%**，会在结果里记为漂移（`driftedTargetIds`），但**不取消删除**——用户确认的是路径，不是字节数。
- **失败隔离**：单个目标失败会被记录（`outcome: 'failed'` + `error`）并继续处理剩余目标，绝不中断整批。最终 `deletedCount / skippedCount / failedCount` 恰好划分所有结果。
- **部分失败影响退出码**：只要 `failedCount > 0`，`dvc clean` 以 `1` 退出。
- **`--dry-run` 完全不碰磁盘**：连读都不读，每个目标返回 `skipped / dry-run`、`freedBytes: 0`，只有计时的真实值。

---

## 报告与快照对比

### 1. JSON 契约

`dvc scan --json` 与 `dvc report export` 输出的是 `ScanReport` 文档本身（不是 `{ok,data}` 包装），顶层字段固定为：

```jsonc
{
  "schemaVersion": 1,          // 报告契约版本，先验它
  "toolVersion": "0.1.0",      // 产生报告的工具版本
  "scannedAt": "2026-09-29T15:00:42.891Z",
  "root": "/Users/you/Content",
  "platform": "darwin",
  "durationMs": 9712,
  "directoriesVisited": 41203,
  "skippedDirectories": 0,     // 读不了的目录数
  "truncated": false,          // 命中 limits.maxDirectories 而提前停止（此时总量是下界）
  "config": {                  // 产生这份报告时生效的配置快照，保证可复现
    "sourcePath": "/Users/you/dvc.config.json",
    "minSizeBytes": 1048576,
    "maxDepth": 6,
    "disabledRules": [],
    "whitelist": ["/Users/you/Library/Caches/pnpm"],
    "lockedRules": [],
    "ecosystems": ["bun", "c-cpp", "dotnet", "..."],
    "limits": { "highRiskBytes": 5368709120, "lightNodeModulesEntries": 500, "concurrency": 24, "maxDirectories": 400000 }
  },
  "targets": [ /* CleanTarget[]，按 bytes 降序、同体积按 path 升序 */ ],
  "projects": [ /* DetectedProject[]，同样排序 */ ],
  "summary": {
    "totalBytes": 23622320128,
    "reclaimableBytes": 0,
    "targetCount": 679,
    "lockedCount": 12,
    "fileCount": 8123456,
    "byLayer": [ /* 每个层级都在，顺序固定 */ ],
    "byRule": [ /* 按 bytes 降序 */ ],
    "byEcosystem": [ /* 按 bytes 降序 */ ],
    "largestTargetBytes": 4100000000
  }
}
```

单条 `targets[]` 的字段：`id`、`ruleId`、`label`、`path`、`projectPath`、`projectName`、`layer`、`kind`、`scope`、`risk`、`bytes`、`files`、`mtimeMs`、`ageDays`、`locked`、`lockedReason`、`note`。

字节数是原始整数（不预先格式化），这样求和、排序、diff 都精确；格式化只发生在展示层。

序列化是**字节稳定**的：字段顺序固定、2 空格缩进、以换行结尾，`targets` / `projects` 会强制按 `bytes` 降序、`path` 升序重排。换言之，两次同样的扫描产出同样的字节，`git diff` 里只会出现真正变化的行。

### 2. `schemaVersion` 策略

`SCHEMA_VERSION = 1`，它与包版本**相互独立**：

- 同一个 schema 版本内**可以新增可选字段**；字段重命名或删除必须提升 `SCHEMA_VERSION`。
- 读取时：缺失 / 非数字 / 负数 / 非整数 → 直接报错（无法确信它是报告）；**大于**当前版本 → 拒绝读取（`report schemaVersion N is newer than the supported version 1; upgrade DevEnvClean to read this report`）；**小于**当前版本 → 接受，缺失字段按契约零值补齐。这样既不会误读新格式，也不会让上个月的归档变成废纸。
- `dvc.config.json` 的 `schemaVersion` 与它同名但只管配置文件，取值不一致只会 warning。

### 3. Markdown 导出

```bash
dvc scan --root ~/Content --out report.md          # 扩展名推断为 markdown
dvc report export --root ~/Content --format markdown --dir .devenvclean
```

Markdown 报告便于贴进 PR 或作为构建产物归档：概览表、按层级 / 规则 / 生态的分解、最大的 20 个目标，完整目标列表折叠在 `<details>` 里；路径会转义 `|` 并包在代码span里，避免撑破表格。**Markdown 报告的表头与文案是中文硬编码**（与 `--lang` 无关）。

### 4. 快照与 CI 增长门禁

```bash
# 1) 基线（例如在 main 上执行一次，并归档为 CI artifact 或提交进仓库）
dvc report export --root "$HOME/Content" --dir .devenvclean --out baseline.json

# 2) 当前分支再导出一份
dvc report export --root "$HOME/Content" --dir .devenvclean --out latest.json

# 3) 门禁：净增长超过 500 MiB 就以退出码 2 失败
dvc report diff --from baseline.json --to latest.json --fail-on-growth 524288000
```

输出：

```text
disk usage change

  from  2026-09-29T15:00:56.824Z  2.2 MB
  to    2026-09-29T15:00:56.921Z  7.1 MB
  net   +4.9 MB

net +4.9 MB over 2 reports | 0 added, 0 removed, 1 grew, 0 shrank

     +4.9 MB  grew      /private/tmp/dvc-readme-demo/shop-web/node_modules
```

接入 GitHub Actions 时，把第 3 步单独作为一个 step，并让退出码 `2` 与工具故障（`1`）区分开来处理：

```yaml
- name: Disk growth gate
  run: |
    dvc report export --root "$HOME/Content" --dir .devenvclean --out latest.json
    dvc report diff \
      --from .devenvclean/baseline.json \
      --to latest.json \
      --fail-on-growth 524288000
```

`dvc report list` 用来确认目录里到底有哪些快照（默认按修改时间从新到旧）：

```bash
dvc report list --dir .devenvclean
```

---

## 开发

### 1. 脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | `tsup` 构建 `dist/`（`cli.js` + 库入口 `index.js`）。 |
| `pnpm dev` | `tsup --watch`，改动自动重建。 |
| `pnpm start` | `node dist/cli.js`，跑构建产物。 |
| `pnpm typecheck` | `tsc --noEmit`，严格类型检查。 |
| `pnpm lint` | `biome check .`（格式 + 静态检查）。 |
| `pnpm lint:fix` | `biome check --write .`，自动修复。 |
| `pnpm format` | `biome format --write .`，只格式化。 |
| `pnpm test` | `vitest run`，跑 `tests/**/*.test.ts`。 |
| `pnpm test:watch` | vitest watch 模式。 |
| `pnpm test:coverage` | 带覆盖率的测试。 |
| `pnpm check` | `typecheck && lint && test && build` —— **提交前必须全绿**。 |
| `pnpm prepublishOnly` | 发布前自动跑 `pnpm check`。 |

### 2. 目录结构

```text
src/
  cli/          # 命令行入口与 JSON/表格输出
    index.ts    #   ← 命令、参数、退出码的唯一定义处
    output.ts
  commands/     # 各子命令的实现：scan / clean / rules / config / report / doctor
  core/         # 引擎：types / platform / detector / measure / scanner / planner / executor
                #        doctor / format / ids
  rules/        # builtin（45 条规则目录）/ engine（匹配与去重）/ config（发现、校验、解析）
  report/       # json（字节稳定序列化）/ markdown / diff
  i18n/         # 语言检测与中英文案表（已实现，尚未被渲染层消费）
  tui/          # 交互式界面组件与主题（组件已完成，入口 run.ts 为占位实现）
tests/          # vitest 用例（真实创建/删除 tests/.fixtures 下的目录，故串行执行）
scripts/        # 开发辅助：smoke.ts（扫描冒烟）、frames.tsx（把界面组件渲染成文本帧）
docs/           # 需求与设计文档
dist/           # 构建产物（bin 指向 dist/cli.js）
```

### 3. 需求与设计文档

- [docs/requirements.md](docs/requirements.md) — 需求规格说明书：背景、用户与场景、竞品分析、功能/非功能需求、数据语义、安全分析、边界与不做的事、需求追踪矩阵。
- [docs/design.md](docs/design.md) — 技术设计文档：设计目标与硬约束、分层架构与依赖方向、逐模块职责、扫描/清理/diff 关键流程、算法设计、规则引擎、报告契约。

新增规则或新增生态的扩展路径（改哪两个文件、为什么漏一个 `rule.<id>` 会让启动失败），见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 贡献与许可

- 贡献流程、环境搭建、`pnpm check` 门禁、提交信息规范（Emoji + Conventional Commits）、**DCO 签名要求**与代码注释规范，见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- Bug 报告请附上 `dvc doctor --json` 与 `dvc scan --json` 的摘要，模板见 [.github/ISSUE_TEMPLATE/bug_report.yml](.github/ISSUE_TEMPLATE/bug_report.yml)。
- 本项目以 **MIT License** 发布，详见 [LICENSE](LICENSE)。

```
Copyright (c) 2026 zexuan.peng <pengzexuan2001@gmail.com>
```
