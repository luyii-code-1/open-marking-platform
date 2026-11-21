using System.Reflection.PortableExecutable;
using System.Text.Json;
using NAPS2.Images;
using NAPS2.Scan;

namespace OMP.Scanner;

internal static class ScannerBridgeSelfTest
{
    public static async Task Run(bool discover)
    {
        static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
        var path=System.IO.Path.Combine(AppContext.BaseDirectory,"NAPS2.Worker.exe");
        using(var stream=System.IO.File.OpenRead(path))
        using(var image=new PEReader(stream))Check(image.PEHeaders.CoffHeader.Machine==Machine.I386,"TWAIN worker must be x86.");
        var discovery=ScannerService.DiscoveryOptions(Driver.Twain);
        Check(discovery.Driver==Driver.Twain&&discovery.TwainOptions.Dsm==TwainDsm.New,"Discovery must use the 32-bit modern DSM.");
        var device=new ScanDevice(Driver.Twain,"self-test","self-test");
        foreach(var paper in new[]{"A3","A4"})
        foreach(var duplex in new[]{false,true})
        {
            var options=ScannerService.CaptureOptions(device,paper,true,duplex);
            Check(options.Dpi==300&&options.BitDepth==BitDepth.Grayscale,"TWAIN capture must use 300 dpi grayscale.");
            Check(options.TwainOptions.Dsm==discovery.TwainOptions.Dsm&&options.TwainOptions.TransferMode==TwainTransferMode.Native,"Capture and discovery must share the x86 DSM and native transfer.");
            Check(!options.UseNativeUI&&!options.TwainOptions.ShowProgress&&!options.TwainOptions.IncludeWiaDevices,"Driver UI and WIA aliases must be disabled.");
            Check(options.PaperSource==(duplex?PaperSource.Duplex:PaperSource.Feeder),"Batch duplex selection was lost.");
            Check(options.PageSize==(paper=="A3"?PageSize.A3:PageSize.A4),"Batch paper size was lost.");
        }
        using(var buffer=new System.IO.MemoryStream())
        {
            using var original=new System.Drawing.Bitmap(32,32);
            original.Save(buffer,System.Drawing.Imaging.ImageFormat.Png);
            var bytes=buffer.ToArray();
            var temporary=System.IO.Path.Combine(System.IO.Path.GetTempPath(),"omp-png-copy-"+Guid.NewGuid()+".png");
            System.IO.File.WriteAllBytes(temporary,bytes);
            try
            {
                using var loaded=System.Drawing.Image.FromFile(temporary);loaded.Tag=new ScannerImageFile(temporary);
                using var output=new System.IO.MemoryStream();ScannerService.SaveImage(loaded,output);
                Check(output.ToArray().SequenceEqual(bytes),"Raw PNG preservation recompressed or changed the scan.");
            }
            finally{System.IO.File.Delete(temporary);}
        }
        var wia=ScannerService.CaptureOptions(new ScanDevice(Driver.Wia,"self-test","self-test"),"A4",true,false);
        Check(wia.Dpi==300,"WIA capture settings changed.");
        foreach(var dpi in new[]{150,200,300,600})
        foreach(var color in new[]{"bw","gray","color"})
        {
            var options=ScannerService.CaptureOptions(device,"A4",true,false,new(dpi,color));
            Check(options.Dpi==(dpi is 150 or 200 ? 300 : dpi),"Selected resolution was not forwarded to the driver.");
            Check(options.BitDepth==(color=="bw"?BitDepth.BlackAndWhite:color=="color"?BitDepth.Color:BitDepth.Grayscale),"Selected color mode was not forwarded to the driver.");
        }
        foreach(var invalid in new[]{new ScanCaptureSettings(72,"gray"),new ScanCaptureSettings(300,"invalid")})
        {
            var rejected=false;
            try{ScannerService.CaptureOptions(device,"A4",true,false,invalid);}catch(ArgumentException){rejected=true;}
            Check(rejected,"Invalid scan settings were accepted.");
        }
        var settingsRoot=System.IO.Path.Combine(System.IO.Path.GetTempPath(),"omp-scanner-preferences-"+Guid.NewGuid().ToString("N"));
        System.IO.Directory.CreateDirectory(settingsRoot);
        try
        {
            var first="https://first.example/api/v1/";
            var second="https://second.example/api/v1/";
            System.IO.File.WriteAllText(System.IO.Path.Combine(settingsRoot,"desktop-settings.json"),JsonSerializer.Serialize(new{server_url=first,servers=new[]{first,second}}));
            System.IO.File.WriteAllText(System.IO.Path.Combine(settingsRoot,"scan-capture-settings.json"),JsonSerializer.Serialize(new ScanCaptureSettings(200,"gray")));
            using(var controller=new DesktopController(new LocalQueue(settingsRoot),selfTest:true))
            {
                Check(controller.ScanSettings.Dpi==300,"Legacy resolution was not migrated to standard quality.");
                await controller.Invoke("setDefaultServer",JsonSerializer.SerializeToElement(new{server_url=second}));
                var state=JsonSerializer.SerializeToElement(await controller.Invoke("state",JsonSerializer.SerializeToElement(new{})));
                Check(state.GetProperty("default_server_url").GetString()==second,"Default server was not saved.");
                Check(controller.Server==first&&!state.GetProperty("session_open").GetBoolean(),"Saving a default server changed the active connection.");
                await controller.Invoke("scanSettings",JsonSerializer.SerializeToElement(new{dpi=600,color="gray"}));
                await controller.Close();
            }
            using(var restarted=new DesktopController(new LocalQueue(settingsRoot),selfTest:true))
            {
                var state=JsonSerializer.SerializeToElement(await restarted.Invoke("state",JsonSerializer.SerializeToElement(new{})));
                Check(state.GetProperty("default_server_url").GetString()==second,"Restart lost the default server.");
                Check(restarted.ScanSettings.Dpi==600,"Restart lost high quality settings.");
                Check(!state.GetProperty("session_open").GetBoolean(),"Restart bypassed server selection.");
                await restarted.Close();
            }
        }
        finally{Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();System.IO.Directory.Delete(settingsRoot,true);}
        int? count=null;
        if(discover){using var scanner=new ScannerService();count=(await scanner.Devices(Driver.Twain)).Count;}
        Console.WriteLine(JsonSerializer.Serialize(new{worker_arch="x86",dsm="New",transfer="Native",dpi=300,bit_depth="8-bit grayscale",discovery_executed=discover,devices=count}));
    }
}
