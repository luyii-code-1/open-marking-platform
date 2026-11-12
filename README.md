# Open Marking Platform

开源全流程阅卷系统。需求记录见 [概要设计完整整理](docs/概要设计完整整理.md)，接口契约见 [API](docs/API.md)。

后台角色、扫描客户端下载与配对、考场标签说明见[管理教师与扫描台](docs/管理教师与扫描台.md)。

## 开发

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn server.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

首次启动通过 `/api/v1/auth/bootstrap` 创建管理员。数据默认保存在 `data/`，可通过 `OMP_DATA` 设置本地数据目录。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

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

Linux容器部署、持久队列与外部存储配置见 [部署与存储](docs/部署与存储.md)。

备份登记、下载、新目录恢复及数据目录切换见 [备份与恢复](docs/备份与恢复.md)。

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
