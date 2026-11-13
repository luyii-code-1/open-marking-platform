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
            Check(options.Dpi==200&&options.BitDepth==BitDepth.Grayscale,"TWAIN capture must use 200 dpi grayscale.");
            Check(options.TwainOptions.Dsm==discovery.TwainOptions.Dsm&&options.TwainOptions.TransferMode==TwainTransferMode.Native,"Capture and discovery must share the x86 DSM and native transfer.");
            Check(!options.UseNativeUI&&!options.TwainOptions.ShowProgress&&!options.TwainOptions.IncludeWiaDevices,"Driver UI and WIA aliases must be disabled.");
            Check(options.PaperSource==(duplex?PaperSource.Duplex:PaperSource.Feeder),"Batch duplex selection was lost.");
            Check(options.PageSize==(paper=="A3"?PageSize.A3:PageSize.A4),"Batch paper size was lost.");
        }
        var wia=ScannerService.CaptureOptions(new ScanDevice(Driver.Wia,"self-test","self-test"),"A4",true,false);
        Check(wia.Dpi==300,"WIA capture settings changed.");
        int? count=null;
        if(discover){using var scanner=new ScannerService();count=(await scanner.Devices(Driver.Twain)).Count;}
        Console.WriteLine(JsonSerializer.Serialize(new{worker_arch="x86",dsm="New",transfer="Native",dpi=200,bit_depth="8-bit grayscale",discovery_executed=discover,devices=count}));
    }
}
