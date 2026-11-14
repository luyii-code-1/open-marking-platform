using NAPS2.Images;
using NAPS2.Images.Gdi;
using NAPS2.Scan;

namespace OMP.Scanner;

public sealed class ScannerService : IDisposable
{
    private readonly ScanningContext _context;
    private readonly ScanController _controller;
    public ScannerService()
    {
        _context = new ScanningContext(new GdiImageContext());
        _context.SetUpWin32Worker();
        _controller = new ScanController(_context);
    }

    private static TwainOptions Twain32Options()=>new()
    {
        Dsm=TwainDsm.New,
        TransferMode=TwainTransferMode.Native,
        ShowProgress=false,
        IncludeWiaDevices=false,
    };

    internal static ScanOptions DiscoveryOptions(Driver driver)=>new()
    {
        Driver=driver,
        TwainOptions=Twain32Options(),
    };

    public Task<List<ScanDevice>> Devices(Driver driver) => _controller.GetDeviceList(DiscoveryOptions(driver));

    internal static ScanOptions CaptureOptions(ScanDevice device,string paper,bool feeder,bool duplex,ScanCaptureSettings? settings=null)
    {
        var selected=(settings??new()).Validate();
        return new()
        {
        Device=device,
        Driver=device.Driver,
        Dpi=selected.Dpi,
        PageSize=paper=="A3"?PageSize.A3:PageSize.A4,
        PaperSource=duplex?PaperSource.Duplex:feeder?PaperSource.Feeder:PaperSource.Flatbed,
        BitDepth=selected.Color switch {"bw"=>BitDepth.BlackAndWhite,"color"=>BitDepth.Color,_=>BitDepth.Grayscale},
        UseNativeUI=false,
        TwainOptions=Twain32Options(),
        ExcludeBlankPages=false,
        AutoDeskew=false,
        MaxQuality=true,
        };
    }

    public async Task Acquire(ScanDevice device, string paper, bool feeder, Func<System.Drawing.Image, Task> receive, CancellationToken cancel, bool duplex = false, ScanCaptureSettings? settings=null)
    {
        var options = CaptureOptions(device,paper,feeder,duplex,settings);
        await foreach (var scanned in _controller.Scan(options, cancel))
        {
            using (scanned)
            {
                var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "omp-" + Guid.NewGuid().ToString("N") + ".png");
                try
                {
                    scanned.Save(path);
                    using var image = System.Drawing.Image.FromFile(path);
                    await receive(image);
                }
                finally { if (System.IO.File.Exists(path)) System.IO.File.Delete(path); }
            }
        }
    }
    public void Dispose() => _context.Dispose();
}
