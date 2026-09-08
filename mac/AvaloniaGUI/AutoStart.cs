// macOS 自动启动：写 ~/Library/LaunchAgents/local.takase.discord-bot.plist
// 并 launchctl bootstrap（macOS 13+ 推荐；bootout 忽略未装载错误）。
using System;
using System.Diagnostics;
using System.IO;

namespace TakaseBotDiscord;

public static class AutoStart
{
    public static string PlistPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "LaunchAgents",
        "local.takase.discord-bot.plist");

    private const string PlistBody = @"<?xml version=""1.0"" encoding=""UTF-8""?>
<!DOCTYPE plist PUBLIC ""-//Apple//DTD PLIST 1.0//EN"" ""http://www.apple.com/DTDs/PropertyList-1.0.dtd"">
<plist version=""1.0"">
<dict>
  <key>Label</key><string>local.takase.discord-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{APP_BINARY}}</string>
    <string>--autostart</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
";

    private static string Uid()
    {
        var psi = new ProcessStartInfo("/usr/bin/id", "-u");
        psi.RedirectStandardOutput = true;
        psi.UseShellExecute = false;
        using (var p = Process.Start(psi)!)
        {
            string uid = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit(2000);
            return uid;
        }
    }

    private static void LaunchCtl(string action, string plistPath)
    {
        try
        {
            var psi = new ProcessStartInfo("/bin/launchctl");
            psi.ArgumentList.Add(action);
            psi.ArgumentList.Add("gui/" + Uid());
            psi.ArgumentList.Add(plistPath);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (var p = Process.Start(psi)!)
            {
                p.WaitForExit(5000);
                if (p.ExitCode != 0 && action != "bootout")
                    throw new Exception("launchctl " + action + " 失败（退出码 " + p.ExitCode + "）");
            }
        }
        catch (Exception ex)
        {
            if (action == "bootstrap") throw new Exception("自动启动设置失败：" + ex.Message);
            // bootout 失败（未装载）忽略
        }
    }

    public static void Apply(bool enabled, string appBinaryPath)
    {
        if (enabled)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(PlistPath)!);
            File.WriteAllText(PlistPath, PlistBody.Replace("{{APP_BINARY}}", appBinaryPath));
            LaunchCtl("bootout", PlistPath); // 先卸载旧实例，再装载
            LaunchCtl("bootstrap", PlistPath);
        }
        else
        {
            LaunchCtl("bootout", PlistPath);
            try { if (File.Exists(PlistPath)) File.Delete(PlistPath); } catch { }
        }
    }
}
