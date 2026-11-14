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
        if(args.Length is not (10 or 11))throw new ArgumentException("Desktop self-test: server root front back project username password python-or-dash repository [first-side]");
        var firstSide=args.Length==11?args[10]:"front";
        if(firstSide is not ("front" or "back"))throw new ArgumentException("Invalid first side");
        var root=Path.GetFullPath(args[2]);Directory.CreateDirectory(root);var queue=new LocalQueue(root);
        var python=args[8]=="-"?null:args[8];var repository=args[9];
        RecognitionWorker Worker()=>new(root,python,repository);
        string normalized;using(var address=new ApiClient(args[1]))normalized=address.ServerUrl;
        if(args[6]=="pair-code")
        {
            var uri="omp-scanner://connect?server="+Uri.EscapeDataString(args[1])+"&code="+Uri.EscapeDataString(args[7]);
            Check(PairingActivation.Parse(uri).Server==normalized,"Protocol URI parsed another server.");
            foreach(var bad in new[]{"file:///tmp",uri+"&code=duplicate","omp-scanner://connect?server=https%3A%2F%2Fuser%3Apassword%40example.com&code=ABCDEFGHJKLM", "omp-scanner://connect?server=http%3A%2F%2Fexample.com&code=ABCDEFGHJKLM"})
            {
                var rejected=false;try{PairingActivation.Parse(bad);}catch(ArgumentException){rejected=true;}Check(rejected,"Invalid activation URI accepted.");
            }
            var channel=".SelfTest."+Guid.NewGuid().ToString("N");using var signal=new ManualResetEventSlim();
            using(var primary=new DesktopInstance(channel))
            {
                Check(primary.Primary,"Self-test instance is not primary.");primary.Activated=value=>{if(value==uri)signal.Set();};var listener=primary.Listen();
                using var secondary=new DesktopInstance(channel);Check(!secondary.Primary,"Duplicate desktop instance was allowed.");secondary.Forward(uri).GetAwaiter().GetResult();Check(signal.Wait(TimeSpan.FromSeconds(5)),"Activation did not reach primary instance.");
            }
        }
        try
        {
            using(var online=new DesktopController(queue,Worker(),selfTest:true))
            {
                await online.Invoke("connect",args[6]=="pair-code"?Json(new{server_url=args[1],pairing_code=args[7]}):Json(new{server_url=args[1],username=args[6],password=args[7]}));
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
                var tags=state.GetProperty("package").TryGetProperty("room_tags",out var tagList)?tagList.EnumerateArray().Where(t=>!t.TryGetProperty("group_id",out var gid)||gid.GetString()==group.GetProperty("id").GetString()).Select(t=>t.GetProperty("id").GetString()).ToArray():[];
                var created=Json(await offline.Invoke("createBatch",Json(new{group_id=group.GetProperty("id").GetString(),name="离线重启验证",capture_mode="duplex",first_side=firstSide,room_tag_ids=tags}))!);
                batchId=created.GetProperty("id").GetString()!;var batch=queue.Batches().Single(b=>b.Id==batchId);
                using(var savedTags=JsonDocument.Parse(batch.RoomTagsJson))Check(savedTags.RootElement.GetArrayLength()==tags.Length,"Offline batch tags were lost.");
                foreach(var file in firstSide=="back"?new[]{args[4],args[3]}:new[]{args[3],args[4]})
                {
                    using var image=System.Drawing.Image.FromFile(file);var page=queue.AddPage(batch,"auto",image);Check(page.Status=="pending",page.Error);
                    var result=await worker.Recognize(batch,page);queue.PageRecognized(page.CaptureId,result.GetRawText());
                }
                var pairs=JsonDocument.Parse(queue.PairLocally(batch));Check(pairs.RootElement[0].GetProperty("candidate_number").GetString()=="123","Offline candidate recognition failed.");
                Check(queue.Pages(batchId).Count==2,"Offline queue lost a page.");
                var review=Json(await offline.Invoke("roomReview",Json(new{batch_id=batchId})));
                Check(review.GetArrayLength()==1&&review[0].GetProperty("candidate").GetString()=="123"&&review[0].GetProperty("absent").ValueKind==JsonValueKind.False,"Room review identity or absence flag is incorrect: "+review.GetRawText());
                var sides=review[0].GetProperty("sides");Check(sides.GetArrayLength()==2,"Room review lost a side.");
                foreach(var side in sides.EnumerateArray()){
                    var id=side.GetProperty("id").GetString();
                    var original=Json(await offline.Invoke("originalPage",Json(new{batch_id=batchId,page_id=id})));
                    Check(Convert.FromBase64String(original.GetProperty("url").GetString()!.Split(',')[1]).SequenceEqual(File.ReadAllBytes(queue.Pages(batchId).Single(p=>p.CaptureId==id).Path)),"Original scan differs from saved file.");
                }
                var firstQuestion=JsonDocument.Parse(batch.TemplateJson).RootElement.GetProperty("questions")[0];
                var preview=Json(await offline.Invoke("preview",Json(new{batch_id=batchId,page_id=queue.Pages(batchId).First(p=>p.Side=="front").CaptureId,question_id=firstQuestion.GetProperty("id").GetString()})));
                using(var imageStream=new MemoryStream(Convert.FromBase64String(preview.GetProperty("url").GetString()!.Split(',')[1])))
                using(var thumbnail=System.Drawing.Image.FromStream(imageStream))Check(thumbnail.Width==360&&thumbnail.Height==172,"Local question preview did not merge all regions.");
                await offline.Close();
            }
            Checkpoint("offline_processed",new{batch_id=batchId,pages=2});await Console.In.ReadLineAsync();
            using(var resumed=new DesktopController(new LocalQueue(root),Worker(),selfTest:true))
            {
                Check(queue.Batches().Single(b=>b.Id==batchId).Status=="local_paired","Restart lost the local pairing state.");
                await resumed.Tick();Check(queue.Pages(batchId).All(p=>p.Status=="pending"),"Connection uploaded local pages without confirmation.");
                await resumed.Invoke("upload",Json(new{batch_id=batchId}));
                for(var i=0;i<300&&queue.Batches().Single(b=>b.Id==batchId).Status=="local_paired";i++)await Task.Delay(100);
                Check(queue.Batches().Single(b=>b.Id==batchId).Status=="paired","Resumed batch was not committed: "+queue.Batches().Single(b=>b.Id==batchId).Error);
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
