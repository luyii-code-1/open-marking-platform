using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows.Threading;

namespace OMP.Scanner;

// Private stdio transport. The Electron main process is the only caller.
public static class ElectronHost
{
    private static readonly object OutputLock=new();
    private static void Send(object value)
    {
        lock(OutputLock){Console.Out.WriteLine(JsonSerializer.Serialize(value));Console.Out.Flush();}
    }

    [STAThread]
    public static int Main(string[] args)
    {
        if(args.FirstOrDefault()=="--device-plugin")return DevicePlugin.Serve().GetAwaiter().GetResult();
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        if(args.FirstOrDefault()=="--scan-bridge-self-test")
        {
            try{ScannerBridgeSelfTest.Run(args.Contains("--discover")).GetAwaiter().GetResult();return 0;}
            catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}
        }
        if(args.Length==2&&args[0]=="--parse-activation")
        {
            try{var pairing=PairingActivation.Parse(args[1]);Send(new{server=pairing.Server,code=pairing.Code});return 0;}
            catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}
        }
        var dispatcher=Dispatcher.CurrentDispatcher;
        try
        {
            var testRoot=args.Length==2&&args[0]=="--transport-self-test"?Path.GetFullPath(args[1]):null;
            using var instance=testRoot is null ? new DesktopInstance() : null;
            if(instance is {Primary:false})throw new InvalidOperationException("扫描客户端已经运行，请先关闭现有扫描窗口。");
            var closed=false;
            using var controller=new DesktopController(testRoot is null?null:new LocalQueue(testRoot));
            controller.Changed=()=>Send(new{ @event="changed",protocol=DesktopController.Protocol });
            var timer=new DispatcherTimer{Interval=TimeSpan.FromSeconds(8)};
            timer.Tick+=async(_,_)=>{try{await controller.Tick();}catch(Exception error){Console.Error.WriteLine(error.Message);}};
            timer.Start();
            Send(new{@event="ready",protocol=DesktopController.Protocol,server=controller.Server,page_url=controller.Server.Length>0?controller.PageUrl():null});
            _=Task.Run(async()=>
            {
                try
                {
                    while(await Console.In.ReadLineAsync() is { } line)
                    {
                        if(line.Length>2*1024*1024)throw new InvalidDataException("客户端消息过大。");
                        using var document=JsonDocument.Parse(line);var request=document.RootElement.Clone();
                        await dispatcher.InvokeAsync(async()=>
                        {
                            string? id=null;
                            try
                            {
                                id=request.GetProperty("id").GetString();
                                if(string.IsNullOrEmpty(id)||id.Length>100||request.GetProperty("protocol").GetString()!=DesktopController.Protocol)throw new InvalidDataException("客户端协议无效。");
                                var method=request.GetProperty("method").GetString()??"";
                                if(method=="close"){timer.Stop();await controller.Close();closed=true;Send(new{id,ok=true,result=new{}});return;}
                                if(method=="parseActivation")
                                {
                                    var pairing=PairingActivation.Parse(request.GetProperty("args").GetProperty("uri").GetString()??"");
                                    Send(new{id,ok=true,result=new{server=pairing.Server,code=pairing.Code}});return;
                                }
                                var body=request.GetProperty("args");
                                if(body.ValueKind!=JsonValueKind.Object)throw new InvalidDataException("客户端参数无效。");
                                var result=await controller.Invoke(method,body);Send(new{id,ok=true,result});
                            }
                            catch(Exception error)when(error is not OutOfMemoryException){Send(new{id,ok=false,error=error.Message});}
                        }).Task.Unwrap();
                    }
                }
                catch(Exception error){Console.Error.WriteLine(error.Message);}
                finally
                {
                    await dispatcher.InvokeAsync(async()=>{timer.Stop();if(!closed)await controller.Close();dispatcher.BeginInvokeShutdown(DispatcherPriority.Background);}).Task.Unwrap();
                }
            });
            Dispatcher.Run();return 0;
        }
        catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}
    }
}
