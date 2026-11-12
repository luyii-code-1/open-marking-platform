using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace OMP.Scanner;

public sealed record QualityOptions(bool CheckQr = true, bool CheckCorners = true, bool CheckSharpness = true, double MinDpi = 150, double MinSharpness = 35)
{
    public static QualityOptions Load(string root)
    {
        var path = Path.Combine(root, "quality-options.json");
        if (!File.Exists(path)) File.WriteAllText(path, JsonSerializer.Serialize(new QualityOptions(), new JsonSerializerOptions { WriteIndented = true }));
        var value = JsonSerializer.Deserialize<QualityOptions>(File.ReadAllText(path)) ?? throw new InvalidDataException("质量检查配置为空。");
        if (!double.IsFinite(value.MinDpi) || value.MinDpi < 100 || value.MinDpi > 600 || !double.IsFinite(value.MinSharpness) || value.MinSharpness < 0 || value.MinSharpness > 10000)
            throw new InvalidDataException("质量检查配置无效：DPI应为100至600，清晰度阈值应为0至10000。");
        return value;
    }
}

public sealed record QualityReport(string[] Issues, double Dpi, double Sharpness, int Corners, QualityOptions Options)
{
    public bool Passed => Issues.Length == 0;
    public string Summary => Passed ? "本地检查通过" : string.Join("；", Issues.Select(x => x switch
    {
        "low_resolution" => "页面分辨率不足", "missing_binding" => "缺少考卷版本绑定", "missing_qr" => "二维码未读出",
        "wrong_paper" => "二维码与所选考卷或面不符", "multiple_qr" => "混有多个题卡二维码", "missing_markers" => "四角定位标记不完整",
        "blur" => "页面可能模糊", "too_large" => "上传文件超过30MB", "inspection_failed" => "本地检查未完成，请检查配置或扫描图像", _ => "质量检查异常"
    }));
}

public static class QualityInspector
{
    private static Bitmap Preview(Image source)
    {
        var scale = Math.Min(1, 1800.0 / Math.Max(source.Width, source.Height));
        var bitmap = new Bitmap(Math.Max(1, (int)(source.Width * scale)), Math.Max(1, (int)(source.Height * scale)), PixelFormat.Format24bppRgb);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.Clear(Color.White); graphics.DrawImage(source, new Rectangle(0, 0, bitmap.Width, bitmap.Height));
        return bitmap;
    }

    private static string[] Codes(Bitmap bitmap)
    {
        var reader = new ZXing.Windows.Compatibility.BarcodeReader { AutoRotate = true, Options = new ZXing.Common.DecodingOptions { TryHarder = true, PossibleFormats = [ZXing.BarcodeFormat.QR_CODE] } };
        return (reader.DecodeMultiple(bitmap) ?? []).Select(x => x.Text).Where(x => x.StartsWith("OMP1:", StringComparison.Ordinal)).Distinct().ToArray();
    }

    public static string? ReadSide(Image source, BatchRow batch)
    {
        using var bitmap = Preview(source);
        var codes = Codes(bitmap);
        if (codes.Length != 1) return null;
        return new[] { "front", "back" }.FirstOrDefault(side => codes[0] == $"OMP1:{batch.TemplateId}:{batch.TemplateRevision}:{side}");
    }

    public static QualityReport Inspect(Image source, BatchRow batch, string side, QualityOptions options)
    {
        var issues = new List<string>();
        double paperWidth = batch.Paper == "A3" ? 420 : 210, paperHeight = 297;
        if ((source.Width > source.Height) != (paperWidth > paperHeight)) (paperWidth, paperHeight) = (paperHeight, paperWidth);
        var dpi = Math.Min(source.Width / paperWidth, source.Height / paperHeight) * 25.4;
        if (dpi + 1 < options.MinDpi) issues.Add("low_resolution");
        using var bitmap = Preview(source);
        if (options.CheckQr)
        {
            if (string.IsNullOrEmpty(batch.TemplateId) || batch.TemplateRevision < 1) issues.Add("missing_binding");
            var codes = Codes(bitmap);
            if (codes.Length == 0) issues.Add("missing_qr");
            else if (codes.Length > 1) issues.Add("multiple_qr");
            else if (codes[0] != $"OMP1:{batch.TemplateId}:{batch.TemplateRevision}:{side}") issues.Add("wrong_paper");
        }
        var gray = Grayscale(bitmap);
        var corners = CountCorners(gray, bitmap.Width, bitmap.Height, paperWidth, paperHeight);
        if (options.CheckCorners && corners != 4) issues.Add("missing_markers");
        var sharpness = Sharpness(gray, bitmap.Width, bitmap.Height);
        if (options.CheckSharpness && sharpness < options.MinSharpness) issues.Add("blur");
        return new QualityReport(issues.ToArray(), Math.Round(dpi, 2), Math.Round(sharpness, 2), corners, options);
    }

    private static byte[] Grayscale(Bitmap bitmap)
    {
        var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            var row = new byte[bitmap.Width * 3]; var result = new byte[bitmap.Width * bitmap.Height];
            for (int y = 0; y < bitmap.Height; y++)
            {
                Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, row.Length);
                for (int x = 0; x < bitmap.Width; x++) result[y * bitmap.Width + x] = (byte)((row[3 * x] + 2 * row[3 * x + 1] + row[3 * x + 2]) / 4);
            }
            return result;
        }
        finally { bitmap.UnlockBits(data); }
    }

    private static int CountCorners(byte[] gray, int width, int height, double paperWidth, double paperHeight)
    {
        int count = 0, rw = Math.Max(1, width / 10), rh = Math.Max(1, height / 10);
        var sx = width / paperWidth; var sy = height / paperHeight;
        foreach (var (ox, oy) in new[] { (0, 0), (width - rw, 0), (0, height - rh), (width - rw, height - rh) })
        {
            var seen = new bool[rw * rh]; var found = false;
            for (int y = 0; y < rh && !found; y++) for (int x = 0; x < rw && !found; x++)
            {
                if (seen[y * rw + x] || gray[(oy + y) * width + ox + x] > 90) continue;
                var pending = new Queue<(int, int)>(); pending.Enqueue((x, y)); seen[y * rw + x] = true;
                int minX = x, maxX = x, minY = y, maxY = y, pixels = 0;
                while (pending.TryDequeue(out var point))
                {
                    var (px, py) = point; pixels++; minX = Math.Min(minX, px); maxX = Math.Max(maxX, px); minY = Math.Min(minY, py); maxY = Math.Max(maxY, py);
                    foreach (var (nx, ny) in new[] { (px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1) })
                        if (nx >= 0 && nx < rw && ny >= 0 && ny < rh && !seen[ny * rw + nx] && gray[(oy + ny) * width + ox + nx] <= 90)
                        { seen[ny * rw + nx] = true; pending.Enqueue((nx, ny)); }
                }
                double bw = (maxX - minX + 1) / sx, bh = (maxY - minY + 1) / sy;
                double cx = (ox + (minX + maxX) / 2.0) / sx, cy = (oy + (minY + maxY) / 2.0) / sy;
                double ex = ox == 0 ? 7 : paperWidth - 7, ey = oy == 0 ? 7 : paperHeight - 7;
                found = bw >= 2.5 && bw <= 6.5 && bh >= 2.5 && bh <= 6.5 && bw / bh >= .6 && bw / bh <= 1.6 && pixels >= .7 * (maxX - minX + 1) * (maxY - minY + 1) && Math.Abs(cx - ex) <= 8 && Math.Abs(cy - ey) <= 8;
            }
            if (found) count++;
        }
        return count;
    }

    private static double Sharpness(byte[] gray, int width, int height)
    {
        double best = 0;
        for (int ty = 0; ty < 3; ty++) for (int tx = 0; tx < 3; tx++)
        {
            double sum = 0, squares = 0; int count = 0;
            for (int y = Math.Max(1, ty * height / 3); y < Math.Min(height - 1, (ty + 1) * height / 3); y++)
                for (int x = Math.Max(1, tx * width / 3); x < Math.Min(width - 1, (tx + 1) * width / 3); x++)
                {
                    int i = y * width + x, laplacian = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
                    sum += laplacian; squares += laplacian * laplacian; count++;
                }
            if (count > 0) best = Math.Max(best, squares / count - Math.Pow(sum / count, 2));
        }
        return best;
    }
}
