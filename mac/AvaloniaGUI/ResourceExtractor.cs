// 从程序集内嵌资源解压三个 SEA 二进制到 runtime 目录。
// macOS 上必须设置可执行位（UnixFileMode），否则 spawn 报 EACCES。
using System;
using System.IO;
using System.Reflection;

namespace TakaseBotDiscord;

public static class ResourceExtractor
{
    public static void Extract(string resourceName, string destination)
    {
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
        {
            if (input == null) throw new Exception("内嵌资源缺失：" + resourceName);
            bool write = !File.Exists(destination) || new FileInfo(destination).Length != input.Length;
            if (!write) return;
            using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                input.CopyTo(output);
        }
        if (OperatingSystem.IsMacOS())
        {
            try
            {
                File.SetUnixFileMode(destination,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                    UnixFileMode.GroupRead | UnixFileMode.GroupExecute);
            }
            catch { }
        }
    }
}
