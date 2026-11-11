using System.Text.Json.Serialization;

namespace OMP.Scanner;

public sealed record Choice(string Id, string Label, string? TemplateId = null, int Sides = 1, string Paper = "A4")
{
    public override string ToString() => Label;
}

public sealed class BatchRow
{
    public string Id { get; set; } = "";
    public string ServerUrl { get; set; } = "";
    public string GroupId { get; set; } = "";
    public string TemplateId { get; set; } = "";
    public int TemplateRevision { get; set; }
    public string Label { get; set; } = "";
    public string Room { get; set; } = "";
    public string Paper { get; set; } = "A4";
    public int Sides { get; set; }
    public string BackOrder { get; set; } = "same";
    public string Status { get; set; } = "open";
    public string Error { get; set; } = "";
    public string CreatedAt { get; set; } = "";
    public override string ToString() => $"{CreatedAt} · {Label} · {Room} · {Status}";
}

public sealed class PageRow
{
    public string CaptureId { get; set; } = "";
    public string BatchId { get; set; } = "";
    public string Side { get; set; } = "front";
    public int Sequence { get; set; }
    public string Path { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public string Status { get; set; } = "pending";
    public string Error { get; set; } = "";
    public string DisplaySide => Side == "front" ? "正面" : "背面";
    public string QualityJson { get; set; } = "{}";
    public string QualitySummary
    {
        get
        {
            if (QualityJson == "{}") return "旧记录，未执行本地检查";
            try { return System.Text.Json.JsonSerializer.Deserialize<QualityReport>(QualityJson, new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true })?.Summary ?? "检查记录缺失"; }
            catch (System.Text.Json.JsonException) { return "检查记录无法读取"; }
        }
    }
    public string DisplayStatus => Status switch { "pending" => "待上传", "uploaded" => "已上传", "blocked" => "待处理", "excluded" => "已排除", _ => Status };
}

public sealed class ApiException(int code, string message) : Exception(message)
{
    public int StatusCode { get; } = code;
}
