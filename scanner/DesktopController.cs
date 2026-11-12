using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NAPS2.Scan;
using FileDialog=Microsoft.Win32.OpenFileDialog;

namespace OMP.Scanner;

public sealed class DesktopController : IDisposable
{
    public const string Protocol="omp-scanner-4";
    private readonly LocalQueue _queue;
    private readonly RecognitionWorker _worker;
    private readonly bool _selfTest;
    private readonly ScannerService _scanner=new();
    private readonly SemaphoreSlim _uploadGate=new(1,1);
    private readonly CancellationTokenSource _lifetime=new();
    private readonly Dictionary<string,JsonElement> _packages=new();
    private List<ScanDevice> _devices=[];
    private ApiClient? _api;
    private CancellationTokenSource? _captureCancel;
    private Task? _capture;
    private string _server="",_project="",_message="",_captureBatchId="";
    private bool _online,_tickRunning,_revoked,_disposed,_connecting;
    public Action<string>? NavigateRequested {get;set;}
    public Action? Changed {get;set;}
    public bool Capturing=>_capture is {IsCompleted:false};
    public string Server=>_server;
    public DesktopController(LocalQueue? queue=null,RecognitionWorker? worker=null,bool selfTest=false)
    {
        _queue=queue??new LocalQueue();_worker=worker??new RecognitionWorker(_queue.Root);_selfTest=selfTest;
        var path=Path.Combine(_queue.Root,"desktop-settings.json");
        if(File.Exists(path))
        {
            using var saved=JsonDocument.Parse(File.ReadAllText(path));_server=Text(saved.RootElement,"server_url");_project=Text(saved.RootElement,"project_id");
        }
        LoadPackages();
    }

    private static string Text(JsonElement value,string key,string fallback="")=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(key,out var found)&&found.ValueKind!=JsonValueKind.Null?found.ToString():fallback;
    private static JsonElement Json(string value)=>JsonSerializer.Deserialize<JsonElement>(value);
    private ApiClient Api(string url)=>new(url,Path.Combine(_queue.Root,"devices"),selfTest:_selfTest);
    private string Partition=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_server))).ToLowerInvariant();
    private string ProjectPath(string id)=>Path.Combine(_queue.Root,"workspaces",Partition,Guid.Parse(id).ToString(),"package.json");
    private static void Save(string path,string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);var temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
        try{using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)){var bytes=Encoding.UTF8.GetBytes(value);stream.Write(bytes);stream.Flush(true);}File.Move(temporary,path,true);}
        finally{if(File.Exists(temporary))File.Delete(temporary);}
    }
    private void SaveSettings()=>Save(Path.Combine(_queue.Root,"desktop-settings.json"),JsonSerializer.Serialize(new{server_url=_server,project_id=_project}));
    private void LoadPackages()
    {
        _packages.Clear();var directory=Path.Combine(_queue.Root,"workspaces",Partition);
        if(!Directory.Exists(directory))return;
        foreach(var path in Directory.EnumerateFiles(directory,"package.json",SearchOption.AllDirectories))
        {
            try{var value=Json(File.ReadAllText(path));_packages[Text(value.GetProperty("project"),"id")]=value;}catch(JsonException){ }
        }
    }
    private BatchRow Batch(string id)
    {
        var batch=_queue.Batches().FirstOrDefault(b=>b.Id==id&&b.ServerUrl==_server)??throw new InvalidOperationException("批次不存在或属于其他服务器。");
        if(batch.TemplateJson=="{}")throw new InvalidOperationException("请先下载所属项目的题卡配置。");
        return batch;
    }
    private void Notify(string message=""){if(message.Length>0)_message=message;Changed?.Invoke();}
    private void Freeze(BatchRow batch,string message){_queue.BatchStatus(batch.Id,"frozen",message);if(Capturing&&_captureBatchId==batch.Id)_captureCancel?.Cancel();Notify(message);}

    private object State(JsonElement args)
    {
        var selected=Text(args,"batch_id");var batches=_queue.Batches().Where(b=>b.ServerUrl==_server&&b.ProjectId==_project).ToArray();
        var batch=batches.FirstOrDefault(b=>b.Id==selected);var pages=batch is null?[]:_queue.Pages(batch.Id);
        var offset=args.TryGetProperty("offset",out var start)?Math.Max(0,start.GetInt32()):0;
        var projects=_packages.Values.Select(p=>new{id=Text(p.GetProperty("project"),"id"),name=Text(p.GetProperty("project"),"name"),downloaded_at=Text(p,"downloaded_at")}).ToArray();
        var catalogPath=Path.Combine(_queue.Root,"workspaces",Partition,"catalog.json");
        return new{protocol=Protocol,server_url=_server,storage_path=_queue.Root,online=_online,capturing=Capturing,syncing=_tickRunning,message=_message,project_id=_project,
            projects,catalog=File.Exists(catalogPath)?Json(File.ReadAllText(catalogPath)):Json("{\"projects\":[]}"),
            package=_packages.TryGetValue(_project,out var package)?package:Json("null"),
            batches=batches.Select(b=>new{id=b.Id,name=b.Label,subject_id=b.SubjectId,group_id=b.GroupId,room=b.Room,room_tags=JsonSerializer.Deserialize<JsonElement>(b.RoomTagsJson),status=b.Status,error=b.Error,capture_mode=b.CaptureMode,back_order=b.BackOrder,paper=b.Paper,sides=b.Sides,created_at=b.CreatedAt,
                total=_queue.Pages(b.Id).Count,pending=_queue.Pages(b.Id).Count(p=>p.Status=="pending"),blocked=_queue.Pages(b.Id).Count(p=>p.Status=="blocked"),uploaded=_queue.Pages(b.Id).Count(p=>p.Status=="uploaded")}),
            page_total=pages.Count,pages=pages.Skip(offset).Take(50).Select(p=>new{id=p.CaptureId,sequence=p.Sequence,side=p.Side,status=p.Status,error=p.Error,candidate=p.RecognitionJson=="{}"?"":Text(Json(p.RecognitionJson),"candidate_number"),quality=p.QualitySummary,recognized=p.RecognitionJson!="{}",local_cut_available=File.Exists(Path.Combine(_queue.Root,"processed",p.CaptureId,"cuts.zip"))})};
    }

    public async Task<object?> Invoke(string method,JsonElement args)
    {
        switch(method)
        {
            case "state":return State(args);
            case "connect":
                if(_connecting)throw new InvalidOperationException("正在连接服务器，请稍后重试。");
                _connecting=true;
                try
                {
                if(Capturing||_tickRunning)throw new InvalidOperationException("正在采集或同步，请完成后再切换连接。");
                using(var validate=new ApiClient(Text(args,"server_url")))
                {
                _api?.Dispose();_api=Api(validate.ServerUrl);_server=validate.ServerUrl;_online=false;_revoked=false;LoadPackages();SaveSettings();
                }
                using(var timeout=CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token))
                {
                    timeout.CancelAfter(TimeSpan.FromSeconds(20));
                    if(Text(args,"pairing_code").Length>0)await _api.Pair(Text(args,"pairing_code"),timeout.Token);
                    else if(Text(args,"username").Length>0)await _api.Login(Text(args,"username"),Text(args,"password"),timeout.Token,_queue.Batches().Where(b=>b.ServerUrl==_server&&b.Status!="paired").Select(b=>b.Id));
                    else await _api.ConnectDevice(timeout.Token);
                    var catalog=await _api.Get("scanner/catalog",timeout.Token);Save(Path.Combine(_queue.Root,"workspaces",Partition,"catalog.json"),catalog.GetRawText());
                }
                _online=true;Notify("设备已连接。选择考试项目并下载配置。");return new{page_url=PageUrl()};
                }
                finally{_connecting=false;}
            case "downloadProject":
                if(!_online||_api is null)throw new InvalidOperationException("下载项目需要连接服务器。");
                var id=Guid.Parse(Text(args,"project_id")).ToString();var data=await _api.Get($"scanner/projects/{id}/package",_lifetime.Token);
                var packageFields=JsonSerializer.Deserialize<Dictionary<string,JsonElement>>(data.GetRawText())!;packageFields["downloaded_at"]=JsonSerializer.SerializeToElement(DateTimeOffset.UtcNow.ToString("O"));
                data=JsonSerializer.SerializeToElement(packageFields);Save(ProjectPath(id),data.GetRawText());_packages[id]=data;
                foreach(var batch in _queue.Batches().Where(b=>b.ServerUrl==_server))
                {
                    var group=data.GetProperty("groups").EnumerateArray().FirstOrDefault(g=>Text(g,"id")==batch.GroupId&&Text(g.GetProperty("template"),"id")==batch.TemplateId&&g.GetProperty("template").GetProperty("revision").GetInt32()==batch.TemplateRevision);
                    if(group.ValueKind==JsonValueKind.Undefined)continue;Bind(batch,id,group);_queue.SaveDesktopBatch(batch);
                }
                _project=id;SaveSettings();Notify("项目配置已下载，可离线扫描。");return State(Json("{}"));
            case "openProject":
                if(Capturing)throw new InvalidOperationException("请先停止扫描再切换项目。");
                id=Text(args,"project_id");if(!_packages.ContainsKey(id))throw new InvalidOperationException("请先联网下载项目配置。");_project=id;SaveSettings();return State(Json("{}"));
            case "createBatch":
                if(_revoked)throw new InvalidOperationException("设备授权已失效，请重新连接并核查授权。");
                if(!_packages.TryGetValue(_project,out var project))throw new InvalidOperationException("请先打开已下载的考试项目。");
                var selected=project.GetProperty("groups").EnumerateArray().First(g=>Text(g,"id")==Text(args,"group_id"));
                if(selected.GetProperty("frozen").GetBoolean())throw new InvalidOperationException("该题卡组已发布，请联网刷新项目并核查。");
                var template=selected.GetProperty("template");var sides=template.GetProperty("sides").GetInt32();
                var mode=sides==2?Text(args,"capture_mode","duplex"):"separate";var order=mode=="duplex"?"same":Text(args,"back_order","same");
                if(mode is not ("duplex" or "separate")||order is not ("same" or "reverse"))throw new InvalidOperationException("扫描模式无效。");
                var created=new BatchRow{Id=Guid.NewGuid().ToString(),ServerUrl=_server,GroupId=Text(selected,"id"),Label=Text(args,"name","扫描批次"),Room=Text(args,"room"),Paper=Text(template,"paper"),Sides=sides,CaptureMode=mode,BackOrder=order,TemplateId=Text(template,"id"),TemplateRevision=template.GetProperty("revision").GetInt32()};
                if(mode=="duplex"&&template.TryGetProperty("layout_version",out var version)&&version.GetInt32()>=3)
                {
                    created.DuplexFirstSide=Text(args,"first_side");
                    if(created.DuplexFirstSide is not ("front" or "back"))throw new InvalidOperationException("请先校准并选择扫描仪正面或背面先出图。");
                }
                var tagIds=args.TryGetProperty("room_tag_ids",out var requestedTags)?requestedTags.EnumerateArray().Select(t=>t.GetString()??"").ToArray():[];
                var tags=project.TryGetProperty("room_tags",out var availableTags)?availableTags.EnumerateArray().Where(t=>tagIds.Contains(Text(t,"id"))).ToArray():[];
                if(tagIds.Distinct().Count()!=tagIds.Length||tags.Length!=tagIds.Length)throw new InvalidOperationException("考场标签不在已下载的项目配置中，请刷新项目。");
                created.RoomTagsJson=JsonSerializer.Serialize(tags);
                Bind(created,_project,selected);_queue.AddBatch(created);_queue.SaveDesktopBatch(created);return new{id=created.Id};
            case "devices":
                var driver=Enum.Parse<Driver>(Text(args,"driver","Twain"),true);_devices=await _scanner.Devices(driver);return _devices.Select((d,i)=>new{id=i.ToString(),name=d.Name});
            case "start":
                if(Capturing)throw new InvalidOperationException("扫描正在进行。");
                var scanBatch=Batch(Text(args,"batch_id"));CheckCapture(scanBatch);
                var index=int.Parse(Text(args,"device_id"));if(index<0||index>=_devices.Count)throw new InvalidOperationException("请先发现并选择扫描仪。");
                var side=scanBatch.CaptureMode=="duplex"?"auto":Text(args,"side","front");
                _captureCancel=CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);var selectedDevice=_devices[index];
                _capture=Capture(scanBatch,async receive=>await _scanner.Acquire(selectedDevice,scanBatch.Paper,true,receive,_captureCancel.Token,scanBatch.CaptureMode=="duplex"),side);Notify();return new{started=true};
            case "stop":_captureCancel?.Cancel();return new{stopping=true};
            case "import":
                if(Capturing)throw new InvalidOperationException("请先停止扫描。");
                var importBatch=Batch(Text(args,"batch_id"));CheckCapture(importBatch);
                var dialog=new FileDialog{Multiselect=true,Filter="扫描图像|*.png;*.jpg;*.jpeg;*.tif;*.tiff;*.bmp"};if(dialog.ShowDialog()!=true)return null;
                var importSide=importBatch.CaptureMode=="duplex"?"auto":Text(args,"side","front");var files=dialog.FileNames.OrderBy(p=>p,StringComparer.OrdinalIgnoreCase).ToArray();
                _captureCancel=CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
                _capture=Capture(importBatch,async receive=>
                {
                    foreach(var path in files)
                    {
                        using var image=Image.FromFile(path);var frame=image.FrameDimensionsList.Contains(FrameDimension.Page.Guid)?new FrameDimension(FrameDimension.Page.Guid):new FrameDimension(image.FrameDimensionsList[0]);
                        for(var i=0;i<image.GetFrameCount(frame);i++){_captureCancel.Token.ThrowIfCancellationRequested();image.SelectActiveFrame(frame,i);await receive(image);}
                    }
                },importSide);return new{started=true};
            case "pair":var pairBatch=Batch(Text(args,"batch_id"));if(Capturing)throw new InvalidOperationException("请先停止采集再确认批次。");_queue.PairLocally(pairBatch);Notify("本地配页完成，剩余文件将继续上传。");return new{paired=true};
            case "upload":_ = ManualUpload();return new{started=true};
            case "refreshBatch":
                if(Capturing)throw new InvalidOperationException("请先停止采集再核查批次状态。");
                var refresh=Batch(Text(args,"batch_id"));await RefreshBatch(refresh);return State(args);
            case "sendForReview":
                if(Capturing||_api?.LoggedIn!=true)throw new InvalidOperationException("请停止采集并连接服务器。");
                var reviewBatch=Batch(Text(args,"batch_id"));var reviewPage=_queue.Pages(reviewBatch.Id).First(p=>p.CaptureId==Text(args,"page_id"));
                await _api.RegisterBatch(reviewBatch,_lifetime.Token);
                try{await _api.Upload(reviewPage,_lifetime.Token);}
                catch(ApiException error)when(error.StatusCode==409)
                {
                    var received=await _api.Get($"scan-batches/{reviewBatch.Id}/pages",_lifetime.Token);
                    if(!received.EnumerateArray().Any(p=>Text(p,"id")==reviewPage.CaptureId))throw;
                    Notify(error.Message);
                }
                Freeze(reviewBatch,"原图已送交管理员核查，处理后刷新服务端状态。");return State(args);
            case "retryPage":
                if(Capturing)throw new InvalidOperationException("请先停止采集。");
                var retryBatch=Batch(Text(args,"batch_id"));var retryPage=_queue.Pages(retryBatch.Id).First(p=>p.CaptureId==Text(args,"page_id"));
                var quality=JsonSerializer.Deserialize<QualityReport>(retryPage.QualityJson,new JsonSerializerOptions{PropertyNameCaseInsensitive=true});
                if(quality?.Passed!=true)throw new InvalidOperationException("该页未通过采集质量检查，请排除整张后重扫，或在管理端核查原卷。");
                await Recognize(retryBatch,retryPage);if(!_queue.Pages(retryBatch.Id).Any(p=>p.Status=="blocked"))_queue.BatchStatus(retryBatch.Id,"open");return State(args);
            case "exclude":
                if(Capturing)throw new InvalidOperationException("请先停止采集。");
                var excludeBatch=Batch(Text(args,"batch_id"));if(excludeBatch.Status=="paired")throw new InvalidOperationException("批次已提交，请在管理端处理补扫。");
                var excludePage=_queue.Pages(excludeBatch.Id).First(p=>p.CaptureId==Text(args,"page_id"));
                foreach(var page in _queue.Pages(excludeBatch.Id).Where(p=>excludeBatch.CaptureMode=="duplex"?p.Sequence==excludePage.Sequence:p.CaptureId==excludePage.CaptureId))_queue.PageExcluded(page.CaptureId);
                _queue.BatchStatus(excludeBatch.Id,"open");Notify("原图已保留，请整张重扫。");return State(args);
            case "preview":return Preview(Text(args,"batch_id"),Text(args,"page_id"),Text(args,"question_id"));
            case "onlinePage":return new{page_url=PageUrl()};
            default:throw new InvalidOperationException("不支持的客户端命令。");
        }
    }

    public string PageUrl()=>new Uri(new Uri(_server),"../../scanner.html").AbsoluteUri;
    private static void Bind(BatchRow batch,string projectId,JsonElement group)
    {
        batch.ProjectId=projectId;batch.SubjectId=Text(group,"subject_id");batch.TemplateJson=group.GetProperty("template").GetRawText();batch.ConfigSha256=Text(group,"config_sha256");batch.RosterJson=group.GetProperty("roster").GetRawText();
    }
    private void CheckCapture(BatchRow batch)
    {
        if(_revoked)throw new InvalidOperationException("设备授权已失效，请先核查授权。");
        if(batch.Status!="open")throw new InvalidOperationException(batch.Error.Length>0?batch.Error:"该批次已关闭，请建立新批次。");
        if(batch.CaptureMode=="duplex")DuplexOrder.RequireComplete(batch,_queue.Pages(batch.Id));
    }
    private async Task Recognize(BatchRow batch,PageRow page)
    {
        try{var result=await _worker.Recognize(batch,page,_lifetime.Token);_queue.PageRecognized(page.CaptureId,result.GetRawText());Notify();}
        catch(Exception error)when(error is not OutOfMemoryException){_queue.PageError(page.CaptureId,error.Message,true);Freeze(batch,"本地识读未完成："+error.Message);throw;}
    }
    private async Task Capture(BatchRow batch,Func<Func<Image,Task>,Task> acquire,string side)
    {
        _captureBatchId=batch.Id;
        try
        {
            await Task.Yield();
            await acquire(async image=>
            {
                var page=await Task.Run(()=>_queue.AddPage(batch,side,image),_lifetime.Token);Notify();
                if(page.Status=="blocked"){Freeze(batch,page.Error);throw new OperationCanceledException();}
                await Recognize(batch,page);
                _captureCancel!.Token.ThrowIfCancellationRequested();
            });
            Notify("本轮采集完成。请核对纸张与考号后确认批次。");
        }
        catch(OperationCanceledException){Notify("采集已停止，已落盘页面保留。");}
        catch(Exception error)when(error is not OutOfMemoryException){Notify(error.Message);}
        finally{_captureCancel?.Dispose();_captureCancel=null;_captureBatchId="";Changed?.Invoke();}
    }

    public async Task Tick(bool manual=false)
    {
        if(_connecting||_tickRunning||_disposed||string.IsNullOrEmpty(_server))return;_tickRunning=true;
        try
        {
            if(_api?.LoggedIn!=true||!_online)
            {
                _api??=Api(_server);using var timeout=CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);timeout.CancelAfter(TimeSpan.FromSeconds(6));
                try{await _api.ConnectDevice(timeout.Token);_online=true;_revoked=false;}
                catch(ApiException error)when(error.StatusCode==403){_revoked=true;_online=false;_captureCancel?.Cancel();if(manual)throw;return;}
                catch(Exception error)when(error is not OutOfMemoryException){_online=false;if(manual)throw new InvalidOperationException("暂时无法连接服务器，本地数据保留。",error);return;}
            }
            if(!await _uploadGate.WaitAsync(0,_lifetime.Token))return;
            try
            {
                foreach(var batch in _queue.Batches().Where(b=>b.ServerUrl==_server&&b.TemplateJson!="{}"&&b.Status is "open" or "local_paired"))
                {
                    var pages=_queue.Pages(batch.Id);
                    if(!pages.Any(p=>p.Status=="pending"&&p.RecognitionJson!="{}")&&batch.Status!="local_paired")continue;
                    try
                    {
                        var registered=await _api.RegisterBatch(batch,_lifetime.Token);
                        if(Text(registered,"status")=="paired"){_queue.BatchStatus(batch.Id,"paired");continue;}
                        var excluded=pages.Where(p=>p.Status=="excluded").ToArray();
                        foreach(var page in excluded)await _api.Post($"scanner/batches/{batch.Id}/exclude",new{page_ids=new[]{page.CaptureId},reason="操作员排除页面并保留本地原图"},_lifetime.Token);
                        foreach(var page in pages.Where(p=>p.Status=="pending"&&p.RecognitionJson!="{}"))
                        {
                            var accepted=await _api.UploadProcessed(page,_queue.Root,_lifetime.Token);ApplyRemote(page,accepted);Notify();
                        }
                        if(batch.Status=="local_paired"&&_queue.Pages(batch.Id).All(p=>p.Status is "uploaded" or "excluded"))
                        {
                            await _api.Post($"scan-batches/{batch.Id}/pair",new{local_pairs=Json(batch.LocalPairsJson)},_lifetime.Token);_queue.BatchStatus(batch.Id,"paired");Notify("批次已同步并由服务器确认。");
                        }
                    }
                    catch(ApiException error)when(error.StatusCode is 403 or 404 or 409 or 422){if(error.StatusCode==403){_revoked=true;_captureCancel?.Cancel();}Freeze(batch,"同步被服务器拒绝："+error.Message);}
                }
            }
            finally{_uploadGate.Release();}
        }
        catch(OperationCanceledException)when(_lifetime.IsCancellationRequested){ }
        catch(Exception error)when(error is not OutOfMemoryException){_online=false;Notify("上传暂停，本地队列保留："+error.Message);if(manual)throw;}
        finally{_tickRunning=false;Changed?.Invoke();}
    }

    private async Task ManualUpload(){try{await Tick(true);}catch(Exception error)when(error is not OutOfMemoryException){Notify(error.Message);}}
    private void ApplyRemote(PageRow page,JsonElement remote)
    {
        if(remote.TryGetProperty("excluded",out var excluded)&&excluded.ValueKind==JsonValueKind.True){_queue.PageExcluded(page.CaptureId);return;}
        if(Text(remote,"status")!="recognized")return;
        var data=JsonSerializer.Deserialize<Dictionary<string,JsonElement>>(page.RecognitionJson)!;
        foreach(var key in new[]{"candidate_number","selections","absent_mark"})if(remote.TryGetProperty(key,out var value))data[key]=value.Clone();
        if(!data.ContainsKey("cuts"))data["cuts"]=Json("[]");
        _queue.PageRecognized(page.CaptureId,JsonSerializer.Serialize(data));_queue.PageUploaded(page.CaptureId,page.CaptureId);
    }
    private async Task RefreshBatch(BatchRow batch)
    {
        if(_api?.LoggedIn!=true)throw new InvalidOperationException("请先连接服务器。");
        var remote=await _api.Get($"scan-batches/{batch.Id}",_lifetime.Token);
        if(Text(remote,"status")=="paired"){_queue.BatchStatus(batch.Id,"paired");return;}
        if(remote.TryGetProperty("group_frozen",out var frozen)&&frozen.GetBoolean())throw new InvalidOperationException("成绩已发布，请先在管理端发起复核。");
        if(Text(remote,"status")=="frozen")throw new InvalidOperationException("服务端批次仍被冻结，请先完成核查。");
        var pages=_queue.Pages(batch.Id).ToDictionary(p=>p.CaptureId);
        foreach(var page in (await _api.Get($"scan-batches/{batch.Id}/pages",_lifetime.Token)).EnumerateArray())if(pages.TryGetValue(Text(page,"id"),out var local))ApplyRemote(local,page);
        if(_queue.Pages(batch.Id).Any(p=>p.Status=="blocked"))throw new InvalidOperationException("仍有本地异常页面，请核查或排除后重扫。");
        _queue.BatchStatus(batch.Id,"open");Notify("批次状态已更新。");
    }

    private object Preview(string batchId,string pageId,string questionId)
    {
        var page=_queue.Pages(Batch(batchId).Id).First(p=>p.CaptureId==pageId);byte[]? content=null;
        if(questionId.Length>0&&Guid.TryParse(questionId,out _)&&page.RecognitionJson!="{}")
        {
            var entries=Json(page.RecognitionJson).GetProperty("cuts").EnumerateArray().Where(e=>Text(e,"question_id")==questionId).ToArray();
            if(entries.Length==0)throw new InvalidOperationException("本页没有该题的本地切题图。");
            using var archive=System.IO.Compression.ZipFile.OpenRead(Path.Combine(_queue.Root,"processed",pageId,"cuts.zip"));var pieces=new List<Bitmap>();
            try
            {
                foreach(var entry in entries)
                {
                    using var input=archive.GetEntry(Text(entry,"entry"))!.Open();using var original=Image.FromStream(input);pieces.Add(new Bitmap(original));
                }
                using var merged=new Bitmap(pieces.Max(p=>p.Width),pieces.Sum(p=>p.Height)+12*(pieces.Count-1));
                using(var graphics=Graphics.FromImage(merged)){graphics.Clear(Color.White);var top=0;foreach(var piece in pieces){graphics.DrawImageUnscaled(piece,0,top);top+=piece.Height+12;}}
                using var output=new MemoryStream();merged.Save(output,ImageFormat.Png);content=output.ToArray();
            }
            finally{foreach(var piece in pieces)piece.Dispose();}
        }
        using Stream stream=content is null?File.OpenRead(page.Path):new MemoryStream(content);using var image=Image.FromStream(stream);
        var scale=Math.Min(1,1000d/Math.Max(image.Width,image.Height));using var thumbnail=new Bitmap(Math.Max(1,(int)(image.Width*scale)),Math.Max(1,(int)(image.Height*scale)));using(var graphics=Graphics.FromImage(thumbnail))graphics.DrawImage(image,0,0,thumbnail.Width,thumbnail.Height);
        using var buffer=new MemoryStream();thumbnail.Save(buffer,ImageFormat.Jpeg);return new{url="data:image/jpeg;base64,"+Convert.ToBase64String(buffer.ToArray())};
    }
    public async Task Close()
    {
        _captureCancel?.Cancel();if(_capture is not null)await _capture;_lifetime.Cancel();
        while(_tickRunning)await Task.Delay(50);Dispose();
    }
    public void Dispose(){if(_disposed)return;_disposed=true;_lifetime.Cancel();_worker.Dispose();_scanner.Dispose();_api?.Dispose();_lifetime.Dispose();_uploadGate.Dispose();}
}
