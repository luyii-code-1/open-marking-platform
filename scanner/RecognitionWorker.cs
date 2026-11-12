using System.Buffers.Binary;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;

namespace OMP.Scanner;

public sealed class RecognitionWorker : IDisposable
{
    private readonly string _root;
    private readonly SemaphoreSlim _gate=new(1,1);
    private readonly string? _python;
    private readonly string? _repository;
    private Process? _process;
    private string _token="";
    private int _port;
    private bool _disposed;
    public RecognitionWorker(string root,string? python=null,string? repository=null){_root=root;_python=python;_repository=repository;}

    private async Task Start(CancellationToken cancel)
    {
        if(_process is {HasExited:false})return;
        _process?.Dispose();_token=Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var executable=Path.Combine(AppContext.BaseDirectory,"recognition","OMP.RecognitionWorker.exe");
        var start=new ProcessStartInfo{FileName=_python??executable,UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        if(_python is not null){start.ArgumentList.Add("-m");start.ArgumentList.Add("scanner_engine.main");start.WorkingDirectory=_repository??throw new InvalidOperationException("缺少本地引擎开发目录。");}
        else if(!File.Exists(executable))throw new InvalidOperationException("扫描程序缺少识读引擎，请完整解压扫描端安装包。");
        start.ArgumentList.Add("--root");start.ArgumentList.Add(_root);
        _process=Process.Start(start)??throw new InvalidOperationException("无法启动识读引擎。");
        _=_process.StandardError.ReadToEndAsync(cancel);
        await _process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new{token=_token}).AsMemory(),cancel);await _process.StandardInput.FlushAsync(cancel);
        var line=await _process.StandardOutput.ReadLineAsync(cancel).AsTask().WaitAsync(TimeSpan.FromSeconds(30),cancel);
        if(line is null)throw new InvalidOperationException("识读引擎未能启动。");
        using var ready=JsonDocument.Parse(line);
        if(ready.RootElement.GetProperty("protocol").GetString()!="omp-recognition-1")throw new InvalidOperationException("识读引擎协议不兼容。");
        _port=ready.RootElement.GetProperty("port").GetInt32();
    }

    public async Task<JsonElement> Call(string method,object args,CancellationToken cancel=default)
    {
        await _gate.WaitAsync(cancel);
        try
        {
            await Start(cancel);using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(TimeSpan.FromMinutes(2));
            using var client=new TcpClient();await client.ConnectAsync("127.0.0.1",_port,timeout.Token);await using var stream=client.GetStream();
            var content=JsonSerializer.SerializeToUtf8Bytes(new{token=_token,method,args});var header=new byte[4];BinaryPrimitives.WriteInt32LittleEndian(header,content.Length);
            await stream.WriteAsync(header,timeout.Token);await stream.WriteAsync(content,timeout.Token);
            await stream.ReadExactlyAsync(header,timeout.Token);var size=BinaryPrimitives.ReadInt32LittleEndian(header);
            if(size<=0||size>2*1024*1024)throw new InvalidDataException("识读引擎响应过大。");
            var result=new byte[size];await stream.ReadExactlyAsync(result,timeout.Token);using var document=JsonDocument.Parse(result);
            if(!document.RootElement.GetProperty("ok").GetBoolean())throw new InvalidOperationException(document.RootElement.GetProperty("error").GetString());
            return document.RootElement.GetProperty("result").Clone();
        }
        finally{_gate.Release();}
    }

    public Task<JsonElement> Recognize(BatchRow batch,PageRow page,CancellationToken cancel=default)=>Call("recognize",new{batch_id=batch.Id,capture_id=page.CaptureId,side=page.Side,source_sha256=page.Sha256,config_sha256=batch.ConfigSha256,template=JsonSerializer.Deserialize<JsonElement>(batch.TemplateJson)},cancel);
    public void Dispose(){if(_disposed)return;_disposed=true;if(_process is {HasExited:false}){_process.Kill(entireProcessTree:true);_process.WaitForExit(5000);}_process?.Dispose();_process=null;_gate.Dispose();}
}
