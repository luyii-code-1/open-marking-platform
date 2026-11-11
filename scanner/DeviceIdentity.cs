using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OMP.Scanner;

public sealed class DeviceIdentity : IDisposable
{
    private readonly ECDsaCng _signer;
    private readonly string _file;
    private readonly string _keyName;
    private readonly bool _selfTest;
    public string DeviceId { get; private set; } = "";
    public string PublicKey => Base64Url(_signer.ExportSubjectPublicKeyInfo());

    public DeviceIdentity(string serverUrl, string? root = null, bool create = true, bool selfTest = false)
    {
        _selfTest = selfTest;
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(serverUrl))).ToLowerInvariant();
        _keyName = (selfTest ? "OMP.Scanner.SelfTest." : "OMP.Scanner.") + fingerprint;
        root ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenMarkingPlatform", "Scanner", "devices");
        Directory.CreateDirectory(root);
        _file = Path.Combine(root, fingerprint + ".json");
        if (!CngKey.Exists(_keyName, CngProvider.MicrosoftSoftwareKeyStorageProvider))
        {
            if (!create) throw new InvalidOperationException("此Windows用户尚未注册设备密钥，请先使用管理员账号登录注册。");
            using var created = CngKey.Create(CngAlgorithm.ECDsaP256, _keyName, new CngKeyCreationParameters
            {
                Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider,
                KeyUsage = CngKeyUsages.Signing,
                ExportPolicy = CngExportPolicies.None,
            });
        }
        using var key = CngKey.Open(_keyName, CngProvider.MicrosoftSoftwareKeyStorageProvider);
        _signer = new ECDsaCng(key);
        if (File.Exists(_file))
        {
            try { DeviceId = JsonDocument.Parse(File.ReadAllText(_file)).RootElement.GetProperty("device_id").GetString() ?? ""; }
            catch (Exception ex) when (ex is JsonException or KeyNotFoundException)
            {
                if (!create) throw new InvalidDataException("设备登记文件损坏，请使用管理员账号重新注册。", ex);
            }
        }
    }

    public void SetDevice(string identifier)
    {
        if (!Guid.TryParse(identifier, out _)) throw new InvalidDataException("设备登记响应缺少有效编号。");
        var temporary = _file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(stream, new { device_id = identifier });
            stream.Flush(true);
        }
        File.Move(temporary, _file, true);
        DeviceId = identifier;
    }

    public string Sign(JsonElement challenge)
    {
        if (challenge.GetProperty("device_id").GetString() != DeviceId) throw new InvalidDataException("设备挑战归属不符。");
        var message = "OMP-SCANNER-1\n" + challenge.GetProperty("id").GetString() + "\n" + challenge.GetProperty("nonce").GetString() + "\n" + DeviceId;
        return Base64Url(_signer.SignData(Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));
    }

    public static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    internal void CheckTestExportPolicy()
    {
        if (!_selfTest) throw new InvalidOperationException("仅用于自检密钥。");
        try { _signer.ExportPkcs8PrivateKey(); }
        catch (CryptographicException) { return; }
        throw new InvalidOperationException("自检失败：私钥可被导出。");
    }
    internal void DeleteTestKey()
    {
        if (!_selfTest || !_keyName.StartsWith("OMP.Scanner.SelfTest.", StringComparison.Ordinal)) throw new InvalidOperationException("仅可清理本次自检密钥。");
        _signer.Dispose();
        using var key = CngKey.Open(_keyName, CngProvider.MicrosoftSoftwareKeyStorageProvider);
        key.Delete();
    }
    public void Dispose() => _signer.Dispose();
}
