using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace OMP.Scanner;

public sealed partial class ApiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _identityLock = new(1, 1);
    private readonly string? _deviceRoot;
    private readonly bool _selfTest;
    private DeviceIdentity? _identity;
    private long _renewAt;
    public string ServerUrl { get; }
    public bool LoggedIn { get; private set; }

    public ApiClient(string url, string? deviceRoot = null, bool selfTest = false, HttpMessageHandler? handler = null)
    {
        if (!Uri.TryCreate(url.Trim().TrimEnd('/') + "/", UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https") || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("请输入有效的 HTTP 或 HTTPS 服务器地址。");
        if (uri.Scheme != "https" && !uri.IsLoopback) throw new ArgumentException("扫描服务器需要HTTPS；仅本机调试允许HTTP。");
        if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)) throw new ArgumentException("服务器地址不能包含查询参数或片段。");
        ServerUrl = uri.AbsoluteUri.EndsWith("/api/v1/", StringComparison.OrdinalIgnoreCase) ? uri.AbsoluteUri : uri.AbsoluteUri + "api/v1/";
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.BaseAddress = new Uri(ServerUrl); _http.Timeout = TimeSpan.FromMinutes(2);
        _deviceRoot = deviceRoot; _selfTest = selfTest;
    }

    public async Task<string> Login(string username, string password, CancellationToken cancel = default, IEnumerable<string>? adoptBatches = null)
    {
        using var response = await _http.PostAsJsonAsync("auth/login", new { username, password }, cancel);
        var body = await Read(response, cancel);
        var token = body.GetProperty("token").GetString();
        if (string.IsNullOrWhiteSpace(token)) throw new InvalidDataException("登录响应缺少访问令牌。");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        try
        {
            if (body.GetProperty("user").GetProperty("role").GetString() != "admin") throw new InvalidOperationException("设备注册需要管理员账号。");
            _identity?.Dispose(); _identity = new DeviceIdentity(ServerUrl, _deviceRoot, selfTest: _selfTest);
            var device = await PostCore("scanner/devices", new { label = Environment.MachineName, public_key = _identity.PublicKey, password }, cancel);
            _identity.SetDevice(device.GetProperty("id").GetString()!);
            var batches = adoptBatches?.Distinct().ToArray() ?? Array.Empty<string>();
            if (batches.Length > 0) await PostCore($"scanner/devices/{_identity.DeviceId}/adopt-batches", new { batch_ids = batches }, cancel);
        }
        finally
        {
            try { await PostCore("auth/logout", new { }, cancel); } catch { }
            _http.DefaultRequestHeaders.Authorization = null;
        }
        await AuthenticateDevice(cancel);
        return body.GetProperty("user").GetProperty("name").GetString() ?? username;
    }

    public async Task<string> ConnectDevice(CancellationToken cancel = default)
    {
        _identity?.Dispose(); _identity = new DeviceIdentity(ServerUrl, _deviceRoot, create: false, selfTest: _selfTest);
        if (string.IsNullOrWhiteSpace(_identity.DeviceId)) throw new InvalidOperationException("请先使用管理员账号登记此设备。");
        return await AuthenticateDevice(cancel);
    }

    private async Task<string> AuthenticateDevice(CancellationToken cancel)
    {
        if (_identity is null) throw new InvalidOperationException("设备密钥未初始化。");
        var challenge = await PostCore("scanner/challenge", new { device_id = _identity.DeviceId }, cancel);
        var session = await PostCore("scanner/authenticate", new { challenge_id = challenge.GetProperty("id").GetString(), signature = _identity.Sign(challenge) }, cancel);
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.GetProperty("token").GetString());
        _renewAt = Environment.TickCount64 + Math.Max(1, session.GetProperty("expires_in").GetInt64() - 60) * 1000;
        LoggedIn = true;
        return session.GetProperty("device").GetProperty("label").GetString() ?? "扫描设备";
    }

    private async Task EnsureIdentity(CancellationToken cancel)
    {
        if (!LoggedIn || _identity is null) throw new InvalidOperationException("请先连接已注册设备。");
        if (Environment.TickCount64 < _renewAt) return;
        await _identityLock.WaitAsync(cancel);
        try { if (Environment.TickCount64 >= _renewAt) await AuthenticateDevice(cancel); }
        finally { _identityLock.Release(); }
    }

    public async Task<JsonElement> Get(string route, CancellationToken cancel = default)
    {
        await EnsureIdentity(cancel);
        using var response = await _http.GetAsync(route, cancel);
        return await Read(response, cancel);
    }

    public async Task<JsonElement> Post(string route, object? value = null, CancellationToken cancel = default)
    {
        await EnsureIdentity(cancel);
        return await PostCore(route, value ?? new { }, cancel);
    }

    private async Task<JsonElement> PostCore(string route, object value, CancellationToken cancel)
    {
        using var response = await _http.PostAsJsonAsync(route, value ?? new { }, cancel);
        return await Read(response, cancel);
    }

    public async Task<JsonElement> Upload(PageRow page, CancellationToken cancel = default)
    {
        await EnsureIdentity(cancel);
        using var content = new MultipartFormDataContent();
        await using var stream = File.OpenRead(page.Path);
        var digest = Convert.ToHexString(await System.Security.Cryptography.SHA256.HashDataAsync(stream, cancel)).ToLowerInvariant();
        if (digest != page.Sha256) throw new InvalidDataException("本地队列文件校验失败，请保留该批次并检查磁盘。");
        stream.Position = 0;
        var file = new StreamContent(stream);
        file.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
        content.Add(file, "file", page.CaptureId + ".jpg");
        content.Add(new StringContent(page.CaptureId), "capture_id");
        content.Add(new StringContent(page.Side), "side");
        content.Add(new StringContent(page.QualityJson), "quality_report");
        content.Add(new StringContent(page.Sequence.ToString(System.Globalization.CultureInfo.InvariantCulture)), "sequence");
        using var response = await _http.PostAsync($"scan-batches/{page.BatchId}/pages", content, cancel);
        return await Read(response, cancel);
    }

    private async Task<JsonElement> Read(HttpResponseMessage response, CancellationToken cancel)
    {
        var text = await response.Content.ReadAsStringAsync(cancel);
        JsonElement body;
        try { body = JsonDocument.Parse(text).RootElement.Clone(); }
        catch (JsonException) { throw new ApiException((int)response.StatusCode, $"服务器返回无法解析的响应（HTTP {(int)response.StatusCode}）。"); }
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode == HttpStatusCode.Unauthorized) _renewAt = 0;
            if (response.StatusCode == HttpStatusCode.Forbidden) LoggedIn = false;
            var message = body.TryGetProperty("detail", out var detail) ? detail.ToString() : $"HTTP {(int)response.StatusCode}";
            throw new ApiException((int)response.StatusCode, message);
        }
        return body;
    }

    internal void CheckTestKey() => _identity!.CheckTestExportPolicy();
    internal void DeleteTestKey() => _identity?.DeleteTestKey();
    public void Dispose() { _identity?.Dispose(); _http.Dispose(); _identityLock.Dispose(); }
}
