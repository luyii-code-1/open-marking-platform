# Canon imageCLASS MF752Cdw II 扫描插件

本插件通过 Windows 上佳能驱动注册的 TWAIN 或 WIA 扫描源接入阅卷系统扫描客户端，使用 `omp-device-1` 协议。支持 A4 输稿器单面、自动双面和平板单面，沿用客户端的 300/600 DPI 和黑白、灰度、彩色设置。

## 安装和选择设备

1. 在 Windows x64 扫描机上安装包含 ScanGear MF 的[佳能扫描驱动](https://asia.canon/en/support/imageCLASS%20MF752Cdw%20II/model)。先用佳能扫描软件确认能读取原稿。网络连接时，先在佳能软件中选定对应机器。
2. 将构建或解压得到的完整目录放到固定位置。在扫描客户端的设备设置中选择「外部插件」，添加目录中的 `CanonMF752CdwII.exe`，然后发现设备。运行时需要同目录的 DLL 和 `NAPS2.Worker.exe`。
3. 按驱动原名、接口和纸源选设备。连续扫描选「输稿器」，掀盖扫一张选「平板」。若两个接口都能发现同一台设备，可任选一个试扫；若驱动不接受某种模式，可换另一个接口。

发现时匹配含 MF752Cdw II 或 MF750C II 系列标识的扫描源，保留驱动登记的原名。系列名同时用于其他机型；多机环境请核对驱动选中的实际机器。只安装了打印队列、网络扫描尚未配置或驱动未登记上述型号标识时，可能返回空列表。

## 采集行为

输稿器按驱动出图顺序逐面输出 PNG，保留空白背面，每次写完并关闭文件后通知客户端，收到继续确认再交付下一面。固件的预进纸和真实双面顺序取决于设备。首次接机可用两张纸标记「1 正、1 反、2 正、2 反」试扫。A3 以及平板自动双面请求会在进纸前报错。

## 构建

在仓库根目录使用 .NET 10 SDK 执行：

```powershell
dotnet publish scanner-plugins/CanonMF752CdwII -c Release -r win-x64 --self-contained true -o dist/canon-mf752cdw-ii
```

独立检查设备发现：

```powershell
'{"protocol":"omp-device-1","command":"devices","driver":"external"}' | .\dist\canon-mf752cdw-ii\CanonMF752CdwII.exe
```

协议及停止行为见[扫描设备插件说明](../../scanner/DEVICE-PLUGIN.md)。
