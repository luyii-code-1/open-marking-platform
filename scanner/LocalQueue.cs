using Microsoft.Data.Sqlite;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;

namespace OMP.Scanner;

public sealed class LocalQueue
{
    public string Root { get; }
    private readonly string _connectionString;

    public LocalQueue(string? root = null)
    {
        Root = root ?? System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenMarkingPlatform", "Scanner");
        Directory.CreateDirectory(Root);
        _connectionString = new SqliteConnectionStringBuilder { DataSource = System.IO.Path.Combine(Root, "queue.sqlite3"), Mode = SqliteOpenMode.ReadWriteCreate }.ToString();
        using var db = Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS batches(
              id TEXT PRIMARY KEY,server_url TEXT NOT NULL,group_id TEXT NOT NULL,label TEXT NOT NULL,
              room TEXT NOT NULL,paper TEXT NOT NULL,sides INTEGER NOT NULL,back_order TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'open',error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pages(
              capture_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id),side TEXT NOT NULL,
              sequence INTEGER NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
              error TEXT NOT NULL DEFAULT '',server_id TEXT, UNIQUE(batch_id,side,sequence));
            """;
        cmd.ExecuteNonQuery();
        EnsureColumn(db, "batches", "template_id", "TEXT NOT NULL DEFAULT ''");
        EnsureColumn(db, "batches", "template_revision", "INTEGER NOT NULL DEFAULT 0");
        EnsureColumn(db, "pages", "quality_report", "TEXT NOT NULL DEFAULT '{}'");
    }

    private static void EnsureColumn(SqliteConnection db, string table, string name, string definition)
    {
        using var cmd = db.CreateCommand(); cmd.CommandText = $"PRAGMA table_info({table})";
        using (var reader = cmd.ExecuteReader()) { while (reader.Read()) if (reader.GetString(1) == name) return; }
        cmd.CommandText = $"ALTER TABLE {table} ADD COLUMN {name} {definition}"; cmd.ExecuteNonQuery();
    }

    private SqliteConnection Open()
    {
        var db = new SqliteConnection(_connectionString);
        db.Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;";
        cmd.ExecuteNonQuery();
        return db;
    }

    private void Execute(string sql, params (string, object?)[] parameters)
    {
        using var db = Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (key, value) in parameters) cmd.Parameters.AddWithValue(key, value ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    public void AddBatch(BatchRow batch) => Execute("""
        INSERT INTO batches(id,server_url,group_id,label,room,paper,sides,back_order,status,created_at,template_id,template_revision)
        VALUES($id,$server,$group,$label,$room,$paper,$sides,$ordering,'open',$at,$template,$revision)
        """, ("$id", batch.Id), ("$server", batch.ServerUrl), ("$group", batch.GroupId), ("$label", batch.Label),
        ("$room", batch.Room), ("$paper", batch.Paper), ("$sides", batch.Sides), ("$ordering", batch.BackOrder), ("$at", DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss")), ("$template", batch.TemplateId), ("$revision", batch.TemplateRevision));

    public void BindTemplate(BatchRow batch) => Execute("UPDATE batches SET template_id=$template,template_revision=$revision WHERE id=$id", ("$template", batch.TemplateId), ("$revision", batch.TemplateRevision), ("$id", batch.Id));

    public List<BatchRow> Batches()
    {
        using var db = Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT id,server_url,group_id,label,room,paper,sides,back_order,status,error,created_at,template_id,template_revision FROM batches ORDER BY created_at DESC";
        using var row = cmd.ExecuteReader();
        var list = new List<BatchRow>();
        while (row.Read()) list.Add(new BatchRow { Id = row.GetString(0), ServerUrl = row.GetString(1), GroupId = row.GetString(2), Label = row.GetString(3), Room = row.GetString(4), Paper = row.GetString(5), Sides = row.GetInt32(6), BackOrder = row.GetString(7), Status = row.GetString(8), Error = row.GetString(9), CreatedAt = row.GetString(10), TemplateId = row.GetString(11), TemplateRevision = row.GetInt32(12) });
        return list;
    }

    public List<PageRow> Pages(string batchId)
    {
        using var db = Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT capture_id,batch_id,side,sequence,path,sha256,status,error,quality_report FROM pages WHERE batch_id=$batch ORDER BY CASE side WHEN 'front' THEN 0 ELSE 1 END,sequence";
        cmd.Parameters.AddWithValue("$batch", batchId);
        using var row = cmd.ExecuteReader();
        var list = new List<PageRow>();
        while (row.Read()) list.Add(new PageRow { CaptureId = row.GetString(0), BatchId = row.GetString(1), Side = row.GetString(2), Sequence = row.GetInt32(3), Path = row.GetString(4), Sha256 = row.GetString(5), Status = row.GetString(6), Error = row.GetString(7), QualityJson = row.GetString(8) });
        return list;
    }

    public PageRow AddPage(BatchRow batch, string side, System.Drawing.Image image)
    {
        if (batch.Status != "open") throw new InvalidOperationException("当前批次已关闭或冻结，请新建批次。");
        if (side == "back" && batch.Sides != 2) throw new InvalidOperationException("单面题卡不需要扫描背面。");
        if (side is not ("front" or "back")) throw new ArgumentException("扫描面无效。");
        var captureId = Guid.NewGuid().ToString();
        var folder = System.IO.Path.Combine(Root, "pages", batch.Id);
        Directory.CreateDirectory(folder);
        var original = System.IO.Path.Combine(folder, captureId + ".png");
        var upload = System.IO.Path.Combine(folder, captureId + ".jpg");
        SaveDurably(original, stream => image.Save(stream, ImageFormat.Png));
        var codec = ImageCodecInfo.GetImageEncoders().Single(x => x.FormatID == ImageFormat.Jpeg.Guid);
        using var settings = new EncoderParameters(1);
        settings.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 95L);
        SaveDurably(upload, stream => image.Save(stream, codec, settings));
        using var file = File.OpenRead(upload);
        var sha = Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant();
        QualityReport report;
        try { report = QualityInspector.Inspect(image, batch, side, QualityOptions.Load(Root)); }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        { report = new QualityReport(["inspection_failed"], 0, 0, 0, new QualityOptions()); }
        if (file.Length > 30 * 1024 * 1024) report = report with { Issues = [.. report.Issues, "too_large"] };
        var quality = System.Text.Json.JsonSerializer.Serialize(report, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
        using var db = Open();
        using var transaction = db.BeginTransaction();
        using var cmd = db.CreateCommand();
        cmd.Transaction = transaction;
        cmd.CommandText = "SELECT COALESCE(MAX(sequence),0)+1 FROM pages WHERE batch_id=$batch AND side=$side";
        cmd.Parameters.AddWithValue("$batch", batch.Id);
        cmd.Parameters.AddWithValue("$side", side);
        var sequence = Convert.ToInt32(cmd.ExecuteScalar());
        cmd.CommandText = "INSERT INTO pages(capture_id,batch_id,side,sequence,path,sha256,status,error,quality_report) VALUES($id,$batch,$side,$sequence,$path,$sha,$status,$error,$quality)";
        cmd.Parameters.AddWithValue("$id", captureId);
        cmd.Parameters.AddWithValue("$sequence", sequence);
        cmd.Parameters.AddWithValue("$path", upload);
        cmd.Parameters.AddWithValue("$sha", sha);
        cmd.Parameters.AddWithValue("$status", report.Passed ? "pending" : "blocked");
        cmd.Parameters.AddWithValue("$error", report.Passed ? "" : report.Summary);
        cmd.Parameters.AddWithValue("$quality", quality);
        cmd.ExecuteNonQuery();
        if (!report.Passed)
        {
            cmd.CommandText = "UPDATE batches SET status='frozen',error=$error WHERE id=$batch"; cmd.ExecuteNonQuery();
        }
        transaction.Commit();
        if (!report.Passed) { batch.Status = "frozen"; batch.Error = report.Summary; }
        return new PageRow { CaptureId = captureId, BatchId = batch.Id, Side = side, Sequence = sequence, Path = upload, Sha256 = sha, QualityJson = quality, Status = report.Passed ? "pending" : "blocked", Error = report.Passed ? "" : report.Summary };
    }

    private static void SaveDurably(string path, Action<FileStream> write)
    {
        var temporary = path + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { write(stream); stream.Flush(true); }
        File.Move(temporary, path);
    }

    public void PageUploaded(string id, string serverId) => Execute("UPDATE pages SET status='uploaded',error='',server_id=$server WHERE capture_id=$id", ("$id", id), ("$server", serverId));
    public void PageExcluded(string id) => Execute("UPDATE pages SET status='excluded',error='管理员已排除该页，原始文件保留' WHERE capture_id=$id", ("$id", id));
    public void PageError(string id, string error, bool blocked = false) => Execute("UPDATE pages SET error=$error,status=$status WHERE capture_id=$id", ("$id", id), ("$error", error), ("$status", blocked ? "blocked" : "pending"));
    public void RetryBlocked(string batchId) => Execute("UPDATE pages SET status='pending',error='' WHERE batch_id=$batch AND status='blocked'", ("$batch", batchId));
    public void BatchStatus(string id, string status, string error = "") => Execute("UPDATE batches SET status=$status,error=$error WHERE id=$id", ("$id", id), ("$status", status), ("$error", error));
}
