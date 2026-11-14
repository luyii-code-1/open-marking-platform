using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace OMP.Scanner;

public sealed partial class LocalQueue
{
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

    public void PageRecognized(string captureId,string result)=>Execute("UPDATE pages SET recognition_json=$result,status='pending',error='' WHERE capture_id=$id AND status!='excluded'",("$id",captureId),("$result",result));

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
