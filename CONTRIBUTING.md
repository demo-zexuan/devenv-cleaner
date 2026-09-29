# 贡献指南

感谢参与 DevEnvClean（命令名 `dvc`）。本文件说明**怎么在本仓库工作**：环境、门禁、提交规范、代码注释规范，以及新增规则 / 新增生态的扩展路径。

需求与设计不在这里重复，请按需查阅：

- [docs/requirements.md](docs/requirements.md) — 需求规格：功能范围、非功能要求、安全模型、明确「不做的事」。
- [docs/design.md](docs/design.md) — 技术设计：分层架构、扫描 / 清理流程、规则引擎、报告契约。

---

## I. 开始之前

### 1. 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **>= 22** | `package.json` 的 `engines.node` 就是 `>=22`。TUI 依赖 Ink 7，低于 22 无法运行；`dvc doctor` 的第一个检查项就是这一条。 |
| pnpm | 与 `pnpm-lock.yaml` 匹配的版本 | 本仓库用 pnpm，提交 `pnpm-lock.yaml`；CI 用 `--frozen-lockfile` 安装。 |
| 操作系统 | macOS / Linux 优先 | Windows 可用，但路径与别名相关的行为主要在 macOS/Linux 上验证。 |

### 2. 搭建

```bash
git clone <repo-url> devenv-cleaner
cd devenv-cleaner
pnpm install
pnpm build          # 生成 dist/，之后可用 node dist/cli.js 直接跑 CLI
node dist/cli.js --help
```

开发时用 `pnpm dev`（`tsup --watch`）持续重建；测试用 `pnpm test:watch`。

---

## II. 提交前门禁：`pnpm check`

**在开 PR 之前，`pnpm check` 必须全绿。** 它串联了四项，任何一项失败都不应该提交：

```bash
pnpm check
```

等价于按顺序执行：

| 命令 | 作用 | 单独运行 |
| --- | --- | --- |
| `pnpm typecheck` | `tsc --noEmit`，严格模式类型检查 | 改了类型或签名后先跑这个 |
| `pnpm lint` | `biome check .`，格式 + 静态检查 | 自动修复用 `pnpm lint:fix`，只格式化用 `pnpm format` |
| `pnpm test` | `vitest run`，`tests/**/*.test.ts` | 覆盖率用 `pnpm test:coverage` |
| `pnpm build` | `tsup`，产出 `dist/` | `dist/` 是 `bin` 指向的产物，必须能构建 |

补充约定：

1. 测试用例放在 `tests/`，文件名 `*.test.ts`。测试会真实创建 / 删除 `tests/.fixtures/` 下的目录，因此 vitest 配置为**串行执行**（`pool: 'forks'` + `fileParallelism: false`）——请不要为了提速改成并行。
2. Biome 的行宽是 110、缩进 2 空格、单引号、行尾分号，别手工调格式，交给 `pnpm lint:fix`。
3. 新增行为请带测试；修 bug 请带一个先红后绿的用例。
4. CI 在 ubuntu 上跑完整门禁，在 macOS 上只跑 `pnpm test`。本地在 macOS 上开发时，尤其要跑 `pnpm test`——`src/core/platform.ts` 的 `/private/tmp` 别名逻辑只在 macOS 上真正生效。

---

## III. 提交信息规范（Emoji + Conventional Commits）

本仓库遵循 `~/.dsh/AGENTS.md` 的规范。格式：

```
<emoji> <type>(<scope>): <subject>

<body>

<footer>
```

Emoji 与 type 之间保留一个空格。

### 1. type ↔ emoji 对照

| Type | Emoji | 说明 |
| --- | --- | --- |
| `feat` | ✨ | 新功能 |
| `fix` | 🐛 | 修 bug |
| `docs` | 📝 | 文档变更 |
| `style` | 💄 | 纯格式调整 |
| `refactor` | ♻️ | 重构（无功能 / bug 变更） |
| `perf` | ⚡ | 性能优化 |
| `test` | ✅ | 测试增改 |
| `build` | 📦 | 构建 / 依赖变更 |
| `ci` | 🤖 | CI/CD 配置 |
| `chore` | 🔧 | 杂项维护 |
| `revert` | 🔙 | 回退提交 |

### 2. 硬性规则

1. **祈使句**：`add login`，不要 `added login` / `adds login`。
2. **首字母小写**：`fix typo`，不要 `Fix typo`。
3. **结尾不加标点**：`update config`，不要 `update config.`。
4. **首行 ≤ 72 字符**（含 emoji、type、scope）。终端与 GitHub PR 列表都按这个宽度显示。
5. **body 每行 ≤ 72 字符**，与 subject 之间空一行。
6. **body 写 Why 与 What，不写 How**。实现细节在 diff 里，重复一遍只会随时间失真。
7. footer 放 breaking change 与 issue 关联：`BREAKING CHANGE: ...`、`Closes #123`。

示例：

```bash
✨ feat(rules): add turborepo cache rule
🐛 fix(executor): re-check whitelist on the resolved path
📝 docs(readme): document the exit code contract
🤖 ci(release): guard publish behind the v* tag
```

---

## IV. DCO 签名（强制）

每个提交都必须带 `Signed-off-by` trailer，**且必须与 git Author 完全一致**。本仓库的 Author 是：

```
zexuan.peng <pengzexuan2001@gmail.com>
```

即：

```
Signed-off-by: zexuan.peng <pengzexuan2001@gmail.com>
```

### 1. 为什么会被拒

DCO 检查比对的是 `Signed-off-by` 与 `git log --format=%an` / 提交邮箱。下面这些写法都会失败：

- `Signed-off-by: Zexuan Peng <...>` —— 名字写成 `Zexuan Peng`，与 `zexuan.peng` 不一致，报错形如 `Expected git config user.name, but got ...`。
- `Signed-off-by: zexuan.peng <pengzexuan2001@gmail.com>` 之外的邮箱。
- 只给合并提交签名，而把中间提交漏掉——检查覆盖**每一个**提交。

### 2. 怎么签

```bash
git config user.name "zexuan.peng"
git config user.email "pengzexuan2001@gmail.com"

git commit -s -m "✨ feat(rules): add turborepo cache rule"
```

`-s` 会自动追加 trailer。已经提交但漏签，可以补：

```bash
git commit --amend -s --no-edit          # 只补最后一个提交
git rebase --signoff HEAD~3              # 补最近 3 个提交
```

> ⚠️ 使用 AI 工具辅助提交时，按本机 AGENTS.md 的规定：**任何 git 操作都必须先与用户确认**，再执行。

---

## V. 代码注释规范

代码注释一律**英文**（源码注释是英文，面向用户的文档 / README 是中文），遵循 `AGENTS.md` 的层次结构。

### 1. 文件头

每个文件以 JSDoc 块开头，说明这个模块**为什么存在**，而不是复述它做了什么：

```typescript
/**
 * Plan Executor
 *
 * Executes a {@link CleanPlan} one target at a time, re-verifying every safety
 * condition immediately before each unlink.
 *
 * I. Why the executor accepts only a `CleanPlan`
 *
 * 1. A `CleanPlan` can only be produced by `core/planner.ts`, which is the only
 *    module that knows the lock rules.
 *
 * @module core/executor
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */
```

`@author` 按 AGENTS.md 只写小写账号名（不含邮箱）：`@author zexuan.peng`。仓库现有 `src/**` 文件写的是 `zexuan.peng <pengzexuan2001@gmail.com>`；新增文件请与所在目录保持一致，不要创造第三种写法。

### 2. 层次序号

多层次的说明性注释严格按 `I.` → `1.` → `(1)` 递进，不跳级、不混用、序号连续，子层缩进 2–3 空格：

```typescript
/**
 * I. 第一层：整体设计
 *
 * 1. 第二层：某个方面
 *    (1) 第三层：具体做法
 *    (2) ...
 * 2. ...
 */
```

注释要**紧跟它所描述的代码步骤**：

```typescript
// I. 校验输入
// 1. 检查邮箱格式
// (1) 必须包含 @ 符号
if (!email.includes('@')) throw new Error('invalid email');
```

### 3. 禁止

- 复述代码的注释：`i = i + 1; // increment i`。
- 注释掉的旧实现：直接删掉，版本历史里有。
- 情绪化注释：`// terrible hack`。
- 过时注释——**过时的注释比没有注释更糟**。

`TODO` / `FIXME` 必须带作者与日期：

```typescript
// TODO: zexuan.peng - 2026-09-29
// 支持按 inode 复用统计结果，避免重复 lstat
```

---

## VI. 扩展路径

### 1. 新增一条清理规则（已有生态）

**主要只改一个文件**：`src/rules/builtin.ts`。在对应生态分节里追加一条 `rule({ ... })`，必填字段是 `id`、`label`、`description`、`layer`、`kind`、`patterns`；其余默认值是 `scope: 'project'`、`risk: 'low'`、`reportOnly: false`。

```typescript
rule({
  id: 'node-turbo-cache',
  label: 'Turborepo Cache',
  description: 'Remote/local task cache written by Turborepo. Rebuilt on the next task run.',
  layer: 'cache',
  kind: 'cache',
  patterns: ['**/.turbo'],
  withinEcosystem: ['node'],
  note: 'rebuilt on next run',
}),
```

然后**必须**在 `src/i18n/index.ts` 的中英两张表里各补一行 `rule.<id>`：

```typescript
'rule.node-turbo-cache': 'Turborepo Cache',   // EN_MESSAGES
'rule.node-turbo-cache': 'Turborepo 缓存',    // ZH_MESSAGES
```

漏掉任何一个，`assertMessageTables()` 会在模块初始化时直接抛错（这是刻意的：宁可启动失败，也不要发布一张对不齐的表）。测试在 `tests/engine.test.ts` 里补匹配 / 不匹配的用例。

两条容易踩的坑：

1. `withinEcosystem` 不是装饰：省略它意味着该模式会在**任何**目录树下匹配。像 `vendor`、`build` 这种名字必须限定生态，否则会误报。
2. `minEntries` 用来区分「真的安装」和占位空目录；`minSizeBytes` / `olderThanDays` 不建议写在规则里——前者由 planner 通过配置快照应用，`olderThanDays` 属于用户策略。

### 2. 新增一个生态（新语言 / 新包管理器）

这是两文件扩展路径，**不需要改引擎**：

1. `src/core/detector.ts` — 在 `ECOSYSTEMS` 里追加一条 `EcosystemDefinition`：`id`、`name`、`language`、`markers`。`markers` 里 `weak: true` 表示「只是提示，不足以单独判定为项目根」（例如只有 lock 文件没有 manifest）。`EcosystemId` 联合类型也要加上新 id。
2. `src/rules/builtin.ts` — 追加该生态的规则，用 `withinEcosystem: ['<新 id>']` 限定。
3. `src/i18n/index.ts` — 新规则的 `rule.<id>` 键（两张表都要）。
4. `tests/detector.test.ts` — 补 marker 识别用例（含 weak marker 的负例）。

生态默认是全部启用的（`resolveEcosystems` 先全开，再由配置关闭），所以新增生态会立刻出现在所有人的扫描结果里——请确认它的默认规则集不会误伤。

### 3. 不要碰的安全底线

- `src/core/platform.ts` 的内置拒绝列表（denylist）是硬编码的，不通过配置暴露。**不要为了「让某个目录能被删」而放宽它**；用户要保护自己的目录应该用 `whitelist`。
- `src/core/planner.ts` 的 `OVERRIDABLE_LOCK_REASONS` 是白名单语义：没有列出的 `LockReason` 一律**不可覆盖**，新增 reason 时默认即「拒绝覆盖」。这是刻意的 fail-closed 设计，请勿改成默认允许。
- `src/core/executor.ts` 只接受 `CleanPlan`，并且在每次 `rm` 之前重新校验。不要为任何调用方增加绕过它的删除路径。

---

## VII. 开 PR

1. 从 `main` 切分支，改动尽量小而单一。
2. `pnpm check` 全绿，并在 PR 描述里粘贴实际执行的命令与输出。
3. 使用 [.github/pull_request_template.md](.github/pull_request_template.md)：变更说明、关联 Issue、验证方式、DCO 勾选。
4. 有行为变更的，同步更新受影响的文档：`README.md`、`docs/requirements.md`、`docs/design.md`。
5. 文档里出现的每一个命令与参数都必须真实存在——README 的命令参考逐条对照 `src/cli/index.ts`，不要写「计划中」的用法。

---

## VIII. 许可

提交即表示你同意以 [MIT License](LICENSE) 授权你的贡献，并同意遵守上面的 DCO 签名要求。
