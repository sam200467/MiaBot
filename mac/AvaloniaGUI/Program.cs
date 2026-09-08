// Takase Bot Discord 本地控制台（macOS 版，Avalonia 11）
// 与 Windows 版 takase-discord-gui.cs 1:1 复刻：UI、交互、Discord 启动流程完全一致，
// 仅替换系统适配层（Keychain 凭据 / scutil 代理检测 / LaunchAgent 自动启动 / 进程树终止）。
using System;
using System.IO;
using System.Reflection;
using Avalonia;

namespace TakaseBotDiscord;

static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        if (args != null && Array.IndexOf(args, "--selftest") >= 0)
        {
            try
            {
                Assembly assembly = Assembly.GetExecutingAssembly();
                using (Stream a = assembly.GetManifestResourceStream("takase-discord-core")) { if (a == null || a.Length == 0) Environment.Exit(11); }
                using (Stream b = assembly.GetManifestResourceStream("ongeki-core")) { if (b == null || b.Length == 0) Environment.Exit(12); }
                using (Stream c = assembly.GetManifestResourceStream("takase-discord-vault")) { if (c == null || c.Length == 0) Environment.Exit(15); }
                if (!KeychainHelper.SelfTest()) Environment.Exit(13);
                Environment.Exit(0);
            }
            catch { Environment.Exit(14); }
        }
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
