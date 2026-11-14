# CPM Custom r3：与原版并存

定制版应用配置改为 CPM_CUSTOM_ 前缀，绝不回退读取 CPM_。
例如 CPM_CUSTOM_API_KEY、CPM_CUSTOM_DB_PATH、CPM_CUSTOM_SECRET_KEY。
环境变量优先于 .env；旧 .env 中的 CPM_ 配置不再生效。
升级前应手动把属于定制版的显式配置迁到新名称；不要复制原版数据库路径或密钥。
默认数据仍为 %LOCALAPPDATA%\CPM Custom，已有 secret.key 保留。
若曾依赖外部 CPM_SECRET_KEY 加密数据，必须先把原值配置到 CPM_CUSTOM_SECRET_KEY；不得生成替代密钥。

首次设置：配置独立 CPM_CUSTOM_API_KEY，重启定制版，用该 Key 进入，在“访问管理”创建管理员。
创建首个账户后网页会转到用户名登录；以后复用有效会话，注销后回到用户名登录。
网页已有账户时不再携带缓存 Key；MyDrive 的 X-API-Key 调用仍可用。
原版继续使用 CPM_API_KEY 和原有数据目录。

MyDrive 设置中分别配置 CPM 原版与 CPM Custom，测试后保存。
原有绑定继续指向原版；默认新建实例只决定未绑定环境的创建位置。
在环境管理中选择目标实例创建或查找，再按需设为日常。
不要通过复制 profiles.db 或清空数据标识迁移旧绑定。
