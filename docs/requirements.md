# DevEnvClean 需求规格说明书

> 产品名：**DevEnvClean** ｜ npm 包名：`devenv-cleaner` ｜ 可执行文件名：`dvc`
> 形态：TypeScript 编写的终端 TUI 应用，同时提供完整的非交互 CLI
> 本文档为 v1 需求基线。数据契约以 `src/core/types.ts` 为唯一真源，本文件不重复定义类型，只引用其名称。
> 技术选型（已冻结）：Node.js >= 22 ／ ESM ／ TypeScript strict ／ Ink 7 + React 19 ／ Commander ／ fast-glob ／ zod ／ picocolors ／ tsup ／ vitest ／ pnpm。
>
> 文档状态：待评审 ｜ 关联设计文档：`docs/design.md`

---

## I. 背景与问题陈述

### 1. 现象

现代开发机的磁盘压力不是来自源码，而是来自**可再生的派生产物**：第三方依赖副本、编译中间产物、包管理器与构建工具的全局缓存、模拟器与容器镜像。这些数据有三个共同特征：

1. **体量大**：单个项目即可占用数 GB，且随项目数量线性叠加。
2. **可再生**：理论上都能通过重新安装/重新构建恢复，因此"可以删"。
3. **不可见**：散落在 `node_modules/`、`target/`、`~/.gradle/caches` 等约定路径中，`ls` 与 Finder 都不擅长按语义聚合，用户无法判断"删了会损失什么"。

### 2. 量级估算（按生态）

| 生态 / 位置 | 典型单点占用 | 常见累积规模 | 再生成本 |
| --- | --- | --- | --- |
| `node_modules/` | 200 MB – 2 GB（含 `.bin`、native 依赖） | monorepo 50 包以上可达 20 – 60 GB | 低：`pnpm i` / `npm i` |
| `.pnpm-store` / `~/Library/pnpm/store` | 数十 GB（内容寻址，只增不减） | 30 – 80 GB | 中：需重新下载 tarball |
| `~/.npm/_cacache` | 1 – 10 GB | 5 – 20 GB | 中：需重新下载 |
| Rust `target/` | 单项目 2 – 20 GB（debug + incremental） | 多项目 30 – 100 GB | 高：全量重编译，分钟到小时级 |
| `~/.cargo/registry` | 2 – 15 GB | 5 – 30 GB | 中：需重新拉取 crate |
| Python `.venv/` + `__pycache__/` | 100 MB – 1.5 GB | 10 – 40 GB | 低 – 中：重装依赖或自动重建 |
| `~/.cache/uv`、`~/.cache/pip` | 数 GB | 5 – 30 GB | 中：需重新下载 wheel |
| `~/.gradle/caches` | 5 – 30 GB | 10 – 50 GB | 高：需重新下载并解析依赖 |
| `~/.m2/repository` | 2 – 20 GB | 5 – 40 GB | 高：需重新下载 jar |
| macOS `~/Library/Developer/Xcode/DerivedData` | 10 – 100 GB | 单机即可占满 256 GB SSD | 中：增量重建，首次全量很慢 |
| macOS `~/Library/Developer/CoreSimulator`、`iOS DeviceSupport` | 每个运行时/设备 2 – 4 GB | 20 – 80 GB | 低 – 中：可重新下载 |
| Docker Desktop `Docker.raw` / `docker` 卷 | 20 – 200 GB | 常为单机第一大项 | 中：镜像需重新拉取 |
| 通用构建产物 `.next/`、`dist/`、`build/`、`coverage/` | 50 MB – 5 GB | 10 – 50 GB | 低：重新构建 |

结论：一台活跃使用 2 – 3 年的开发机，可回收空间通常在 **100 – 500 GB** 量级，且分布高度长尾——少数巨型目录（Xcode、Docker、pnpm store）占据大部分空间，大量中小 `node_modules` 占据剩余部分。

### 3. 现有手段为什么不够

1. **看不清**：`du -sh` 在百万级 inode 上耗时数分钟且无并发；Finder"储存空间"只给应用/文稿的粗粒度归类，看不到 `.cargo`、`.gradle` 这类点目录。
2. **分不清**：用户真正想区分的是"删了只是花时间重装"（dependencies / cache）与"删了可能不可恢复"（artifacts）；文件系统工具只按大小排序，不提供这种语义分层。
3. **不敢删**：没有 dry-run 预览、没有白名单、没有"这个目录正在被使用"的判断，误删 `target/` 或正在运行的 venv 的代价由用户承担。
4. **不可复用**：`cargo clean`、`pnpm store prune`、`docker system prune` 各自只覆盖一个生态，且多为"全删或全不删"，无法按目录年龄、大小阈值选择性清理，也无法把结果沉淀成可比较的报告。

### 4. DevEnvClean 的定位

一个**语义化、规则驱动、默认安全**的跨生态开发环境清理器：扫描配置的磁盘位置 → 通过 marker 文件识别项目 → 度量可回收目录 → 按可编辑规则库给出可解释的候选集 → 交互式多选 → dry-run 预览 → 二次确认 → 执行并出报告。同一套引擎可被 CI 以非交互方式调用，并将两次扫描的差异作为"磁盘增长门禁"。

---

## II. 目标用户与典型场景

### 1. 用户画像

| 画像 | 特征 | 核心诉求 |
| --- | --- | --- |
| 前端 / 全栈开发者 | 同时维护 5 – 50 个仓库，monorepo 常见；`node_modules` 是主要负担 | 快速定位可安全重装的依赖目录，批量清理长期不动的项目 |
| 后端开发者 | Rust / Go / Java / Python 混合；`target/`、`~/.gradle`、`~/.m2`、`.venv` 为主要负担 | 区分"重装便宜"与"重编译昂贵"的目录，避免误删构建缓存导致停工半天 |
| DevOps / CI 维护者 | 构建机磁盘周期性打满，需要无人值守清理与审计 | 非交互执行、JSON 报告入档、按增长量在 CI 中阻断 |
| 学生 / 低配设备用户 | 256 GB SSD 笔记本，剩余空间个位数 GB；不熟悉各类缓存路径 | 一键找出"占空间最多且删了没关系"的目录，并给出预计释放量 |

### 2. 典型场景

**S1 — 前端 monorepo 的空间审计**
痛点：150 个包，`node_modules` 合计 42 GB，其中 100 多个包半年未动；`du` 扫描一次要 4 分钟且看不到项目边界。
期望结果：`dvc` 首次扫描在 30 秒内给出按 layer 与 project 聚合的排行，用户筛出"180 天未修改 + 依赖层"的目标，dry-run 显示预计释放 31 GB，二次确认后实际释放偏差小于 5%。

**S2 — 低配 macOS 设备急救**
痛点：256 GB SSD 只剩 8 GB，系统"储存空间"只提示"系统数据"很大，无法定位。
期望结果：`dvc scan --root ~` 指出 `~/Library/Developer/Xcode/DerivedData`（38 GB）与 `iOS DeviceSupport`（22 GB）为前二大项，且被标为 `safe` / `low` 风险，用户可仅清理这两项即恢复可用空间。

**S3 — Rust 后端的"别删错东西"**
痛点：习惯性 `cargo clean` 后重新全量编译一次 40 分钟；同时 `~/.cargo/registry` 已 12 GB 但不敢删。
期望结果：DevEnvClean 把 `target/` 标为 `build` 层、`medium` 风险并附 `note`（"删除后需重新编译"），把 `~/.cargo/registry` 标为 `cache` 层、`low` 风险；默认勾选只包含 `safe` 层目标，`target/` 默认不选中。

**S4 — CI 构建机的无人值守清理与增长门禁**
痛点：构建机每两周磁盘打满一次，需要人工登录处理；同时希望尽早发现某个仓库的产物体积异常增长。
期望结果：CI 中执行 `dvc scan --json -o report.json` 归档，并执行 `dvc report diff baseline.json report.json --fail-on-growth 5GB` 作为门禁；清理任务用 `dvc clean --yes --layer cache --dry-run` 先做一次演练，确认日志无误后改为实际执行。

**S5 — 跨生态一次性大扫除**
痛点：Node + Python + Docker 混用，清理要分别记 `pnpm store prune`、`pip cache purge`、`docker system prune`，且都不可预览。
期望结果：单次 `dvc` 会话内使用 `f` 过滤到 `layer=cache`，`s` 按体积排序，一次性勾选 npm/pnpm/uv/cargo/gradle 的缓存目标，预览确认后执行，最终产出一份 Markdown 报告说明"清掉了什么、释放了多少、下次怎么复现"。

---

## III. 竞品与现有工具分析

| 工具 | 覆盖范围 | 缺失 | DevEnvClean 的补位 |
| --- | --- | --- | --- |
| **npkill** | 交互式查找并删除 `node_modules`，支持按大小排序 | 仅 Node 单生态；不含全局 store / 缓存；无规则引擎、无报告、无 diff；无分层风险模型；删除前无二次确认的强约束 | 跨生态（Node/Python/Rust/JVM/Go/通用构建产物）；规则可编辑；dry-run + 二次确认；报告可归档与比较 |
| **node_modules-cleaner** | 按磁盘与时间阈值自动清理 `node_modules` | 只做 Node；无交互选择；无预览；不度量其它生态 | 多生态 + 交互多选 + 预览；把"年龄/大小阈值"收敛为规则文件中的可配置项 |
| **BleachBit** | 系统级清理（浏览器缓存、临时文件、系统日志），有 GUI 与 CLI | 不理解"开发项目"结构，会清理与开发无关的系统文件，风险面大；不统计项目级依赖；无项目语义分组 | 只针对开发工件；通过 marker 文件建立项目边界；所有内置规则都是"开发语义"的，不碰系统文件 |
| **DaisyDisk** | macOS 环形可视化，交互式钻取磁盘占用 | 仅 macOS、闭源、只回答"什么大"不回答"什么能删"；无规则、无年龄/大小语义、无报告与 CI 能力 | 回答"什么能删、删了会怎样"；跨平台；报告与 diff 可入 CI |
| **`cargo clean`** | 清理当前项目 `target/` | 单项目、单生态；粒度只有 `-p` 包级，无全局 registry 管理；无 dry-run 的量化预览；无跨生态视角 | 在统一视图里与其他生态一起排序比较；按大小/年龄阈值选择性清理 |
| **`pnpm store prune`** | 清除 store 中未被任何项目引用的包 | 只处理"未被引用"的部分，无法回收被引用但项目已废弃的 store 内容；不度量、不报告、无预览 | 直接以 store 目录为 `global` 范围的 `cache` 目标，给出体积与风险，删除后再由包管理器重建 |
| **`docker system prune`** | 清理停止的容器、未使用镜像/网络/构建缓存 | 全或无式操作，`-a` 与 `--volumes` 极易误删；无预览影响范围与预计释放量；不参与跨生态聚合 | 以 `reportOnly` 规则报告 Docker 占用，给出提示与目标命令，不在 v1 内直接删除（见第 VIII 节） |
| **macOS"储存空间"设置** | 给出应用/文稿/系统数据的粗粒度分类与少量建议 | 不可操作第三方缓存（`.cargo`、`.gradle`、pnpm store 全部不可见）；无路径级信息；无报告 | 提供路径级明细、可解释的分层与可导出的报告 |
| **`du` / `ncdu`** | 通用磁盘占用统计与钻取 | 无语义（不知道 `node_modules` 与 `src` 的区别）；无并发，百万 inode 时慢；无规则、无报告契约 | 并发扫描 + 语义规则 + 稳定 JSON 契约；对 `du` 的补充而非替代 |

**共同缺口**：没有工具同时做到（a）跨生态、（b）语义分层与风险标注、（c）可编辑规则、（d）默认 dry-run 的安全确认模型、（e）版本化的机器可读报告与快照 diff。DevEnvClean 的全部功能设计都围绕填补这一交叉空白。

---

## IV. 需求范围 — 功能性需求

优先级：**P0** = v1 必须交付；**P1** = v1 应交付，可降级；**P2** = 可延后。

### 0. CLI 命令面总览

所有需求最终都落在下面这 7 个入口上（同名前缀的旗标需在各子命令间保持一致语义）。

| 入口 | 用途 | 关键旗标 / 子动作 | 退出码 |
| --- | --- | --- | --- |
| `dvc`（无子命令） | 默认进入 TUI 主流程 | `--root`、`--config` | 0 / 130 |
| `dvc scan` | 扫描并输出（可选保存）报告，支持排序 / 过滤 / 搜索 | `--root`、`--json`、`-o <file>`、`--max-depth`、`--concurrency`、`--sort`、`--layer`、`--kind`、`--ecosystem`、`--scope`、`--status`、`--search`、`--min-size`、`--max-size` | 0 / 1 / 130 |
| `dvc clean` | 按选择集清理；`--dry-run` 只看不做，`--yes` 跳过交互确认 | `--dry-run`、`--yes`、`--include-locked`、`--select <id...>`、`--from-report <file>`、`--layer`、`--report` | 0 / 1 / 130 |
| `dvc rules` | 规则库查询与解释（生效值 vs 内置默认） | `list`、`explain <ruleId>`、`--json` | 0 / 1 |
| `dvc config` | 配置脚手架、查看、校验、定位 | `init`、`show`、`validate`、`path`、`--with-docs`、`--path`、`--force` | 0 / 1 |
| `dvc report` | 报告查看、对已归档报告离线查询、两次快照比较 | `show`、`query`、`diff`、`--fail-on-growth <bytes>`、`--all` | 0 / 1 / 2 |
| `dvc doctor` | 环境、配置与规则自检 | `--json` | 0 / 1 |

退出码语义（全局统一，见 NFR-8）：**0** 成功；**1** 用法或校验错误；**2** diff 增长门禁未通过；**130** 用户中断。CI 依赖 `2` 与 `1` 的区分来决定"阻断"还是"修正配置"。

### 1. 扫描与识别

| 编号 | 描述 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-1 | 解析扫描根：合并 `config.roots`、`--root` 与默认根（`$HOME`），展开 `~`，去重并规范化；不存在的根记为警告而非致命错误 | P0 | 给定 2 个存在的根 + 1 个不存在的根，`scan` 成功退出，报告中涵盖两个存在的根，stderr 出现 1 条针对缺失根的警告；`ScanReport.root` 记录主根 |
| FR-2 | 通过 marker 文件识别项目：`package.json`、`pnpm-workspace.yaml`、`Cargo.toml`、`go.mod`、`pyproject.toml`、`requirements.txt`、`pom.xml`、`build.gradle(.kts)`、`Gemfile`、`composer.json`、`*.csproj`、`CMakeLists.txt` | P0 | 在临时目录写入 `package.json` 后扫描，`ScanReport.projects` 含该项目，`ecosystems` 含 `node`，`markers` 含 `package.json`；monorepo 每个含 marker 的子包各成一条记录 |
| FR-3 | 内置规则库覆盖全部 9 种 `TargetKind` 与 4 种 `TargetLayer`，规则条数 ≥ 24，每条规则含 id/label/description/layer/kind/scope/risk/patterns/reportOnly/note | P0 | `dvc rules list` 输出的每条规则字段完整；9 种 kind 各自至少被 1 条规则覆盖；4 种 layer 各自至少被 2 条规则覆盖 |
| FR-4 | glob 匹配语义与 `fast-glob` 一致，`dot: true`（点目录可命中），匹配对象为目录的**绝对路径** | P0 | `/proj/node_modules` 命中 Node 依赖规则；`/proj/.next` 命中 Next.js 构建规则；`/proj/sub/node_modules` 与 `/proj/node_modules` 命中同一规则 |
| FR-5 | 深度限制：`maxDepth` 默认 6，仅约束每个扫描根以下的遍历深度 | P0 | 构造深度 7 的 `node_modules`，默认配置下不出现在 `targets`；`--max-depth 8` 后出现 |
| FR-6 | 全局缓存规则（`scope: 'global'`）不依赖项目识别，直接以约定路径为目标 | P0 | 在无任何项目 marker 的空目录中执行扫描，`~/.cargo/registry`、`~/.gradle/caches`、`~/.npm/_cacache` 若存在则出现在 `targets` 且 `projectPath` 为 `null` |
| FR-7 | 度量时**不跟随符号链接**：symlink 目录不计入遍历，也不作为目标 | P0 | 在扫描根内创建指向根外的 symlink 目录，`targets` 不含该路径；根外目标不被度量、不被删除 |
| FR-8 | 目录访问硬上限 `maxDirectories`（默认 500 000）作为失控保护，超限时停止遍历并显式告警 | P0 | 人为将 `maxDirectories` 设为 200 并扫描更大目录树，进程正常结束（非崩溃），输出明确的截断告警，`directoriesVisited` 不超过上限 + 并发窗口大小 |
| FR-9 | 支持取消：`AbortSignal` 触发后停止遍历，不做部分写入，退出码 130 | P0 | 扫描中发送 SIGINT，进程在 1 秒内退出，退出码为 130，未生成半成品报告文件 |
| FR-10 | 扫描进度回调：按 `discovering` → `measuring` → `finalizing` 顺序触发 `onProgress`，携带已访问目录数、已发现目标数与当前路径 | P1 | 注册回调后，收到的 phase 序列单调不回退；`directoriesVisited` 单调不减；最终值与 `ScanReport.directoriesVisited` 一致 |
| FR-11 | 扫描中的不可读目录（EACCES/EPERM/ENOENT 竞态）被跳过并计数，不中断整体扫描 | P0 | 构造一个 `chmod 000` 的子目录，扫描成功完成，`skippedDirectories` ≥ 1，其余目标正常出现在报告中 |

### 2. 度量与统计

| 编号 | 描述 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-12 | 递归度量每个目标的 `bytes` 与 `files`，`bytes` 为原始整数（不做单位换算） | P0 | 对合成目录树，`bytes` 等于用同一文件集合独立求和的结果（含稀疏文件按逻辑大小计） |
| FR-13 | 每个目标记录 `mtimeMs`（目录自身最后修改时间）并换算 `ageDays` | P0 | 用 `utimes` 将目录 mtime 设为 100 天前，`ageDays` 为 100（允许 ±1 的取整误差） |
| FR-14 | 嵌套目标去重：当目标 A 的路径是目标 B 的祖先时，只保留 B（最长路径优先），A 不重复计入总量 | P0 | 构造 `/p/node_modules/x/node_modules`，`targets` 中只保留内层路径，`summary.totalBytes` 不含外层重复计数 |
| FR-15 | 汇总统计 `ScanSummary` 完整计算：`totalBytes`、`reclaimableBytes`、`targetCount`、`lockedCount`、`fileCount`、`byLayer`、`byRule`、`byEcosystem`、`largestTargetBytes` | P0 | 合成数据下逐项与手算一致；`byLayer` 恒含全部 4 个 layer（无目标时该层计数为 0）；`byRule` 与 `byEcosystem` 按 bytes 降序 |
| FR-16 | 桩目录过滤：`minEntries` 生效时，条目数不足的目录不产生目标（避免把空 `node_modules` 计入） | P1 | 空目录 `node_modules/` 不出现；含 50 个条目的 `node_modules/` 出现 |
| FR-17 | `node_modules` 轻/重启发式：条目数低于 `limits.lightNodeModulesEntries`（默认 20）时标记为轻量，在 TUI 中降级展示并不默认选中 | P1 | 构造 5 条目与 500 条目两个 `node_modules`，前者被标记为轻量且默认不选中，后者默认选中 |
| FR-18 | 度量精度：`clean` 执行前预估的 `CleanPlan.totalBytes` 与执行后 `CleanExecution.freedBytes` 的偏差 < 5%（在执行期间目标未被外部修改的前提下） | P0 | 在受控合成树上执行清理，`abs(freed - planned) / planned < 0.05` |

### 3. 规则引擎与配置

| 编号 | 描述 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-19 | 声明式规则形状严格对应 `CleanRule`，规则为纯数据，不含函数字段 | P0 | 序列化内置规则库为 JSON 无信息丢失；`dvc rules list --json` 可被重新读取 |
| FR-20 | 用户可通过 `UserConfig.rules[ruleId]` 覆盖 `enabled` / `risk` / `minSizeBytes` / `olderThanDays` / `minEntries` / `extraPatterns` / `reportOnly` | P0 | 对某规则设 `enabled: false` 后该规则不产生任何目标；设 `minEntries: 100` 后 50 条目的目录被锁定或剔除 |
| FR-21 | 合并优先级：内置默认 → 生态开关 → 用户配置 → CLI 旗标；后者覆盖前者，`extraPatterns` 为追加而非替换 | P0 | 同一次运行中 `--min-size 1GB` 覆盖配置文件中的 `500MB`；`extraPatterns` 与内置 patterns 取并集 |
| FR-22 | 冲突解决：`--layer` / `--kind` 等 CLI 过滤器与 `disabledRules` 为交集语义，任一维排除即不产出目标 | P1 | 规则被禁用时即使 `--layer` 匹配也不产出目标 |
| FR-23 | `risk` 升级：目标体积超过 `limits.highRiskBytes`（默认 5 GB）或年龄超过该规则 `olderThanDays` 阈值时，最终 risk 至少升一级（`safe`→`low`→`medium`→`high`，上限 `high`） | P0 | 一个 `safe` 规则命中 6 GB 目标，其 `CleanTarget.risk` 为 `low`；命中超龄目标时同样升级 |
| FR-24 | `locked` 与 `LockReason`：七种原因 `protected-path` / `whitelisted` / `too-small` / `too-recent` / `risk-exceeds-policy` / `outside-root` / `user-config` 均可达且互斥（取首个命中） | P0 | 为每种原因构造一个用例，`locked` 为 true 且 `lockedReason` 等于预期值；未锁定时 `locked` 为 false、`lockedReason` 为 null |
| FR-25 | 白名单：`whitelist` 中的绝对路径前缀下的目标一律锁定为 `whitelisted`，TUI 中不可选中 | P0 | 将某 `node_modules` 加入白名单后，该目标仍出现在报告（可见性）但 `locked` 为 true、TUI 不可选中 |
| FR-26 | 保护路径 denylist：内置不可删除路径（`/`、`/System`、`/usr`、`/etc`、`/var`、`$HOME` 自身、`$HOME/Library`、`$HOME/Documents`、`$HOME/Desktop`、`$HOME/Downloads`、扫描根自身）不进入可执行计划 | P0 | 构造指向 `$HOME` 的规则命中，目标被锁定为 `protected-path`；`dvc clean` 不会对其发起删除 |
| FR-27 | `reportOnly` 规则只报告不删除：命中的目标始终锁定，并在 TUI 中显示为"仅报告" | P0 | `docker` 类目标的 `locked` 为 true、`lockedReason` 非 null，执行阶段 `outcome` 为 `skipped` |
| FR-28 | 全局阈值：`minSizeBytes`（默认 1 MB）与规则级 `olderThanDays` 共同决定 `too-small` / `too-recent` 锁定 | P0 | 小于 `minSizeBytes` 的目标被锁定为 `too-small` 且不出现在默认计划中；`--include-locked` 也不能删除 `too-small` |
| FR-29 | `dvc rules list` 输出全部规则及生效覆盖；`dvc rules explain <ruleId>` 输出单条规则说明、命中路径、被锁定原因与可覆盖字段 | P0 | 对不存在的规则 id，`explain` 以非零码退出并给出候选建议；对存在的 id 输出包含 `description` 与生效阈值 |
| FR-30 | `dvc config init` 生成 `dvc.config.json`（JSON 无注释语法，`--with-docs` 额外生成同目录的 `dvc.config.md` 说明文件）；`dvc config show` 输出合并后的生效配置；`dvc config validate` 校验并报告错误位置；`dvc config path` 输出当前解析到的配置文件路径 | P0 | 在无配置的目录执行 `config init` 后文件可被 `config validate` 通过；`config init --with-docs` 生成配套 Markdown；`config path` 在无配置时输出空或提示使用内置默认 |
| FR-31 | 配置解析顺序：CLI 旗标 > 项目级 `./dvc.config.json` > 用户级 `~/.config/devenvclean/config.json` > 内置默认；`sourcePath` 记录实际生效来源 | P0 | 同时存在项目级与用户级配置时，项目级优先且 `ResolvedConfigSnapshot.sourcePath` 指向项目级文件 |
| FR-32 | 配置 schema 校验：未知字段、类型错误、数值越界均给出**含字段路径**的可读错误，退出码非零 | P0 | 将 `maxDepth` 设为 `"abc"`，`validate` 报错信息包含字段路径 `maxDepth` 与实际值类型 |
| FR-33 | `roots` 支持 `~` 展开与相对路径（相对配置文件所在目录解析） | P1 | 配置 `"roots": ["~/dev"]` 可正确扫描家目录下的 `dev` |
| FR-34 | `schemaVersion` 与当前契约不一致时发出警告但不阻断（仅在存在不兼容重命名时阻断） | P2 | 报告文件 `schemaVersion: 999` 时 `config validate` 给出警告且退出码为 0 |

### 4. 交互式清理

| 编号 | 描述 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-35 | 无子命令时默认进入 Ink TUI（`dvc` 等价于 `dvc tui`） | P0 | 直接执行 `dvc` 进入 TUI；`dvc` 在非 TTY 环境下自动降级为非交互模式或明确报错提示 |
| FR-36 | 结果屏支持按 layer / ecosystem / project / rule 分组，可折叠展开 | P0 | 使用 `←/→` 或 `h/l` 折叠后，子项隐藏且父项仍显示聚合体积；状态被正确保持 |
| FR-37 | 多选：`space` 切换单选、`a` 全选、`n` 反选；已锁定目标不可选中并给出原因提示 | P0 | 混选场景下选中集合与预期一致；对 `locked` 目标按 `space` 无效果并显示 `lockedReason` 文案 |
| FR-38 | 选择与过滤联动：过滤后 `a` 仅作用于当前可见且未锁定项 | P1 | 过滤出 3 项（其中 1 项锁定）后按 `a`，选中数为 2 |
| FR-39 | dry-run 预览：`d` 进入预览屏，展示将删除的目标明细、预计释放总量、被跳过的目标及跳过原因；**预览阶段不产生任何文件系统写操作** | P0 | 预览后目标目录仍存在；`CleanPlan.totalBytes` 与预览显示一致；`skipped` 与 `skipReasons` 非空时被渲染 |
| FR-40 | 二次确认：`enter` 进入确认屏，需再次明确确认（`enter` 或输入确认词）方可执行；确认屏必须显示目标数量与总字节数 | P0 | 在确认屏按 `q`/`esc` 可取消且无删除发生；确认后进入执行屏 |
| FR-41 | 执行屏逐目标展示 `CleanResult`，其 `outcome`（`CleanOutcome`）为 `deleted` / `skipped` / `failed`，实时刷新 | P0 | 对 3 个目标执行后，屏幕依次出现三条结果，`freedBytes` 累加显示 |
| FR-42 | 执行前 re-check：对每个目标重新做 `realpath`、denylist、root 包含性检查与 `stat`，路径不复存在或体积漂移超阈值时跳过而非失败 | P0 | 预览后手工删除其中一个目标，执行时该目标 `outcome` 为 `skipped` 且 `skipReason` 说明路径已消失；其余目标正常删除 |
| FR-43 | 部分失败可继续：单个目标删除失败不中断整体执行，最终汇总 `deletedCount` / `skippedCount` / `failedCount` | P0 | 使其中一个目标不可写，执行完成后其余目标被删除，`failedCount` 为 1 且 `results` 内含 `error` 文本 |
| FR-44 | 执行摘要屏展示 `CleanExecution` 全量统计与逐条结果，退出 TUI 后终端打印一行汇总 | P0 | 摘要屏字段与 `CleanExecution` 一致；退出后 stdout 出现一行汇总（非 TTY 模式下为纯文本） |
| FR-45 | 非交互清理：`dvc clean --yes` 跳过交互直接执行；`dvc clean --dry-run` 只输出计划不删除 | P0 | `--dry-run` 后目标仍存在且 stdout 输出计划摘要；`--yes` 在无 TTY 环境下可正常执行 |
| FR-46 | `--include-locked` 可解除部分锁定（`user-config` / `risk-exceeds-policy` / `too-recent`），但 `protected-path` / `whitelisted` / `outside-root` / `too-small` 永不可解除 | P0 | 对白名单目标使用 `--include-locked` 仍不删除；对 `too-recent` 目标使用后成功删除 |
| FR-47 | 清理选择可复现：`dvc clean` 支持 `--select <targetId...>` 或从报告文件读取选择（`--from-report`） | P1 | 使用报告中记录的 `id` 列表执行清理，选中集合与报告一致 |
| FR-48 | 执行后可选地自动生成清理报告（`--report`），记录执行前后对比 | P2 | 加 `--report` 后 `.devenvclean/` 下新增一份包含 `CleanExecution` 的报告文件 |

### 5. 查询与筛选

| 编号 | 描述 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-49 | `dvc scan --json` 输出符合 `ScanReport` 契约的 JSON 到 stdout，人类可读日志一律走 stderr | P0 | `dvc scan --json > r.json 2>/dev/null` 得到可被 `JSON.parse` 的结果且 stdout 无其它字符 |
| FR-50 | 排序：`--sort bytes\|files\|age\|path`，默认 `bytes` 降序 | P0 | 对同一报告分别按四种字段排序，输出顺序与预期一致；`age` 为降序（越旧越前） |
| FR-51 | 过滤：`--layer`、`--kind`、`--ecosystem`、`--scope`、`--status locked\|unlocked` 可组合 | P0 | 组合 `--layer cache --status unlocked` 输出中每项 layer 为 `cache` 且 `locked` 为 false |
| FR-52 | 搜索：`--search <substring>` 对目标路径做大小写不敏感的子串匹配 | P0 | `--search node_modules` 输出中每项路径均含该子串（大小写不敏感） |
| FR-53 | 体积阈值过滤：`--min-size` / `--max-size` 按字节筛选目标 | P1 | `--min-size 1GB` 输出中每项 `bytes` ≥ 1 GB |
| FR-54 | 对已有报告离线查询：`dvc report show <file>` 与 `dvc report query <file> --sort/--layer/...` 无需重新扫描 | P1 | 对一份已归档 JSON 执行 `report query`，结果为该文件的子集且无磁盘遍历 |
| FR-55 | 人类可读输出为紧凑表格，宽终端显示路径/层/风险/体积/年龄/文件数，窄终端自动省略次要列 | P1 | 终端宽度 60 列时输出不换行错乱，列数减少但关键列（体积、路径）保留 |
| FR-56 | 所有查询与筛选在 TUI 内等价可用：`s` 排序、`f` 过滤、`/` 搜索 | P0 | TUI 内执行搜索后列表实时收窄，清空搜索词后恢复 |

### 6. 报告与快照

| 编号 | 描述 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-57 | JSON 报告严格遵循 `ScanReport` 契约，含 `schemaVersion`、`toolVersion`、`scannedAt`、`root`、`platform`、`durationMs`、`directoriesVisited`、`skippedDirectories`、`config`（`ResolvedConfigSnapshot`）、`targets`、`projects`、`summary` | P0 | 报告经 zod 校验通过；`targets` 按 `bytes` 降序；所有字节字段为整数 |
| FR-58 | 报告写入：默认写入 `.devenvclean/`（可由 `report.dir` 覆盖），文件名含时间戳，同时维护一个 `latest.json` 指向最新 | P1 | 连续两次扫描后目录下有两份带时间戳报告且 `latest.json` 内容等于后一次 |
| FR-59 | Markdown 报告：包含概览表（总量/可回收/目标数/锁定数）、按 layer 汇总、按 ecosystem 汇总、Top-N 目标表与"本次生效配置"段落 | P0 | 生成的 Markdown 表格行列数正确；总量数字与 JSON 报告一致 |
| FR-60 | 快照 diff：`dvc report diff <old> <new>` 比较两份报告，输出 `ReportDiff` | P0 | 两次已知差异的扫描之间，`deltaBytes` 等于两次 `totalBytes` 之差 |
| FR-61 | diff 分类：按规范化绝对路径为键，分类为 `added` / `removed` / `grew` / `shrank` / `unchanged`，`entries` 按 `deltaBytes` 绝对值降序 | P0 | 构造新增、消失、增长、缩小、不变各一个路径，分类结果与预期完全一致 |
| FR-62 | diff 前置校验：两份报告 `schemaVersion` 不一致时拒绝比较并给出明确错误 | P0 | 篡改 `schemaVersion` 后 `report diff` 非零退出并提示版本不匹配 |
| FR-63 | CI 增长门禁：`--fail-on-growth <bytes>`，当 `deltaBytes` 超过阈值时以退出码 2 结束 | P0 | `deltaBytes` 超阈值时退出码为 2；未超时为 0 |
| FR-64 | 报告可复现性：`config`（`ResolvedConfigSnapshot`）足以说明"这份报告是用什么配置产生的" | P1 | 用报告中回显的配置重新扫描同一目录，`targets` 的 id 集合一致 |
| FR-65 | `dvc report` 无参数时展示最新报告的摘要 | P2 | 存在 `latest.json` 时输出概览；不存在时给出提示 |

### 7. 诊断

| 编号 | 描述 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-66 | `dvc doctor` 输出 `DoctorCheck[]`，覆盖：Node 版本 ≥ 22、平台支持、扫描根可读性、配置文件可解析、白名单与根的重叠、denylist 与 roots 的冲突、并发与内存上限合理性 | P0 | 每项含 `name` / `status` / `detail`，`status` 非 `pass` 时 `hint` 非 null |
| FR-67 | 权限诊断：报告不可读目录数量与首个典型路径，并给出修复提示 | P0 | 存在 `chmod 000` 目录时，对应检查 `status` 为 `warn`，`detail` 含该路径，`hint` 给出 `chmod`/`sudo` 建议 |
| FR-68 | 规则自检：校验内置规则 patterns 可编译、id 唯一、`withinEcosystem` 引用的生态存在 | P1 | 人为注入重复 id 的规则集，`doctor` 的对应检查 `status` 为 `fail` |
| FR-69 | 环境信息：输出 `dvc --version`、实际生效配置路径、各全局缓存路径是否存在及其体积（不递归） | P1 | 输出包含所有已配置 root 与已知全局缓存路径的存在性标记 |
| FR-70 | `doctor --json` 输出机器可读结果，便于 CI 归档 | P2 | 输出可被 `JSON.parse` 且为 `DoctorCheck[]` 数组 |

---

## V. 非功能性需求

| 编号 | 类别 | 需求 | 验收标准 |
| --- | --- | --- | --- |
| NFR-1 | 性能 | SSD 上 100 000 个目录的完整扫描 < 10 s；机械盘/网络盘不设硬性指标但必须有进度反馈 | 基准测试在 100k 合成目录上重复 5 次，P95 < 10 s |
| NFR-2 | 性能 | 并发模型为有界 I/O 池，默认 `concurrency = min(32, max(8, cpus × 4))`，可由 `limits.concurrency` 覆盖 | 并发数在运行期不超过配置值；`--concurrency 1` 时结果与并发运行一致 |
| NFR-3 | 内存 | 100 万文件规模下常驻内存 < 300 MB；不保留 per-file 记录，只做流式聚合 | 在 100 万合成文件上测量 `process.memoryUsage().rss`，峰值 < 300 MB |
| NFR-4 | 安全 | 绝不在扫描根之外删除任何内容；删除前对路径做 `realpath` 规范化并校验包含性 | 构造指向根外的 symlink 目标，执行阶段该目标 `outcome` 为 `skipped`（`outside-root`） |
| NFR-5 | 安全 | 默认 dry-run 心智：任何破坏性操作都必须经过"选择 → 预览 → 二次确认"，非交互模式必须显式传入 `--yes` | 无 `--yes` 且非 TTY 时 `dvc clean` 拒绝执行并以非零码退出 |
| NFR-6 | 安全 | 度量绝不跟随 symlink；不跨越设备边界改变判定语义（跨挂载点目标单独标记） | symlink 目录不计入 `bytes`/`files`；跨挂载点子目录不被视作同一目标的内部内容 |
| NFR-7 | 安全 | 权限不足是"跳过并计数"而非错误：不可读目录不导致扫描失败，不可写目标不导致整体清理失败 | 混入不可读目录的扫描成功退出；混入不可写目标的清理完成且 `failedCount` 准确 |
| NFR-8 | 可靠性 | 部分失败可继续，执行结果逐条记录；退出码语义固定：0 成功、1 用法/校验错误、130 用户中断、2 门禁未通过 | 四种场景分别断言退出码；`clean` 有失败目标时退出码为 0 但摘要含 `failedCount > 0` 提示 |
| NFR-9 | 可靠性 | Ctrl-C 可中断且幂等：扫描中断不写报告；清理中断停止后续目标但保留已完成记录并输出摘要 | 在执行第 3 个目标时中断，前 2 个结果被保留并打印，无残留半删除目录 |
| NFR-10 | 可测试性 | 核心为纯函数优先；文件系统、时钟、随机性通过依赖注入端口提供，测试可替换为内存实现 | 单元测试无需真实文件系统即可覆盖规则合并、diff、汇总、格式化；`core/**` 不 import `ink`/`react` |
| NFR-11 | 可移植性 | 支持 macOS 14+、Linux（glibc 与现代 musl 发行版）、Windows 11（PowerShell/Windows Terminal） | 三平台 CI 上 `scan`/`report`/`doctor` 的 fixture 测试通过；路径分隔符与大小写差异被规范化层吸收 |
| NFR-12 | 可移植性 | 大小写不敏感文件系统（APFS 默认、NTFS）下，白名单与 denylist 比较使用规范化大小写策略，避免"写错大小写即绕过保护" | 在大小写不敏感卷上以不同大小写书写白名单路径，仍能正确锁定目标 |
| NFR-13 | 可访问性 | 窄终端降级：宽度 < 80 列时切换为单列紧凑布局；< 60 列时隐藏次要列 | 60/80/120 列三种宽度下渲染不溢出、不串行 |
| NFR-14 | 可访问性 | 无色终端降级：遵循 `NO_COLOR` 与 `TERM=dumb`，不依赖颜色传递语义（风险等级同时用文本标签表达） | `NO_COLOR=1` 时输出不含 ANSI 转义；风险以 `[safe]` 等文本形式可见 |
| NFR-15 | 可访问性 | 非 TTY 与非交互场景提供纯文本/JSON 输出路径，保证管道与 CI 可读 | `dvc scan --json`、`dvc report show` 在管道中输出稳定文本 |
| NFR-16 | 可维护性 | 严格分层且依赖方向单向：`cli`/`tui` → `commands` → `core`/`rules`/`report`；`core` 不依赖任何 UI 与 Commander | 依赖检查（lint 规则或脚本）在 CI 中阻止 `core/**` 引入 UI 依赖环 |
| NFR-17 | 可维护性 | 契约稳定：`src/core/types.ts` 为唯一真源，跨模块结构不在此文件之外重复定义 | 代码评审检查项：新增跨模块结构必须先进 `types.ts` |
| NFR-18 | 国际化 | 文案表驱动（`i18n/*.ts`），v1 提供 `zh-CN` 与 `en-US`，无硬编码用户可见字符串 | 切换语言后 TUI 与 CLI 帮助文本全部变化；源码中不存在未被 i18n 包装的用户可见字面量 |
| NFR-19 | 打包与分发 | 单一 ESM 入口，`engines.node >= 22`，无原生（node-gyp）依赖，`npx devenv-cleaner` 可直接运行 | `tsup` 构建产物在 Node 22 下可执行；`pnpm pack` 后安装不触发编译 |
| NFR-20 | 可观测性 | `--verbose` 日志写入 stderr，绝不污染 stdout 的 JSON 契约；日志含阶段、耗时与跳过原因 | `dvc scan --json --verbose > r.json` 后 `r.json` 仍可被 `JSON.parse` |

---

## VI. 数据与磁盘语义

### 1. reclaimable 与 locked

- **可回收（reclaimable）**：在**当前生效配置**下允许被删除的目标。`summary.reclaimableBytes` 是所有 `locked === false` 目标的 `bytes` 之和。
- **锁定（locked）**：被识别并**照常报告**，但不可删除的目标。可见性与可删除性被刻意分离——用户需要知道"这里占了 20 GB，但因为你把它放进白名单/它是保护路径，我们不会动它"。
- **总量**：`summary.totalBytes` 包含锁定目标，代表"这些目录实际占了多少"；`reclaimableBytes` 才代表"现在能释放多少"。TUI 与报告必须同时呈现两者，避免把总量误读为可释放量。

### 2. 重复计算风险

| 风险 | 具体场景 | DevEnvClean 的处理 |
| --- | --- | --- |
| 嵌套 `node_modules` | 包 A 的 `node_modules/b/node_modules`，外层规则与内层规则同时命中，外层 `bytes` 已把内层算进去 | **最长路径优先**：同一规则族内，若目标 A 的路径是目标 B 的严格前缀（祖先），丢弃 A、保留 B。祖先与被包含者不同时出现在 `targets` 中，`totalBytes` 不重复 |
| monorepo hoisting | pnpm/npm workspace 把依赖提升到仓库根 `node_modules`，各子包只剩符号链接或极少文件 | 子包内的 `node_modules` 条目少 → 触发 `minEntries` 与轻量启发式，不产生独立目标；根 `node_modules` 作为唯一目标被度量。符号链接不跟随，避免把 store 内容重复计入 |
| 硬链接 | `nlink > 1` 的文件被两个目标目录引用，按 `stat.size` 累加会重复计数 | 记录 `st_nlink > 1` 的文件并只在其**首个**被访问的路径上计入；同一 inode 集合（`dev:ino`）在一个扫描会话内只累加一次 |
| APFS / Btrfs copy-on-write | 克隆文件共享物理块，删除逻辑上"释放"的字节不等于磁盘实际回收量 | 报告的是**逻辑字节**（与 `du` 口径一致但更快）；在文档与 TUI 帮助中明确标注"显示为逻辑大小，COW/压缩卷上实际释放可能更少" |
| 跨挂载点 | 目标目录内含指向另一块盘的子目录或挂载点 | 遍历时比较 `st_dev`；设备号变化即视为子树边界，计入 `skippedDirectories` 语义提示而非静默穿透 |
| 稀疏文件 | 声明大小远大于实际占用块 | 采用逻辑大小口径，并在文档中说明与 `df` 的差异来源 |
| 全局缓存与项目副本 | pnpm store 与项目 `node_modules` 中同一包的硬链接 | 依赖硬链接去重（同一 `dev:ino` 只计一次）与"store 为 `global` scope"的范围区分，二者不会重复相加 |

### 3. 语义分层

`TargetLayer` 是用户决策的主轴，其内涵必须在 UI 与文档中保持一致：

| Layer | 含义 | 丢失代价 | 默认风险基线 |
| --- | --- | --- | --- |
| `dependencies` | 可重新安装的第三方依赖副本（`node_modules`、`vendor`、`.venv`） | 一次安装耗时 + 网络流量 | `low`（重装昂贵的大目标升级为 `medium`） |
| `build` | 可由源码重建的编译/打包产物（`target/`、`dist/`、`build/`、`.next`） | 一次完整重建耗时，可能数十分钟 | `medium` |
| `cache` | 工具缓存（`~/.npm/_cacache`、`~/.cargo/registry`、`~/.gradle/caches`、`~/.cache/uv`、pnpm store） | 重新下载，通常可接受 | `safe` 或 `low` |
| `artifacts` | 可能是唯一副本的产出（安装包、生成的 schema、导出数据） | 可能不可恢复 | `high`，且默认 `reportOnly` 或强制二次确认 |

---

## VII. 安全与风险分析

### 1. 风险与缓解

| 风险 | 触发场景 | 潜在影响 | 缓解措施 |
| --- | --- | --- | --- |
| 误删源码 | 某项目把 `dist/` 或 `build/` 用作源码目录；用户在该目录内直接编辑 | 不可恢复的数据丢失 | denylist 覆盖常见源码目录名；`build`/`artifacts` 层默认为 `medium`/`high` 且不默认选中；二次确认屏明确列出被删路径；`reportOnly` 可用于纯报告 |
| 删除正在使用的目录 | 删除正在运行 dev server 的项目 `node_modules`，或某进程 cwd 落在目标内 | 进程崩溃、构建中断、罕见的数据不一致 | 执行前 `re-check`；对 `.venv`、`target/` 等标记 `note`（如"确认无活动构建"）；文档建议清理前停止构建；不尝试强制结束进程 |
| 权限不足 | 目标属主为 root，或位于需管理员权限的路径 | 清理部分失败、用户以为已清理 | 逐个目标独立处理，失败记入 `failedCount` 与 `error`；`doctor` 预检并给出 `hint`；不自动提权 |
| 网络盘 / 外置盘 | 扫描根位于 SMB/NFS 挂载或未挂载的外置卷上 | 极慢扫描、挂载断开导致遍历错误、误删远端数据 | 比较 `st_dev` 识别跨设备边界；对网络文件系统给出性能提示；扫描根不存在时警告而非静默跳过；不自动挂载/卸载 |
| 符号链接逃逸 | 目标目录是 symlink，`rm -rf` 语义在不同实现下可能删除链接本身或链接目标 | 删除扫描根之外的任意路径 | 度量与删除均**不跟随** symlink；删除前对目标做 `realpath` 并与扫描根做包含性校验；不匹配 `outside-root` 的目标一律跳过 |
| 大小写不敏感文件系统 | 白名单写 `~/Dev/Node_Modules`，实际路径为 `~/dev/node_modules`，字符串比较失败 | 保护被绕过，误删本应受保护的目录 | 路径规范化层统一大小写策略（在大小写不敏感卷上按小写比较）；白名单与 denylist 匹配均走规范化后的路径 |
| 用户误操作 | 全选后直接确认；把 `$HOME` 误当作扫描根并全选 | 大面积误删 | 危险目标（`high` 风险或体积超 `highRiskBytes`）不参与 `a` 全选；二次确认屏显示总字节数与目标数；确认操作不可用单个快捷键连续触发；`--yes` 在非交互场景要求显式传入 |
| 配置错误 | 白名单路径拼写错误、`roots` 指向 `/` | 保护失效或扫描范围失控 | `config validate` 与 `doctor` 检查白名单/roots/denylist 的重叠与异常；`roots` 为文件系统根时给出显著警告并拒绝默认全选 |
| 失控遍历 | 扫描根指向巨型目录或存在循环挂载 | 长时间占用、内存增长 | `maxDirectories` 硬上限；`maxDepth` 限制；不跟随 symlink；`AbortSignal` 支持随时中断 |

### 2. 三步确认模型

破坏性操作必须顺序通过三个阶段，任一阶段可中止，且**只有第三阶段会写文件系统**：

1. **选择**：在结果屏通过多选确定候选集合。锁定目标不可选中。此阶段无任何写操作。
2. **干跑预览（dry-run）**：对候选集合计算 `CleanPlan`，渲染将删除的路径、预计释放总量、被跳过项与跳过原因、风险分布。此阶段同样无任何写操作，且是 CLI `dvc clean --dry-run` 与 TUI `d` 键的共同实现。
3. **二次确认**：独立确认屏显示"目标数 + 总字节数 + 最高风险等级"，要求用户再次明确确认。确认后进入执行阶段，执行前对每个目标做 re-check（见 `docs/design.md` 第 VII 节）。非交互模式以 `--yes` 显式替代此阶段。

---

## VIII. 边界与不做的事

| 不做的事 | 理由 |
| --- | --- |
| 回收站 / 撤销删除 | 用户未选择该能力。可靠撤销需要在删除前把内容移动到保留区（等价于一次完整复制，空间与时间成本翻倍），或依赖平台回收站 API（跨平台语义不一致、Linux 无统一接口、恢复元数据难以保证）。v1 以"默认 dry-run + 白名单 + denylist + 二次确认"换取安全，而不是以"可撤销"换取。配置中的 `retentionDays` 字段保留但不生效，仅为未来版本预留。 |
| GUI / Web UI | TUI 已覆盖交互选择、预览与确认；Web UI 会引入浏览器端状态同步、跨进程通信与打包复杂度，与"开发者终端工作流"的目标不符。 |
| 云同步 / 账号体系 | 无服务端组件、无遥测、无账号。报告是本地文件，用户可自行提交到自己的制品库。避免引入隐私与运维成本。 |
| Windows 注册表清理细节 | 注册表项与文件系统目标不属于同一语义模型（不是"可回收目录"，无法用 `CleanTarget` 表达）；且注册表误删的破坏性远高于缓存目录。v1 在 Windows 上只做基础的文件系统支持。 |
| 文件级目标（单个文件清理） | 原子单位是目录 `CleanTarget`。文件级粒度会让预览与确认的信息量爆炸，并显著提高误删风险。 |
| 卸载全局包 / 修改包管理器状态 | DevEnvClean 只删除缓存目录，不调用 `pnpm remove`、`npm uninstall`、`cargo uninstall`，不修改 lockfile、全局配置或包管理器数据库。避免与包管理器自身的状态管理冲突。 |
| 清理非开发类系统缓存 | 与 BleachBit 类工具划清边界：浏览器缓存、系统日志、缩略图缓存、废纸篓不在范围内。范围收窄换来更高的可预测性与更低的风险。 |
| 后台常驻 / 定时任务 / 文件系统监听 | v1 为一次性命令；常驻进程会带来跨平台服务注册、权限与升级问题。CI 场景用外部调度器触发 `dvc clean --yes` 即可。 |
| 系统级"清理全部"一键操作 | 不存在"跳过预览直接全删"的路径（包括 CI：`--yes` 仍需先经过 `scan` + 计划计算）。 |
| 删除 Docker 卷与镜像 | v1 仅通过 `reportOnly` 规则报告 Docker 占用并给出建议命令，不代为执行破坏性极强且范围难以精确界定的卷/镜像删除。 |

---

## IX. 成功指标

| 指标 | 目标值 | 测量方式 |
| --- | --- | --- |
| 首次扫描到首屏耗时（P50 / P95） | ≤ 15 s / ≤ 60 s（100k 目录、SSD） | 基准测试与真实机器埋点，从进程启动到结果屏首帧渲染 |
| 核心扫描吞吐 | 100k 目录 < 10 s（NFR-1） | vitest 基准 + CI 性能作业 |
| 误删率 | **0**（在任何已定义的保护条件下不得删除受保护路径） | 安全测试套件：symlink 逃逸、白名单、denylist、root 包含性、大小写变体全部必须为 `skipped` |
| 规则命中率 | 在 fixture 语料上 ≥ 95%（应命中的目标被识别） | 合成 fixture 目录树（覆盖 9 种 kind）的断言测试 |
| 清理偏差 | `abs(freedBytes - plannedBytes) / plannedBytes < 5%` | 受控合成树上的执行测试 |
| 锁定判定准确率 | 100%（七种 `LockReason` 的构造用例全部命中预期原因，且不误锁） | 规则引擎单元测试 |
| TUI 交互响应 | 按键到重渲染 < 100 ms（10 000 个目标规模） | `ink-testing-library` 组件测试 + 手工性能核对 |
| 报告契约稳定性 | 同一 `schemaVersion` 内，旧消费者解析新报告不报错 | 契约测试：对历史报告样本执行 zod 校验 |
| CI 门禁可用性 | `report diff` 在两次真实扫描间给出确定性的 `deltaBytes` | E2E：两次扫描 + diff 的固定断言 |
| 内存峰值 | 100 万文件 < 300 MB（NFR-3） | 大目录基准测试中的 RSS 采样 |

---

## X. 需求追踪矩阵

> 模块文件为最佳努力映射，与 `docs/design.md` 第 III 节的架构一致，后续实现时再校正。

| 需求编号 | 主要实现模块 | 辅助模块 / 测试 |
| --- | --- | --- |
| FR-1, FR-5, FR-6 | `src/core/scanner.ts` | `src/rules/config.ts`, `tests/core/scanner.test.ts` |
| FR-2, FR-3 | `src/core/detector.ts` | `src/rules/builtin.ts`, `tests/core/detector.test.ts` |
| FR-4, FR-19 | `src/rules/engine.ts` | `src/rules/builtin.ts`, `tests/rules/engine.test.ts` |
| FR-7, FR-8, FR-9, FR-10, FR-11 | `src/core/scanner.ts` | `src/core/platform.ts`, `tests/core/scanner.test.ts` |
| FR-12, FR-13, FR-16, FR-17, FR-18 | `src/core/measure.ts` | `tests/core/measure.test.ts` |
| FR-14, FR-15 | `src/core/planner.ts` | `src/core/scanner.ts`, `tests/core/planner.test.ts` |
| FR-20 – FR-24, FR-28 | `src/rules/engine.ts` | `src/core/planner.ts`, `tests/rules/engine.test.ts` |
| FR-25, FR-26, FR-27 | `src/core/platform.ts` | `src/core/planner.ts`, `tests/core/platform.test.ts` |
| FR-29 | `src/commands/rules.ts` | `src/rules/builtin.ts` |
| FR-30 – FR-34 | `src/rules/config.ts` | `src/commands/config.ts`, `tests/rules/config.test.ts` |
| FR-35 – FR-44, FR-48, FR-56 | `src/tui/*.tsx` | `src/commands/clean.ts`, `tests/tui/*.test.tsx` |
| FR-45, FR-46, FR-47 | `src/commands/clean.ts` | `src/core/executor.ts`, `tests/core/executor.test.ts` |
| FR-49 – FR-55 | `src/commands/scan.ts` | `src/core/format.ts`, `src/report/json.ts` |
| FR-57, FR-58, FR-64, FR-65 | `src/report/json.ts` | `src/commands/report.ts` |
| FR-59 | `src/report/markdown.ts` | `src/core/format.ts` |
| FR-60 – FR-63 | `src/report/diff.ts` | `src/commands/report.ts`, `tests/report/diff.test.ts` |
| FR-66 – FR-70 | `src/commands/doctor.ts` | `src/core/platform.ts`, `src/rules/config.ts` |
| NFR-2, NFR-3, NFR-19 | `src/core/measure.ts` | `src/core/scanner.ts` |
| NFR-4 – NFR-9 | `src/core/executor.ts` | `src/core/platform.ts`, `src/core/planner.ts` |
| NFR-10, NFR-16, NFR-17 | 全局架构约束 | `src/core/types.ts`, CI 依赖检查 |
| NFR-11, NFR-12 | `src/core/platform.ts` | `tests/core/platform.test.ts` |
| NFR-13, NFR-14, NFR-15 | `src/tui/components/*.tsx` | `src/core/format.ts` |
| NFR-18 | `src/i18n/*.ts` | 全部 UI 模块 |
| NFR-20 | `src/cli/index.ts` | 全部命令模块 |

---

## 附录 A. 术语与约定

| 术语 | 契约名 / 取值 | 含义与约定 |
| --- | --- | --- |
| 目标 | `CleanTarget` | 一个可删除的**目录**，是系统的原子单位。文件级目标不在范围内 |
| 候选 | 尚未经 planner 判定的匹配结果 | 内部概念；仅出现在扫描与规则匹配阶段，不进入报告 |
| 锁定 | `locked` / `lockedReason` | 已识别并**照常报告**，但不可删除。可见性与可删除性刻意分离 |
| 可回收 | `reclaimableBytes` | 当前生效配置下允许删除的目标体积之和，**不含**锁定目标 |
| 占用总量 | `totalBytes` | 所有已发现目标的体积之和，**含**锁定目标。UI 必须与可回收量并列展示 |
| 层 | `TargetLayer` = `dependencies` / `build` / `cache` / `artifacts` | 用户决策的主轴，表达"丢失代价"而非"文件类型" |
| 种类 | `TargetKind` = `node_modules` / `vendor` / `venv` / `build` / `cache` / `logs` / `temp` / `coverage` / `artifacts` | 物理形态，驱动默认风险与解释文案 |
| 风险 | `RiskLevel` = `safe` / `low` / `medium` / `high` | 删除代价的粗粒度分级；会随体积与陈旧度自动升级（FR-23） |
| 范围 | `TargetScope` = `project` / `global` | `project` 指位于某项目根之下；`global` 指机器级约定路径（`~/.npm/_cacache` 等），其 `projectPath` 为 `null` |
| 规则 | `CleanRule` | 纯数据的声明式匹配定义；函数字段不入契约 |
| 干跑 | `dryRun` | **只计算与校验、不写文件系统**。注意 `types.ts` 中该字段注释与命名不一致，见 `docs/design.md` 第 XIV 节 |
| 计划 | `CleanPlan` | 干跑的产物，是执行器的唯一合法输入 |
| 执行 | `CleanExecution` | 逐目标结果的汇总，`freedBytes` 为**实测**释放量 |
| 报告 | `ScanReport` | 版本化契约（`schemaVersion`）；`toolVersion` 与契约版本相互独立 |
| 快照 | 已归档的报告文件 | 用于跨时间比较；`report diff` 的两侧输入 |
| 逻辑大小 | — | 按文件 `size` 累加的字节数，与 `du --apparent-size` 口径一致；COW / 压缩卷上的实际物理释放可能更少 |
| marker 文件 | `DetectedProject.markers` | 用于识别项目与生态的约定文件（`package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml` …） |
| 轻量目标 | 轻量 `node_modules` | 直接条目数低于 `limits.lightNodeModulesEntries` 的依赖目录，通常由 hoisting 造成，默认不选中 |

约定：

I. 字节数一律为原始整数，格式化只发生在输出边界。
II. "删除"在本产品中只有一种含义：递归删除一个目录。不存在"部分删除某个目录内容"的操作。
III. "可回收"永远相对于**当前生效配置**而言；同一台机器换一套配置，可回收量会变。

---

## 附录 B. 场景 ↔ 需求映射

| 场景 | 主要相关需求 | 关键验收点 |
| --- | --- | --- |
| S1 前端 monorepo 空间审计 | FR-1、FR-2、FR-12、FR-14、FR-15、FR-17、FR-23、FR-36、FR-37、FR-39、FR-50 | 30 秒内出结果；monorepo 子包被识别为轻量；按 project 分组与"180 天未动 + 依赖层"筛选可用；偏差 < 5% |
| S2 低配 macOS 急救 | FR-3、FR-6、FR-13、FR-23、FR-50、FR-59 | Xcode DerivedData 与 iOS DeviceSupport 被识别并进入 Top 排行；风险标注可读；Markdown 报告可交给他人复现 |
| S3 Rust 后端"别删错" | FR-3、FR-14、FR-23、FR-24、FR-27、FR-37、FR-40 | `target/` 为 `build`/`medium` 且默认不选中；`~/.cargo/registry` 为 `cache`/`low`；`note` 解释重建代价；二次确认存在 |
| S4 CI 无人值守与增长门禁 | FR-45、FR-49、FR-57、FR-60、FR-61、FR-62、FR-63 | `scan --json` 可被 `jq` 解析；`clean --yes` 在无 TTY 下可用；`report diff --fail-on-growth` 退出码 2 |
| S5 跨生态大扫除 | FR-4、FR-6、FR-28、FR-35、FR-51、FR-55、FR-56 | 单会话内按 `layer=cache` 过滤并跨 5 个生态勾选；过滤 + 排序 + 搜索在 CLI 与 TUI 行为一致 |

此映射用于评审时快速判断"某条需求的优先级是否被真实场景支撑"：任何场景都不引用的 P0 需求应当被重新审视。
