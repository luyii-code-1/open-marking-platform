namespace OMP.Scanner;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if(args.FirstOrDefault()=="--desktop-self-test")
        {
            try{DesktopSelfTest.Run(args).GetAwaiter().GetResult();return 0;}
            catch(Exception error){Console.Error.WriteLine("DESKTOP SELFTEST FAIL: "+error.GetType().Name+": "+error.Message);return 1;}
        }
        if (args.FirstOrDefault() == "--self-test")
        {
            try { ScannerSelfTest.Run(args).GetAwaiter().GetResult(); return 0; }
            catch (Exception error) { Console.Error.WriteLine("SELFTEST FAIL: " + error.GetType().Name + ": " + error.Message); return 1; }
        }
        var app = new App();
        app.InitializeComponent();
        return app.Run();
    }
}
