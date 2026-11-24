using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OMP.Scanner;

internal sealed class PluginMarket
{
    internal sealed record Entry(string Id, string Name, string Version, string Description, string Sha256);
    private sealed record Catalog(int Format, long Revision, Entry[] Plugins);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly string bundledDirectory;
    private readonly HttpClient client;
    private const string Repo = "luyii-code-1/open-marking-platform";
    private static readonly (string Name, string Url)[] Sources = [
        ("GitHub", $"https://raw.githubusercontent.com/{Repo}/main/scanner-plugins/market/"),
        ("jsDelivr", $"https://cdn.jsdelivr.net/gh/{Repo}@main/scanner-plugins/market/")
    ];
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) {
        MaxResponseContentBufferSize = 8 * 1024 * 1024, Timeout = TimeSpan.FromSeconds(10)
    };
    private readonly string root;
    private readonly Catalog builtin;
    private Catalog catalog;
    private readonly Dictionary<string, Entry> installed = new();
    private string source = "内置目录";
    private readonly SemaphoreSlim writes = new(1, 1);

    internal PluginMarket(string queueRoot, string? bundle = null, HttpClient? client = null)
    {
        this.client = client ?? Http;
        bundledDirectory = bundle ?? Path.Combine(AppContext.BaseDirectory, "plugin-market");
        root = Path.Combine(queueRoot, "plugin-market");
        builtin = ReadCatalog(Path.Combine(bundledDirectory, "catalog.json"));
        catalog = builtin;
        if (!Directory.Exists(root)) return;
        try {
            var cached = ReadCatalog(Path.Combine(root, "catalog.json"));
            if (cached.Revision >= builtin.Revision) { catalog = cached; source = "本机缓存"; }
        } catch (Exception ex) when (IsInvalidData(ex)) { }
        foreach (var dir in Directory.EnumerateDirectories(root)) {
            var hash = Path.GetFileName(dir);
            if (!ValidHash(hash)) continue;
            try {
                var entry = ReadCatalog(Path.Combine(dir, "catalog.json")).Plugins.FirstOrDefault(p => p.Sha256 == hash);
                if (entry != null && File.Exists(InstalledFile(hash))) installed[hash] = entry;
            } catch (Exception ex) when (IsInvalidData(ex)) { }
        }
    }

    private static bool IsInvalidData(Exception e) => e is IOException or UnauthorizedAccessException or JsonException
        or FormatException or CryptographicException or InvalidDataException or KeyNotFoundException or InvalidOperationException or ArgumentException;
    private static bool ValidHash(string? hash) => hash != null && Regex.IsMatch(hash, @"\A[a-f0-9]{64}\z");
    private static Catalog ReadCatalog(string path) => Verify(File.ReadAllBytes(path));
    private static Catalog Verify(byte[] envelope)
    {
        using var doc = JsonDocument.Parse(envelope);
        var payload = doc.RootElement.GetProperty("payload").GetBytesFromBase64();
        var signature = doc.RootElement.GetProperty("signature").GetBytesFromBase64();
        using var key = ECDsa.Create();
        using var stream = typeof(PluginMarket).Assembly.GetManifestResourceStream("OMP.MarketPublicKey")!;
        using var reader = new StreamReader(stream);
        key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(reader.ReadToEnd()), out _);
        if (!key.VerifyData(payload, signature, HashAlgorithmName.SHA256)) throw new InvalidDataException("官方插件目录签名无效。");
        var data = JsonSerializer.Deserialize<Catalog>(payload, Json);
        if (data is not { Format: 1, Revision: > 0, Plugins.Length: <= 256 } ||
            data.Plugins.Any(p => p == null || !ValidHash(p.Sha256) || string.IsNullOrWhiteSpace(p.Id) || string.IsNullOrWhiteSpace(p.Name)) ||
            data.Plugins.DistinctBy(p => p.Id).Count() != data.Plugins.Length)
            throw new InvalidDataException("不支持此插件目录。");
        return data;
    }
    private string InstalledFile(string hash) => Path.Combine(root, hash, hash + ".b64");
    private string BundledFile(string hash) => Path.Combine(bundledDirectory, "packages", hash + ".b64");
    private bool IsBuiltin(string hash) => builtin.Plugins.Any(p => p.Sha256 == hash) && File.Exists(BundledFile(hash));
    internal string Resolve(string hash)
    {
        if (IsBuiltin(hash)) return BundledFile(hash);
        if (installed.ContainsKey(hash) && File.Exists(InstalledFile(hash))) return InstalledFile(hash);
        throw new IOException("插件未安装或文件缺失。");
    }
    internal void KeepSelected(string hash)
    {
        var path = Resolve(hash);
        if (!IsBuiltin(hash) || installed.ContainsKey(hash)) return;
        var data = File.ReadAllBytes(path);
        Decode(data, hash);
        Save(InstalledFile(hash), data);
        Save(Path.Combine(root, hash, "catalog.json"), File.ReadAllBytes(Path.Combine(bundledDirectory, "catalog.json")));
        installed[hash] = builtin.Plugins.Single(p => p.Sha256 == hash);
    }
    internal object View() => new {
        source, revision = catalog.Revision,
        plugins = catalog.Plugins.Concat(builtin.Plugins).Concat(installed.Values).DistinctBy(p => p.Sha256)
            .Select(p => new { id = p.Id, name = p.Name, version = p.Version, description = p.Description,
                hash = p.Sha256, builtin = IsBuiltin(p.Sha256), installed = IsBuiltin(p.Sha256) || installed.ContainsKey(p.Sha256),
                latest = catalog.Plugins.Any(q => q.Sha256 == p.Sha256) }).ToArray()
    };

    private static byte[] Decode(byte[] encoded, string hash)
    {
        var bytes = Convert.FromBase64String(System.Text.Encoding.ASCII.GetString(encoded));
        if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(hash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("插件内容校验失败。");
        return bytes;
    }
    private static void Save(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllBytes(tmp, bytes); File.Move(tmp, path, true); }
        finally { File.Delete(tmp); }
    }
    internal async Task Fetch(string? hash, CancellationToken cancel)
    {
        await writes.WaitAsync(cancel);
        try {
            if (hash != null && !catalog.Plugins.Any(p => p.Sha256 == hash)) throw new InvalidDataException("插件不在当前官方目录中。");
            if (hash != null && (IsBuiltin(hash) || installed.ContainsKey(hash))) return;
            var errors = new List<string>();
            foreach (var remote in Sources) {
                cancel.ThrowIfCancellationRequested();
                try {
                    if (hash == null) {
                        var bytes = await client.GetByteArrayAsync(remote.Url + "catalog.json", cancel);
                        var next = Verify(bytes);
                        if (next.Revision < catalog.Revision) throw new InvalidDataException("目录版本过旧。");
                        Save(Path.Combine(root,"catalog.json"), bytes);
                        catalog = next; source = remote.Name;
                    } else {
                        var bytes = await client.GetByteArrayAsync(remote.Url + "packages/" + hash + ".b64", cancel);
                        Decode(bytes, hash);
                        var catalogPath = Path.Combine(root, "catalog.json");
                        var receipt = File.ReadAllBytes(File.Exists(catalogPath) ? catalogPath : Path.Combine(bundledDirectory, "catalog.json"));
                        var entry = Verify(receipt).Plugins.Single(p => p.Sha256 == hash);
                        Save(InstalledFile(hash), bytes);
                        Save(Path.Combine(root,hash,"catalog.json"), receipt);
                        installed[hash] = entry;
                    }
                    return;
                } catch (Exception e) when (!cancel.IsCancellationRequested && (IsInvalidData(e) || e is HttpRequestException or OperationCanceledException)) {
                    errors.Add(remote.Name + "：" + e.Message);
                }
            }
            throw new IOException(string.Join("；", errors));
        } finally { writes.Release(); }
    }
    internal void Remove(string hash)
    {
        if (!writes.Wait(0)) throw new IOException("插件操作进行中。");
        try {
            if (!installed.ContainsKey(hash) || IsBuiltin(hash)) throw new ArgumentException("只能移除本机下载的插件。");
            File.Delete(InstalledFile(hash));
            File.Delete(Path.Combine(root,hash,"catalog.json"));
            installed.Remove(hash);
        } finally { writes.Release(); }
    }
    // Runs only in a fresh protocol child process. Shared NAPS2 libraries and its Win32 worker resolve from the host installation.
    internal static int RunPackage(string path)
    {
        try {
            path = Path.GetFullPath(path);
            var hash = Path.GetFileNameWithoutExtension(path);
            if (!ValidHash(hash)) throw new InvalidDataException("插件文件名无效。");
            var dir = Path.GetDirectoryName(path)!;
            var manifest = Path.Combine(Path.GetFileName(dir) == "packages" ? Path.GetDirectoryName(dir)! : dir, "catalog.json");
            if (!ReadCatalog(manifest).Plugins.Any(p => p.Sha256 == hash)) throw new InvalidDataException("该插件未获官方签名。");
            var assembly = Assembly.Load(Decode(File.ReadAllBytes(path), hash));
            var entry = assembly.EntryPoint ?? throw new InvalidDataException("插件缺少入口。");
            return (int?)entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[]{Array.Empty<string>()}) ?? 0;
        } catch(Exception e) {
            Console.WriteLine(JsonSerializer.Serialize(new {type="error",message=e.GetBaseException().Message}));return 1;
        }
    }
}
