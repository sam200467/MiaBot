// macOS Keychain 存取封装：统一走 /usr/bin/security，参数用 ArgumentList 防注入。
// 替代 Windows 版的 DPAPI（ProtectedData）。
using System;
using System.Diagnostics;
using System.Text;

namespace TakaseBotDiscord;

public static class KeychainHelper
{
    private const string SettingsService = "TakaseDiscordBotSettingsV1";
    private const string SettingsAccount = "default";
    private const string SecurityBinary = "/usr/bin/security";

    private static string RunSecurity(params string[] args)
    {
        var psi = new ProcessStartInfo(SecurityBinary);
        foreach (string arg in args) psi.ArgumentList.Add(arg);
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.UseShellExecute = false;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        using (var p = Process.Start(psi)!)
        {
            string stdout = p.StandardOutput.ReadToEnd();
            string stderr = p.StandardError.ReadToEnd();
            p.WaitForExit(15000);
            if (p.ExitCode != 0)
                throw new Exception(StderrMessage(stderr) + "（security 退出码 " + p.ExitCode + "）");
            return stdout;
        }
    }

    private static string StderrMessage(string stderr)
    {
        string text = stderr.Trim();
        return text.Length == 0 ? "钥匙串操作失败" : text;
    }

    /// <summary>读取一条密钥；不存在返回 null。未找到不能只信退出码 44（各 macOS 版本不一致），stderr 文本匹配兜底。</summary>
    public static string? GetSecret(string service, string account)
    {
        var psi = new ProcessStartInfo(SecurityBinary);
        foreach (string arg in new[] { "find-generic-password", "-a", account, "-s", service, "-w" })
            psi.ArgumentList.Add(arg);
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.UseShellExecute = false;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        using (var p = Process.Start(psi)!)
        {
            string stdout = p.StandardOutput.ReadToEnd();
            string stderr = p.StandardError.ReadToEnd();
            p.WaitForExit(15000);
            if (p.ExitCode == 0) return stdout.TrimEnd('\r', '\n');
            if (IsNotFound(stderr)) return null;
            throw new Exception(StderrMessage(stderr) + "（security 退出码 " + p.ExitCode + "）");
        }
    }

    private static bool IsNotFound(string stderr)
    {
        string t = stderr.ToLowerInvariant();
        return t.Contains("could not be found") || t.Contains("not found in the keychain") || t.Contains("item not found");
    }

    /// <summary>写入/更新一条密钥（-U 已存在则更新）。</summary>
    public static void SetSecret(string service, string account, string value)
    {
        RunSecurity("add-generic-password", "-a", account, "-s", service, "-w", value, "-U");
    }

    public static void DeleteSecret(string service, string account)
    {
        var psi = new ProcessStartInfo(SecurityBinary);
        foreach (string arg in new[] { "delete-generic-password", "-a", account, "-s", service })
            psi.ArgumentList.Add(arg);
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.UseShellExecute = false;
        using (var p = Process.Start(psi)!)
        {
            string stderr = p.StandardError.ReadToEnd();
            p.WaitForExit(15000);
            if (p.ExitCode != 0 && !IsNotFound(stderr))
                throw new Exception(StderrMessage(stderr) + "（security 退出码 " + p.ExitCode + "）");
        }
    }

    // ---- GUI 设置存取（service 固定）----
    public static string? GetSettings() => GetSecret(SettingsService, SettingsAccount);

    public static void SaveSettings(string json) => SetSecret(SettingsService, SettingsAccount, json);

    /// <summary>自测：临时 service 做一轮写读删，不碰生产数据、无网络。</summary>
    public static bool SelfTest()
    {
        const string service = "TakaseDiscordBotSelftestV1";
        string account = "selftest-" + Guid.NewGuid().ToString("N");
        string payload = "Takase Discord Bot 自测♪DEMO";
        try
        {
            SetSecret(service, account, payload);
            string? roundtrip = GetSecret(service, account);
            if (roundtrip != payload) return false;
            if (GetSecret(service, "definitely-not-exists-account") != null) return false;
            DeleteSecret(service, account);
            if (GetSecret(service, account) != null) return false;
            return true;
        }
        finally
        {
            try { DeleteSecret(service, account); } catch { }
        }
    }
}
