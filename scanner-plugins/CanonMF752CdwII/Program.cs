using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using NAPS2.Scan;
using OMP.Scanner;

internal static class Program
{
    // ScanGear may identify a scanner by the shared MF750C II series name.
    private static readonly Regex Model = new(
        @"(?<![a-z0-9])MF[\s-]*(?:752[\s-]*Cdw|750[\s-]*C)[\s_-]*(?:II|2)(?![a-z0-9])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static void Emit(object message)
    {
        Console.WriteLine(JsonSerializer.Serialize(message));
        Console.Out.Flush();
    }

    private static async Task Discover(ScannerService scanner)
    {
        var devices = new List<object>();
        int completed = 0;
        foreach (var driver in new[] { Driver.Twain, Driver.Wia })
        {
            try
            {
                foreach (var device in await scanner.Devices(driver))
                {
                    if (!Model.IsMatch(device.Name)) continue;
                    devices.Add(new { id = $"adf/{driver}/{device.ID}", name = $"{device.Name} ({driver} · 输稿器)" });
                    devices.Add(new { id = $"glass/{driver}/{device.ID}", name = $"{device.Name} ({driver} · 平板)" });
                }
                completed++;
            }
            catch (Exception ex) { Console.Error.WriteLine($"{driver}: {ex.Message}"); }
        }
        if (completed == 0) throw new IOException("TWAIN 和 WIA 均未能枚举设备，请检查佳能 ScanGear MF 扫描驱动。");
        Emit(new { type = "devices", devices });
    }

    private static async Task Capture(JsonElement request, ScannerService scanner)
    {
        if (request.GetProperty("paper").GetString() != "A4")
            throw new ArgumentException("MF752Cdw II 插件支持 A4 答题卡，无法采集 A3 整页。");
        var id = (request.GetProperty("device_id").GetString() ?? "").Split('/', 3);
        if (id.Length != 3 || id[0] is not ("adf" or "glass") || id[1] is not ("Twain" or "Wia") || id[2].Length == 0)
            throw new ArgumentException("设备标识无效，请重新发现扫描仪。");
        bool feeder = id[0] == "adf";
        bool duplex = request.GetProperty("duplex").GetBoolean();
        if (!feeder && duplex) throw new ArgumentException("平板只支持单面扫描，自动双面请选择输稿器。");
        var settings = new ScanCaptureSettings(request.GetProperty("dpi").GetInt32(),
            request.GetProperty("color").GetString() ?? "").Validate();
        var folder = request.GetProperty("directory").GetString();
        if (string.IsNullOrEmpty(folder) || !Path.IsPathFullyQualified(folder) || !Directory.Exists(folder))
            throw new DirectoryNotFoundException("主程序未提供有效的扫描临时目录。");

        var driver = id[1] == "Twain" ? Driver.Twain : Driver.Wia;
        var device = (await scanner.Devices(driver)).FirstOrDefault(d => d.ID == id[2] && Model.IsMatch(d.Name))
            ?? throw new IOException("所选佳能扫描设备不可用，请检查连接和驱动后重新发现。");
        await scanner.Acquire(device, "A4", feeder, async image =>
        {
            var file = $"{Guid.NewGuid():N}.png";
            using (var output = File.Create(Path.Combine(folder, file))) ScannerService.SaveImage(image, output);
            Emit(new { type = "page", file });
            var line = await Console.In.ReadLineAsync() ?? throw new EndOfStreamException("客户端已结束扫描。");
            using var ack = JsonDocument.Parse(line);
            if (!ack.RootElement.TryGetProperty("continue", out var next) || next.ValueKind != JsonValueKind.True)
                throw new OperationCanceledException("客户端已停止扫描。");
        }, CancellationToken.None, duplex, settings);
    }

    [STAThread]
    private static async Task<int> Main()
    {
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            using var job = JsonDocument.Parse(await Console.In.ReadLineAsync() ?? "{}");
            var request = job.RootElement;
            if (request.GetProperty("protocol").GetString() != "omp-device-1")
                throw new ArgumentException("设备协议版本不匹配。");
            using var scanner = new ScannerService();
            switch (request.GetProperty("command").GetString())
            {
                case "devices": await Discover(scanner); break;
                case "scan": await Capture(request, scanner); break;
                default: throw new ArgumentException("未知的扫描插件命令。");
            }
            Emit(new { type = "done" });
            return 0;
        }
        catch (Exception ex)
        {
            Emit(new { type = "error", message = ex.Message });
            return 1;
        }
    }
}
