# Docker镜像联调

2026-11-12在Ubuntu WSL2的独立Docker 29.9.3进程中，按仓库原Dockerfile完成多阶段镜像构建。前端使用Node 22阶段构建，服务端镜像实际Python版本为3.13.18。镜像ID记录在 [Docker队列联调结果](Docker队列联调结果.json)。

构建后的镜像挂入只读测试目录与工具目录，全量72项测试通过（42.59秒）；镜像中的程序与依赖未用宿主机源码目录替换。另有一条Starlette/httpx弃用提示。

## 四容器业务流程

以构建镜像分别运行API、双进程prefork Worker及Beat调度器，以官方 `redis:7-alpine` 运行Redis 7.4.12。先在Redis离线时上传模拟扫描JPEG，确认任务保存；再启动Redis及后台进程，由调度器找回任务。识别考号123、配页结分3分、管理员发布及后台归档校验均通过，识别任务执行一次，流程耗时27.55秒。

检查脚本为Redis使用官方镜像自己的 `/data` 卷，符合镜像入口切换到redis用户后的目录权限要求。API、Worker及调度器使用本次专属临时数据目录。测试结束确认该隔离Docker实例无剩余容器，随后停止Docker进程；没有注册系统服务或连接生产数据。

## 重现

在Linux具备Docker、客户端Python依赖及Poppler后，从仓库根目录执行：

```sh
docker build -t omp-integration:local .
python -m tools.linux_queue_smoke --image omp-integration:local --report dist/docker-queue-report.json
```

脚本会创建并清理以 `omp-check-` 开头的本次容器。当前容器联调使用host网络及随机本机端口，API仅监听127.0.0.1；它用于检查镜像运行和跨容器共享文件/Redis任务流程。当前测试环境关闭了Docker桥接与转发，不改动WSL的转发配置。

本次不证明Compose默认桥接网络、Redis服务名解析、Caddy HTTPS/WSS、浏览器通行密钥/PWA或正式4核8GB服务器负载通过。这些仍需正式部署环境验收。

测试环境使用Docker官方[静态二进制测试安装方式](https://docs.docker.com/engine/install/binaries/)，文件留在专用缓存目录。正式服务器按Docker发行版安装文档部署受维护的Engine与Compose插件。
