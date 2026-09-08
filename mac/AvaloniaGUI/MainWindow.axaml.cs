// Takase Bot · Discord 本地控制台（macOS 版主窗口逻辑）
// 与 Windows 版 takase-discord-gui.cs 逐行对拍：启动/停止/保存/清空/日志解析完全一致，
// 仅替换系统适配层（见各 Helper 类）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Threading;

namespace TakaseBotDiscord;

public partial class MainWindow : Window
{
    private const string DefaultApplicationId = "";
    private const string DefaultGuildId = "";
    private const string DefaultChannelId = "";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    // macOS：~/Library/Application Support/TakaseDiscordBot；其他平台退回系统 LocalApplicationData
    private readonly string rootDir = OperatingSystem.IsMacOS()
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "TakaseDiscordBot")
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TakaseDiscordBot");
    private string vaultPath => Path.Combine(rootDir, "bindings.json");
    private string runtimeDir => Path.Combine(rootDir, "runtime");
    private string dataDir => Path.Combine(rootDir, "data");
    private string outputDir => Path.Combine(rootDir, "output");
    private string botCorePath => Path.Combine(runtimeDir, "takase-discord-core");
    private string ongekiCorePath => Path.Combine(runtimeDir, "ongeki-core");
    private string vaultHelperPath => Path.Combine(runtimeDir, "takase-discord-vault");

    private Process? botProcess;
    private bool closing;

    public MainWindow()
    {
        InitializeComponent();
        txtApplicationId.Text = DefaultApplicationId;
        txtGuildId.Text = DefaultGuildId;
        txtChannelIds.Text = DefaultChannelId;
        txtProxyUrl.Text = ProxyDetect.DetectSystemProxy();
        btnStop.IsEnabled = false;
        btnSave.Click += async (_, _) => await SaveSettings(true);
        btnStart.Click += async (_, _) => await StartBot();
        btnStop.Click += (_, _) => StopBot();
        btnClearBindings.Click += async (_, _) => await ClearBindings();
        chkReveal.IsCheckedChanged += (_, _) => txtBotToken.RevealPassword = chkReveal.IsChecked == true;
        chkAutoStart.IsCheckedChanged += (_, _) => { if (IsVisible) ApplyAutoStart(chkAutoStart.IsChecked == true); };
        Closing += (_, _) => { closing = true; StopBot(); };
        LoadSettings();
        Opened += (_, _) =>
        {
            foreach (string arg in Environment.GetCommandLineArgs())
            {
                if (string.Equals(arg, "--autostart", StringComparison.OrdinalIgnoreCase))
                {
                    Dispatcher.UIThread.Post(StartBot);
                    break;
                }
            }
        };
        AppendLog("三个 ID 已预填。请在本机粘贴 Bot Token，然后保存并启动。");
        if (!string.IsNullOrWhiteSpace(txtProxyUrl.Text))
            AppendLog("已自动读取系统代理：" + txtProxyUrl.Text);
    }

    private DiscordBotSettings ReadFields() => new()
    {
        ApplicationId = txtApplicationId.Text?.Trim() ?? "",
        BotToken = txtBotToken.Text ?? "",
        GuildId = txtGuildId.Text?.Trim() ?? "",
        ChannelIds = txtChannelIds.Text?.Trim() ?? "",
        ProxyUrl = txtProxyUrl.Text?.Trim() ?? "",
        AutoStart = chkAutoStart.IsChecked == true,
    };

    private static string[] ParseChannelIds(string text)
    {
        var list = new List<string>();
        foreach (string raw in (text ?? "").Split(new[] { ',', ';', '，', '；', ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string item = raw.Trim();
            if (!list.Contains(item)) list.Add(item);
        }
        return list.ToArray();
    }

    private static bool IsSnowflake(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length < 17 || value.Length > 20) return false;
        foreach (char c in value) if (c < '0' || c > '9') return false;
        return true;
    }

    private async Task<bool> ValidateSettings(DiscordBotSettings settings, bool showMessage)
    {
        string? error = null;
        if (!IsSnowflake(settings.ApplicationId)) error = "Application ID 格式不正确";
        else if (string.IsNullOrWhiteSpace(settings.BotToken)) error = "请填写 Bot Token";
        else if (!IsSnowflake(settings.GuildId)) error = "服务器 ID 格式不正确";
        else
        {
            string[] channels = ParseChannelIds(settings.ChannelIds);
            if (channels.Length == 0) error = "请至少填写一个频道 ID";
            else foreach (string channel in channels) if (!IsSnowflake(channel)) { error = "频道 ID 格式不正确：" + channel; break; }
        }
        if (error == null && !string.IsNullOrWhiteSpace(settings.ProxyUrl) &&
            !(settings.ProxyUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || settings.ProxyUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
            error = "HTTP 代理必须以 http:// 或 https:// 开头";
        if (error == null) return true;
        if (showMessage) await MessageBox.ShowAsync(this, error, "设置不完整", MsgBoxButtons.OK);
        return false;
    }

    private async Task<bool> SaveSettings(bool notify)
    {
        DiscordBotSettings settings = ReadFields();
        if (!await ValidateSettings(settings, true)) return false;
        try
        {
            Directory.CreateDirectory(rootDir);
            string json = JsonSerializer.Serialize(settings, JsonOptions);
            KeychainHelper.SaveSettings(json);
            ApplyAutoStart(settings.AutoStart);
            AppendLog("设置已保存到本机钥匙串。");
            if (notify) await MessageBox.ShowAsync(this, "设置已安全保存。", "Takase Bot", MsgBoxButtons.OK);
            return true;
        }
        catch (Exception ex)
        {
            await MessageBox.ShowAsync(this, "保存设置失败：" + ex.Message, "Takase Bot", MsgBoxButtons.OK);
            return false;
        }
    }

    private void LoadSettings()
    {
        try
        {
            string? json = KeychainHelper.GetSettings();
            if (string.IsNullOrWhiteSpace(json)) return;
            DiscordBotSettings? settings = JsonSerializer.Deserialize<DiscordBotSettings>(json, JsonOptions);
            if (settings == null) return;
            txtApplicationId.Text = string.IsNullOrWhiteSpace(settings.ApplicationId) ? DefaultApplicationId : settings.ApplicationId;
            txtBotToken.Text = settings.BotToken ?? "";
            txtGuildId.Text = string.IsNullOrWhiteSpace(settings.GuildId) ? DefaultGuildId : settings.GuildId;
            txtChannelIds.Text = string.IsNullOrWhiteSpace(settings.ChannelIds) ? DefaultChannelId : settings.ChannelIds;
            txtProxyUrl.Text = string.IsNullOrWhiteSpace(settings.ProxyUrl) ? ProxyDetect.DetectSystemProxy() : settings.ProxyUrl;
            chkAutoStart.IsChecked = settings.AutoStart;
            AppendLog("已读取本机钥匙串中的设置。");
        }
        catch (Exception ex) { AppendLog("读取钥匙串设置失败：" + ex.Message); }
    }

    private void ApplyAutoStart(bool enabled)
    {
        try
        {
            AutoStart.Apply(enabled, Environment.ProcessPath ?? "");
        }
        catch (Exception ex) { AppendLog("自动启动设置失败：" + ex.Message); }
    }

    private void EnsureRuntime()
    {
        Directory.CreateDirectory(runtimeDir);
        Directory.CreateDirectory(dataDir);
        Directory.CreateDirectory(outputDir);
        ResourceExtractor.Extract("takase-discord-core", botCorePath);
        ResourceExtractor.Extract("ongeki-core", ongekiCorePath);
        ResourceExtractor.Extract("takase-discord-vault", vaultHelperPath);
    }

    private async Task StartBot()
    {
        if (botProcess != null && !botProcess.HasExited) return;
        DiscordBotSettings settings = ReadFields();
        if (!await ValidateSettings(settings, true) || !await SaveSettings(false)) return;
        try
        {
            EnsureRuntime();
            var config = new DiscordBotLaunchConfig
            {
                applicationId = settings.ApplicationId,
                botToken = settings.BotToken,
                guildId = settings.GuildId,
                channelIds = ParseChannelIds(settings.ChannelIds),
                proxyUrl = settings.ProxyUrl,
                workDir = dataDir,
                outputDir = outputDir,
                corePath = ongekiCorePath,
                vaultPath = vaultPath,
                vaultHelperPath = vaultHelperPath,
            };
            var psi = new ProcessStartInfo(botCorePath)
            {
                WorkingDirectory = runtimeDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            botProcess = new Process();
            botProcess.StartInfo = psi;
            botProcess.EnableRaisingEvents = true;
            botProcess.OutputDataReceived += OnBotOutput;
            botProcess.ErrorDataReceived += OnBotOutput;
            botProcess.Exited += OnBotExited;
            botProcess.Start();
            botProcess.BeginOutputReadLine();
            botProcess.BeginErrorReadLine();
            byte[] configBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(config));
            botProcess.StandardInput.BaseStream.Write(configBytes, 0, configBytes.Length);
            botProcess.StandardInput.BaseStream.Close();
            SetStatus("正在连接 Discord……", "#C4700C");
            btnStart.IsEnabled = false;
            btnStop.IsEnabled = true;
            AppendLog("正在注册斜杠指令并连接 Discord Gateway……");
        }
        catch (Exception ex)
        {
            SetStatus("启动失败", "#B22222");
            btnStart.IsEnabled = true;
            btnStop.IsEnabled = false;
            AppendLog("启动失败：" + ex.Message);
            await MessageBox.ShowAsync(this, "启动失败：" + ex.Message, "Takase Bot", MsgBoxButtons.OK);
        }
    }

    private void OnBotOutput(object sender, DataReceivedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(e.Data) || closing) return;
        Dispatcher.UIThread.Post(() => HandleBotLine(e.Data));
    }

    private void HandleBotLine(string line)
    {
        if (line == "BOT_READY") { SetStatus("运行中", "#168748"); return; }
        if (line.StartsWith("BOT_BINDING_COUNT:", StringComparison.Ordinal)) { lblBindingCount.Text = "已绑定用户：" + line.Substring(18); return; }
        if (line.StartsWith("BOT_BINDING_SAVED:", StringComparison.Ordinal)) { AppendLog("用户绑定成功：" + line.Substring(18)); return; }
        if (line.StartsWith("BOT_BUSY:", StringComparison.Ordinal))
        {
            bool idle = line == "BOT_BUSY:0";
            SetStatus(idle ? "运行中" : line.Substring(9), idle ? "#168748" : "#C4700C");
            return;
        }
        if (line.StartsWith("BOT_FATAL:", StringComparison.Ordinal)) { SetStatus("连接失败", "#B22222"); AppendLog("严重错误：" + line.Substring(10)); return; }
        if (line.StartsWith("BOT_ERROR:", StringComparison.Ordinal)) { AppendLog("错误：" + line.Substring(10)); return; }
        if (line.StartsWith("BOT_LOG:", StringComparison.Ordinal)) line = line.Substring(8);
        AppendLog(line);
    }

    private void OnBotExited(object? sender, EventArgs e)
    {
        if (closing) return;
        Dispatcher.UIThread.Post(() =>
        {
            int code = 0;
            try { code = botProcess?.ExitCode ?? 0; } catch { }
            SetStatus("已停止", code == 0 ? "#6A7486" : "#B22222");
            btnStart.IsEnabled = true;
            btnStop.IsEnabled = false;
            AppendLog("Bot 进程已结束（代码 " + code + "）。");
        });
    }

    private void StopBot()
    {
        Process? process = botProcess;
        if (process == null || process.HasExited)
        {
            SetStatus("已停止", "#6A7486");
            btnStart.IsEnabled = true;
            btnStop.IsEnabled = false;
            return;
        }
        try { process.Kill(entireProcessTree: true); } catch { }
        SetStatus("已停止", "#6A7486");
        btnStart.IsEnabled = true;
        btnStop.IsEnabled = false;
        AppendLog("Bot 已停止。");
    }

    private void RunVaultClear()
    {
        var psi = new ProcessStartInfo(vaultHelperPath);
        psi.ArgumentList.Add("clear");
        psi.ArgumentList.Add(vaultPath);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardError = true;
        psi.StandardErrorEncoding = Encoding.UTF8;
        using (var p = Process.Start(psi)!)
        {
            string stderr = p.StandardError.ReadToEnd();
            p.WaitForExit(15000);
            if (p.ExitCode != 0)
            {
                string message = stderr.Trim();
                if (message.StartsWith("VAULT_ERROR:", StringComparison.Ordinal)) message = message.Substring(11);
                throw new Exception(message.Length == 0 ? "清空绑定失败（退出码 " + p.ExitCode + "）" : message);
            }
        }
    }

    private async Task ClearBindings()
    {
        if (await MessageBox.ShowAsync(this, "这会删除全部 Discord 用户绑定的大饼账号，且无法恢复。确定继续吗？", "清空全部用户绑定", MsgBoxButtons.YesNo) != MsgBoxResult.Yes)
            return;
        StopBot();
        try
        {
            // macOS：凭据在钥匙串中，必须经 vault clear 清理（Windows 版直接删文件即可）
            RunVaultClear();
            lblBindingCount.Text = "已绑定用户：0";
            AppendLog("所有 Discord 用户绑定已清空。");
        }
        catch (Exception ex) { await MessageBox.ShowAsync(this, "清除失败：" + ex.Message, "Takase Bot", MsgBoxButtons.OK); }
    }

    private void SetStatus(string status, string color)
    {
        lblStatus.Text = "状态：" + status;
        lblStatus.Foreground = new SolidColorBrush(Color.Parse(color));
    }

    private void AppendLog(string message)
    {
        txtLog.Text += "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message.Trim() + Environment.NewLine;
        txtLog.CaretIndex = txtLog.Text.Length;
        txtLog.ScrollToEnd();
    }
}
