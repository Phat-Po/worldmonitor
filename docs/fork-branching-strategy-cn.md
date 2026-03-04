# WorldMonitor CN Fork - Baseline & Branch Strategy

Date: 2026-03-04

## 1) Current baseline

- Baseline commit: `f10880e`
- Baseline tag: `baseline/2026-03-04`
- Default working branch: `china/stable`

## 2) Branch split (分治)

- `china/stable`
  - 日常可运行分支（你本地长期使用）
  - 只接收已验证改动

- `china/r2-news-ai-hardening`
  - 第二轮改造分支（新闻可用性 + AI 洞察兜底）
  - 所有实验和改动先在这里完成

- `china/upstream-sync`
  - 上游同步缓冲分支
  - 每次同步 upstream 先在此分支对齐和验证，再决定是否合并回 `china/stable`

## 3) Daily workflow

1. 切开发分支:
   - `git checkout china/r2-news-ai-hardening`
2. 开发并验证:
   - `npm run typecheck`
   - `npm run typecheck:api`
   - `npm run test:sidecar`
   - `npm run build`
3. 验证通过后回合并:
   - `git checkout china/stable`
   - `git merge --no-ff china/r2-news-ai-hardening`

## 4) Upstream sync workflow (safe mode)

When network is stable:

1. `git ls-remote upstream HEAD` (先确认可连)
2. `git fetch upstream main`
3. `git checkout china/upstream-sync`
4. `git reset --hard china/stable`
5. `git merge --no-ff upstream/main`
6. 解决冲突 + 验证（typecheck/test/build）
7. 验证通过后：
   - `git checkout china/stable`
   - `git merge --no-ff china/upstream-sync`

## 5) Rules

- 不在 `china/stable` 上直接做实验。
- 每次同步都先过 `china/upstream-sync`，不要跳过。
- 任何 `git push` 前先人工确认（避免误触发远端部署）。
