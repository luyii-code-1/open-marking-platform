using System.ComponentModel;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace OMP.Scanner;

public partial class DesktopWindow : Window
{
    private bool _pageReady;
    private string _pendingActivation="";
    public async void ReceiveActivation(string value)
    {
        if(_closing)return;
        if(value.Length==0){Activate();return;}
        if(!_pageReady){_pendingActivation=value;return;}
        try
        {
            var pairing=PairingActivation.Parse(value);Activate();
            if(System.Windows.MessageBox.Show(this,"将本机连接到：\n"+pairing.Server+"\n并使用网页生成的配对请求绑定设备。","连接扫描服务器",MessageBoxButton.OKCancel,MessageBoxImage.Question)!=MessageBoxResult.OK)return;
            var args=JsonSerializer.SerializeToElement(new{server_url=pairing.Server,pairing_code=pairing.Code});
            var result=await _controller.Invoke("connect",args);
            if(result is not null){var data=JsonSerializer.SerializeToElement(result);Browser.CoreWebView2.Navigate(data.GetProperty("page_url").GetString());}
        }
        catch(Exception error){System.Windows.MessageBox.Show(this,error.Message,"扫描客户端连接");}
    }
    private const string LocalPage="https://omp-scanner.local/scanner.html";
    private readonly DesktopController _controller=new();
    private readonly DispatcherTimer _timer=new(){Interval=TimeSpan.FromSeconds(8)};
    private bool _closing,_ready;
    public DesktopWindow(){InitializeComponent();}
    private bool Allowed(string source)
    {
        if(!Uri.TryCreate(source,UriKind.Absolute,out var value))return false;
        if(value.GetLeftPart(UriPartial.Path)==LocalPage)return true;
        if(_controller.Server.Length==0)return false;
        return value.GetLeftPart(UriPartial.Path)==_controller.PageUrl();
    }
    private async void LoadedWindow(object sender,RoutedEventArgs args)
    {
        try
        {
            var directory=Path.Combine(AppContext.BaseDirectory,"ui");
            if(!File.Exists(Path.Combine(directory,"scanner.html")))throw new InvalidOperationException("缺少离线扫描页面，请完整解压扫描端安装包。");
            var profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"OpenMarkingPlatform","Scanner","webview");
            var environment=await CoreWebView2Environment.CreateAsync(userDataFolder:profile);await Browser.EnsureCoreWebView2Async(environment);
            Browser.CoreWebView2.SetVirtualHostNameToFolderMapping("omp-scanner.local",directory,CoreWebView2HostResourceAccessKind.DenyCors);
            Browser.CoreWebView2.Settings.AreHostObjectsAllowed=false;
            Browser.CoreWebView2.Settings.IsPasswordAutosaveEnabled=false;
            Browser.CoreWebView2.Settings.IsGeneralAutofillEnabled=false;
            Browser.CoreWebView2.NewWindowRequested+=(_,e)=>e.Handled=true;
            Browser.CoreWebView2.NavigationStarting+=(_,e)=>{if(!Allowed(e.Uri))e.Cancel=true;};
            Browser.CoreWebView2.NavigationCompleted+=(_,e)=>
            {
                if((!e.IsSuccess||e.HttpStatusCode>=400)&&Browser.Source?.GetLeftPart(UriPartial.Path)!=LocalPage){Browser.CoreWebView2.Navigate(LocalPage);return;}
                LoadingText.Visibility=Visibility.Collapsed;
            };
            Browser.CoreWebView2.WebMessageReceived+=Message;
            _controller.Changed=()=>Dispatcher.BeginInvoke(()=>
            {
                if(!_closing&&Allowed(Browser.Source?.AbsoluteUri??""))Browser.CoreWebView2.PostWebMessageAsJson("{\"event\":\"changed\",\"protocol\":\"omp-scanner-4\"}");
            });
            _timer.Tick+=async(_,_)=>await _controller.Tick();_timer.Start();
            Browser.CoreWebView2.Navigate(LocalPage);
            // A bundled page is always available before an online navigation.
            if(_controller.Server.Length>0)
            {
                await _controller.Tick();
                Browser.CoreWebView2.PostWebMessageAsJson("{\"event\":\"changed\",\"protocol\":\"omp-scanner-4\"}");
                using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(4));
                try{using var http=new System.Net.Http.HttpClient();using var response=await http.GetAsync(_controller.PageUrl(),timeout.Token);if(response.IsSuccessStatusCode)Browser.CoreWebView2.Navigate(_controller.PageUrl());}catch(System.Net.Http.HttpRequestException){}catch(OperationCanceledException){}
            }
        }
        catch(Exception error){if(!_closing){LoadingText.Text=error.Message;LoadingText.Visibility=Visibility.Visible;}return;}
        _pageReady=true;
        var activation=_pendingActivation.Length>0?_pendingActivation:PairingActivation.InitialUri;
        PairingActivation.InitialUri="";_pendingActivation="";
        if(activation.Length>0)ReceiveActivation(activation);
    }
    private async void Message(object? sender,CoreWebView2WebMessageReceivedEventArgs args)
    {
        if(_closing||!Allowed(args.Source)||!Allowed(Browser.Source?.AbsoluteUri??""))return;
        string? requestId=null;
        try
        {
            var text=args.WebMessageAsJson;if(text.Length>2*1024*1024)throw new InvalidOperationException("客户端消息过大。");
            using var document=JsonDocument.Parse(text);var request=document.RootElement;
            requestId=request.GetProperty("id").GetString();if(requestId is null||requestId.Length>100)throw new InvalidOperationException("客户端消息编号无效。");
            if(request.GetProperty("protocol").GetString()!=DesktopController.Protocol)
            {
                if(Browser.Source?.GetLeftPart(UriPartial.Path)!=LocalPage){Browser.CoreWebView2.Navigate(LocalPage);return;}
                throw new InvalidOperationException("扫描页面与客户端协议不兼容，请完整更新客户端。");
            }
            var method=request.GetProperty("method").GetString()??"";var body=request.GetProperty("args");
            if(body.ValueKind!=JsonValueKind.Object)throw new InvalidOperationException("客户端参数无效。");
            if(method=="connect"&&body.TryGetProperty("server_url",out var server))
            {
                using var validate=new ApiClient(server.GetString()??"");
                if(validate.ServerUrl!=_controller.Server&&System.Windows.MessageBox.Show(this,"将扫描客户端连接到：\n"+validate.ServerUrl,"确认服务器",MessageBoxButton.OKCancel,MessageBoxImage.Information)!=MessageBoxResult.OK)throw new OperationCanceledException("已取消服务器切换。");
            }
            if(method=="offlinePage")
            {
                Browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new{id=requestId,ok=true,result=new{}}));Browser.CoreWebView2.Navigate(LocalPage);return;
            }
            var result=await _controller.Invoke(method,body);
            if(method=="connect"&&result is not null)
            {
                var connected=JsonSerializer.SerializeToElement(result);
                if(connected.TryGetProperty("page_url",out var target)&&Allowed(target.GetString()??"")){Browser.CoreWebView2.Navigate(target.GetString());return;}
            }
            if(!Allowed(args.Source)||Browser.Source?.GetLeftPart(UriPartial.Path)!=new Uri(args.Source).GetLeftPart(UriPartial.Path))return;
            Browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new{id=requestId,ok=true,result}));
            if((method is "connect" or "onlinePage")&&result is not null)
            {
                var navigation=JsonSerializer.SerializeToElement(result);
                if(navigation.TryGetProperty("page_url",out var address)&&Allowed(address.GetString()??""))_ = Dispatcher.BeginInvoke(()=>Browser.CoreWebView2.Navigate(address.GetString()));
            }
        }
        catch(Exception error)when(error is not OutOfMemoryException)
        {
            if(requestId is not null&&Allowed(Browser.Source?.AbsoluteUri??""))Browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new{id=requestId,ok=false,error=error.Message}));
        }
    }
    private async void ClosingWindow(object? sender,CancelEventArgs args)
    {
        if(_ready)return;args.Cancel=true;if(_closing)return;_closing=true;_timer.Stop();
        try{await _controller.Close();}
        finally{_ready=true;Browser.Dispose();_ = Dispatcher.BeginInvoke(DispatcherPriority.Normal,new Action(Close));}
    }
}
