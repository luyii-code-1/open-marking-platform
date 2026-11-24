using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;

namespace OMP.Scanner;

internal static class PluginMarketSelfTest
{
    // Emulate an older offline installation with one package missing and a newer online catalog.
    private sealed class Mirror(string bundled) : HttpMessageHandler
    {
        public int MainRequests, MirrorRequests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            if (uri.Host == "raw.githubusercontent.com") {
                MainRequests++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
            }
            if (uri.Host != "cdn.jsdelivr.net") throw new InvalidOperationException("Unexpected catalog origin");
            MirrorRequests++;
            var name = uri.Segments.Last();
            var path = name == "catalog.json" ? Path.Combine(bundled, name) : Path.Combine(bundled, "packages", name);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(File.ReadAllBytes(path)) });
        }
    }
    internal static async Task Run()
    {
        static void Check(bool ok) { if (!ok) throw new InvalidOperationException("Scanner plugin market check failed"); }
        var bundled = Path.Combine(AppContext.BaseDirectory, "plugin-market");
        var temp = Directory.CreateTempSubdirectory("omp-market-test-");
        try {
            var offline = new PluginMarket(temp.FullName);
            var entries = JsonSerializer.SerializeToElement(offline.View()).GetProperty("plugins").EnumerateArray().ToArray();
            Check(entries.Any(p => p.GetProperty("id").GetString()=="hi5100s") &&
                  entries.Any(p => p.GetProperty("id").GetString()=="canon-mf752cdw-ii"));
            foreach (var entry in entries.Where(p => p.GetProperty("builtin").GetBoolean())) {
                var hash = entry.GetProperty("hash").GetString()!;
                try {
                    await DevicePlugin.Run(offline.Resolve(hash), new { protocol = "test" }, _ => Task.CompletedTask, CancellationToken.None);
                    throw new InvalidOperationException("Plugin accepted a mismatched protocol");
                } catch (IOException ex) when (ex.Message.Contains("协议版本不匹配")) { }
            }
            var folder = Directory.CreateDirectory(Path.Combine(temp.FullName, "bundle")).FullName;
            File.Copy(Path.Combine(bundled, "catalog.json"), Path.Combine(folder, "catalog.json"));
            using var handler = new Mirror(bundled);
            using var client = new HttpClient(handler);
            var market = new PluginMarket(temp.FullName, folder, client);
            var target = entries[0].GetProperty("hash").GetString()!;
            await market.Fetch(null, CancellationToken.None);
            await market.Fetch(target, CancellationToken.None);
            Check(handler.MainRequests == 2 && handler.MirrorRequests == 2);
            var restarted = new PluginMarket(temp.FullName, folder, client);
            var file = restarted.Resolve(target);
            File.WriteAllText(file, "AQID");
            try {
                await DevicePlugin.Run(file, new { protocol = "test" }, _ => Task.CompletedTask, CancellationToken.None);
                throw new InvalidOperationException("Modified package was accepted");
            } catch (IOException ex) when (ex.Message.Contains("校验失败")) { }
            restarted.Remove(target);
            Check(!File.Exists(file));
        } finally { temp.Delete(true); }
    }
}
