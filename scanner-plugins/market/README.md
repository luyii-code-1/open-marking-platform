# 扫描插件市场

扫描客户端的「扫描设置 → 扫描插件市场」显示官方目录。「刷新官方清单」先访问 GitHub Raw，再尝试 jsDelivr。两个来源都不可用时，可以继续使用上次保存的目录和本机插件。选择「安装」将指定版本下载到当前 Windows 用户的扫描数据目录，选择「启用」后再查找设备。升级插件时可以保留旧版，直到手动切换。新安装的客户端包含 Hi-5100S 和 Canon imageCLASS MF752Cdw II，扫描机需要已安装对应厂商驱动。

## 发布官方插件

1. 插件项目放在 `scanner-plugins` 下，使用 .NET 10 Windows 和宿主提供的 NAPS2 SDK 1.2.1。市场包是单个带入口的托管程序集，在独立子进程中通过 `omp-device-1` 协议与客户端交换消息。需要额外运行时文件的插件可继续使用外部 EXE 入口。
2. 在 `plugins.json` 中登记稳定 ID、名称、项目目录、描述和版本。变更插件内容时提高该插件的版本。
3. 使用持有发布密钥的 Windows 账户，在仓库根目录运行 `pwsh -File tools/publish_scanner_catalog.ps1 -Revision 2`，将目录修订号替换为高于当前值的整数。可用 `-Dotnet` 指定 .NET 10 SDK 的路径。
4. 将插件源码、元数据、签名后的 `catalog.json` 和新增的 `packages/<sha256>.b64` 一起提交到官方仓库的 main 分支。历史包按散列保留。旧客户端刷新即可获取新版本。新构建的客户端随包携带构建时的官方目录。

目录用 ECDSA P-256 签名。客户端内嵌验证公钥，按目录中的 SHA-256 校验解码后的程序集，运行时再次校验。私钥由 Windows DPAPI 保护，位于发布账户的 `%LOCALAPPDATA%/OpenMarkingPlatform/Publisher`。维护者应保留可恢复的发布账户和密钥备份。公钥轮换需要同步发布新版客户端。
