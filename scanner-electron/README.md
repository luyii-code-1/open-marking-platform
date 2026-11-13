# Scanner Electron

Windows 10 build 19041 or later, x64. The Electron shell loads the existing online scanner page and uses the shared .NET scanner controller through a private stdio connection. Device pairing, local queues, recognition and uploads use the same implementation and data directory as the standard scanner.

Install the generated setup executable, close the standard scanner, then open **Scanner Electron**. Connect from the server's scanner desk using its pairing link, or enter the server address and pairing code in the client. The server's HTTPS certificate must be trusted by Windows. After pairing, the client loads the server's `/scanner.html` page.

Build from the repository root:

```powershell
npm --prefix scanner-electron ci
python tools/build_electron_scanner.py --dotnet path/to/dotnet.exe
```

The builder uses .NET 10, Node.js, the Python recognition build dependencies, and Inno Setup. It bundles Electron, the .NET runtime and the recognition engine. `--recognition path/to/recognition` can reuse an already built recognition directory.

Run message-policy and preload checks with `npm --prefix scanner-electron test`. Native transport checks run during packaging without opening the graphical interface. Real scanner and target-computer acceptance are performed on the scanning computer.
