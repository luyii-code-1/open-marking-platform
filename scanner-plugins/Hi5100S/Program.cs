using System.Drawing.Imaging;
using System.Text;
using System.Text.Json;
using NAPS2.Scan;
using OMP.Scanner;

internal static class Program
{
    private static void Emit(object message) => Console.WriteLine(JsonSerializer.Serialize(message));
    private static string Id(ScanDevice device) => $"{device.Driver}:{device.ID}";

    private static async Task<List<ScanDevice>> Discover(ScannerService scanner)
    {
        var devices = new List<ScanDevice>();
        var errors = new List<string>();
        foreach (var driver in new[] { Driver.Twain, Driver.Wia })
        {
            try { devices.AddRange(await scanner.Devices(driver)); }
            catch (Exception ex) { errors.Add($"{driver}: {ex.Message}"); }
        }
        if (devices.Count == 0 && errors.Count > 0)
            throw new IOException(string.Join(Environment.NewLine, errors));
        return devices;
    }

    private static async Task Protocol(ScannerService scanner)
    {
        using var job = JsonDocument.Parse(await Console.In.ReadLineAsync() ?? "");
        var request = job.RootElement;
        if (request.GetProperty("protocol").GetString() != "omp-device-1")
            throw new InvalidDataException("设备协议版本不匹配。");
        var command = request.GetProperty("command").GetString();
        if (command == "devices")
        {
            var devices = await Discover(scanner);
            Emit(new { type = "devices", devices = devices.SelectMany(d => new[] {
                new { id = Id(d), name = $"{d.Name} ({d.Driver} · 输稿器)" },
                new { id = "flatbed/" + Id(d), name = $"{d.Name} ({d.Driver} · 平板)" }
            }) });
        }
        else if (command == "scan")
        {
            var id = request.GetProperty("device_id").GetString() ?? "";
            bool feeder = !id.StartsWith("flatbed/", StringComparison.Ordinal);
            if (!feeder) id = id["flatbed/".Length..];
            bool duplex = request.GetProperty("duplex").GetBoolean();
            if (!feeder && duplex) throw new InvalidOperationException("平板请使用单面或手动翻面，自动双面请选择输稿器。");
            var driver = id.StartsWith("Twain:", StringComparison.Ordinal) ? Driver.Twain : Driver.Wia;
            var device = (await scanner.Devices(driver)).FirstOrDefault(d => Id(d) == id)
                ?? throw new IOException("未找到上次选择的设备，请检查 USB 连接并重新发现扫描仪。");
            var folder = request.GetProperty("directory").GetString()!;
            var settings = new ScanCaptureSettings(request.GetProperty("dpi").GetInt32(), request.GetProperty("color").GetString()!);
            await scanner.Acquire(device, request.GetProperty("paper").GetString()!, feeder, async image =>
            {
                var file = $"{Guid.NewGuid():N}.png";
                image.Save(Path.Combine(folder, file), ImageFormat.Png);
                Emit(new { type = "page", file });
                using var ack = JsonDocument.Parse(await Console.In.ReadLineAsync() ?? "{}");
                if (!ack.RootElement.TryGetProperty("continue", out var next) || next.ValueKind != JsonValueKind.True)
                    throw new OperationCanceledException();
            }, CancellationToken.None, duplex, settings);
        }
        else throw new InvalidDataException("未知设备命令。");
        Emit(new { type = "done" });
    }

    private static async Task Test(ScannerService scanner, string directory)
    {
        var devices = await Discover(scanner);
        if (devices.Count == 0) throw new IOException("未发现扫描仪，请检查 USB 和厂商驱动。");
        for (int i = 0; i < devices.Count; i++)
            Console.WriteLine($"{i + 1}. {devices[i].Name} ({devices[i].Driver})");
        Console.Write("请输入要测试的扫描仪序号：");
        if (!int.TryParse(Console.ReadLine(), out int index) || index < 1 || index > devices.Count)
            throw new ArgumentException("设备序号无效。");
        var selected = devices[index - 1];
        Console.Write("选择纸源：0 平板，1 输稿器单面，回车输稿器双面：");
        var source = Console.ReadLine()?.Trim();
        if (source is not ("0" or "1" or "")) throw new ArgumentException("纸源选项无效。");
        bool feeder = source != "0";
        bool duplex = source == "";
        Console.Write("纸型默认 A4，使用 A3 请输入 A3：");
        var paper = Console.ReadLine()?.Trim().ToUpperInvariant() == "A3" ? "A3" : "A4";
        void Log(string line)
        {
            Console.WriteLine(line);
            File.AppendAllText(Path.Combine(directory, "scan.log"), line + Environment.NewLine);
        }
        Log($"{selected.Name} / {selected.Driver} / {paper} / {(feeder ? "输稿器" : "平板")} / {(duplex ? "双面" : "单面")} / 300 DPI 灰度");
        int pages = 0;
        await scanner.Acquire(selected, paper, feeder, image =>
        {
            var name = $"page-{++pages:D4}.png";
            image.Save(Path.Combine(directory, name), ImageFormat.Png);
            Log($"{DateTime.Now:HH:mm:ss}  {name}  {image.Width} × {image.Height}");
            return Task.CompletedTask;
        }, CancellationToken.None, duplex);
        Log($"共返回 {pages} 面。");
    }

    [STAThread]
    private static async Task<int> Main()
    {
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        var interactive = !Console.IsInputRedirected;
        string? directory = null;
        try
        {
            if (interactive)
            {
                directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Hi5100S", DateTime.Now.ToString("yyyyMMdd-HHmmss-fff"));
                Directory.CreateDirectory(directory);
                Console.WriteLine($"测试结果：{directory}");
            }
            using var scanner = new ScannerService();
            if (interactive) await Test(scanner, directory!);
            else await Protocol(scanner);
            return 0;
        }
        catch (Exception ex)
        {
            if (!interactive) Emit(new { type = "error", message = ex.Message });
            else
            {
                Console.WriteLine(ex.Message);
                if (directory != null && Directory.Exists(directory)) File.AppendAllText(Path.Combine(directory, "scan.log"), ex.ToString());
            }
            return 1;
        }
        finally { if (interactive) { Console.Write("回车退出。"); Console.ReadLine(); } }
    }
}
