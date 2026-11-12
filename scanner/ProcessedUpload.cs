using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;

namespace OMP.Scanner;

public sealed partial class ApiClient
{
    public Task<JsonElement> RegisterBatch(BatchRow batch,CancellationToken cancel=default)=>Post($"scanner/batches/{batch.Id}",new{group_id=batch.GroupId,template_id=batch.TemplateId,template_revision=batch.TemplateRevision,config_sha256=batch.ConfigSha256,capture_mode=batch.CaptureMode,back_order=batch.BackOrder,room=batch.Room},cancel);

    public async Task<JsonElement> UploadProcessed(PageRow page,string queueRoot,CancellationToken cancel=default)
    {
        await EnsureIdentity(cancel);using var form=new MultipartFormDataContent();using var manifest=JsonDocument.Parse(page.RecognitionJson);
        var derived=Path.Combine(queueRoot,"processed",page.CaptureId);
        foreach(var (field,path,hash,mime) in new[]{("file",page.Path,"source_sha256","image/jpeg"),("normalized",Path.Combine(derived,"normalized.png"),"normalized_sha256","image/png"),("cuts",Path.Combine(derived,"cuts.zip"),"local_cuts_sha256","application/zip")})
        {
            var stream=File.OpenRead(path);
            try
            {
                var actual=Convert.ToHexString(await SHA256.HashDataAsync(stream,cancel)).ToLowerInvariant();
                if(actual!=manifest.RootElement.GetProperty(hash).GetString())throw new InvalidDataException("本地识读文件校验失败，请保留原卷后重新识读。");
                stream.Position=0;var file=new StreamContent(stream);file.Headers.ContentType=new MediaTypeHeaderValue(mime);form.Add(file,field,Path.GetFileName(path));
            }
            catch{stream.Dispose();throw;}
        }
        form.Add(new StringContent(page.CaptureId),"capture_id");form.Add(new StringContent(page.Side),"side");form.Add(new StringContent(page.Sequence.ToString(System.Globalization.CultureInfo.InvariantCulture)),"sequence");form.Add(new StringContent(page.RecognitionJson),"manifest");
        using var response=await _http.PostAsync($"scanner/batches/{page.BatchId}/pages",form,cancel);return await Read(response,cancel);
    }
}
