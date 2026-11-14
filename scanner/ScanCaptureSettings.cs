namespace OMP.Scanner;

public sealed record ScanCaptureSettings(int Dpi=300,string Color="gray")
{
    public ScanCaptureSettings Validate()
    {
        if(Dpi is not (150 or 200 or 300 or 600))throw new ArgumentException("分辨率请选择150、200、300或600 DPI。");
        if(Color is not ("bw" or "gray" or "color"))throw new ArgumentException("请选择黑白、灰度或彩色。");
        return this;
    }
}
