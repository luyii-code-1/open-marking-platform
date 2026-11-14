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
        var wia=ScannerService.CaptureOptions(new ScanDevice(Driver.Wia,"self-test","self-test"),"A4",true,false);
        Check(wia.Dpi==300,"WIA capture settings changed.");
        foreach(var dpi in new[]{150,200,300,600})
        foreach(var color in new[]{"bw","gray","color"})
        {
            var options=ScannerService.CaptureOptions(device,"A4",true,false,new(dpi,color));
            Check(options.Dpi==dpi,"Selected resolution was not forwarded to the driver.");
            Check(options.BitDepth==(color=="bw"?BitDepth.BlackAndWhite:color=="color"?BitDepth.Color:BitDepth.Grayscale),"Selected color mode was not forwarded to the driver.");
        }
        foreach(var invalid in new[]{new ScanCaptureSettings(72,"gray"),new ScanCaptureSettings(300,"invalid")})
        {
            var rejected=false;
            try{ScannerService.CaptureOptions(device,"A4",true,false,invalid);}catch(ArgumentException){rejected=true;}
            Check(rejected,"Invalid scan settings were accepted.");
        }
        int? count=null;
        if(discover){using var scanner=new ScannerService();count=(await scanner.Devices(Driver.Twain)).Count;}
        Console.WriteLine(JsonSerializer.Serialize(new{worker_arch="x86",dsm="New",transfer="Native",dpi=300,bit_depth="8-bit grayscale",discovery_executed=discover,devices=count}));
    }
}
