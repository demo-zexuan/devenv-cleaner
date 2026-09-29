<!--
  提交 PR 前请先读 CONTRIBUTING.md。合并要求：`pnpm check` 全绿 + 每个提交带
  DCO 签名。标题请沿用 commit 规范（Emoji + Conventional Commits）。
-->

## 变更说明

<!--
  说明 Why 与 What：为什么需要这个改动、它改变了什么行为。
  不要复述实现细节——diff 已经在下面了。
-->

-

关联 Issue
----------

<!--
  用 `Closes #123` / `Fixes #123` 让合并后自动关闭；没有关联 issue 就写「无」并说明原因。
-->

-

验证方式
--------

<!--
  勾选你实际执行过的项，并粘贴关键命令的输出（尤其是失败前后的对比）。
  没有跑过的项请不要勾选。
-->

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm check`（以上四项的组合门禁）
- [ ] 手工验证：`node dist/cli.js <实际用到的命令>`

补充说明（手工验证的命令与实际输出）：

```text

```

影响面自查
----------

- [ ] 没有修改 `src/rules/builtin.ts` 之外会改变删除行为的代码；如修改了，已说明哪些目标会因此新增 / 不再被匹配。
- [ ] 如新增了规则 id，已在 `src/i18n/index.ts` 的中英两张表里补上 `rule.<id>`（缺一个会导致启动即抛错）。
- [ ] 如新增了 `LockReason`，已确认 `src/core/planner.ts` 的 `OVERRIDABLE_LOCK_REASONS` 行为符合预期（默认拒绝覆盖）。
- [ ] 如改动了报告 JSON 的字段，已同步更新 `src/report/json.ts` 并说明是否需要 bump `SCHEMA_VERSION`。
- [ ] 文档已同步：README / docs/requirements.md / docs/design.md 中受影响的部分。

DCO
---

<!--
  每个提交都需要一行与 git Author 完全一致的签名，否则仓库的 DCO 检查会失败：

    Signed-off-by: zexuan.peng <pengzexuan2001@gmail.com>

  用 `git commit -s` 自动追加。名字大小写、句点与邮箱必须逐字符一致。
-->

- [ ] 本 PR 的**每一个**提交都带有 `Signed-off-by` trailer，且与 `git config user.name` / `user.email` 完全一致。
