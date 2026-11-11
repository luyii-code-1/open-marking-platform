using System.IO;

namespace OMP.Scanner;

internal static class ScannerSelfTest
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    public static async Task Run(string[] args)
    {
        if (args.Length != 7) throw new ArgumentException("自检参数：--self-test 服务器地址 临时目录 测试图像 题卡组 账号 密码");
        var server = args[1]; var root = Path.GetFullPath(args[2]); var imagePath = args[3]; var groupId = args[4];
        Directory.CreateDirectory(root);
        var deviceRoot = Path.Combine(root, "devices");
        using var api = new ApiClient(server, deviceRoot, selfTest: true);
        try
        {
            await api.Login(args[5], args[6]);
            api.CheckTestKey();
            var templates = await api.Get("templates");
            var template = templates.EnumerateArray().Single(t => t.GetProperty("group_id").GetString() == groupId);
            Check(!template.TryGetProperty("questions", out _), "设备接口不应包含标准答案。");
            var remote = await api.Post("scan-batches", new { group_id = groupId, room = "自检", back_order = "same" });
            var batch = new BatchRow { Id = remote.GetProperty("id").GetString()!, ServerUrl = api.ServerUrl, GroupId = groupId, Label = "自检批次", Paper = "A4", Sides = 1 };
            batch.TemplateId = remote.GetProperty("template_id").GetString()!; batch.TemplateRevision = remote.GetProperty("template_revision").GetInt32();
            var queue = new LocalQueue(Path.Combine(root, "queue")); queue.AddBatch(batch);
            using var image = System.Drawing.Image.FromFile(imagePath);
            var options = new QualityOptions();
            var normal = QualityInspector.Inspect(image, batch, "front", options);
            Check(normal.Passed, "打印样本本地检查未通过：" + System.Text.Json.JsonSerializer.Serialize(normal));
            using (var rotated = new System.Drawing.Bitmap(image))
                for (int i = 0; i < 4; i++)
                {
                    Check(QualityInspector.Inspect(rotated, batch, "front", options).Passed, $"旋转{i * 90}度检查失败。");
                    rotated.RotateFlip(System.Drawing.RotateFlipType.Rotate90FlipNone);
                }
            Check(QualityInspector.Inspect(image, batch, "back", options).Issues.Contains("wrong_paper"), "正反面混卷未拦截。");
            using (var blurred = System.Drawing.Image.FromFile(Path.Combine(Path.GetDirectoryName(imagePath)!, "blurred.png")))
                Check(QualityInspector.Inspect(blurred, batch, "front", options).Issues.Contains("blur"), "模糊页未拦截。");
            using (var damaged = System.Drawing.Image.FromFile(Path.Combine(Path.GetDirectoryName(imagePath)!, "missing-corner.png")))
                Check(QualityInspector.Inspect(damaged, batch, "front", options).Issues.Contains("missing_markers"), "缺角页未拦截。");
            var page = queue.AddPage(batch, "front", image);
            Check(page.Status == "pending", "合格页面未进入待上传队列。");
            Check(File.Exists(Path.ChangeExtension(page.Path, ".png")), "扫描原图未落盘。");
            var reopened = new LocalQueue(queue.Root);
            Check(reopened.Pages(batch.Id).Single().Sha256 == page.Sha256 && reopened.Batches().Single().Id == batch.Id, "队列重启恢复失败。");
            var valid = await File.ReadAllBytesAsync(page.Path);
            try
            {
                await File.WriteAllBytesAsync(page.Path, [0, 1, 2]);
                var rejected = false;
                try { await api.Upload(page); } catch (InvalidDataException) { rejected = true; }
                Check(rejected, "损坏队列文件未被校验拦截。");
                Check((await api.Get($"scan-batches/{batch.Id}/pages")).GetArrayLength() == 0, "损坏文件被发送至服务器。");
            }
            finally { await File.WriteAllBytesAsync(page.Path, valid); }
            var accepted = await api.Upload(page);
            Check(accepted.GetProperty("id").GetString() == page.CaptureId && accepted.GetProperty("candidate_number").GetString() == "123", "JPEG上传识读不符。");
            queue.PageUploaded(page.CaptureId, page.CaptureId);
            api.Dispose();
            using (var connected = new ApiClient(server, deviceRoot, selfTest: true))
            {
                await connected.ConnectDevice();
                Check((await connected.Get($"scan-batches/{batch.Id}")).GetProperty("id").GetString() == batch.Id, "密钥持久化或批次归属验证失败。");
                var scoped = false;
                try { await connected.Get("students"); } catch (ApiException error) when (error.StatusCode == 401) { scoped = true; }
                Check(scoped, "设备令牌获得了人员读取权限。");
                await connected.Post($"scan-batches/{batch.Id}/pair");
            }
            var excludedBatch = new BatchRow { Id = Guid.NewGuid().ToString(), ServerUrl = api.ServerUrl, GroupId = groupId, Label = "本地队列状态自检", Paper = "A4", Sides = 2 };
            excludedBatch.TemplateId = batch.TemplateId; excludedBatch.TemplateRevision = batch.TemplateRevision;
            queue.AddBatch(excludedBatch);
            var front = queue.AddPage(excludedBatch, "front", image); var back = queue.AddPage(excludedBatch, "back", image);
            var recovered = new LocalQueue(queue.Root);
            Check(back.Status == "blocked" && recovered.Batches().Single(b => b.Id == excludedBatch.Id).Status == "frozen", "异常页未持久冻结批次。");
            Check(File.Exists(Path.ChangeExtension(back.Path, ".png")) && recovered.Pages(excludedBatch.Id).Single(p => p.CaptureId == back.CaptureId).QualityJson.Contains("wrong_paper"), "异常页原图或检查证据丢失。");
            Check(front.Sequence == 1 && back.Sequence == 1, "正反面序号不独立。");
            queue.PageExcluded(front.CaptureId); queue.RetryBlocked(excludedBatch.Id);
            Check(new LocalQueue(queue.Root).Pages(excludedBatch.Id).Single(p => p.CaptureId == front.CaptureId).Status == "excluded", "已排除页被重试重新加入。");
            Console.WriteLine("SELFTEST PASS: CNG key protection, signed device auth, durable queue, 4 rotations, QR mismatch, blur, corner damage, persistent quality freeze, SHA-256 mismatch rejection, JPEG upload, reconnect, scoped access, pairing");
        }
        finally { api.DeleteTestKey(); }
    }
}
