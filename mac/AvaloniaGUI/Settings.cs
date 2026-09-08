using System.Text.Json.Serialization;

namespace TakaseBotDiscord;

// 与 Windows 版 DiscordBotSettings / DiscordBotLaunchConfig 字段一一对应（camelCase）
public class DiscordBotSettings
{
    public string ApplicationId { get; set; } = "";
    public string BotToken { get; set; } = "";
    public string GuildId { get; set; } = "";
    public string ChannelIds { get; set; } = "";
    public string ProxyUrl { get; set; } = "";
    public bool AutoStart { get; set; }
}

public class DiscordBotLaunchConfig
{
    public string applicationId { get; set; } = "";
    public string botToken { get; set; } = "";
    public string guildId { get; set; } = "";
    public string[] channelIds { get; set; } = Array.Empty<string>();
    public string proxyUrl { get; set; } = "";
    public string workDir { get; set; } = "";
    public string outputDir { get; set; } = "";
    public string corePath { get; set; } = "";
    public string vaultPath { get; set; } = "";
    public string vaultHelperPath { get; set; } = "";
}
