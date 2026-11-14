# Windows 扫描设备插件

选择插件程序后，客户端每次发现设备或开始进纸时启动一个独立 EXE。使用 UTF-8 标准输入和标准输出，每行一个 JSON 对象。诊断信息写到标准错误。

发现请求示例

    {"protocol":"omp-device-1","command":"devices","driver":"external"}

返回设备列表，然后结束

    {"type":"devices","devices":[{"id":"usb-1","name":"测试扫描仪"}]}
    {"type":"done"}

采集请求包含 device_id、paper（A4 或 A3）、duplex、dpi、color（gray、bw 或 color）及 directory。插件将每个纸面保存为该临时目录中的独立图片，关闭文件后按设备出图顺序发送

    {"type":"page","file":"page-001.png"}

读到主程序的下一行确认后，再请求下一页

    {"continue":true}

主程序停止或识读异常时可能直接终止插件进程。插件应尽量关闭驱动预取，并处理设备取消及断开。设备固件预取行为需通过实机试扫确认。双面不得自动删除空白页。出图结束发 done，错误发 error 并提供 message。主程序负责删除临时图片、方向判断、考号识读、配页及上传。内置插件可用客户端 EXE 的 --device-plugin 参数独立测试。

## 测试示例

tools/example_scanner_plugin.py 从 OMP_TEST_IMAGES 指定目录读取按文件名排序的 PNG 图片。用 PyInstaller 的 --onefile 参数打包成 EXE 后，在设备设置里选择它，即可重复测试相同的试卷。
