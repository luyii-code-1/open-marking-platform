# Compose与HTTPS联调

2026-11-12使用仓库原 `compose.yaml` 和 `deploy/Caddyfile`，以独立项目名、临时数据目录和本机随机HTTPS端口完成五服务联调。Compose版本5.7.1，服务端为此前构建并通过72项测试的Python 3.13镜像。

测试覆盖Compose默认bridge网络、Redis服务名解析、API/Worker/调度器共享数据目录，以及Caddy反向代理。除测试镜像、独立env文件、数据目录及代理端口外，业务服务配置沿用原Compose；API端口未向宿主机发布。

## 实际结果

- HTTPS证书及localhost主机名验证通过。客户端仅信任本次Caddy生成的测试CA，未关闭TLS验证，也未安装系统根证书。
- 经HTTPS读取健康接口和前端静态页面，打印PDF、上传模拟JPEG并后台识别考号123，配页结分3分，发布及后台归档校验通过。
- 经Caddy建立WSS，首帧令牌鉴权通过；跨来源握手返回403；已提交的项目变化触发通知；退出登录后连接以4401关闭。
- Docker检查确认网络驱动为bridge，API没有发布宿主端口。服务间使用原配置的 `redis:6379`，没有替换为宿主机回环地址。

流程50.67秒。机器可读结果见 [Compose联调结果](Compose联调结果.json)。结束后移除本次容器、测试卷及网络，并停止隔离Docker进程；确认只剩host/none内置网络，无剩余容器或卷。

## 重现

在有Docker Compose、项目Python依赖及Poppler的Linux环境中，从仓库根目录执行：

```sh
docker build -t omp-integration:local .
python -m tools.compose_smoke --image omp-integration:local --report dist/compose-report.json
```

脚本使用临时override文件及支持 `!override` 的Compose，把测试代理端口限制在127.0.0.1，并为本次来源配置WS/通行密钥来源；不改写仓库 `.env`、原Compose或Caddyfile。`finally` 按唯一项目名执行down并移除测试卷，避免影响其他项目。

第一次检查暴露WSL缺少iptables可执行文件，Docker容器内置DNS无法配置，导致Caddy返回502。将工具和依赖解包至本次专用目录后重跑通过；未修改应用以绕过服务名解析。此环境问题不等同于项目业务代码缺陷。

生产公网域名、ACME证书签发、4核8GB主机真实负载、真实外存、扫描仪及浏览器界面体验仍需正式验收。本次使用命令行HTTP/WebSocket客户端，没有操作浏览器或电脑界面。
