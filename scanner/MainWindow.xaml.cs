using System.ComponentModel;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using NAPS2.Scan;
using MessageBox = System.Windows.MessageBox;

namespace OMP.Scanner;

public partial class MainWindow : Window
{
    private readonly LocalQueue _queue = new();
    private readonly ScannerService _scanner = new();
    private readonly SemaphoreSlim _uploadLock = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly DispatcherTimer _retryTimer = new() { Interval = TimeSpan.FromSeconds(8) };
    private ApiClient? _api;
    private CancellationTokenSource? _captureCancel;
    private Task? _captureTask;
    private Task? _uploadTask;
    private bool _busy;
    private bool _closing;
    private bool _closedReady;
    private BatchRow? CurrentBatch => BatchesBox.SelectedItem as BatchRow;

    public MainWindow()
    {
        InitializeComponent();
        StorageText.Text = "本地页面与持久队列：" + _queue.Root;
        LoadBatches();
        _retryTimer.Tick += async (_, _) =>
        {
            if (_api?.LoggedIn == true && CurrentBatch?.Status == "open" && !_closing)
            {
                _uploadTask = UploadPending(false);
                await _uploadTask;
            }
        };
        _retryTimer.Start();
        UpdateControls();
    }

    private void Tell(string message, bool error = false)
    {
        StatusText.Text = message;
        StatusText.Foreground = error ? System.Windows.Media.Brushes.Firebrick : System.Windows.Media.Brushes.DarkSlateGray;
    }

    private async Task Run(Func<Task> operation)
    {
        if (_busy || _closing) return;
        _busy = true;
        UpdateControls();
        try { await operation(); }
        catch (OperationCanceledException) { Tell("采集已停止，已经落盘的页面保留在本地队列。"); }
        catch (Exception ex) { Tell(ex.Message, true); }
        finally { _busy = false; UpdateControls(); }
    }

    private ApiClient RequireApi(BatchRow? batch = null)
    {
        if (_api?.LoggedIn != true) throw new InvalidOperationException("请先登录服务器。");
        if (batch is not null && !string.Equals(batch.ServerUrl, _api.ServerUrl, StringComparison.Ordinal))
            throw new InvalidOperationException("当前登录服务器与该批次不一致，请登录创建此批次的服务器。");
        return _api;
    }

    private BatchRow RequireBatch(bool open = true)
    {
        var batch = CurrentBatch ?? throw new InvalidOperationException("请先选择或新建扫描批次。");
        if (open && batch.Status != "open") throw new InvalidOperationException("此批次已关闭或冻结，请查看提示并联系管理员。");
        return batch;
    }

    private async void Login_Click(object sender, RoutedEventArgs e) => await Run(async () =>
    {
        var api = new ApiClient(ServerBox.Text);
        try
        {
            var legacy = _queue.Batches().Where(b => b.ServerUrl == api.ServerUrl && b.Status != "paired").Select(b => b.Id);
            var name = await api.Login(UsernameBox.Text.Trim(), PasswordBox.Password, _lifetime.Token, legacy);
            _api?.Dispose();
            _api = api;
            PasswordBox.Clear();
            await LoadGroups();
            Tell($"{name}，已登录。选择考卷并新建批次，或继续本地已保存的批次。");
        }
        catch { if (!ReferenceEquals(api, _api)) api.Dispose(); throw; }
    });

    private async void DeviceLogin_Click(object sender, RoutedEventArgs e) => await Run(async () =>
    {
        var api = new ApiClient(ServerBox.Text);
        try
        {
            var name = await api.ConnectDevice(_lifetime.Token);
            _api?.Dispose(); _api = api;
            await LoadGroups(); Tell($"设备 {name} 已连接，请选择考卷或继续本地批次。");
        }
        catch { if (!ReferenceEquals(api, _api)) api.Dispose(); throw; }
    });

    private static string Field(JsonElement row, string key, string fallback = "") => row.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null ? value.ToString() : fallback;
    private async Task LoadGroups()
    {
        var api = RequireApi();
        var projects = (await api.Get("projects", _lifetime.Token)).EnumerateArray().ToDictionary(x => Field(x, "id"), x => Field(x, "name"));
        var subjects = (await api.Get("subjects", _lifetime.Token)).EnumerateArray().ToDictionary(x => Field(x, "id"));
        var templates = (await api.Get("templates", _lifetime.Token)).EnumerateArray().ToDictionary(x => Field(x, "id"));
        var groups = (await api.Get("groups", _lifetime.Token)).EnumerateArray();
        var list = new List<Choice>();
        foreach (var group in groups)
        {
            if (!templates.TryGetValue(Field(group, "template_id"), out var template)) continue;
            if (template.TryGetProperty("status", out var status) && status.GetString() != "published") continue;
            var subjectId = Field(group, "subject_id");
            var parent = subjects.TryGetValue(subjectId, out var subject) ? (projects.GetValueOrDefault(Field(subject, "project_id"), "") + " / " + Field(subject, "name")) : "";
            var sides = template.TryGetProperty("sides", out var sideValue) ? sideValue.GetInt32() : 1;
            var paper = Field(template, "paper", "A4");
            list.Add(new Choice(Field(group, "id"), $"{parent} / {Field(group, "name")} · {Field(template, "name")}（{paper} {(sides == 2 ? "双面" : "单面")}）", Field(template, "id"), sides, paper));
        }
        GroupsBox.ItemsSource = list;
        if (list.Count > 0) GroupsBox.SelectedIndex = 0;
        else Tell("当前没有已绑定发布题卡的考卷组，请先在管理端发布题卡。", true);
    }

    private async void CreateBatch_Click(object sender, RoutedEventArgs e) => await Run(async () =>
    {
        var api = RequireApi();
        var choice = GroupsBox.SelectedItem as Choice ?? throw new InvalidOperationException("请选择已经发布的考卷。");
        var ordering = (BackOrderBox.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "same";
        var room = RoomBox.Text.Trim();
        var result = await api.Post("scan-batches", new { group_id = choice.Id, room, back_order = ordering }, _lifetime.Token);
        var batch = new BatchRow { Id = result.GetProperty("id").GetString()!, ServerUrl = api.ServerUrl, GroupId = choice.Id, Label = choice.Label, Room = room, Paper = choice.Paper, Sides = choice.Sides, BackOrder = ordering };
        batch.TemplateId = Field(result, "template_id"); batch.TemplateRevision = result.GetProperty("template_revision").GetInt32();
        _queue.AddBatch(batch);
        LoadBatches(batch.Id);
        Tell("批次已建立。先采集全部正面，核对张数后再翻面采集。");
    });

    private void LoadBatches(string? selectedId = null)
    {
        selectedId ??= CurrentBatch?.Id;
        var batches = _queue.Batches();
        BatchesBox.ItemsSource = batches;
        BatchesBox.SelectedItem = batches.FirstOrDefault(x => x.Id == selectedId) ?? batches.FirstOrDefault();
        RefreshPages();
    }

    private void Batch_Changed(object sender, SelectionChangedEventArgs e) { if (PagesGrid is not null) { RefreshPages(); UpdateControls(); } }
    private void RefreshPages()
    {
        if (CurrentBatch is not { } batch) { PagesGrid.ItemsSource = Array.Empty<PageRow>(); BatchSummary.Text = "尚未选择批次。"; return; }
        var allPages = _queue.Pages(batch.Id);
        var pages = allPages.Where(x => x.Status != "excluded").ToList();
        PagesGrid.ItemsSource = allPages;
        BatchSummary.Text = $"{batch.Paper} {(batch.Sides == 2 ? "双面" : "单面")} · 正面 {pages.Count(x => x.Side == "front")} 张 · 背面 {pages.Count(x => x.Side == "back")} 张 · 已上传 {pages.Count(x => x.Status == "uploaded")}/{pages.Count} · 已排除 {allPages.Count - pages.Count} 张 · {(batch.BackOrder == "same" ? "同序配对" : "逆序配对")} · {batch.Status}" + (batch.Error.Length > 0 ? "\n" + batch.Error : "");
    }

    private void UpdateControls()
    {
        var open = CurrentBatch?.Status == "open";
        LoginButton.IsEnabled = !_busy;
        DeviceLoginButton.IsEnabled = !_busy;
        CreateBatchButton.IsEnabled = !_busy && _api?.LoggedIn == true;
        FindDevicesButton.IsEnabled = !_busy;
        ScanFrontButton.IsEnabled = !_busy && open;
        ScanBackButton.IsEnabled = !_busy && open && CurrentBatch?.Sides == 2;
        ImportFrontButton.IsEnabled = !_busy && open;
        ImportBackButton.IsEnabled = !_busy && open && CurrentBatch?.Sides == 2;
        UploadButton.IsEnabled = !_busy && CurrentBatch is { Status: not "paired" } && _api?.LoggedIn == true;
        PairButton.IsEnabled = !_busy && open && _api?.LoggedIn == true;
        BatchesBox.IsEnabled = !_busy;
        StopButton.IsEnabled = _captureCancel is not null;
    }

    private async void Devices_Click(object sender, RoutedEventArgs e) => await Run(async () =>
    {
        var driver = Enum.Parse<Driver>((DriverBox.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "Wia", true);
        var devices = await _scanner.Devices(driver);
        DevicesBox.ItemsSource = devices;
        if (devices.Count > 0) DevicesBox.SelectedIndex = 0;
        Tell(devices.Count > 0 ? $"找到 {devices.Count} 台设备，请确认选中的扫描仪。" : "未找到设备，请确认驱动与连接；也可导入图片。");
    });

    private async Task CheckBatch(BatchRow batch, bool allowLocalReview = false)
    {
        var result = await RequireApi(batch).Get($"scan-batches/{batch.Id}", _lifetime.Token);
        if (result.TryGetProperty("group_frozen", out var groupFrozen) && groupFrozen.ValueKind == JsonValueKind.True) { Freeze(batch, "成绩已经发布，请先在管理端发起复核。"); throw new InvalidOperationException(batch.Error); }
        var status = Field(result, "status", "open");
        if (status is "frozen" or "blocked" or "error") { Freeze(batch, Field(result, "error", "服务器已冻结该批次，请联系管理员。")); throw new InvalidOperationException(batch.Error); }
        if (status is "paired" or "completed" or "confirmed") { _queue.BatchStatus(batch.Id, "paired"); LoadBatches(batch.Id); throw new InvalidOperationException("此批次已经确认，请新建批次采集。"); }
        batch.TemplateId = Field(result, "template_id"); batch.TemplateRevision = result.GetProperty("template_revision").GetInt32();
        _queue.BindTemplate(batch);
        foreach (var page in (await RequireApi(batch).Get($"scan-batches/{batch.Id}/pages", _lifetime.Token)).EnumerateArray())
        {
            var id = Field(page, "id");
            if (page.TryGetProperty("excluded", out var excluded) && excluded.ValueKind == JsonValueKind.True) { _queue.PageExcluded(id); continue; }
            if (NeedsReview(page))
            {
                _queue.PageError(id, "请在管理端核对考号或恢复页面定位。", true);
                Freeze(batch, "存在待人工处理的识读页面，请处理后刷新批次状态。");
                throw new InvalidOperationException(batch.Error);
            }
            if (Field(page, "status") == "recognized") _queue.PageUploaded(id, id);
        }
        if (!allowLocalReview && _queue.Pages(batch.Id).Any(p => p.Status == "blocked"))
        { Freeze(batch, "本地仍有待处理页面，请点击上传 / 重试，确认送交管理员核查。"); throw new InvalidOperationException(batch.Error); }
        if (batch.Status == "frozen") { batch.Status = "open"; batch.Error = ""; _queue.BatchStatus(batch.Id, "open"); }
    }

    private static bool NeedsReview(JsonElement page) => (page.TryGetProperty("quality_review_required", out var quality) && quality.ValueKind == JsonValueKind.True) || Field(page, "status") is "needs_review" or "quarantined" ||
        (Field(page, "status") == "recognized" && Field(page, "side") == "front" &&
         (string.IsNullOrWhiteSpace(Field(page, "candidate_number")) || Field(page, "candidate_number").Contains('?')));

    private async Task Capture(string side)
    {
        var batch = RequireBatch();
        RequireApi(batch);
        await CheckBatch(batch);
        var device = DevicesBox.SelectedItem as ScanDevice ?? throw new InvalidOperationException("请先查找并选择扫描仪。");
        var feeder = FeederBox.IsChecked == true;
        var count = _queue.Pages(batch.Id).Count(x => x.Side == "front");
        if (side == "back" && count == 0) throw new InvalidOperationException("请先采集正面。");
        if (side == "back" && MessageBox.Show($"请确认整堆正面共 {count} 张，已翻面并按{(batch.BackOrder == "same" ? "同序" : "逆序")}放入输稿器。继续扫描背面？", "确认翻面", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        _captureCancel = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        UpdateControls();
        Tell("正在采集。每页先保存在本地，再进入上传队列。");
        try
        {
            _captureTask = _scanner.Acquire(device, batch.Paper, feeder, async image =>
            {
                _captureCancel.Token.ThrowIfCancellationRequested();
                var page = await Task.Run(() => _queue.AddPage(batch, side, image));
                RefreshPages();
                if (page.Status == "blocked") { Freeze(batch, page.Error); throw new InvalidOperationException("当前页已保存，采集已停止：" + page.Error); }
            }, _captureCancel.Token);
            await _captureTask;
            RefreshPages();
            Tell("本遍采集结束，页面已保存。请核对张数与纸张方向。");
        }
        finally { _captureCancel.Dispose(); _captureCancel = null; UpdateControls(); }
    }

    private async void ScanFront_Click(object sender, RoutedEventArgs e) => await Run(() => Capture("front"));
    private async void ScanBack_Click(object sender, RoutedEventArgs e) => await Run(() => Capture("back"));
    private void Stop_Click(object sender, RoutedEventArgs e) { _captureCancel?.Cancel(); Tell("已请求停止扫描，正在等待设备结束当前操作。"); }

    private async Task Import(string side)
    {
        var batch = RequireBatch();
        RequireApi(batch);
        await CheckBatch(batch);
        if (side == "back" && _queue.Pages(batch.Id).All(x => x.Side != "front")) throw new InvalidOperationException("请先导入正面。");
        var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "扫描图片|*.png;*.jpg;*.jpeg;*.bmp;*.tif;*.tiff", Multiselect = true, Title = side == "front" ? "按采集顺序导入正面" : "按采集顺序导入背面" };
        if (dialog.ShowDialog(this) != true) return;
        var files = dialog.FileNames.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToArray();
        if (MessageBox.Show($"将按文件名顺序导入 {files.Length} 个文件。请使用 001、002 等补零名称确保顺序。确认导入{(side == "front" ? "正面" : "背面")}？", "确认图片顺序", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        _captureCancel = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        UpdateControls();
        try
        {
            foreach (var file in files)
            {
                _captureCancel.Token.ThrowIfCancellationRequested();
                using var image = System.Drawing.Image.FromFile(file);
                var frames = image.GetFrameCount(System.Drawing.Imaging.FrameDimension.Page);
                for (var i = 0; i < frames; i++)
                {
                    _captureCancel.Token.ThrowIfCancellationRequested();
                    image.SelectActiveFrame(System.Drawing.Imaging.FrameDimension.Page, i);
                    var page = await Task.Run(() => _queue.AddPage(batch, side, image));
                    RefreshPages();
                    if (page.Status == "blocked") { Freeze(batch, page.Error); throw new InvalidOperationException("当前页已保存，后续图片未导入：" + page.Error); }
                    await Dispatcher.Yield(DispatcherPriority.Background);
                }
            }
            Tell("图片已保存到本地队列，等待上传。");
        }
        finally { _captureCancel.Dispose(); _captureCancel = null; UpdateControls(); }
    }

    private async void ImportFront_Click(object sender, RoutedEventArgs e) => await Run(() => Import("front"));
    private async void ImportBack_Click(object sender, RoutedEventArgs e) => await Run(() => Import("back"));

    private void Freeze(BatchRow batch, string reason)
    {
        batch.Status = "frozen";
        batch.Error = reason;
        _queue.BatchStatus(batch.Id, "frozen", reason);
        _captureCancel?.Cancel();
        LoadBatches(batch.Id);
        Tell("批次已冻结，扫描与上传已停止：" + reason, true);
        UpdateControls();
    }

    private async Task UploadPending(bool manual)
    {
        if (!await _uploadLock.WaitAsync(0)) return;
        try
        {
            var batch = RequireBatch(open: !manual);
            var api = RequireApi(batch);
            var blocked = _queue.Pages(batch.Id).Where(p => p.Status == "blocked").ToList();
            if (manual && blocked.Count > 0 && MessageBox.Show($"本地有 {blocked.Count} 页待处理。是否将这些已保存页面及检查结果送交管理员核查？服务器仍会检查题卡、页面定位及考号。", "确认送交核查", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            await CheckBatch(batch, allowLocalReview: manual);
            if (manual) _queue.RetryBlocked(batch.Id);
            foreach (var page in _queue.Pages(batch.Id).Where(x => x.Status == "pending"))
            {
                _lifetime.Token.ThrowIfCancellationRequested();
                if (batch.Status != "open") break;
                try
                {
                    var response = await api.Upload(page, _lifetime.Token);
                    var status = Field(response, "status");
                    if (status is "frozen" or "blocked" or "error") { Freeze(batch, Field(response, "detail", "服务器要求停止该批次。")); break; }
                    var serverId = Field(response, "id");
                    if (string.IsNullOrEmpty(serverId)) throw new InvalidDataException("上传响应缺少页面编号，保留本地页等待重试。");
                    _queue.PageUploaded(page.CaptureId, serverId);
                    if (NeedsReview(response)) { _queue.PageError(page.CaptureId, "页面需要人工核对。", true); Freeze(batch, "页面识读异常，请在管理端处理后刷新批次。"); break; }
                }
                catch (ApiException ex) when (ex.StatusCode == 409)
                {
                    _queue.PageError(page.CaptureId, ex.Message, true);
                    Freeze(batch, ex.Message);
                    break;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _queue.PageError(page.CaptureId, ex.Message, ex is InvalidDataException || ex is ApiException { StatusCode: >= 400 and < 500 });
                    Tell("上传暂停，本地文件保留：" + ex.Message, true);
                    break;
                }
                finally { RefreshPages(); }
            }
            if (manual && batch.Status == "open") Tell("本轮上传结束，请核对页面状态；待上传页面会自动重试。");
        }
        catch (OperationCanceledException) { }
        catch (ApiException ex) when (ex.StatusCode == 403) { if (CurrentBatch is { } batch) Freeze(batch, ex.Message); else Tell(ex.Message, true); }
        catch (Exception ex) { if (manual) Tell(ex.Message, true); }
        finally { _uploadLock.Release(); }
    }

    private async void Upload_Click(object sender, RoutedEventArgs e) => await Run(async () => { _uploadTask = UploadPending(true); await _uploadTask; });
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await Run(async () => { var batch = RequireBatch(false); await CheckBatch(batch); LoadBatches(batch.Id); Tell("批次状态已刷新。"); });
    private async void Pair_Click(object sender, RoutedEventArgs e) => await Run(async () =>
    {
        var batch = RequireBatch();
        var api = RequireApi(batch);
        await CheckBatch(batch);
        var pages = _queue.Pages(batch.Id).Where(x => x.Status != "excluded").ToList();
        var fronts = pages.Count(x => x.Side == "front");
        var backs = pages.Count(x => x.Side == "back");
        if (fronts == 0 || (batch.Sides == 2 && fronts != backs) || pages.Any(x => x.Status != "uploaded")) throw new InvalidOperationException("确认前必须上传全部页面，且双面卷的正背面张数一致。");
        var mapping = batch.Sides == 1 ? "单面卷，共 " + fronts + " 张。" : string.Join("\n", Enumerable.Range(1, Math.Min(fronts, 6)).Select(i => $"正面 {i} ↔ 背面 {(batch.BackOrder == "same" ? i : fronts - i + 1)}")) + (fronts > 6 ? "\n……" : "");
        if (MessageBox.Show($"请人工核对纸张与页面顺序。\n\n{mapping}\n\n确认后服务器将建立答卷并继续处理。是否确认此批次？", "确认配对", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        try { await api.Post($"scan-batches/{batch.Id}/pair", cancel: _lifetime.Token); }
        catch (ApiException ex) when (ex.StatusCode == 409) { Freeze(batch, ex.Message); return; }
        _queue.BatchStatus(batch.Id, "paired");
        LoadBatches(batch.Id);
        Tell("批次已确认。请在管理端检查识别结果和异常卷。");
    });

    private async void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_closedReady) return;
        e.Cancel = true;
        if (_closing) return;
        _closing = true;
        _retryTimer.Stop();
        _captureCancel?.Cancel();
        _lifetime.Cancel();
        Tell("正在停止采集与上传，已保存的页面将在下次启动时保留。");
        try
        {
            if (_captureTask is not null) await _captureTask;
            if (_uploadTask is not null) await _uploadTask;
        }
        catch { }
        _scanner.Dispose();
        _api?.Dispose();
        _closedReady = true;
        Close();
    }
}
