using System.IO;
using System.Text.Json;

namespace OMP.Scanner;

internal static class DesktopSelfTest
{
    private static JsonElement Json(object? value)=>JsonSerializer.SerializeToElement(value);
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    private static void Checkpoint(string name,object? result=null){Console.WriteLine(JsonSerializer.Serialize(new{checkpoint=name,result}));Console.Out.Flush();}
    public static async Task Run(string[] args)
    {
        if(args.Length!=10)throw new ArgumentException("Desktop self-test: server root front back project username password python-or-dash repository");
        var root=Path.GetFullPath(args[2]);Directory.CreateDirectory(root);var queue=new LocalQueue(root);
        var python=args[8]=="-"?null:args[8];var repository=args[9];
        RecognitionWorker Worker()=>new(root,python,repository);
        string normalized;using(var address=new ApiClient(args[1]))normalized=address.ServerUrl;
        try
        {
            using(var online=new DesktopController(queue,Worker(),selfTest:true))
            {
                await online.Invoke("connect",Json(new{server_url=args[1],username=args[6],password=args[7]}));
                await online.Invoke("downloadProject",Json(new{project_id=args[5]}));await online.Close();
            }
            Checkpoint("ready_for_offline");await Console.In.ReadLineAsync();
            string batchId;
            using(var worker=Worker())
            using(var offline=new DesktopController(new LocalQueue(root),worker,selfTest:true))
            {
                var state=Json(await offline.Invoke("state",Json(new{}))!);Check(!state.GetProperty("online").GetBoolean(),"Restart should start with cached metadata before a connection.");
                var group=state.GetProperty("package").GetProperty("groups")[0];
                Check(!group.GetProperty("template").GetProperty("questions")[0].TryGetProperty("answer",out _),"Device cache contains an answer key.");
                var created=Json(await offline.Invoke("createBatch",Json(new{group_id=group.GetProperty("id").GetString(),name="离线重启验证",capture_mode="duplex"}))!);
                batchId=created.GetProperty("id").GetString()!;var batch=queue.Batches().Single(b=>b.Id==batchId);
                foreach(var file in new[]{args[3],args[4]})
                {
                    using var image=System.Drawing.Image.FromFile(file);var page=queue.AddPage(batch,"auto",image);Check(page.Status=="pending",page.Error);
                    var result=await worker.Recognize(batch,page);queue.PageRecognized(page.CaptureId,result.GetRawText());
                }
                var pairs=JsonDocument.Parse(queue.PairLocally(batch));Check(pairs.RootElement[0].GetProperty("candidate_number").GetString()=="123","Offline candidate recognition failed.");
                Check(queue.Pages(batchId).Count==2,"Offline queue lost a page.");await offline.Close();
            }
            Checkpoint("offline_processed",new{batch_id=batchId,pages=2});await Console.In.ReadLineAsync();
            using(var resumed=new DesktopController(new LocalQueue(root),Worker(),selfTest:true))
            {
                Check(queue.Batches().Single(b=>b.Id==batchId).Status=="local_paired","Restart lost the local pairing state.");
                await resumed.Tick(true);Check(queue.Batches().Single(b=>b.Id==batchId).Status=="paired","Resumed batch was not committed: "+queue.Batches().Single(b=>b.Id==batchId).Error);
                Check(queue.Pages(batchId).All(p=>p.Status=="uploaded"),"Upload acknowledgement was lost.");await resumed.Close();
            }
            Checkpoint("passed",new{batch_id=batchId,scope="offline restart, local TCP recognition, durable queue, native signed upload and server pairing"});
        }
        finally
        {
            try{using var identity=new DeviceIdentity(normalized,Path.Combine(root,"devices"),create:false,selfTest:true);identity.DeleteTestKey();}catch(InvalidOperationException){}
        }
    }
}
