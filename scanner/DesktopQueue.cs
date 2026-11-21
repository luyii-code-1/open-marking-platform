using Microsoft.Data.Sqlite;
using System.IO;
using System.Text.Json;

namespace OMP.Scanner;

public sealed partial class LocalQueue
{
    internal sealed record JpegSample(string CaptureId, string NormalizedSha256, string Paper);

    internal JpegSample? LatestJpegSample(string server, string project, string group, string template, string preferredBatch)
    {
        if (string.IsNullOrEmpty(project) || (string.IsNullOrEmpty(group) && string.IsNullOrEmpty(template))) return null;
        using var db = Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT p.capture_id, json_extract(p.recognition_json,'$.normalized_sha256'), b.paper
              FROM batches b JOIN pages p ON p.batch_id=b.id
             WHERE b.server_url=$server AND b.project_id=$project
               AND ($group='' OR b.group_id=$group) AND ($template='' OR b.template_id=$template)
               AND p.status IN ('pending','uploaded') AND json_extract(p.recognition_json,'$.normalized_sha256') IS NOT NULL
             ORDER BY (b.id=$preferred) DESC, p.rowid DESC
            """;
        cmd.Parameters.AddWithValue("$server", server);
        cmd.Parameters.AddWithValue("$project", project);
        cmd.Parameters.AddWithValue("$group", group);
        cmd.Parameters.AddWithValue("$template", template);
        cmd.Parameters.AddWithValue("$preferred", preferredBatch);
        using var rows = cmd.ExecuteReader();
        while (rows.Read())
        {
            var id = rows.GetString(0);
            if (Guid.TryParseExact(id, "D", out _) && File.Exists(Path.Combine(Root, "processed", id, "normalized.png")))
                return new(id, rows.GetString(1), rows.GetString(2));
        }
        return null;
    }

    internal void PinUpload(PageRow page, string normalized, string jpeg)
    {
        using var db = Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = """
            UPDATE pages SET jpeg_quality=$quality, upload_normalized_sha256=$normalized, upload_sha256=$jpeg
             WHERE capture_id=$id AND COALESCE(jpeg_quality,80)=$quality AND recognition_json=$manifest
               AND (upload_sha256='' OR (upload_sha256=$jpeg AND upload_normalized_sha256=$normalized))
            """;
        cmd.Parameters.AddWithValue("$id", page.CaptureId);
        cmd.Parameters.AddWithValue("$quality", page.JpegQuality);
        cmd.Parameters.AddWithValue("$manifest", page.RecognitionJson);
        cmd.Parameters.AddWithValue("$normalized", normalized);
        cmd.Parameters.AddWithValue("$jpeg", jpeg);
        if (cmd.ExecuteNonQuery() != 1) throw new InvalidDataException("上传页面已更改，请重新核对本地队列。");
        page.LegacyJpeg = false;
        page.UploadSha256 = jpeg;
        page.UploadNormalizedSha256 = normalized;
    }

    private static void LoadDesktopFields(SqliteConnection db,BatchRow batch)
    {
        using var command=db.CreateCommand();
        command.CommandText="SELECT project_id,subject_id,config_sha256,template_json,roster_json,local_pairs_json,room_tags_json FROM batches WHERE id=$id";
        command.Parameters.AddWithValue("$id",batch.Id);using var row=command.ExecuteReader();row.Read();
        batch.ProjectId=row.GetString(0);batch.SubjectId=row.GetString(1);batch.ConfigSha256=row.GetString(2);
        batch.TemplateJson=row.GetString(3);batch.RosterJson=row.GetString(4);batch.LocalPairsJson=row.GetString(5);batch.RoomTagsJson=row.GetString(6);
    }

    public void SaveDesktopBatch(BatchRow batch)=>Execute("""
        UPDATE batches SET project_id=$project,subject_id=$subject,config_sha256=$hash,template_json=$template,roster_json=$roster,local_pairs_json=$pairs,room_tags_json=$tags WHERE id=$id
        """,("$id",batch.Id),("$project",batch.ProjectId),("$subject",batch.SubjectId),("$hash",batch.ConfigSha256),("$template",batch.TemplateJson),("$roster",batch.RosterJson),("$pairs",batch.LocalPairsJson),("$tags",batch.RoomTagsJson));

    public void PageRecognized(string captureId,string result,string? issue=null)=>Execute("""
        UPDATE pages SET recognition_json=$result,status=$status,error=$error
        WHERE capture_id=$id AND status IN ('pending','blocked')
        """,("$id",captureId),("$result",result),("$status",issue==null?"pending":"blocked"),("$error",issue??""));

    public string PairLocally(BatchRow batch)
    {
        var pages=Pages(batch.Id).Where(p=>p.Status!="excluded").ToList();
        batch.LocalPairsJson=BuildPairs(batch,pages);SaveDesktopBatch(batch);BatchStatus(batch.Id,"local_paired");return batch.LocalPairsJson;
    }

    private static string BuildPairs(BatchRow batch,List<PageRow> pages)
    {
        if(pages.Count==0||pages.Any(p=>p.Status=="blocked"||p.RecognitionJson=="{}"))throw new InvalidOperationException("请先完成本地识读并处理异常页面。");
        var fronts=pages.Where(p=>p.Side=="front").OrderBy(p=>p.Sequence).ToArray();
        var backs=pages.Where(p=>p.Side=="back").OrderBy(p=>p.Sequence).ToArray();
        if(batch.BackOrder=="reverse")Array.Reverse(backs);
        if(fronts.Length==0||(batch.Sides==2&&fronts.Length!=backs.Length))throw new InvalidOperationException("正反面数量不符，请处理缺面后再确认。");
        if(batch.CaptureMode=="duplex"&&fronts.Any(p=>!backs.Any(b=>b.Sequence==p.Sequence)))throw new InvalidOperationException("自动双面的纸张序号不完整。");
        var candidates=new HashSet<string>();var pairs=new List<object>();
        using var roster=JsonDocument.Parse(batch.RosterJson);
        var known=roster.RootElement.ValueKind==JsonValueKind.Array?roster.RootElement.EnumerateArray().Select(s=>s.GetProperty("candidate_number").GetString()).ToHashSet():null;
        for(var i=0;i<fronts.Length;i++)
        {
            using var result=JsonDocument.Parse(fronts[i].RecognitionJson);var candidate=result.RootElement.GetProperty("candidate_number").GetString()??"";
            if(candidate.Length==0||candidate.Contains('?')||!candidates.Add(candidate))throw new InvalidOperationException("存在未识别或重复考号，请核查后再确认。");
            if(known is not null&&!known.Contains(candidate))throw new InvalidOperationException("考号不在下载的应考名单中，请核查项目配置。");
            pairs.Add(new {candidate_number=candidate,pages=batch.Sides==2?new[]{fronts[i].CaptureId,backs[i].CaptureId}:new[]{fronts[i].CaptureId}});
        }
        return JsonSerializer.Serialize(pairs);
    }
    public void SaveQuality(string id,QualityReport report)=>Execute(
        "UPDATE pages SET quality_report=$quality WHERE capture_id=$id AND status IN ('pending','blocked')",
        ("$id",id),("$quality",JsonSerializer.Serialize(report,System.Text.Json.JsonSerializerOptions.Web)));

    public bool ClearLocalSheets(BatchRow[] sheets)
    {
        var root=Path.GetFullPath(Root)+Path.DirectorySeparatorChar;
        string CheckedPath(string relative)
        {
            var path=Path.GetFullPath(Path.Combine(Root,relative));
            if(!path.StartsWith(root,StringComparison.OrdinalIgnoreCase))throw new IOException("清理路径超出本地队列");
            return path;
        }
        var trash=CheckedPath(Path.Combine("trash",Guid.NewGuid().ToString("N")));
        var paths=sheets.Select(b=>CheckedPath(Path.Combine("pages",Guid.Parse(b.Id).ToString())))
            .Concat(sheets.SelectMany(b=>Pages(b.Id)).Select(p=>CheckedPath(Path.Combine("processed",Guid.Parse(p.CaptureId).ToString())))).Where(Directory.Exists).ToArray();
        var moved=new List<(string Original,string Temporary)>();
        Directory.CreateDirectory(trash);
        try
        {
            foreach(var path in paths)
            {
                if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new IOException("请先处理本地文件夹的链接");
                var target=Path.Combine(trash,moved.Count.ToString());
                Directory.Move(path,target);moved.Add((path,target));
            }
            using var db=Open();using var tx=db.BeginTransaction();using var cmd=db.CreateCommand();
            cmd.Transaction=tx;
            foreach(var batch in sheets)
            {
                cmd.CommandText="DELETE FROM pages WHERE batch_id=$id; DELETE FROM batches WHERE id=$id";
                cmd.Parameters.Clear();cmd.Parameters.AddWithValue("$id",batch.Id);cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
        catch
        {
            foreach(var pair in moved.AsEnumerable().Reverse())Directory.Move(pair.Temporary,pair.Original);
            throw;
        }
        try
        {
            Directory.Delete(trash,true);
            foreach(var pending in Directory.EnumerateDirectories(CheckedPath("trash")))
                if((File.GetAttributes(pending)&FileAttributes.ReparsePoint)==0)Directory.Delete(pending,true);
            return true;
        }
        catch(IOException){return false;}
        catch(UnauthorizedAccessException){return false;}
    }

    public void SaveCorrection(BatchRow batch,PageRow page,string recognition)
    {
        var pages=Pages(batch.Id).Where(p=>p.Status!="excluded").ToList();
        var front=pages.Single(p=>p.CaptureId==page.CaptureId);
        front.RecognitionJson=recognition;front.Status="pending";
        string pairs="[]",status="local_paired",error="";
        try{pairs=BuildPairs(batch,pages);}
        catch(InvalidOperationException issue){status="frozen";error=issue.Message;}
        using var db=Open();using var tx=db.BeginTransaction();using var cmd=db.CreateCommand();
        cmd.Transaction=tx;cmd.CommandText="""
            UPDATE pages SET recognition_json=$recognition,status='pending',error='' WHERE capture_id=$page;
            UPDATE batches SET local_pairs_json=$pairs,status=$status,error=$error WHERE id=$batch;
            """;
        foreach(var (key,value) in new[]{("$recognition",recognition),("$page",page.CaptureId),("$pairs",pairs),("$status",status),("$error",error),("$batch",batch.Id)})cmd.Parameters.AddWithValue(key,value);
        cmd.ExecuteNonQuery();tx.Commit();
    }

}
