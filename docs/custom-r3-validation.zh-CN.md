# CPM Custom r3 与 MyDrive 双实例验证

版本：0.7.0+southflybird.3。尚未发布或覆盖安装。

- 后端相关测试：88 通过、1 跳过（配置、启动、CLI、更新运行时、认证、权限）。
- 前端：35 项测试、ESLint、TypeScript、静态构建通过。
- Ruff 与 git diff --check 通过。
- Windows 安装包及 SHA-256 已生成。
- 真实 Edge UI 与冻结 EXE 均通过 scripts/smoke_custom_ui.py --api-key --blocked-storage；冻结程序追加 --packaged dist/camoufox-pm/camoufox-pm.exe。
- 验证首次密钥认证、访问管理创建管理员、错误密码、用户名登录、刷新复用会话、注销后仍显示登录，以及机器 API Key 持续有效。
- 已安装原版 EXE 与新 Custom EXE 同时启动，分别指定临时数据库和合成 Key；两套服务均完成认证、创建合成配置。错误 Key 被拒绝，Custom 忽略故意设置的原版数据库路径和 Key，报告版本为 r3。
- 测试未启动真实浏览器环境、修改正式数据库、复制真实账户、覆盖安装或发布。

MyDrive：CPM/浏览器专项及相关配置、存储、计量、监控包测试通过；两套实例故意使用相同 profile ID，验证连接、密钥、查询、活动状态和缺失实例错误不串用。
MyDrive 相关前端测试与生产前端构建通过。正式 Wails 构建由用户手动执行 build.bat。
全量 MyDrive Go 测试仍有资源筛选和 IPQS 前置检查失败；IPQS 使用 git HEAD 原始 Go 文件的 overlay 可复现，资源筛选单独重跑通过。

安装步骤见 custom-dual-instance.zh-CN.md。
