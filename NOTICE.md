# Open Marking Platform

本项目采用 **GPL-3.0-only**，完整条款见 `LICENSE`。项目源代码、构建与安装方法随源码预览包提供。

第三方组件保留各自的著作权和许可。本项目许可声明不改变这些组件的许可。依赖及版本见 `requirements.txt`、`web/package-lock.json` 和 `scanner/OMP.Scanner.csproj`；扫描端发布依赖的精确版本还记录在 `OMP.Scanner.deps.json`。

- Windows扫描组件：[NAPS2 SDK](https://www.naps2.com/sdk)，Copyright NAPS2 Contributors，LGPL-2.1-or-later。上游源码：[cyanfish/naps2](https://github.com/cyanfish/naps2)，当前SDK 1.2.1对应NuGet包中登记的提交 `3cd6800f936d425d3949589b9966804a039ebd54`。预览包中的组件按上游发布形式动态引用，组件许可证随包保留。
- [.NET](https://github.com/dotnet/runtime)及[Microsoft.Data.Sqlite](https://github.com/dotnet/efcore)遵循各上游许可证；扫描端安装包随带.NET Windows Desktop Runtime，对应许可与第三方声明位于`third-party-licenses/dotnet/`。
- React、Ant Design、ZXing、SQLite及Python依赖遵循各自上游许可证和声明。
- 网页宿主使用Microsoft WebView2 SDK，许可证及NOTICE见扫描端`third-party-licenses/webview2-*`。运行时由Microsoft Edge WebView2 Runtime提供。
- 本地识读引擎随包携带Python、NumPy、OpenCV和ZXing-C++；组件版本记录在`recognition/BUILD-INFO.json`，许可材料见`recognition/licenses/`。PyInstaller构建工具及其引导程序的许可材料同目录保留。

正式对外发布前应随实际发布文件核对第三方声明及相应源代码的提供方式。
