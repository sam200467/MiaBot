// macOS 系统代理检测：scutil --proxy 输出 "key : value" 行式字典。
// 语义与 Windows 版 DetectWindowsProxy 一致：https= 优先于 http=。
using System;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace TakaseBotDiscord;

public static class ProxyDetect
{
    public static string DetectSystemProxy()
    {
        try
        {
            var psi = new ProcessStartInfo("/usr/sbin/scutil", "--proxy");
            psi.RedirectStandardOutput = true;
            psi.UseShellExecute = false;
            psi.StandardOutputEncoding = Encoding.UTF8;
            using (var p = Process.Start(psi)!)
            {
                string text = p.StandardOutput.ReadToEnd();
                p.WaitForExit(2000);
                if (p.ExitCode != 0) return "";
                string Get(string key)
                {
                    Match m = Regex.Match(text, @"^\s*" + Regex.Escape(key) + @"\s*:\s*(.+?)\s*$", RegexOptions.Multiline);
                    return m.Success ? m.Groups[1].Value.Trim() : "";
                }
                string EnableOf(string key) => Get(key + "Enable");
                string HostOf(string key) => Get(key + "Proxy");
                string PortOf(string key) => Get(key + "Port");
                // 与 Windows 版一致：优先 https 代理，其次 http 代理
                if (EnableOf("HTTPS") == "1" && HostOf("HTTPS") != "")
                {
                    string port = PortOf("HTTPS");
                    return "http://" + HostOf("HTTPS") + (port == "" ? "" : ":" + port);
                }
                if (EnableOf("HTTP") == "1" && HostOf("HTTP") != "")
                {
                    string port = PortOf("HTTP");
                    return "http://" + HostOf("HTTP") + (port == "" ? "" : ":" + port);
                }
            }
        }
        catch { }
        return "";
    }
}
