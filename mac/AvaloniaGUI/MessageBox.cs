// 极简模态消息框（Avalonia 无内置 MessageBox），对拍 Windows 版 MessageBox.Show 用法。
// 必须在 UI 线程调用，调用方使用 async 事件处理器 await。
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace TakaseBotDiscord;

public enum MsgBoxButtons { OK, OKCancel, YesNo }
public enum MsgBoxResult { None, OK, Cancel, Yes, No }

public static class MessageBox
{
    public static async Task<MsgBoxResult> ShowAsync(Window? owner, string text, string title, MsgBoxButtons buttons = MsgBoxButtons.OK)
    {
        var dialog = new Window
        {
            Title = title,
            Width = 420,
            Height = 190,
            CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = new SolidColorBrush(Color.Parse("#F7F8FB")),
        };
        var panel = new StackPanel { Margin = new Thickness(20), Spacing = 12 };
        var textBlock = new TextBlock
        {
            Text = text,
            TextWrapping = TextWrapping.Wrap,
            MaxHeight = 84,
            VerticalAlignment = VerticalAlignment.Top,
            Foreground = new SolidColorBrush(Color.Parse("#232B3A")),
        };
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
        var result = MsgBoxResult.None;
        Button Make(string label, MsgBoxResult value, bool primary = false)
        {
            var b = new Button
            {
                Content = label,
                MinWidth = 84,
                Background = primary ? new SolidColorBrush(Color.Parse("#586EF2")) : new SolidColorBrush(Colors.White),
                Foreground = primary ? new SolidColorBrush(Colors.White) : new SolidColorBrush(Color.Parse("#182030")),
            };
            b.Click += (_, _) => { result = value; dialog.Close(); };
            return b;
        }
        switch (buttons)
        {
            case MsgBoxButtons.OK: row.Children.Add(Make("确定", MsgBoxResult.OK, true)); break;
            case MsgBoxButtons.OKCancel:
                row.Children.Add(Make("取消", MsgBoxResult.Cancel));
                row.Children.Add(Make("确定", MsgBoxResult.OK, true));
                break;
            case MsgBoxButtons.YesNo:
                row.Children.Add(Make("否", MsgBoxResult.No));
                row.Children.Add(Make("是", MsgBoxResult.Yes, true));
                break;
        }
        panel.Children.Add(textBlock);
        panel.Children.Add(row);
        dialog.Content = panel;
        if (owner != null)
            await dialog.ShowDialog(owner);
        else
            dialog.Show();
        return result;
    }
}
