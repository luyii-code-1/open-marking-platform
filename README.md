# Open Marking Platform

开源全流程阅卷系统。需求记录见 [概要设计完整整理](docs/概要设计完整整理.md)，接口契约见 [API](docs/API.md)。

后台角色、扫描客户端下载与配对、考场标签说明见[管理教师与扫描台](docs/管理教师与扫描台.md)。

## 开发

服务端使用 PostgreSQL 16。直接运行 Python 服务时，先创建 UTF-8 数据库，给应用角色授予该库内建表和创建函数的权限，然后把连接串放入环境变量 `OMP_DATABASE_URL`。例如本机开发库连接串的形式为 `postgresql://omp:<password>@127.0.0.1:5432/omp`。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn server.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

首次启动通过 `/api/v1/auth/bootstrap` 创建管理员。账号、会话、成绩、任务和审计记录保存在 PostgreSQL。扫描文件、归档和备份文件保存在 `OMP_DATA`，默认目录为 `data/`。

考试组接收首笔扫描页或答卷后锁定正式题卡。系统管理员可在“系统设置 → 数据库备份”创建、下载和删除指定备份，或启用每日北京时间 03:00 的自动备份。自动备份初始关闭。整库恢复需同时保管对应的扫描文件快照、归档和存储密钥。

## 验证

将 `OMP_TEST_DATABASE_URL` 指向独立的 PostgreSQL 测试库，并赋予测试角色创建 schema 的权限。测试和压测按运行创建临时 schema。

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

在 Linux 上可用独立临时数据库验证阅卷峰值。下例建立 1,000 个教师会话、10,800 份单面答卷和 1,000 条实时连接，经过本机 HTTPS 反代同时领题、同时评分，再重发原评分。运行前将文件描述符软上限设为至少 16,384。

```sh
ulimit -n 16384
python -m tools.benchmark_burst --users 1000 --papers 10800 --workers 2 --target 2 --realtime --caddy /usr/bin/caddy
```

输出包含各阶段的客户端 P95、连接状态和服务停止后的成绩核对结果。成功条件包括交分 P95 不超过 2 秒、每位教师各领一份答卷、幂等重放后分数与最终结果各有 1,000 笔。省略 `--caddy` 可单独测量 API。图片传输、扫描识别和公网链路应按现场数据另行计量。

领题和交分在 API 内按批提交，每个请求独立校验并使用 PostgreSQL 保存点，成功回执在事务提交后返回。Redis 复用同一题卡和题目的共享进度计数，成绩、领取租约和评分幂等键由 PostgreSQL 持久化。生产部署应同时更新 API、Worker、调度器镜像以及 Compose 中 API 和反代的资源设置。

Web 和 Windows 扫描客户端分别位于 `web/`、`scanner/`。设备兼容及完整业务验收状态记录在开发进度中。

前端构建及PWA校验：

```powershell
Set-Location web
npm ci
npm run build
npm run test:pwa
```

构建后由FastAPI提供前端文件。PWA安装、更新与后台长任务说明见 [PWA与后台任务](docs/PWA与后台任务.md)。正文功能与实际验收差距见 [需求验收清单](docs/需求验收清单.md)。

Windows客户端采用.NET 10 + WebView2，在线加载服务端扫描页面，离线使用随包页面和Python/OpenCV引擎；按考试、科目、组及批次办理，本地识读、切题与配页后持久排队上传。详见[扫描端工作区架构](docs/扫描端工作区架构.md)与[设备及双面扫描说明](docs/扫描端.md)。

Default组、题卡库、打印预览与审查发布见 [制卡工作流](docs/制卡工作流.md)。

## 部署

Compose 在项目私有网络中运行 PostgreSQL，使用命名卷 `postgres-data` 保存数据库。在 `.env` 中设置随机的 URL 安全密码 `OMP_POSTGRES_PASSWORD`，可用 `python -c "import secrets; print(secrets.token_hex(32))"` 生成。生产环境可用 `OMP_POSTGRES_IMAGE` 指定已校验的数据库镜像。API、Worker 和调度器使用同一数据库和业务文件目录。

**从旧版 SQLite 迁移**。先停止旧 API、Worker 和调度器，保留原数据库、扫描文件与旧发布版本。使用 SQLite 在线备份接口生成一致快照，或在完全停写后复制完整数据库。准备一个空的 PostgreSQL 数据库，让 `OMP_DATABASE_URL` 指向目标。先运行演练，再正式导入。

```sh
python -m server.database_transfer /path/to/omp.sqlite3 --check-only
python -m server.database_transfer /path/to/omp.sqlite3
```

核对迁移输出中的记录数，再启动新版服务。首次导入会保留审计顺序、会话及已退役的业务编号。切换后产生的新写入只保存在 PostgreSQL，回到旧快照前需要先处理这些差异。

自动和手动备份生成 `.ompdb`。恢复演练时，设置 `OMP_RESTORE_DATABASE_URL` 指向另一空库，并使用新的文件目录。例如 `python -m server.recovery backup.ompdb --target /restore/omp --files-from /snapshots/omp-data`。旧版 `.sqlite3` 备份也可导入。

Linux容器部署、持久队列与外部存储配置见 [部署与存储](docs/部署与存储.md)。

常规代码和界面发布跳过数据库快照。涉及数据库结构或批量数据变更时，为该发布创建一份校验通过的 PostgreSQL 恢复点；同一次发布重试时复用它。变更也会改写扫描文件时，另行保管对应的文件快照。发布通过健康检查和业务核验后，清理已被取代的发布备份。

生产 Compose 项目使用以下两个命令。`RELEASE_SHA` 取待发布版本的完整 Git 提交哈希。先在数据变更前运行 `prepare`，验收成功后再运行 `complete`。从发布宿主机操作时，脚本路径为 `/opt/openmarkingplatform/tools/database_backup.py`。

```sh
docker exec -i omp-production-api-1 python - prepare "$RELEASE_SHA" < deploy/database_backup.py
# 发布并完成健康检查和业务核验后执行
docker exec -i omp-production-api-1 python - complete "$RELEASE_SHA" < deploy/database_backup.py
```

系统管理员在“系统设置 → 数据库备份”中独立控制每日自动备份。发布清理只针对部署工具生成的备份，管理员手动创建的备份、每日自动备份和迁移基线均由后台单独管理。

管理员日志检索和任教成绩范围见 [操作日志](docs/操作日志.md)。

赋分分段、外部对照表导入及修订发布见 [赋分方案](docs/赋分方案.md)。

源码部署包、Windows扫描端预览包的构建与安装更新见 [安装与交付](docs/安装与交付.md)。

真实Redis/Celery调度恢复及跨平台验证见 [Linux原生联调](docs/Linux原生联调.md)。

Python 3.13镜像构建与四容器业务验证见 [Docker镜像联调](docs/Docker镜像联调.md)。

原Compose网络、Caddy证书验证与WSS链路见 [Compose与HTTPS联调](docs/Compose与HTTPS联调.md)。

后续业务决定与现场验收所需信息汇总在 [待确认事项](docs/待确认事项.md)。

内网部署的地址配置、账号读取方式、资源限制及100人实测结果见 [内网测试部署](docs/内网测试部署.md)，文档连接信息为匿名示例。

题卡A3双面分栏、紧凑选择题、人工选卡、自动双面校准及逐题判分试算见[题卡分栏与判分](docs/题卡分栏与判分.md)。

本项目采用 [GPL-3.0-only](LICENSE)，第三方组件声明见 [NOTICE](NOTICE.md)。Windows扫描端采用 .NET 10；制卡与登录流程见 [界面导航与操作层级](docs/界面导航与操作层级.md)。

考试层级删除、数据保留与完整影响清单见 [删除与数据保留](docs/删除与数据保留.md)。
