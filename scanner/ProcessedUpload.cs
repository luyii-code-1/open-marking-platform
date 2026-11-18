using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;

namespace OMP.Scanner;

public sealed partial class ApiClient
{
    public Task<JsonElement> RegisterBatch(BatchRow batch,CancellationToken cancel=default)=>Post($"scanner/batches/{batch.Id}",new{group_id=batch.GroupId,template_id=batch.TemplateId,template_revision=batch.TemplateRevision,config_sha256=batch.ConfigSha256,capture_mode=batch.CaptureMode,back_order=batch.BackOrder,room=batch.Room,room_tag_ids=JsonSerializer.Deserialize<JsonElement>(batch.RoomTagsJson).EnumerateArray().Select(t=>t.GetProperty("id").GetString()).ToArray()},cancel);

    public async Task<JsonElement> UploadProcessed(PageRow page,string queueRoot,JsonElement sheet,CancellationToken cancel=default)
    {
        await EnsureIdentity(cancel);using var form=new MultipartFormDataContent();using var manifest=JsonDocument.Parse(page.RecognitionJson);
        var derived=Path.Combine(queueRoot,"processed",page.CaptureId);
        var uploadManifest=System.Text.Json.Nodes.JsonNode.Parse(page.RecognitionJson)!.AsObject();
        using var source=File.OpenRead(page.Path);
        var sourceHash=Convert.ToHexString(await SHA256.HashDataAsync(source,cancel)).ToLowerInvariant();
        if(sourceHash!=page.Sha256||page.Sha256!=manifest.RootElement.GetProperty("source_sha256").GetString())
            throw new InvalidDataException("本地原图与识读清单不一致。");
        using var jpeg=File.OpenRead(Path.Combine(derived,"sheet.jpg"));
        var jpegHash=Convert.ToHexString(await SHA256.HashDataAsync(jpeg,cancel)).ToLowerInvariant();
        if(jpegHash!=sheet.GetProperty("sha256").GetString())throw new InvalidDataException("上传校正图校验失败。");
        if(jpeg.Length>30*1024*1024)throw new InvalidDataException("压缩后的扫描页超过 30 MB。");
        uploadManifest["upload_format"]="jpeg-sheet-1";
        uploadManifest["normalized_sha256"]=jpegHash;
        uploadManifest.Remove("cuts");uploadManifest.Remove("local_cuts_sha256");
        jpeg.Position=0;
        var original=new StreamContent(jpeg);
        original.Headers.ContentType=new MediaTypeHeaderValue("image/jpeg");
        form.Add(original,"normalized",page.CaptureId+".jpg");
        form.Add(new StringContent(page.CaptureId),"capture_id");form.Add(new StringContent(page.Side),"side");form.Add(new StringContent(page.Sequence.ToString(System.Globalization.CultureInfo.InvariantCulture)),"sequence");form.Add(new StringContent(uploadManifest.ToJsonString()),"manifest");
        using var response=await _http.PostAsync($"scanner/batches/{page.BatchId}/pages",form,cancel);return await Read(response,cancel);
    }
}
