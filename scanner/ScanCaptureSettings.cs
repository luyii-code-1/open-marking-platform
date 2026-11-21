namespace OMP.Scanner;

public sealed record ScanCaptureSettings(int Dpi=300,string Color="gray")
{
    public ScanCaptureSettings Validate()
    {
        var dpi=Dpi is 150 or 200 ? 300 : Dpi;
        if(dpi is not (300 or 600))throw new ArgumentException("请选择标清（300 DPI）或高清（600 DPI，扫描较慢）。");
        if(Color is not ("bw" or "gray" or "color"))throw new ArgumentException("请选择黑白、灰度或彩色。");
        return this with {Dpi=dpi};
    }
}
