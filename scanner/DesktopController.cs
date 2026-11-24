using System.Drawing;
using System.Threading.Channels;
using System.Collections.Concurrent;
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
    private readonly PluginMarket _market;
    private readonly bool _selfTest;
    private sealed record Plugin(string Id,string Path);
    private sealed record Preferences(string Driver,string? PluginId,List<Plugin> Plugins,JsonElement? Device);
    private Preferences _prefs = new("Twain",null,[],null);
    private string? Executable()
    {
        if(_driver=="market")return _market.Resolve(_prefs.PluginId??"");
        if(_driver=="Hi5100S")return Path.Combine(AppContext.BaseDirectory,"Hi5100S.exe");
        if(_driver!="external")return null;
        var plugin=_prefs.Plugins.Find(p=>p.Id==_prefs.PluginId);
        if(plugin==null || !File.Exists(plugin.Path))throw new IOException("请重新选择扫描插件程序，当前文件不可用。");
        return plugin.Path;
    }
    private void PersistDevices()=>Save(Path.Combine(_queue.Root,"device-plugins.json"),JsonSerializer.Serialize(_prefs));
    private void Switch(string driver,string? id)
    {
        if(driver is not ("Twain" or "Wia" or "Escl" or "Hi5100S" or "external" or "market"))throw new ArgumentException("驱动接口无效");
        if(driver=="market")_market.KeepSelected(id??"");
        if(driver=="external" && id!=null && !_prefs.Plugins.Any(p=>p.Id==id))throw new ArgumentException("插件未登记");
        if(driver is not ("market" or "external"))id=null;
        if(driver==_driver && id==_prefs.PluginId)return;
        _driver=driver;
        _devices=[];
        _prefs=_prefs with {Driver=driver,PluginId=id,Device=null};
        PersistDevices();
    }
    private string _driver="Twain";
    private readonly SemaphoreSlim _uploadGate=new(1,1);
    private readonly CancellationTokenSource _lifetime=new();
    private readonly ConcurrentDictionary<string,JsonElement> _packages=new();
    private readonly Channel<(BatchRow Batch,PageRow Page)> _recognitionJobs=Channel.CreateUnbounded<(BatchRow,PageRow)>(new UnboundedChannelOptions{SingleReader=true});
    private readonly Task _recognitionTask;
    private int _processingCount;
    private readonly ConcurrentDictionary<string,byte> _queuedPages=new();
    private bool _sessionOpen;
    private readonly List<string> _servers=[];
    public bool Processing=>Volatile.Read(ref _processingCount)>0;
    private JsonElement[] _devices=[];
    private ApiClient? _api;
    private CancellationTokenSource? _captureCancel;
    private Task? _capture;
    private string _server="",_defaultServer="",_project="",_message="";
    private bool _online,_tickRunning,_revoked,_disposed,_connecting;
    public Action<string>? NavigateRequested {get;set;}
    public Action? Changed {get;set;}
    public bool Capturing=>_capture is {IsCompleted:false};
    public string Server=>_server;
    public ScanCaptureSettings ScanSettings {get;private set;}=new();
    public DesktopController(LocalQueue? queue=null,RecognitionWorker? worker=null,bool selfTest=false)
    {
        _queue=queue??new LocalQueue();_worker=worker??new RecognitionWorker(_queue.Root);_selfTest=selfTest;
        _market=new PluginMarket(_queue.Root);
        var path=Path.Combine(_queue.Root,"desktop-settings.json");
        if(File.Exists(path))
        {
            using var saved=JsonDocument.Parse(File.ReadAllText(path));_server=Text(saved.RootElement,"server_url");_project=Text(saved.RootElement,"project_id");
            _defaultServer=Text(saved.RootElement,"default_server_url",_server);
            if(saved.RootElement.TryGetProperty("servers",out var servers))_servers.AddRange(servers.EnumerateArray().Select(v=>v.GetString()!).Where(v=>!string.IsNullOrEmpty(v)));
        }
        var settings=Path.Combine(_queue.Root,"scan-capture-settings.json");
        if(File.Exists(settings))ScanSettings=(JsonSerializer.Deserialize<ScanCaptureSettings>(File.ReadAllText(settings))??new()).Validate();
        var preferences=Path.Combine(_queue.Root,"device-plugins.json");
        if(File.Exists(preferences)){
            _prefs=JsonSerializer.Deserialize<Preferences>(File.ReadAllText(preferences))??_prefs;
            _driver=_prefs.Driver;
            if(_prefs.Device is JsonElement device)_devices=[device];
        }
        LoadPackages();
        _recognitionTask=Task.Run(ProcessRecognition);
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
    private string[] SavedServers=>_servers.Append(_server).Append(_defaultServer).Where(v=>v.Length>0).Distinct().ToArray();
    private bool HasOfflineProjects(string server)
    {
        var partition=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(server))).ToLowerInvariant();
        var folder=Path.Combine(_queue.Root,"workspaces",partition);
        return Directory.Exists(folder)&&Directory.EnumerateFiles(folder,"package.json",SearchOption.AllDirectories).Any();
    }
    private void SaveSettings()=>Save(Path.Combine(_queue.Root,"desktop-settings.json"),JsonSerializer.Serialize(new{server_url=_server,default_server_url=_defaultServer,project_id=_project,servers=SavedServers}));
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
    private void Freeze(BatchRow batch,string message){_queue.BatchStatus(batch.Id,"frozen",message);Notify(message);}

    private object State(JsonElement args)
    {
        var selected=Text(args,"batch_id");var batches=_queue.Batches().Where(b=>b.ServerUrl==_server&&b.ProjectId==_project).ToArray();
        var batch=batches.FirstOrDefault(b=>b.Id==selected);
        var counts=_queue.Counts();
        var offset=args.TryGetProperty("offset",out var start)?Math.Max(0,start.GetInt32()):0;
        var roomScope=Text(args,"page_scope")=="room";
        var visible=batch is null?[]:roomScope?batches.Where(b=>b.GroupId==batch.GroupId&&RoomKey(b)==RoomKey(batch)).OrderBy(b=>b.CreatedAt).ToArray():[batch];
        if(roomScope&&args.TryGetProperty("run",out var run)&&run.ValueKind==JsonValueKind.Object)
        {
            var anchor=Text(run,"anchorId");
            var prior=run.GetProperty("previousIds").EnumerateArray().Select(v=>v.GetString()).ToHashSet();
            visible=visible.Where(b=>b.Id==anchor||!prior.Contains(b.Id)).ToArray();
        }
        var displayed=new List<(BatchRow Batch,PageRow Page,int Number)>();
        var total=0;var sheetOffset=0;
        foreach(var entry in visible)
        {
            var count=counts.GetValueOrDefault(entry.Id);
            var from=Math.Max(0,offset-total);var take=Math.Min(count.Total,offset+50-total)-from;
            if(take>0)displayed.AddRange(_queue.Pages(entry.Id).Skip(from).Take(take).Select(p=>(entry,p,sheetOffset+p.Sequence)));
            total+=count.Total;sheetOffset+=Math.Max(count.Front,count.Back);
        }
        var projects=_packages.Values.Select(p=>new{id=Text(p.GetProperty("project"),"id"),name=Text(p.GetProperty("project"),"name"),exam_status=Text(p.GetProperty("project"),"exam_status","in_progress"),downloaded_at=Text(p,"downloaded_at")}).ToArray();
        var catalogPath=Path.Combine(_queue.Root,"workspaces",Partition,"catalog.json");
        return new{device_preferences=new{market=_market.View(),driver=_driver,plugins=_prefs.Plugins.Select(p=>new{id=p.Id,name=Path.GetFileName(p.Path),available=File.Exists(p.Path)}),plugin_id=_prefs.PluginId,device=_prefs.Device,devices=_devices},review_edit=true,room_review=true,manual_room_upload=true,device_protocol=DevicePlugin.Protocol,scan_settings=CaptureSettingsView(),protocol=Protocol,server_url=_server,default_server_url=_defaultServer,storage_path=_queue.Root,servers=SavedServers,cached_servers=SavedServers.Where(HasOfflineProjects).ToArray(),session_open=_sessionOpen,online=_online,capturing=Capturing,processing=Processing,processing_remaining=Volatile.Read(ref _processingCount),syncing=_uploadGate.CurrentCount==0,message=_message,project_id=_project,
            projects,catalog=File.Exists(catalogPath)?Json(File.ReadAllText(catalogPath)):Json("{\"projects\":[]}"),
            package=_packages.TryGetValue(_project,out var package)?package:Json("null"),
            batches=batches.Select(b=>{
                var captured=counts.GetValueOrDefault(b.Id);
                return new{id=b.Id,name=b.Label,subject_id=b.SubjectId,group_id=b.GroupId,room=b.Room,room_tags=JsonSerializer.Deserialize<JsonElement>(b.RoomTagsJson),status=b.Status,error=b.Error,capture_mode=b.CaptureMode,back_order=b.BackOrder,paper=b.Paper,sides=b.Sides,created_at=b.CreatedAt,
                    scanned_sheets=captured.Scanned,paired_sheets=Json(b.LocalPairsJson).GetArrayLength(),
                    total=captured.Total,front_count=captured.Front,back_count=captured.Back,pending=captured.Pending,blocked=captured.Blocked,uploaded=captured.Uploaded};
            }),
            room_pages=roomScope,page_total=total,pages=displayed.Select(v=>new{id=v.Page.CaptureId,batch_id=v.Batch.Id,batch_status=v.Batch.Status,sheet_number=v.Number,sequence=v.Page.Sequence,side=v.Page.Side,status=v.Page.Status,error=v.Page.Error,candidate=v.Page.RecognitionJson=="{}"?"":Text(Json(v.Page.RecognitionJson),"candidate_number"),quality=v.Page.QualitySummary,recognized=v.Page.RecognitionJson!="{}",local_cut_available=File.Exists(Path.Combine(_queue.Root,"processed",v.Page.CaptureId,"cuts.zip"))})};
    }

    private object CaptureSettingsView() => new { dpi = ScanSettings.Dpi, color = ScanSettings.Color, jpeg_quality = ScanSettings.JpegQuality };

    private async Task<object> JpegEstimate(JsonElement args)
    {
        var quality = ScanCaptureSettings.CheckJpegQuality(args.GetProperty("quality").GetInt32());
        var batchId = Text(args, "batch_id");
        var selected = batchId.Length == 0 ? null : Batch(batchId);
        if (selected != null && selected.ProjectId != _project) throw new ArgumentException("批次不属于当前项目。");
        var paper = selected?.Paper ?? Text(args, "paper", "A4");
        if (paper is not ("A3" or "A4")) throw new ArgumentException("请选择 A3 或 A4 纸型。");
        var sample = _queue.LatestJpegSample(_server, _project, selected?.GroupId ?? Text(args, "group_id"),
            selected?.TemplateId ?? Text(args, "template_id"), batchId);
        var estimate = await _worker.EstimateUpload(sample, paper, quality, _lifetime.Token);
        if (estimate.GetProperty("quality").GetInt32() != quality) throw new InvalidDataException("识读引擎返回了不同的 JPEG 质量。");
        return new { size = estimate.GetProperty("size").GetInt64(), quality, source = sample is null ? "reference" : "scan", paper = sample?.Paper ?? paper };
    }

    public async Task<object?> Invoke(string method,JsonElement args)
    {
        if(Processing&&method is "clearRoom" or "correctAnswer" or "retryPage" or "exclude" or "upload" or "sendForReview" or "downloadProject")
            throw new InvalidOperationException("后台正在识读已采集的页面，请等待识读完成。");
        switch(method)
        {
            case "scanSettings":
                var hasDpi = args.TryGetProperty("dpi", out var dpi);
                var hasQuality = args.TryGetProperty("jpeg_quality", out var jpegQuality);
                if(hasDpi || hasQuality || args.TryGetProperty("color", out _)){
                    if(Capturing)throw new InvalidOperationException("请先停止采集");
                    var settings = new ScanCaptureSettings(hasDpi ? dpi.GetInt32() : ScanSettings.Dpi,
                        Text(args,"color",ScanSettings.Color), hasQuality ? jpegQuality.GetInt32() : ScanSettings.JpegQuality).Validate();
                    Save(Path.Combine(_queue.Root,"scan-capture-settings.json"),JsonSerializer.Serialize(settings));
                    ScanSettings = settings;
                }
                return CaptureSettingsView();
            case "jpegEstimate": return await JpegEstimate(args);
            case "state":return State(args);
            case "clearRoom":
                if(Capturing||_tickRunning||_uploadGate.CurrentCount==0)throw new InvalidOperationException("请先停止进纸，并等待上传完成。");
                var clearScope=Batch(Text(args,"batch_id"));
                var oldSheets=RoomSheets(clearScope);
                var oldIds=oldSheets.Select(b=>b.Id).OrderBy(id=>id).ToArray();
                var oldPages=oldSheets.SelectMany(b=>_queue.Pages(b.Id)).ToArray();
                var clearSignature=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join(",",oldIds)+"|"+string.Join(",",oldPages.Select(p=>p.CaptureId+":"+p.Status).OrderBy(id=>id)))));
                if(!args.TryGetProperty("confirm",out var confirmedClear)||confirmedClear.ValueKind!=JsonValueKind.True)
                    return new{pages=oldPages.Length,pending=oldPages.Count(p=>p.Status is not ("uploaded" or "excluded")),signature=clearSignature};
                if(Text(args,"signature")!=clearSignature)throw new InvalidOperationException("扫描记录已变化，请重新确认清理范围。");
                var filesRemoved=_queue.ClearLocalSheets(oldSheets);
                Notify(filesRemoved?"本地旧扫描记录及图片已清理，可以开始新扫描。":"本地扫描记录已清理，部分占用文件将在下次清理时重试。");
                return new{cleared=true,files_removed=filesRemoved};

            case "setDefaultServer":
                using(var savedServer=new ApiClient(Text(args,"server_url")))
                {
                    _defaultServer=savedServer.ServerUrl;
                    SaveSettings();
                }
                return State(args);
            case "enterOffline":
                if(Text(args,"server_url").Length>0&&Text(args,"server_url")!=_server)
                {
                    if(Capturing||Processing||_tickRunning||_uploadGate.CurrentCount==0)throw new InvalidOperationException("请等待当前扫描和上传结束后再切换服务器。");
                    using var offlineServer=new ApiClient(Text(args,"server_url"));
                    _server=offlineServer.ServerUrl;_online=false;_api?.Dispose();_api=null;LoadPackages();SaveSettings();
                }
                if(_packages.IsEmpty)throw new InvalidOperationException("请先连接服务器并下载项目。");
                _sessionOpen=true;ResumeRecognition();return State(args);
            case "connect":
                if(_connecting)throw new InvalidOperationException("正在连接服务器，请稍后重试。");
                _connecting=true;
                try
                {
                if(Capturing||Processing||_tickRunning)throw new InvalidOperationException("正在采集、识读或同步，请完成后再切换连接。");
                using(var validate=new ApiClient(Text(args,"server_url")))
                {
                if(_server.Length>0&&!_servers.Contains(_server))_servers.Add(_server);
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
                if(_defaultServer.Length==0||args.TryGetProperty("set_default",out var defaultServer)&&defaultServer.ValueKind==JsonValueKind.True)_defaultServer=_server;
                SaveSettings();
                _online=true;_sessionOpen=true;ResumeRecognition();Notify("设备已连接。选择考试项目并下载配置。");return new{page_url=PageUrl()};
                }
                finally{_connecting=false;}
            case "refreshCatalog":
                if(!_online||_api is null)throw new InvalidOperationException("请先连接服务器。");
                var refreshed=await _api.Get("scanner/catalog",_lifetime.Token);
                Save(Path.Combine(_queue.Root,"workspaces",Partition,"catalog.json"),refreshed.GetRawText());
                Notify("项目状态已更新。");return State(args);
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
                var gradeId=Text(selected,"grade_id");
                if(gradeId.Length>0&&tags.Length>0&&(tags.Length!=1||Text(tags[0],"group_id")!=created.GroupId||Text(tags[0],"grade_id")!=gradeId||tags[0].TryGetProperty("archived",out var stopped)&&stopped.GetBoolean()))
                    throw new InvalidOperationException("请选择当前题卡组年级下的一个有效考场，并刷新项目配置。");
                created.RoomTagsJson=JsonSerializer.Serialize(tags);
                Bind(created,_project,selected);_queue.AddBatch(created);_queue.SaveDesktopBatch(created);return new{id=created.Id};
            case "marketRefresh":
                await _market.Fetch(null,_lifetime.Token);
                return true;
            case "marketInstall":
                await _market.Fetch(Text(args,"hash"),_lifetime.Token);
                return true;
            case "marketRemove":
                if(Capturing)throw new InvalidOperationException("请先停止采集");
                var hash=Text(args,"hash");
                if(_driver=="market" && _prefs.PluginId==hash)throw new InvalidOperationException("请先切换扫描插件。");
                _market.Remove(hash);
                return true;
            case "choosePlugin":
                if(Capturing)throw new InvalidOperationException("请先停止采集");
                var picker=new FileDialog{Filter="扫描设备插件|*.exe"};
                if(picker.ShowDialog()!=true)return null;
                var plugin=_prefs.Plugins.Find(p=>string.Equals(p.Path,picker.FileName,StringComparison.OrdinalIgnoreCase));
                if(plugin==null){
                    plugin=new Plugin(Guid.NewGuid().ToString("N"),picker.FileName);
                    _prefs.Plugins.Add(plugin);
                }
                Switch("external",plugin.Id);
                return new{name=Path.GetFileName(plugin.Path)};
            case "selectDriver":
                if(Capturing)throw new InvalidOperationException("请先停止采集");
                var nextDriver=Text(args,"driver");
                var key=Text(args,"plugin_id",nextDriver==_driver?_prefs.PluginId??"":"");
                Switch(nextDriver,key.Length==0?null:key);
                return true;
            case "forgetPlugin":
                if(Capturing)throw new InvalidOperationException("请先停止采集");
                _prefs.Plugins.RemoveAll(p=>p.Id==_prefs.PluginId);
                Switch("Twain",null);
                return true;
            case "selectDevice":
                if(Capturing)throw new InvalidOperationException("请先停止采集");
                var choice=_devices.FirstOrDefault(d=>Text(d,"id")==Text(args,"id"));
                if(choice.ValueKind!=JsonValueKind.Object)throw new ArgumentException("请选择已发现的扫描仪");
                _prefs=_prefs with {Device=choice};PersistDevices();
                return true;
            case "devices":
                if(Capturing)throw new InvalidOperationException("请先停止采集");
                Switch(Text(args,"driver",_driver),_prefs.PluginId);
                var executable=Executable();
                _devices=[];
                using(var timeout=CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token)){
                    timeout.CancelAfter(TimeSpan.FromSeconds(60));
                    await DevicePlugin.Run(executable,new{protocol=DevicePlugin.Protocol,command="devices",driver=_driver},msg=>{
                        _devices=msg.GetProperty("devices").EnumerateArray().Select(d=>d.Clone()).ToArray();return Task.CompletedTask;
                    },timeout.Token);
                }
                var savedId=_prefs.Device is JsonElement old ? Text(old,"id") : "";
                var match=_devices.FirstOrDefault(d=>Text(d,"id")==savedId);
                _prefs=_prefs with {Device=match.ValueKind==JsonValueKind.Object?match:_devices.Length==1?_devices[0]:null};
                PersistDevices();
                return _devices;
            case "start":
                if(Capturing)throw new InvalidOperationException("扫描正在进行。");
                var scanBatch=Batch(Text(args,"batch_id"));CheckCapture(scanBatch);
                var deviceId=Text(args,"device_id");
                if(!_devices.Any(d=>Text(d,"id")==deviceId))throw new InvalidOperationException("请先发现并选择扫描仪。");
                var side=scanBatch.CaptureMode=="duplex"?"auto":Text(args,"side","front");
                _captureCancel=CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
                _capture=Capture(scanBatch,async receive=>await DevicePlugin.Acquire(Executable(),_driver,deviceId,scanBatch.Paper,scanBatch.CaptureMode=="duplex",ScanSettings,receive,_captureCancel.Token),side);Notify();return new{started=true};
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
            case "pair":var pairBatch=Batch(Text(args,"batch_id"));if(Capturing)throw new InvalidOperationException("请先停止采集再确认批次。");_queue.PairLocally(pairBatch);Notify("本地配页完成，等待上传。");return new{paired=true};
            case "correctAnswer":return CorrectAnswer(args);
            case "pageReview":return RoomReview(Batch(Text(args,"batch_id")),single:true);
            case "roomReview":return RoomReview(Batch(Text(args,"batch_id")));
            case "upload":
                var scope=Batch(Text(args,"batch_id"));
                if(Capturing||_connecting||_tickRunning)throw new InvalidOperationException("请等待当前操作完成。");
                var roomSheets=RoomSheets(scope);
                if(roomSheets.Any(b=>b.Status=="frozen"||b.Status=="open"&&_queue.Pages(b.Id).Any(p=>p.Status!="excluded")))
                    throw new InvalidOperationException("请先核对本考场的异常或未完成答卷。");
                var ready=roomSheets.Where(b=>b.Status=="local_paired").ToArray();
                if(ready.Length==0)throw new InvalidOperationException("本考场暂无待上传答卷。");
                _ = UploadRoom(ready);return new{started=true};
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
                if(Capturing || _uploadGate.CurrentCount==0)throw new InvalidOperationException("请等待当前采集或上传完成。");
                var retryBatch=Batch(Text(args,"batch_id"));var retryPage=_queue.Pages(retryBatch.Id).First(p=>p.CaptureId==Text(args,"page_id"));
                if(retryPage.Status is "uploaded" or "excluded" || retryBatch.Status=="paired" ||
                   retryBatch.Error.StartsWith("原图已送交") || retryBatch.Error.StartsWith("同步被服务器拒绝"))
                    throw new InvalidOperationException("此页请通过异常核查处理。");
                var quality=JsonSerializer.Deserialize<QualityReport>(retryPage.QualityJson,new JsonSerializerOptions{PropertyNameCaseInsensitive=true});
                if(quality?.Issues is ["missing_markers"] && retryPage.Status=="blocked")
                {
                    quality=await Task.Run(()=>{
                        using var image=Image.FromFile(retryPage.Path);
                        return QualityInspector.Inspect(image,retryBatch,retryPage.Side,quality.Options);
                    },_lifetime.Token);
                    _queue.UpdateQualityReport(retryPage.CaptureId,quality);
                    if(!quality.Passed){
                        _queue.PageError(retryPage.CaptureId,quality.Summary,true);
                        Freeze(retryBatch,quality.Summary);
                        throw new InvalidOperationException(quality.Summary);
                    }
                }
                if(quality?.Passed!=true)throw new InvalidOperationException("该页未通过采集质量检查，请排除整张后重扫，或在管理端核查原卷。");
                if(Json(retryPage.RecognitionJson).TryGetProperty("operator_correction",out _))
                    throw new InvalidOperationException("已人工更正的答卷请在核对界面编辑。");
                await Recognize(retryBatch,retryPage);
                if(!_queue.Pages(retryBatch.Id).Any(p=>p.Status=="blocked")){
                    try{_queue.PairLocally(retryBatch);}
                    catch(InvalidOperationException error){Freeze(retryBatch,error.Message);throw;}
                }
                return State(args);
            case "exclude":
                if(Capturing)throw new InvalidOperationException("请先停止采集。");
                var excludeBatch=Batch(Text(args,"batch_id"));if(excludeBatch.Status=="paired")throw new InvalidOperationException("批次已提交，请在管理端处理补扫。");
                var excludePage=_queue.Pages(excludeBatch.Id).First(p=>p.CaptureId==Text(args,"page_id"));
                foreach(var page in _queue.Pages(excludeBatch.Id).Where(p=>excludeBatch.CaptureMode=="duplex"?p.Sequence==excludePage.Sequence:p.CaptureId==excludePage.CaptureId))_queue.PageExcluded(page.CaptureId);
                _queue.BatchStatus(excludeBatch.Id,"open");Notify("原图已保留，请整张重扫。");return State(args);
            case "originalPage":
                var original=_queue.Pages(Batch(Text(args,"batch_id")).Id).Single(p=>p.CaptureId==Text(args,"page_id"));
                var correctedPath=Path.Combine(_queue.Root,"processed",original.CaptureId,"normalized.png");
                bool corrected=Text(args,"view")=="corrected" && original.RecognitionJson!="{}" && File.Exists(correctedPath);
                var path=corrected?correctedPath:original.Path;
                var mime=Path.GetExtension(path)==".png"?"image/png":"image/jpeg";
                return new{url=$"data:{mime};base64,"+Convert.ToBase64String(await File.ReadAllBytesAsync(path)),corrected};
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
    private string? CandidateIssue(BatchRow batch,string candidate)
    {
        if(candidate.Length==0||candidate.Contains('?'))return "准考证号未填清，请核对原图。";
        var group=_packages[batch.ProjectId].GetProperty("groups").EnumerateArray().First(g=>Text(g,"id")==batch.GroupId);
        if(group.TryGetProperty("roster",out var roster)&&roster.ValueKind==JsonValueKind.Array){
            if(roster.GetArrayLength()==0)return "题卡应考名单为空，请在后台设置名单后重新下载项目，再重试本地识读。";
            if(!roster.EnumerateArray().Any(s=>Text(s,"candidate_number")==candidate))return "准考证号不在当前题卡应考名单中，请核对名单或原图。";
        }
        if((group.TryGetProperty("confirmed_candidates",out var known)&&known.EnumerateArray().Any(s=>s.GetString()==candidate))||
            _queue.Batches().Where(b=>b.Id!=batch.Id&&b.ServerUrl==batch.ServerUrl&&b.GroupId==batch.GroupId&&(b.Status=="local_paired"||b.Status=="paired")).Any(b=>Json(b.LocalPairsJson).EnumerateArray().Any(pair=>Text(pair,"candidate_number")==candidate)))
            return "已扫描此准考证号，请核对原图";
        return null;
    }
    private async Task Recognize(BatchRow batch,PageRow page)
    {
        string? issue;
        try{
            var result=await _worker.Recognize(batch,page,_lifetime.Token);
            issue=page.Side=="front"?CandidateIssue(batch,Text(result,"candidate_number")):null;
            _queue.PageRecognized(page.CaptureId,result.GetRawText(),issue);
        }
        catch(Exception error)when(error is not (OutOfMemoryException or OperationCanceledException)){
            _queue.PageError(page.CaptureId,error.Message,true);Freeze(batch,error.Message);throw;
        }
        if(issue!=null){Freeze(batch,issue);throw new InvalidOperationException(issue);}
        Notify();
    }
    private void ResumeRecognition()
    {
        foreach(var pending in _queue.Batches().Where(b=>b.ServerUrl==_server&&_packages.ContainsKey(b.ProjectId)).OrderBy(b=>b.CreatedAt))
            foreach(var page in _queue.Pages(pending.Id).Where(p=>p.Status=="pending"&&p.RecognitionJson=="{}").OrderBy(p=>p.Sequence).ThenByDescending(p=>p.Side=="front"))
                EnqueueRecognition(pending,page);
        foreach(var pending in _queue.Batches().Where(b=>b.ServerUrl==_server&&b.Status=="open"&&_packages.ContainsKey(b.ProjectId)))
            TryPairRecognized(pending);
    }

    private void TryPairRecognized(BatchRow batch)
    {
        if(batch.Sides!=1&&batch.CaptureMode!="duplex")return;
        var pages=_queue.Pages(batch.Id).Where(p=>p.Status!="excluded").ToArray();
        if(pages.Length==batch.Sides&&pages.All(p=>p.Status=="pending"&&p.RecognitionJson!="{}"))
        {
            try{_queue.PairLocally(batch);}
            catch(InvalidOperationException error){Freeze(batch,error.Message);}
        }
    }

    private void EnqueueRecognition(BatchRow batch,PageRow page)
    {
        if(!_queuedPages.TryAdd(page.CaptureId,0))return;
        Interlocked.Increment(ref _processingCount);
        if(!_recognitionJobs.Writer.TryWrite((batch,page))){_queuedPages.TryRemove(page.CaptureId,out _);Interlocked.Decrement(ref _processingCount);}
    }

    private async Task ProcessRecognition()
    {
        try
        {
            await foreach(var job in _recognitionJobs.Reader.ReadAllAsync(_lifetime.Token))
            {
                var batch=job.Batch;var page=job.Page;
                try
                {
                    using(var image=Image.FromFile(page.Path))
                    {
                        var report=QualityInspector.Inspect(image,batch,page.Side,QualityOptions.Load(_queue.Root));
                        if(new FileInfo(page.Path).Length>160*1024*1024)report=report with{Issues=[..report.Issues,"too_large"]};
                        _queue.SaveQuality(page.CaptureId,report);
                        if(!report.Passed){_queue.PageError(page.CaptureId,report.Summary,true);Freeze(batch,report.Summary);continue;}
                    }
                    await Recognize(batch,page);
                    TryPairRecognized(batch);
                }
                catch(OperationCanceledException)when(_lifetime.IsCancellationRequested){throw;}
                catch(Exception error)when(error is not OutOfMemoryException)
                {
                    _queue.PageError(page.CaptureId,error.Message,true);Freeze(batch,error.Message);
                }
                finally
                {
                    _queuedPages.TryRemove(page.CaptureId,out _);
                    var remaining=Interlocked.Decrement(ref _processingCount);
                    if(remaining==0&&!_lifetime.IsCancellationRequested)
                        Notify(Capturing?"已收图像均已识读，等待后续图像。":"本地识读完成，请核对考号、缺考标记及待处理页面。");
                    else Notify();
                }
            }
        }
        catch(OperationCanceledException)when(_lifetime.IsCancellationRequested){}
    }

    internal async Task Capture(BatchRow batch,Func<Func<Image,Task>,Task> acquire,string side)
    {
        _captureCancel??=new CancellationTokenSource();
        var collected=0;
        var expected=batch.Sides==2&&batch.CaptureMode=="duplex"?2:1;
        var session=batch;
        try
        {
            await Task.Yield();
            await acquire(async image=>
            {
                _captureCancel.Token.ThrowIfCancellationRequested();
                if(collected==expected&&(batch.Sides==1||batch.CaptureMode=="duplex"))
                {
                    session=JsonSerializer.Deserialize<BatchRow>(JsonSerializer.Serialize(batch))!;
                    session.Id=Guid.NewGuid().ToString();session.Status="open";session.Error="";session.LocalPairsJson="[]";
                    _queue.AddBatch(session);_queue.SaveDesktopBatch(session);collected=0;
                }
                var page=await Task.Run(()=>_queue.AddPage(session,side,image,deferInspection:true,jpegQuality:ScanSettings.JpegQuality),_lifetime.Token);
                collected++;
                EnqueueRecognition(session,page);
                Notify("图像已保存在本机，后台识读中。");
            });
            Notify(Processing?"进纸已结束，正在完成后台识读。":"采集完成，答卷已保存在本机。");
        }
        catch(OperationCanceledException){Notify("进纸已停止，已采集页面继续在后台识读。");}
        catch(Exception error)when(error is not OutOfMemoryException){Notify(error.Message);}
        finally
        {
            if(collected>0&&collected<expected)_queue.BatchStatus(session.Id,"frozen","双面缺页，请核对原图");
            _captureCancel?.Dispose();_captureCancel=null;Changed?.Invoke();
        }
    }

    private async Task UploadRoom(BatchRow[] sheets)
    {
        try{await Tick(sheets);}
        catch(Exception error)when(error is not OutOfMemoryException){Notify("上传暂停："+error.Message);}
    }

    private BatchRow[] RoomSheets(BatchRow scope)=>_queue.Batches().Where(b=>b.ServerUrl==_server&&b.ProjectId==scope.ProjectId&&b.GroupId==scope.GroupId&&RoomKey(b)==RoomKey(scope)).ToArray();
    private object CorrectAnswer(JsonElement args)
    {
        if(Capturing||_tickRunning||_revoked)throw new InvalidOperationException("当前无法编辑，请稍后再试。");
        var sheet=Batch(Text(args,"batch_id"));
        var page=_queue.Pages(sheet.Id).Single(p=>p.CaptureId==Text(args,"page_id")&&p.Side=="front");
        if(sheet.Status=="paired"||page.Status is "uploaded" or "excluded"||page.RecognitionJson=="{}"||
            sheet.Status=="frozen"&&(sheet.Error.StartsWith("同步被服务器拒绝")||sheet.Error.StartsWith("原图已送交")))
            throw new InvalidOperationException("此页请通过异常核查处理。");
        var group=_packages[sheet.ProjectId].GetProperty("groups").EnumerateArray().Single(g=>Text(g,"id")==sheet.GroupId);
        var number=Text(args,"candidate_number").Trim();
        if(group.GetProperty("frozen").GetBoolean()||number.Length!=Json(sheet.TemplateJson).GetProperty("candidate_length").GetInt32()||
            number.Any(c=>c<'0'||c>'9')||group.GetProperty("roster").ValueKind!=JsonValueKind.Array||
            !group.GetProperty("roster").EnumerateArray().Any(s=>Text(s,"candidate_number")==number))
            throw new InvalidOperationException("请填写当前题卡应考名单中的准考证号。");
        if(group.GetProperty("confirmed_candidates").EnumerateArray().Any(n=>n.GetString()==number)||
            _queue.Batches().Where(b=>b.ServerUrl==sheet.ServerUrl&&b.GroupId==sheet.GroupId).Any(b=>_queue.Pages(b.Id).Any(p=>p.Side=="front"&&p.Status!="excluded"&&p.CaptureId!=page.CaptureId&&Text(Json(p.RecognitionJson),"candidate_number")==number)))
            throw new InvalidOperationException("本题卡已有相同准考证号的答卷。");
        var data=JsonSerializer.Deserialize<Dictionary<string,JsonElement>>(page.RecognitionJson)!;
        if(!data.ContainsKey("operator_correction"))data["operator_correction"]=JsonSerializer.SerializeToElement(new{original_number=data["candidate_number"],original_absent=data["absent_mark"]});
        data["candidate_number"]=JsonSerializer.SerializeToElement(number);
        data["absent_mark"]=JsonSerializer.SerializeToElement(args.GetProperty("absent").GetBoolean());
        data["absence_layout_known"]=JsonSerializer.SerializeToElement(true);
        _queue.SaveCorrection(sheet,page,JsonSerializer.Serialize(data));Notify("更正已保存在本机。");
        return RoomReview(sheet);
    }

    private object RoomReview(BatchRow scope,bool single=false)
    {
        var rows=new List<object>();
        foreach(var sheet in single?new[]{scope}:RoomSheets(scope))
        {
            var pages=_queue.Pages(sheet.Id).Where(p=>p.Status!="excluded").ToDictionary(p=>p.CaptureId);
            void Add(IEnumerable<PageRow> answer)
            {
                var sides=answer.OrderByDescending(p=>p.Side=="front").ToArray();
                if(sides.Length==0)return;
                var front=sides.FirstOrDefault(p=>p.Side=="front");
                var read=Json(front?.RecognitionJson??"{}");
                bool? absent=read.TryGetProperty("absence_layout_known",out var known)&&known.ValueKind==JsonValueKind.True&&read.TryGetProperty("absent_mark",out var mark)&&mark.ValueKind is JsonValueKind.True or JsonValueKind.False?mark.GetBoolean():null;
                rows.Add(new{id=sides[0].CaptureId,batch_id=sheet.Id,candidate=Text(read,"candidate_number"),absent,status=sheet.Status,editable=front is not null&&front.RecognitionJson!="{}"&&front.Status is "pending" or "blocked"&&sheet.Status!="paired",
                    sides=sides.Select(p=>new{id=p.CaptureId,side=p.Side,sequence=p.Sequence,status=p.Status,error=p.Error}).ToArray()});
            }
            foreach(var pair in Json(sheet.LocalPairsJson).EnumerateArray()){
                var answer=new List<PageRow>();
                foreach(var id in pair.GetProperty("pages").EnumerateArray())
                    if(pages.Remove(id.GetString()!,out var page))answer.Add(page);
                Add(answer);
            }
            foreach(var sequence in pages.Values.GroupBy(p=>p.Sequence))Add(sequence);
        }
        return rows;
    }

    private static string RoomKey(BatchRow sheet)=>string.Join(",",Json(sheet.RoomTagsJson).EnumerateArray().Select(tag=>Text(tag,"id")).OrderBy(id=>id));
    public Task Tick()=>Tick(null);
    private async Task Tick(BatchRow[]? requested)
    {
        if(_connecting||_tickRunning||_disposed||string.IsNullOrEmpty(_server)||requested is null&&!_sessionOpen)return;_tickRunning=true;
        try
        {
            if(_api?.LoggedIn!=true||!_online)
            {
                _api??=Api(_server);using var timeout=CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);timeout.CancelAfter(TimeSpan.FromSeconds(6));
                try{await _api.ConnectDevice(timeout.Token);_online=true;_revoked=false;}
                catch(ApiException error)when(error.StatusCode==403){_revoked=true;_online=false;_captureCancel?.Cancel();if(requested is not null)throw;return;}
                catch(Exception error)when(error is not OutOfMemoryException){_online=false;if(requested is not null)throw new InvalidOperationException("暂时无法连接服务器，本地数据保留。",error);return;}
            }
            if(requested is null)return;
            if(!await _uploadGate.WaitAsync(0,_lifetime.Token))return;
            try
            {
                Notify("正在上传已核对的答卷。");
                foreach(var batch in requested)
                {
                    var pages=_queue.Pages(batch.Id);
                    if(!pages.Any(p=>p.Status=="pending"&&p.RecognitionJson!="{}")&&batch.Status!="local_paired")continue;
                    try
                    {
                        var registered=await _api.RegisterBatch(batch,_lifetime.Token);
                        if(Text(registered,"status")=="paired"){_queue.BatchStatus(batch.Id,"paired");continue;}
                        var excluded=pages.Where(p=>p.Status=="excluded").ToArray();
                        foreach(var page in excluded)await _api.Post($"scanner/batches/{batch.Id}/exclude",new{page_ids=new[]{page.CaptureId},reason="操作员排除页面并保留本地原图"},_lifetime.Token);
                        Dictionary<string,JsonElement>? previousUploads = null;
                        foreach(var page in pages.Where(p=>p.Status=="pending"&&p.RecognitionJson!="{}"))
                        {
                            JsonElement? legacyRemote = null;
                            if (page.LegacyJpeg && page.UploadSha256.Length == 0 && File.Exists(SheetPath(page)))
                            {
                                // An older client may have lost the HTTP response after its Q80 file was accepted.
                                previousUploads ??= (await _api.Get($"scan-batches/{batch.Id}/pages", _lifetime.Token))
                                    .EnumerateArray().ToDictionary(row => Text(row, "id"));
                                if (previousUploads.TryGetValue(page.CaptureId, out var remote)) legacyRemote = remote;
                            }
                            var sheet=await PrepareSheet(page, legacyRemote);
                            var accepted=await _api.UploadProcessed(page,_queue.Root,sheet,_lifetime.Token);ApplyRemote(page,accepted);Notify();
                        }
                        if(batch.Status=="local_paired"&&_queue.Pages(batch.Id).All(p=>p.Status is "uploaded" or "excluded"))
                        {
                            await _api.Post($"scan-batches/{batch.Id}/pair",new{local_pairs=Json(batch.LocalPairsJson)},_lifetime.Token);_queue.BatchStatus(batch.Id,"paired");Notify("批次已同步并由服务器确认。");
                        }
                    }
                    catch(ApiException error)when(error.StatusCode is 403 or 404 or 409 or 422){if(error.StatusCode==403){_revoked=true;_captureCancel?.Cancel();}Freeze(batch,"同步被服务器拒绝："+error.Message);throw;}
                }
            }
            finally{_uploadGate.Release();}
        }
        catch(OperationCanceledException)when(_lifetime.IsCancellationRequested){ }
        catch(Exception error)when(error is not OutOfMemoryException){_online=false;Notify("上传暂停，本地队列保留："+error.Message);if(requested is not null)throw;}
        finally{_tickRunning=false;Changed?.Invoke();}
    }

    private string SheetPath(PageRow page) => Path.Combine(_queue.Root, "processed", page.CaptureId, "sheet.jpg");

    private async Task<JsonElement> PrepareSheet(PageRow page, JsonElement? legacyRemote)
    {
        var normalized = Json(page.RecognitionJson).GetProperty("normalized_sha256").GetString()
            ?? throw new InvalidDataException("缺少本地校正图校验值。");
        string expected = page.UploadSha256;
        if (expected.Length > 0 && page.UploadNormalizedSha256 != normalized)
            throw new InvalidDataException("校正图已变更，请核对已准备上传的答卷。");
        if (legacyRemote is JsonElement remote)
        {
            if (Text(remote, "upload_format") != "jpeg-sheet-1" || Text(remote, "sha256") != page.Sha256 ||
                Text(remote, "batch_id") != page.BatchId || Text(remote, "side") != page.Side ||
                remote.GetProperty("sequence").GetInt32() != page.Sequence)
                throw new InvalidDataException("服务器中的页面与本地记录不一致，请核查批次。");
            expected = Text(remote, "normalized_sha256");
            if (expected.Length != 64) throw new InvalidDataException("服务器缺少已接收 JPEG 的校验值。");
        }
        if (expected.Length > 0 && File.Exists(SheetPath(page)))
        {
            using var file = File.OpenRead(SheetPath(page));
            var hash = Convert.ToHexString(await SHA256.HashDataAsync(file, _lifetime.Token)).ToLowerInvariant();
            if (hash == expected)
            {
                if (page.UploadSha256.Length == 0) _queue.PinUpload(page, normalized, hash);
                return JsonSerializer.SerializeToElement(new { sha256 = hash });
            }
        }
        var sheet = await _worker.PrepareUpload(page, _lifetime.Token);
        var jpeg = Text(sheet, "sha256");
        if (sheet.GetProperty("quality").GetInt32() != page.JpegQuality || jpeg.Length != 64 ||
            (expected.Length > 0 && jpeg != expected))
            throw new InvalidDataException("生成的 JPEG 与本页已固定的上传设置或校验值不一致。");
        _queue.PinUpload(page, normalized, jpeg);
        return sheet;
    }

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
        if(remote.TryGetProperty("group_frozen",out var frozen)&&frozen.GetBoolean())throw new InvalidOperationException("成绩已发布。如需补扫，请联系系统管理员或管理教师，在管理后台打开该题卡的「成绩」，点击「发起成绩复核」。");
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
        _captureCancel?.Cancel();if(_capture is not null)await _capture;_lifetime.Cancel();_recognitionJobs.Writer.TryComplete();await _recognitionTask;
        while(_tickRunning)await Task.Delay(50);Dispose();
    }
    public void Dispose(){if(_disposed)return;_disposed=true;_lifetime.Cancel();_worker.Dispose();_api?.Dispose();_lifetime.Dispose();_uploadGate.Dispose();}
}
