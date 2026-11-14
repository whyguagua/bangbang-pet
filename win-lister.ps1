# 邦邦桌宠 v3 - 窗口列举助手（马里奥平台的来源）
# 常驻进程：stdin 每来一行 "go"，就往 stdout 写一行 JSON 数组。
# 输出统一换算成 DIP（96 DPI 基准），和应用里的坐标系统一致。
# 由 main.js 启动，不要手动运行。
# 手工调试：'go' | powershell -NoProfile -ExecutionPolicy Bypass -File win-lister.ps1

param([int]$SelfPid = 0)

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinLister {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BITMAPINFO bi, uint usage);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder buf, ref int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static readonly System.Collections.Generic.Dictionary<uint, string> _exeCache =
    new System.Collections.Generic.Dictionary<uint, string>();

  // 进程可执行文件名（小写，带 .exe）。全屏检测要按进程名排除「看不见的覆盖窗」进程。
  static string ExeName(uint pid) {
    string name;
    if (_exeCache.TryGetValue(pid, out name)) return name;
    name = "";
    IntPtr h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
    if (h != IntPtr.Zero) {
      try {
        var sb = new StringBuilder(1024);
        int size = sb.Capacity;
        if (QueryFullProcessImageName(h, 0, sb, ref size)) {
          string full = sb.ToString();
          int i = full.LastIndexOf('\\');
          name = (i >= 0 ? full.Substring(i + 1) : full).ToLowerInvariant();
        }
      } finally { CloseHandle(h); }
    }
    _exeCache[pid] = name;
    return name;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount;
    public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter;
    public uint biClrUsed, biClrImportant;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint bmiColors; }

  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const int DWMWA_CLOAKED = 14;
  const int GWL_STYLE = -16;
  const int GWL_EXSTYLE = -20;
  const int WS_CAPTION = 0x00C00000;
  const int WS_EX_LAYERED = 0x00080000;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  const uint GW_OWNER = 4;
  const uint LWA_ALPHA = 2;
  // 全屏窗口（1920x1080 = 2073600 像素）也得能判断有没有画画，所以上限放到 4M，
  // 靠下面按质数步长抽样控制耗时（每帧只对「前台那一个大窗口」调用）。
  const int MAX_SAMPLE_PIXELS = 4200000;
  const int SAMPLE_STRIDE = 61;

  // 0 = 这个窗口一个像素都没画（看不见），1 = 有内容，-1 = 判断不了（当作看得见）
  static int Paints(IntPtr h, int w, int ht) {
    if (w <= 0 || ht <= 0) return -1;
    if ((long)w * ht > MAX_SAMPLE_PIXELS) return 1;
    IntPtr screen = IntPtr.Zero, mem = IntPtr.Zero, bmp = IntPtr.Zero, old = IntPtr.Zero;
    try {
      screen = GetDC(IntPtr.Zero);
      mem = CreateCompatibleDC(screen);
      bmp = CreateCompatibleBitmap(screen, w, ht);
      if (bmp == IntPtr.Zero) return -1;
      old = SelectObject(mem, bmp);
      if (!PrintWindow(h, mem, 2)) return -1;
      var bi = new BITMAPINFO();
      bi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
      bi.bmiHeader.biWidth = w;
      bi.bmiHeader.biHeight = -ht;
      bi.bmiHeader.biPlanes = 1;
      bi.bmiHeader.biBitCount = 32;
      bi.bmiHeader.biCompression = 0;
      byte[] buf = new byte[w * ht * 4];
      if (GetDIBits(mem, bmp, 0, (uint)ht, buf, ref bi, 0) <= 0) return -1;
      for (int i = 0; i < buf.Length; i += 4 * SAMPLE_STRIDE) {
        if (buf[i + 3] > 8 || buf[i] > 8 || buf[i + 1] > 8 || buf[i + 2] > 8) return 1;
      }
      return 0;
    } catch {
      return -1;
    } finally {
      if (old != IntPtr.Zero && mem != IntPtr.Zero) SelectObject(mem, old);
      if (bmp != IntPtr.Zero) DeleteObject(bmp);
      if (mem != IntPtr.Zero) DeleteDC(mem);
      if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen);
    }
  }

  public static string ListAll(int selfPid) {
    var sb = new StringBuilder(32768);
    sb.Append('[');
    bool first = true;
    int z = 0;
    // 前台窗口：判断「全屏看视频 / 打游戏」只认它（用户 m05900）。
    // 桌面上存在一整块 1920x1080 的不可见覆盖窗（airlinks 之类）会误判，所以不用「任何窗口盖满」。
    IntPtr fgWin = GetForegroundWindow();

    EnumWindows(delegate(IntPtr h, IntPtr l) {
      int myZ = z++;
      if (!IsWindowVisible(h)) return true;
      if (IsIconic(h)) return true;

      // 幽灵窗口：被 DWM cloak 掉的（别的虚拟桌面 / 挂起的 UWP）
      int cloaked = 0;
      if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;

      RECT r;
      if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0) {
        if (!GetWindowRect(h, out r)) return true;
      }

      // 物理像素 -> DIP
      double dpi = GetDpiForWindow(h);
      if (dpi <= 0) dpi = 96.0;
      double k = 96.0 / dpi;

      int x  = (int)Math.Round(r.Left * k);
      int y  = (int)Math.Round(r.Top * k);
      int w  = (int)Math.Round((r.Right - r.Left) * k);
      int ht = (int)Math.Round((r.Bottom - r.Top) * k);
      if (w < 40 || ht < 40) return true;

      uint pid;
      GetWindowThreadProcessId(h, out pid);
      // 自己的窗口（三个宠物）不算平台：它们就是精灵本身
      if (selfPid > 0 && pid == (uint)selfPid) return true;

      int ex = GetWindowLong(h, GWL_EXSTYLE);
      int style = GetWindowLong(h, GWL_STYLE);

      // 工具窗口（tooltip / 悬浮助手 / 输入法候选框）不能当平台。
      // 本机上被坑过的是 LeASWpTip 与 lxwp：都是 TOOLWINDOW + 有 owner + 无标题栏，
      // 屏幕上什么都看不见，却横在右边变成一个幽灵平台。
      if ((ex & WS_EX_TOOLWINDOW) != 0) {
        bool hasOwner = GetWindow(h, GW_OWNER) != IntPtr.Zero;
        bool hasCaption = (style & WS_CAPTION) == WS_CAPTION;
        if (hasOwner || !hasCaption) return true;
      }

      // 看不见的窗口不能当平台，否则角色会落在空气上。
      if ((ex & WS_EX_LAYERED) != 0) {
        uint key; byte alpha; uint flags;
        if (GetLayeredWindowAttributes(h, out key, out alpha, out flags)) {
          if ((flags & LWA_ALPHA) != 0 && alpha == 0) return true;
        } else {
          // UpdateLayeredWindow 的逐像素透明窗口（LeASWpTip、lxwp 这类辅助窗）
          // GetLayeredWindowAttributes 直接失败，只能看它到底画没画东西。
          if (Paints(h, r.Right - r.Left, r.Bottom - r.Top) == 0) return true;
        }
      }

      if (!first) sb.Append(',');
      first = false;
      sb.Append("{\"x\":").Append(x)
        .Append(",\"y\":").Append(y)
        .Append(",\"w\":").Append(w)
        .Append(",\"h\":").Append(ht)
        .Append(",\"pid\":").Append(pid)
        .Append(",\"z\":").Append(myZ)
        .Append(",\"fg\":").Append(h == fgWin ? 1 : 0)
        .Append(",\"exe\":\"").Append(ExeName(pid)).Append('"')
        .Append('}');
      return true;
    }, IntPtr.Zero);

    sb.Append(']');
    return sb.ToString();
  }
}
"@

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq 'go') {
    try {
      [Console]::Out.WriteLine([WinLister]::ListAll($SelfPid))
      [Console]::Out.Flush()
    } catch {
      [Console]::Out.WriteLine('[]')
      [Console]::Out.Flush()
    }
  }
}
