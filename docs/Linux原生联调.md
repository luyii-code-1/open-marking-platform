# Linux原生联调

2026-11-12在Ubuntu WSL2实际启动API、Redis 7.0.15、Celery双进程prefork Worker及Beat调度器，使用独立临时数据目录和随机本机端口。Python为3.12.3，Poppler为24.02.0；本次验证不等同于Docker中Python 3.13或正式4核8GB服务器验收。

## 实际流程与结果

先通过HTTP创建管理员、考试与题卡，下载打印PDF，经Linux Poppler渲染并填入模拟考号123及正确选项。在Redis尚未启动时上传JPEG，API投递失败后仍把识别任务保存为pending。随后启动Redis、Worker及Beat，由定时恢复找回任务。

Worker首次执行成功，识别考号123；配页后的成绩为3分。管理员发布后提交后台归档任务，Worker完成归档并校验成功。整个业务流程21.77秒，所有子进程在检查结束时退出，测试数据随临时目录清理。报告见 [Linux原生联调结果](Linux原生联调结果.json)。

本次首次联调暴露了真实Worker中的循环导入：业务模块从API入口导入鉴权与记录查询依赖，独立Worker导入异常模块时反向进入API入口，导致ImportError和反复重试。已将共用依赖移到 `server/dependencies.py`，API与后台业务分别引用该模块；鉴权逻辑及权限规则保留。

修复后Windows全量72项回归通过（33.94秒），Linux全量72项通过（42.69秒）。两端均有同一条Starlette/httpx弃用提示。检查没有启动浏览器或操作实际扫描仪。

## 重现

在Linux安装本项目Python依赖，确认 `redis-server` 与 `pdftoppm` 在PATH上，然后从仓库根目录执行：

```sh
python -m tools.linux_queue_smoke --report dist/linux-native-report.json
python -m pytest -q
```

脚本会自行启动仅监听127.0.0.1、使用随机端口的Redis和临时API/Worker/调度器，覆盖自己的数据目录、存储模式及Redis地址，不连接已部署的阅卷系统或外部存储。失败时输出本次进程日志，结束时回收自己启动的进程。

仍需验证：Docker镜像构建及Python 3.13运行、Caddy HTTPS/WSS与真实浏览器、正式服务器完整负载、外部存储、真实扫描仪及生产恢复演练。
