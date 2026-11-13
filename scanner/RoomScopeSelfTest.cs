using System.IO;
using System.Text.Json;

namespace OMP.Scanner;

internal static class RoomScopeSelfTest
{
    private static JsonElement Json(object value)=>JsonSerializer.SerializeToElement(value);
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    public static async Task Run(string[] args)
    {
        if(args.Length!=6)throw new ArgumentException("Room self-test: server root project username password");
        var root=Path.GetFullPath(args[2]);Directory.CreateDirectory(root);var queue=new LocalQueue(root);
        string server;using(var address=new ApiClient(args[1]))server=address.ServerUrl;
        string batchId,roomId,groupId;
        try
        {
            using(var online=new DesktopController(queue,new RecognitionWorker(root),selfTest:true))
            {
                await online.Invoke("connect",Json(new{server_url=args[1],username=args[4],password=args[5]}));
                await online.Invoke("downloadProject",Json(new{project_id=args[3]}));await online.Close();
            }
            using(var offline=new DesktopController(new LocalQueue(root),new RecognitionWorker(root),selfTest:true))
            {
                var state=Json((await offline.Invoke("state",Json(new{})))!);Check(!state.GetProperty("online").GetBoolean(),"Offline restart unexpectedly connected.");
                var package=state.GetProperty("package");var group=package.GetProperty("groups").EnumerateArray().First(g=>g.TryGetProperty("grade_id",out var id)&&id.ValueKind==JsonValueKind.String);
                groupId=group.GetProperty("id").GetString()!;
                var rooms=package.GetProperty("room_tags").EnumerateArray().Where(t=>!t.GetProperty("archived").GetBoolean()).ToArray();
                var room=rooms.First(t=>t.GetProperty("group_id").GetString()==groupId);roomId=room.GetProperty("id").GetString()!;
                var foreign=rooms.First(t=>t.GetProperty("group_id").GetString()!=groupId);
                Check(room.GetProperty("expected_students").GetInt32()==2,"Expected room capacity not cached.");
                var rejected=false;
                try{await offline.Invoke("createBatch",Json(new{group_id=groupId,name="wrong-room",capture_mode="separate",room_tag_ids=new[]{foreign.GetProperty("id").GetString()}}));}
                catch(InvalidOperationException){rejected=true;}
                Check(rejected,"Wrong group room was accepted offline.");
                var created=Json((await offline.Invoke("createBatch",Json(new{group_id=groupId,name="考场离线验证",capture_mode="separate",room_tag_ids=new[]{roomId}})))!);
                batchId=created.GetProperty("id").GetString()!;await offline.Close();
            }
            using(var resumed=new DesktopController(new LocalQueue(root),new RecognitionWorker(root),selfTest:true))
            {
                var state=Json((await resumed.Invoke("state",Json(new{})))!);var saved=state.GetProperty("batches").EnumerateArray().Single(b=>b.GetProperty("id").GetString()==batchId);
                var room=saved.GetProperty("room_tags")[0];Check(room.GetProperty("id").GetString()==roomId&&room.GetProperty("group_id").GetString()==groupId,"Room identity lost across restart.");
                Check(room.GetProperty("expected_students").GetInt32()==2,"Room capacity lost across restart.");await resumed.Close();
            }
            Console.WriteLine("ROOM SCOPE PASS: cached grade and room, offline rejection, durable batch identity and capacity");
        }
        finally
        {
            try{using var identity=new DeviceIdentity(server,Path.Combine(root,"devices"),create:false,selfTest:true);identity.DeleteTestKey();}catch(InvalidOperationException){}
        }
    }
}
