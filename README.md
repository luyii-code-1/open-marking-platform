<!--markdownlint-disable MD001 MD033 MD041-->

<div align="center">

# <div><img src="web/public/branding/omp-mark.svg" height="280" width="280">  
 Open Marking Platform 开源全流程考试与阅卷管理系统</div>

[![Stars](https://img.shields.io/github/stars/luyii-code-1/open-marking-platform?label=Stars)](https://github.com/luyii-code-1/open-marking-platform)
[![Release](https://img.shields.io/github/v/release/luyii-code-1/open-marking-platform?include_prereleases&style=flat-square&color=%233fb950&label=版本)](https://github.com/luyii-code-1/open-marking-platform/releases)
[![License](https://img.shields.io/badge/License-GPL--3.0--only-blue?style=flat-square)](LICENSE)<br/>
![Python](https://img.shields.io/badge/Python-3.13-3776ab?style=flat-square&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169e1?style=flat-square&logo=postgresql&logoColor=white)
![.NET](https://img.shields.io/badge/.NET-10-512bd4?style=flat-square)

Open Marking Platform（OMP）是一套开源的全流程网上阅卷系统，<br/>
从制作答题卡、扫描识读，到老师在线评卷、成绩统计与赋分，一套系统全部完成。

#### [🚀 下载](https://github.com/luyii-code-1/open-marking-platform/releases) | [🐞 反馈问题](https://github.com/luyii-code-1/open-marking-platform/issues) | [🛠 开发与部署](#开发与部署)

</div>

## 功能

> [!TIP]
>
> OMP 由三部分组成：浏览器中使用的 **管理后台 / 阅卷台**、安装在扫描电脑上的 **扫描客户端**，以及部署在学校服务器上的 **服务端**。

### 考务管理

- [x] 管理考试项目、科目、选科组合与考场
- [x] 从 Excel 模板导入学生名册与任教安排，按班级与学科自动划定阅卷和成绩查看范围
- [x] 系统管理员、管理教师、阅卷教师分级权限，支持 Passkey 通行密钥登录
- [x] 完整的操作日志，谁在什么时候改了什么一目了然
- [x] 考试层级删除前列出完整影响范围，避免误删数据

### 答题卡制作

- [x] 可视化答题卡编辑器，支持 A3 双面分栏、紧凑选择题与主观题区域排版
- [x] 题卡库复用、打印预览与审查发布
- [x] 内置开源排版字体，打印效果在不同电脑上保持一致
- [x] 收到第一份扫描答卷后自动锁定正式题卡，防止误改

### 扫描与识读

- [x] Windows 扫描客户端，扫描后在本地完成识读、切题与双面配页
- [x] 支持 TWAIN 扫描仪，可通过设备插件适配更多型号
- [x] 自动校准双面顺序，检查图像质量、定位点与考号条码
- [x] 断网时继续扫描，答卷在本地持久排队，联网后自动上传
- [x] 扫描页面配对：在后台生成配对链接，扫描电脑一键接入

### 在线阅卷

- [x] 按题分配阅卷任务，老师领题、打分、提交一气呵成
- [x] 支持双评，两位老师评分未能确定最终分时自动进入第三轮仲裁
- [x] 实时同步阅卷进度，任务分配与完成情况随时可见
- [x] 异常卷汇总与人工处理，问题答卷集中解决
- [x] 支持安装为 PWA 应用，网络波动时评分不丢失
- [x] 经过 1,000 名教师同时阅卷的峰值压测，交分 P95 不超过 2 秒

### 成绩分析

- [x] 客观题自动判分，修改答案后可重新判分并试算
- [x] 班级、学科多维度成绩汇总与排名
- [x] 赋分方案：自定义分段，或导入外部对照表
- [x] 分数修改留痕，成绩报表导出与归档

### HTTP 防护工作台

- [x] 站点访问概览：页面浏览量（PV）、独立浏览器与活跃账号三种口径，配合请求趋势图
- [x] 访问日志按 IP、账号、处理结果、命中规则和状态码筛选
- [x] 跨页勾选日志，批量预览后按精确 IP 封禁（默认 24 小时）或放行
- [x] SQL 注入、XSS 检测与敏感路径防护，可选观察或拦截模式
- [x] 单 IP 频率限制与 IP 归属地策略
- [x] 接口性能统计：平均耗时、P95 与 5xx 错误一览

### 运维与数据安全

- [x] 后台一键创建、下载数据库备份，可开启每日自动备份
- [x] 扫描文件可存放在本地、S3 兼容对象存储、WebDAV 或 SFTP
- [x] 提供 Docker Compose 一键部署，自带 HTTPS 反向代理
- [ ] ……

## 开始使用

**首先，请确保您的设备满足以下需求：**

| 用途 | 推荐环境 |
| --- | --- |
| 服务端 | Linux 服务器，安装 Docker 与 Docker Compose |
| 扫描电脑 | Windows 10 版本 2004（build 19041）或更高版本，x64 |
| 管理与阅卷 | 最新版 Chrome、Edge、Firefox 或 Safari 浏览器 |

> [!IMPORTANT]
>
> 扫描客户端通过 HTTPS 连接服务端，服务端证书需要被扫描电脑上的 Windows 信任。

**1. 部署服务端**

```sh
git clone https://github.com/luyii-code-1/open-marking-platform.git
cd open-marking-platform
cp .env.example .env
# 编辑 .env：设置 OMP_DOMAIN 和随机生成的 OMP_POSTGRES_PASSWORD
docker compose up -d --build
```

**2. 创建管理员**

在浏览器中打开 `https://你的域名/`，按提示创建第一个系统管理员账号。

**3. 连接扫描电脑**

在扫描电脑上安装扫描客户端（可在 [Releases](https://github.com/luyii-code-1/open-marking-platform/releases) 下载），然后在管理后台的扫描台生成配对链接，或在客户端中输入服务器地址与配对码。

## 获取帮助

如果您遇到了问题、发现了 Bug，或者想提出新的功能，欢迎 [提交 Issue](https://github.com/luyii-code-1/open-marking-platform/issues/new)。

[![GitHub Issues](https://img.shields.io/github/issues-search/luyii-code-1/open-marking-platform?query=is%3Aopen&style=flat-square&logo=github&label=Issues&color=%233fb950)](https://github.com/luyii-code-1/open-marking-platform/issues)

## 开发与部署

### 项目结构

| 目录 | 说明 |
| --- | --- |
| [`server/`](server) | 服务端：FastAPI、PostgreSQL 16、Celery + Redis |
| [`web/`](web) | 管理后台与阅卷台：React、TypeScript、Ant Design、Vite |
| [`scanner/`](scanner) | Windows 扫描客户端：.NET 10、WebView2 |
| [`scanner-electron/`](scanner-electron) | Electron 版扫描客户端外壳 |
| [`scanner_engine/`](scanner_engine) | 答题卡识读引擎：OpenCV、ZXing-C++ |
| [`scanner-plugins/`](scanner-plugins) | 扫描仪设备插件 |
| [`deploy/`](deploy) | Compose 生产配置、Caddy 反向代理与备份脚本 |
| [`tools/`](tools) | 压测、冒烟测试与打包脚本 |

### 本地运行

服务端需要一个 UTF-8 编码的 PostgreSQL 16 数据库，连接串通过环境变量 `OMP_DATABASE_URL` 传入。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn server.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers --no-access-log
```

前端：

```powershell
Set-Location web
npm ci
npm run dev
```

### 测试

```powershell
# 服务端（OMP_TEST_DATABASE_URL 指向独立测试库）
.\.venv\Scripts\python.exe -m pytest -q

# 前端构建与校验
Set-Location web
npm run build
npm run test:http-guard
```

更多说明：

- [扫描设备插件开发](scanner/DEVICE-PLUGIN.md)
- [Electron 扫描客户端构建](scanner-electron/README.md)
- [HTTP 检测引擎（libinjection）构建](third_party/libinjection/README.md)

欢迎提交 [Pull Request](https://github.com/luyii-code-1/open-marking-platform/pulls) 参与改进。

## 致谢

本项目使用的第三方组件及其许可证见 [NOTICE](NOTICE.md)。IP 归属地数据来自 [Loyalsoldier/geoip](https://github.com/Loyalsoldier/geoip)。

## 许可证

本项目基于 [GNU General Public License v3.0 only](LICENSE) 获得许可。

<div align="center">

如果这个项目对您有帮助，请点亮 Star ⭐

</div>
