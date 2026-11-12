using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

namespace OMP.Scanner;

public sealed record PairingActivation(string Server,string Code)
{
    public static string InitialUri {get;set;}="";
    public static PairingActivation Parse(string value)
    {
        if(value.Length>4096||!Uri.TryCreate(value,UriKind.Absolute,out var uri)||uri.Scheme!="omp-scanner"||uri.Host!="connect"||uri.AbsolutePath is not ("" or "/")||uri.UserInfo.Length>0||uri.Fragment.Length>0)throw new ArgumentException("扫描客户端连接地址无效。");
        var fields=new Dictionary<string,string>();
        foreach(var pair in uri.Query.TrimStart('?').Split('&',StringSplitOptions.RemoveEmptyEntries))
        {
            var parts=pair.Split('=',2);var key=Uri.UnescapeDataString(parts[0]);
            if(parts.Length!=2||key is not ("server" or "code")||!fields.TryAdd(key,Uri.UnescapeDataString(parts[1])))throw new ArgumentException("扫描客户端连接参数无效。");
        }
        if(!fields.TryGetValue("server",out var server)||!fields.TryGetValue("code",out var code))throw new ArgumentException("连接请求缺少服务器或配对码。");
        code=code.Replace("-","").ToUpperInvariant();if(!Regex.IsMatch(code,"^[A-Z2-9]{12}$"))throw new ArgumentException("配对码格式无效。");
        using var check=new ApiClient(server);return new(check.ServerUrl,code);
    }
}

public sealed class DesktopInstance:IDisposable
{
    private readonly string _name="OMP.Scanner."+WindowsIdentity.GetCurrent().User!.Value;
    private readonly Mutex _mutex;
    private readonly CancellationTokenSource _stop=new();
    public bool Primary {get;}
    public Action<string>? Activated {get;set;}
    public DesktopInstance(string suffix=""){_name+=suffix;_mutex=new Mutex(true,@"Local\"+_name,out var created);Primary=created;}
    public async Task Forward(string value)
    {
        using var pipe=new NamedPipeClientStream(".",_name,PipeDirection.Out,PipeOptions.Asynchronous);
        await pipe.ConnectAsync(5000);var data=Encoding.UTF8.GetBytes(value);if(data.Length>4096)throw new ArgumentException("连接请求过长。");
        await pipe.WriteAsync(BitConverter.GetBytes(data.Length));await pipe.WriteAsync(data);await pipe.FlushAsync();
    }
    public async Task Listen()
    {
        while(!_stop.IsCancellationRequested)
        {
            try
            {
                using var pipe=new NamedPipeServerStream(_name,PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(_stop.Token);using var timeout=CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);timeout.CancelAfter(TimeSpan.FromSeconds(5));
                var header=new byte[4];await pipe.ReadExactlyAsync(header,timeout.Token);var length=BitConverter.ToInt32(header);if(length is <0 or >4096)continue;
                var data=new byte[length];await pipe.ReadExactlyAsync(data,timeout.Token);Activated?.Invoke(Encoding.UTF8.GetString(data));
            }
            catch(OperationCanceledException){}catch(IOException){}
        }
    }
    public void Dispose(){_stop.Cancel();if(Primary)_mutex.ReleaseMutex();_mutex.Dispose();}
}
