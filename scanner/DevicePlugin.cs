using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.Json;
using NAPS2.Scan;

namespace OMP.Scanner;

internal static class DevicePlugin
{
    public const string Protocol="omp-device-1";
    public static async Task<int> Serve()
    {
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        void Emit(object data){Console.WriteLine(JsonSerializer.Serialize(data));Console.Out.Flush();}
        try
        {
            using var job=JsonDocument.Parse(await Console.In.ReadLineAsync()??"");
            var r=job.RootElement;
            if(r.GetProperty("protocol").GetString()!=Protocol)throw new InvalidDataException("设备协议版本不匹配");
            using var scanner=new ScannerService();
            var driver=Enum.Parse<Driver>(r.GetProperty("driver").GetString()!,true);
            var devices=await scanner.Devices(driver);
            if(r.GetProperty("command").GetString()=="devices")
                Emit(new{type="devices",devices=devices.Select(d=>new{id=d.ID,name=d.Name})});
            else
            {
                var device=devices.Single(d=>d.ID==r.GetProperty("device_id").GetString());
                var folder=r.GetProperty("directory").GetString()!;
                await scanner.Acquire(device,r.GetProperty("paper").GetString()!,true,async image=>{
                    var name=Guid.NewGuid().ToString("N")+".png";
                    image.Save(Path.Combine(folder,name),System.Drawing.Imaging.ImageFormat.Png);
                    Emit(new{type="page",file=name});
                    if(await Console.In.ReadLineAsync()!="{\"continue\":true}")throw new OperationCanceledException();
                },CancellationToken.None,r.GetProperty("duplex").GetBoolean(),new ScanCaptureSettings(r.GetProperty("dpi").GetInt32(),r.GetProperty("color").GetString()!));
            }
            Emit(new{type="done"});return 0;
        }
        catch(Exception error){Emit(new{type="error",message=error.Message});return 1;}
    }

    public static async Task Run(string? executable,object request,Func<JsonElement,Task> handle,CancellationToken cancel)
    {
        var info=new ProcessStartInfo(executable??Environment.ProcessPath!){UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,
            StandardInputEncoding=new UTF8Encoding(false),StandardOutputEncoding=Encoding.UTF8,CreateNoWindow=true};
        if(executable==null)info.ArgumentList.Add("--device-plugin");
        using var process=Process.Start(info)??throw new IOException("设备插件启动失败");
        void Stop(){try{if(!process.HasExited)process.Kill(true);}catch(InvalidOperationException){}}
        using var registration=cancel.Register(Stop);
        try
        {
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(request));
            while(await process.StandardOutput.ReadLineAsync(cancel) is string line)
            {
                using var doc=JsonDocument.Parse(line);
                var msg=doc.RootElement;var type=msg.GetProperty("type").GetString();
                if(type=="error")throw new IOException(msg.GetProperty("message").GetString());
                if(type=="done")return;
                if(type is not ("devices" or "page"))throw new IOException("插件消息无效");
                await handle(msg);
                if(type=="page")await process.StandardInput.WriteLineAsync("{\"continue\":true}");
            }
            cancel.ThrowIfCancellationRequested();throw new IOException("设备插件意外退出");
        }
        finally{Stop();}
    }

    public static async Task Acquire(string? exe,string driver,string id,string paper,bool duplex,ScanCaptureSettings settings,Func<Image,Task> receive,CancellationToken cancel)
    {
        var directory=Directory.CreateTempSubdirectory("omp-device-");
        try
        {
            await Run(exe,new{protocol=Protocol,command="scan",driver,device_id=id,paper,duplex,dpi=settings.Dpi,color=settings.Color,directory=directory.FullName},async msg=>{
                var file=msg.GetProperty("file").GetString()!;
                if(Path.GetFileName(file)!=file||file.Length==0)throw new IOException("插件返回的文件名无效");
                var path=Path.Combine(directory.FullName,file);
                using(var image=Image.FromFile(path))await receive(image);
                File.Delete(path);
            },cancel);
        }
        finally{directory.Delete(true);}
    }
}
