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

    public Task<List<ScanDevice>> Devices(Driver driver) => _controller.GetDeviceList(driver);

    public async Task Acquire(ScanDevice device, string paper, bool feeder, Func<System.Drawing.Image, Task> receive, CancellationToken cancel)
    {
        var options = new ScanOptions
        {
            Device = device, Dpi = 300,
            PageSize = paper == "A3" ? PageSize.A3 : PageSize.A4,
            PaperSource = feeder ? PaperSource.Feeder : PaperSource.Flatbed,
            BitDepth = BitDepth.Grayscale,
            ExcludeBlankPages = false,
            AutoDeskew = false,
            MaxQuality = true,
        };
        await foreach (var scanned in _controller.Scan(options, cancel))
        {
            using (scanned)
            {
                cancel.ThrowIfCancellationRequested();
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
