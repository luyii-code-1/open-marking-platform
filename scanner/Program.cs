namespace OMP.Scanner;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if(args.FirstOrDefault()=="--device-plugin")return DevicePlugin.Serve().GetAwaiter().GetResult();
        if(args.FirstOrDefault()=="--scan-bridge-self-test")
        {
            try{ScannerBridgeSelfTest.Run(args.Contains("--discover")).GetAwaiter().GetResult();return 0;}
            catch(Exception error){Console.Error.WriteLine("SCAN BRIDGE SELFTEST FAIL: "+error.Message);return 1;}
        }
        if(args.FirstOrDefault()=="--room-scope-self-test")
        {
            try{RoomScopeSelfTest.Run(args).GetAwaiter().GetResult();return 0;}
            catch(Exception error){Console.Error.WriteLine("ROOM SELFTEST FAIL: "+error.GetType().Name+": "+error.Message);return 1;}
        }
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
        try
        {
            var activation=args.FirstOrDefault()??"";
            if(activation.Length>0)PairingActivation.Parse(activation);
            using var instance=new DesktopInstance();
            if(!instance.Primary){instance.Forward(activation).GetAwaiter().GetResult();return 0;}
            PairingActivation.InitialUri=activation;
            var app=new App();app.InitializeComponent();
            instance.Activated=value=>app.Dispatcher.BeginInvoke(()=>
            {
                if(app.MainWindow is DesktopWindow window)window.ReceiveActivation(value);else PairingActivation.InitialUri=value;
            });
            _=instance.Listen();return app.Run();
        }
        catch(Exception error){System.Windows.MessageBox.Show(error.Message,"扫描客户端");return 1;}
    }
}
