// MiaBot 多用户凭据库：使用 Windows DPAPI CurrentUser 加密整个账号库。
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class VaultEntry
{
    public string userId { get; set; }
    public string email { get; set; }
    public string password { get; set; }
    public string playerName { get; set; }
    public string boundAt { get; set; }
    public string dataSource { get; set; }
    public RinnetBinding rinnet { get; set; }
}

class RinnetBinding
{
    public string email { get; set; }
    public string playerName { get; set; }
    public string boundAt { get; set; }
    public string cardNumber { get; set; }
    public string aimeId { get; set; }
    public string sessionId { get; set; }
    public Dictionary<string, object> account { get; set; }
}

class BindingInput : RinnetBinding
{
    public string userId { get; set; }
    public string dataSource { get; set; }
    public string password { get; set; }
}

class VaultData
{
    public List<VaultEntry> entries { get; set; }
}

static class MiaVault
{
    // ⚠ 这个字节串是 DPAPI 的附加熵，**改了就解不开已有的 bindings.dat** ——
    // 所有老用户的账号绑定会一起失效。名字里的 Takase 是历史遗留，别顺手改。
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("TakaseDiscordBotBindingsV1");
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static VaultData Load(string vaultPath)
    {
        if (!File.Exists(vaultPath)) return new VaultData { entries = new List<VaultEntry>() };
        byte[] cipher = File.ReadAllBytes(vaultPath);
        byte[] plain = ProtectedData.Unprotect(cipher, Entropy, DataProtectionScope.CurrentUser);
        VaultData data = Json.Deserialize<VaultData>(Encoding.UTF8.GetString(plain));
        if (data == null) data = new VaultData();
        if (data.entries == null) data.entries = new List<VaultEntry>();
        return data;
    }

    private static void Save(string vaultPath, VaultData data)
    {
        string directory = Path.GetDirectoryName(Path.GetFullPath(vaultPath));
        Directory.CreateDirectory(directory);
        byte[] plain = Encoding.UTF8.GetBytes(Json.Serialize(data));
        byte[] cipher = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
        string temp = vaultPath + ".tmp";
        File.WriteAllBytes(temp, cipher);
        if (File.Exists(vaultPath)) File.Replace(temp, vaultPath, null);
        else File.Move(temp, vaultPath);
    }

    private static string MutexName(string path)
    {
        using (SHA256 sha = SHA256.Create()) {
            byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToLowerInvariant()));
            return "Local\\MiaBotVault_" + BitConverter.ToString(digest, 0, 12).Replace("-", "");
        }
    }

    private static VaultEntry Find(VaultData data, string userId)
    {
        return data.entries.Find(delegate(VaultEntry item) {
            return String.Equals(item.userId, userId, StringComparison.Ordinal);
        });
    }

    private static int Run(string[] args)
    {
        if (args.Length == 1 && args[0] == "--selftest") {
            byte[] plain = Encoding.UTF8.GetBytes("MiaBot Vault 自测");
            byte[] cipher = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
            string roundtrip = Encoding.UTF8.GetString(ProtectedData.Unprotect(cipher, Entropy, DataProtectionScope.CurrentUser));
            if (roundtrip != "MiaBot Vault 自测") return 10;
            string testPath = Path.Combine(Path.GetTempPath(), "MiaVaultSelftest_" + Guid.NewGuid().ToString("N") + ".dat");
            try {
                VaultData sample = new VaultData { entries = new List<VaultEntry>() };
                sample.entries.Add(new VaultEntry {
                    userId = "100000000000000001", email = "test@example.com", password = "密码♪",
                    playerName = "DEMO PLAYER", boundAt = DateTime.UtcNow.ToString("o")
                });
                Save(testPath, sample);
                VaultEntry loaded = Find(Load(testPath), "100000000000000001");
                return loaded != null && loaded.password == "密码♪" && loaded.playerName == "DEMO PLAYER" ? 0 : 11;
            } finally {
                if (File.Exists(testPath)) File.Delete(testPath);
                if (File.Exists(testPath + ".tmp")) File.Delete(testPath + ".tmp");
            }
        }
        if (args.Length < 2) throw new Exception("缺少凭据库命令或路径");
        string command = args[0];
        string vaultPath = Path.GetFullPath(args[1]);
        using (Mutex mutex = new Mutex(false, MutexName(vaultPath))) {
            if (!mutex.WaitOne(TimeSpan.FromSeconds(10))) throw new Exception("凭据库正忙");
            try {
                VaultData data = Load(vaultPath);
                if (command == "get") {
                    if (args.Length != 3) throw new Exception("get 参数无效");
                    VaultEntry entry = Find(data, args[2]);
                    if (entry == null) return 4;
                    Console.Write(Json.Serialize(entry));
                    return 0;
                }
                if (command == "set") {
                    BindingInput incoming = Json.Deserialize<BindingInput>(Console.In.ReadToEnd());
                    bool isRinnet = incoming != null && incoming.dataSource == "rinnet";
                    if (incoming == null || String.IsNullOrEmpty(incoming.userId) || String.IsNullOrEmpty(incoming.email) ||
                        (isRinnet ? (incoming.account == null || String.IsNullOrEmpty(incoming.aimeId) || String.IsNullOrEmpty(incoming.sessionId)) : String.IsNullOrEmpty(incoming.password))) {
                        throw new Exception("绑定数据不完整");
                    }
                    VaultEntry old = Find(data, incoming.userId);
                    if (old == null) { old = new VaultEntry { userId = incoming.userId, dataSource = incoming.dataSource ?? "otogame" }; data.entries.Add(old); }
                    if (isRinnet) {
                        // A re-bind must not overwrite a token refreshed since the
                        // caller read this binding.
                        if (old.rinnet != null && old.rinnet.sessionId == incoming.sessionId) incoming.account = old.rinnet.account;
                        old.rinnet = new RinnetBinding {
                            email = incoming.email, playerName = incoming.playerName, boundAt = incoming.boundAt,
                            cardNumber = incoming.cardNumber, aimeId = incoming.aimeId,
                            sessionId = incoming.sessionId, account = incoming.account
                        };
                    }
                    else { old.email = incoming.email; old.password = incoming.password; old.playerName = incoming.playerName; old.boundAt = incoming.boundAt; }
                    Save(vaultPath, data);
                    Console.Write("OK");
                    return 0;
                }
                if (command == "source") {
                    if (args.Length != 4 || (args[3] != "otogame" && args[3] != "rinnet")) throw new Exception("数据源参数无效");
                    VaultEntry entry = Find(data, args[2]);
                    if (entry == null) { entry = new VaultEntry { userId = args[2] }; data.entries.Add(entry); }
                    entry.dataSource = args[3];
                    Save(vaultPath, data); Console.Write("OK"); return 0;
                }
                if (command == "refresh-rinnet") {
                    BindingInput incoming = Json.Deserialize<BindingInput>(Console.In.ReadToEnd());
                    VaultEntry entry = incoming == null ? null : Find(data, incoming.userId);
                    // A late refresh must never resurrect an unbound/replaced account.
                    if (entry == null || entry.rinnet == null || entry.rinnet.sessionId != incoming.sessionId) return 4;
                    entry.rinnet.account = incoming.account;
                    Save(vaultPath, data); Console.Write("OK"); return 0;
                }
                if (command == "delete-source") {
                    if (args.Length != 4 || (args[3] != "otogame" && args[3] != "rinnet")) throw new Exception("数据源参数无效");
                    VaultEntry entry = Find(data, args[2]);
                    if (entry != null) {
                        if (args[3] == "rinnet") entry.rinnet = null;
                        else { entry.email = null; entry.password = null; entry.playerName = null; entry.boundAt = null; }
                        Save(vaultPath, data);
                    }
                    Console.Write("OK"); return 0;
                }
                if (command == "delete") {
                    if (args.Length != 3) throw new Exception("delete 参数无效");
                    data.entries.RemoveAll(delegate(VaultEntry item) { return String.Equals(item.userId, args[2], StringComparison.Ordinal); });
                    Save(vaultPath, data);
                    Console.Write("OK");
                    return 0;
                }
                if (command == "clear") {
                    data.entries.Clear();
                    Save(vaultPath, data);
                    Console.Write("OK");
                    return 0;
                }
                if (command == "count") {
                    Console.Write(data.entries.FindAll(delegate(VaultEntry item) { return !String.IsNullOrEmpty(item.password) || item.rinnet != null; }).Count.ToString());
                    return 0;
                }
                throw new Exception("未知凭据库命令");
            } finally {
                mutex.ReleaseMutex();
            }
        }
    }

    public static int Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        try { return Run(args); }
        catch (Exception ex) {
            Console.Error.Write("VAULT_ERROR:" + ex.Message);
            return 1;
        }
    }
}
