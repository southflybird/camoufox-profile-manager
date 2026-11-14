# CPM Custom 开发、升级与恢复

维护者：southflybird。上游：polyackiy/camoufox-profile-manager。
当前基础：官方 v0.7.0；定制版本：0.7.0+southflybird.1。

## 分支与提交

- `main` 只镜像官方 `main`，不添加定制代码。
- `custom` 保存经过验证的定制版本，发布以此分支为准。
- `feature/*` 从 `custom` 建立，每项功能单独提交。
- `sync/upstream-vX.Y.Z` 从 `custom` 建立，用于合入官方稳定版本。
- 升级 PR 的目标仓库必须是 **southflybird/camoufox-profile-manager**，目标分支是 **custom**。保留升级的 merge commit，不 squash 或重写已发布历史。

## 首次运行

需要 Git、Node.js 22 或更新版本、uv 和 Python 3.12。若 uv 不在 PATH，可使用 `python -m uv`。

```powershell
python -m uv sync --locked --python 3.12 --extra dev --extra build --extra sync --extra updates --extra chrome-migration
Push-Location web
npm.cmd ci
Pop-Location
python -m uv run --no-sync python scripts/build_webui.py
python -m uv run --no-sync python -m camoufox_pm.desktop
```

桌面版默认数据目录：`%LOCALAPPDATA%\CPM Custom`，安装目录：`%LOCALAPPDATA%\Programs\CPM Custom`；开始菜单与卸载注册均使用独立名称。
浏览器引擎下载能力仍沿用官方实现，浏览器缓存可能与官方版共用；管理器的数据库、配置、密钥与备份默认隔离。
`CPM_DB_PATH`、`CPM_SECRET_KEY` 或 `.env` 中的显式配置优先，运行前必须检查它们是否指向正式数据。
CLI 未加 `--desktop` 时仍使用工作目录下的 `data/profiles.db`。

不要让官方版和定制版同时打开同一套配置数据。首次验证只使用新建的测试配置；正式数据不自动迁移。

## 自动刷新

列表每 10 秒刷新、浏览器状态每 5 秒刷新。隐藏页面暂停，恢复焦点立即刷新。
后台请求失败保留现有数据，重试逐步退避到 60 秒；恢复成功后回到正常间隔。
搜索、排序、筛选、有效勾选、分页及正在编辑的表单均保留。外部已删除的配置会从勾选中移除。
权限丢失仍按原有权限机制清除受保护数据。手动操作后的刷新会取消旧请求，旧响应不会覆盖新数据。

## 跟进官方稳定版本

工作区必须干净。先阅读官方发布说明，尤其检查数据库和浏览器兼容性变化，再执行：

```powershell
.\scripts\Sync-Upstream.ps1 -Version v0.8.0
```

版本号为示例。脚本检查远程地址，快进更新 `main`，然后在独立升级分支合入指定官方标签。
遇到分叉或冲突会停止，不强制覆盖。检查 `git status`，解决冲突后 `git add`、`git merge --continue`；放弃本次合并使用 `git merge --abort`。
测试通过后推送升级分支，在自己的仓库创建指向 `custom` 的 PR，使用 merge 合并。

官方已经提供的功能优先采用；如果已覆盖自己的补丁，应在后续独立提交中移除重复实现。

## 发布与更新渠道

只从定制发布页下载安装：
https://github.com/southflybird/camoufox-profile-manager/releases

管理器的更新 API 与界面下载链接均限制在此仓库，不回退到官方安装包。没有定制发布时会明确提示。
本轮只支持手动安装，应用界面不提供自动替换入口。浏览器引擎下载与应用更新分别处理。

Python/npm/两份锁文件的版本须一致，例如 `0.7.0+southflybird.2`，对应标签 `custom-v0.7.0-r2`。
GitHub prerelease 标志控制预览发布；正式用户不会看到预览更新。预览测试后可以发布同一构建；若修改内容则增加 r 修订号。

```powershell
python -m uv run --no-sync python scripts/verify_custom_release.py --tag custom-v0.7.0-r1
# 完成下面的检查后，才创建并推送标签。
git tag -a custom-v0.7.0-r1 -m 'CPM Custom 0.7.0 r1'
git push origin custom-v0.7.0-r1
```

仅 `custom-v*` 标签触发定制发布流水线。流水线构建 Windows x64 安装包、运行冻结程序和安装生命周期检查、附加 SHA-256，创建 **draft prerelease**。
草稿不自动公开。安装与恢复验证完成后，在 GitHub 发布草稿。不要将镜像上游标签作为自己的新发布推送。
上游其他平台构建脚本仍保留供参考，本轮交付只承诺 Windows x64。

本地打包需要 NSIS（makensis 在 PATH、位于默认安装目录，或在 `%LOCALAPPDATA%\CPMCustomTools\nsis-3.13`）。也可通过 `CPM_NSIS` 指定编译器绝对路径：

```powershell
python -m uv run --no-sync python scripts/build_desktop.py --package
```

输出：`dist/cpm-custom-windows-x86_64-setup.exe` 与对应 `.sha256`。
安装包未签名，保持系统保护；校验和用于验证下载完整性，不等同于发布者身份认证。

## 检查

```powershell
python -m uv run --no-sync ruff check src tests scripts/verify_custom_release.py
python -m uv run --no-sync ruff format --check src tests
python -m uv run --no-sync mypy --platform linux src/camoufox_pm
# 首次 import 时也使用独立目录，不接触工作区或正式数据库。
$env:CPM_DB_PATH = Join-Path $env:TEMP 'cpm-custom-tests-bootstrap\profiles.db'
# 在独立 PowerShell 测试进程中移除继承的 API 密钥，不修改系统环境设置。
Remove-Item Env:\CPM_API_KEY -ErrorAction SilentlyContinue
python -m uv run --no-sync pytest -m 'not browser' -W error::ResourceWarning -W error::pytest.PytestUnraisableExceptionWarning
Remove-Item Env:\CPM_DB_PATH
Push-Location web
npm.cmd test
npm.cmd run lint
Pop-Location
python -m uv run --no-sync python scripts/build_webui.py
```

另需在隔离配置中人工检查：首次启动、安装浏览器、创建与启动配置、外部关闭浏览器、重启、配置归档恢复、覆盖安装后数据保留。
新刷新行为由 `web/tests/auto-refresh.test.ts` 与真实浏览器烟雾测试覆盖。
使用本机已安装的 Edge 验证 UI：`python -m uv run --no-sync python scripts/smoke_custom_ui.py`；可通过 `CPM_TEST_BROWSER=chrome` 改用 Chrome。
类型检查与 CI 一样按 Linux 平台分析跨平台代码。上游部分完整测试依赖 POSIX 或符号链接权限，Windows 本机的完整套件不能替代 Linux CI。

## 备份与回退

关闭管理器及所有受管理浏览器，保留对应版本安装包。使用已有完整恢复点机制，而不只依赖单配置 ZIP：

```powershell
python -m uv run --no-sync camoufox-pm --desktop update-recovery checkpoint
python -m uv run --no-sync camoufox-pm --desktop update-recovery status
```

记录 checkpoint ID 与 UTC 时间。该机制包括数据库、配置（含回收站）、浏览器及本地密钥；外部设置的密钥需要单独保存。备份不得加入 Git。
详见 [上游恢复协议](update-recovery.md)，目录隔离以本指南为准。

回退时先关闭全部实例，安装与恢复点匹配的定制旧版本，再恢复配套数据：

```powershell
python -m uv run --no-sync camoufox-pm --desktop update-recovery restore --checkpoint-id ID --confirm-timestamp TIMESTAMP
```

恢复会替换恢复点之后的数据状态，应先保存当前副本。不能仅切换旧 Git 标签或覆盖旧 EXE 后继续使用已升级的数据库。

首次从官方版迁移时，先关闭两套程序并完整备份实际官方数据目录和密钥，在副本上验证迁移；正式数据迁移单独进行。
