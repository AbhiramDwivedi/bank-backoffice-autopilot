// UIA bridge: the Windows half of @cu/adapter-desktop. Compiled and started by uia-bridge.ps1 and
// driven over stdio by packages/adapter-desktop/src/bridge-client.ts. One JSON object per line.
//
//   request   {"id":1,"op":"snapshot"}
//   response  {"id":1,"ok":true,"result":{...}}  |  {"id":1,"ok":false,"error":{"code":"...","message":"..."}}
//   event     {"event":"human","data":{...}}     (no id; pushed while capture is on)
//
// The bridge is deliberately dumb: it lists the owned process tree's windows and their UI
// Automation elements, runs one UIA pattern call, posts one key to one window, or captures one
// window. Every decision about locators, descriptors, conditions and masking policy lives in the
// TypeScript side, where it is testable on any OS against a fake bridge.
//
// Safety properties enforced here, not just in TypeScript:
//  - Scope. `attach` binds the bridge to ONE root process id, once. Every window and element the
//    bridge reports, acts on or captures must belong to that process or one of its descendants
//    (tracked by parent pid and creation time, so a recycled pid is not adopted). Anything else is
//    refused with `out_of_scope`.
//  - No global input, no activation. Nothing here calls SendInput, keybd_event, mouse_event,
//    SetCursorPos, SetForegroundWindow or SetFocus. Actions are UIA pattern calls, except where a
//    UIA proxy itself would activate the app or block it: a Win32 push button gets the BN_CLICKED
//    notification posted to its parent, a Win32 edit gets WM_SETTEXT on its own handle. `key` posts
//    WM_KEYDOWN/WM_KEYUP (or WM_CHAR) to the target's own window handle.
//  - Passwords. An element whose IsPassword is true never has its value read, and is always painted
//    over in screenshots, whatever the caller asks for.
//
// Uses the native COM UI Automation API (CUIAutomation8) through an interop assembly generated at
// first run from UIAutomationCore.dll's type library: the managed System.Windows.Automation client
// does not apply the Win32/MSAA proxies to Windows Forms controls and reports them all as unnamed
// panes. C# 5 (the compiler that ships with .NET Framework): no string interpolation, no `?.`.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Interop.UIAutomationClient;

namespace CuUiaBridge
{
    public class BridgeError : Exception
    {
        public readonly string Code;
        public BridgeError(string code, string message) : base(message) { Code = code; }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public int cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    public static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
        [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT r);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeoutMs, out IntPtr result);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
        [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")] public static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 pe);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")] public static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 pe);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    }

    /// <summary>The process tree this bridge may touch: one root and its descendants.</summary>
    public class Scope
    {
        readonly int rootPid;
        // pid -> process start time, as first seen. A pid whose start time changes was recycled.
        readonly Dictionary<int, DateTime> owned = new Dictionary<int, DateTime>();
        readonly object gate = new object();

        public Scope(int pid)
        {
            DateTime start;
            try
            {
                using (var p = Process.GetProcessById(pid))
                {
                    start = p.StartTime; // throws when the process cannot be opened
                    if (p.HasExited) throw new BridgeError("not_found", "process " + pid + " has exited");
                }
            }
            catch (ArgumentException) { throw new BridgeError("not_found", "no running process with id " + pid); }
            catch (System.ComponentModel.Win32Exception)
            {
                throw new BridgeError("access_denied", "access denied to process " + pid + " (it may run elevated or as another user)");
            }
            catch (InvalidOperationException) { throw new BridgeError("not_found", "no running process with id " + pid); }
            rootPid = pid;
            owned[pid] = start;
        }

        public int RootPid { get { return rootPid; } }

        /// <summary>
        /// Fails closed unless the root is the process the runtime just launched.
        ///
        /// The guarantee is the parent check: the root's parent must be `launchedBy`, the runtime's
        /// own process, which is alive while it asks, so its pid cannot have been recycled, and a
        /// process whose parent is the live runtime is one the runtime started. The time check is a
        /// sanity bound on top: the root must have started no earlier than `launchedAfter` (epoch ms,
        /// taken just before the spawn). Both sides are wall-clock (process creation times are), so
        /// a clock step between the two readings could skew them; the tolerance is 60 seconds, wide
        /// enough for any clock correction and still far narrower than a recycled pid's age.
        /// </summary>
        public void VerifyLaunched(int launchedBy, long launchedAfterMs)
        {
            int parent;
            if (!ParentTable().TryGetValue(rootPid, out parent) || parent != launchedBy)
                throw new BridgeError("not_launched", "process " + rootPid + " is not a child of the runtime (" + launchedBy + "); refusing to own it");
            long startMs = (long)(owned[rootPid].ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            if (startMs < launchedAfterMs - 60000)
                throw new BridgeError("not_launched", "process " + rootPid + " started before the runtime launched its app; refusing to own it");
        }

        /// <summary>pid -> parent pid for every process, from a Toolhelp snapshot.</summary>
        public static Dictionary<int, int> ParentTable()
        {
            var parents = new Dictionary<int, int>();
            IntPtr snap = Native.CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return parents;
            try
            {
                var pe = new PROCESSENTRY32();
                pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (Native.Process32First(snap, ref pe))
                {
                    do { parents[(int)pe.th32ProcessID] = (int)pe.th32ParentProcessID; } while (Native.Process32Next(snap, ref pe));
                }
            }
            finally { Native.CloseHandle(snap); }
            return parents;
        }

        static bool TryStart(int pid, out DateTime start)
        {
            start = DateTime.MinValue;
            try
            {
                using (var p = Process.GetProcessById(pid)) { start = p.StartTime; return !p.HasExited; }
            }
            catch (Exception) { return false; }
        }

        /// <summary>Re-reads the process table: drops exited or recycled pids, adopts new descendants.</summary>
        public HashSet<int> Refresh()
        {
            lock (gate)
            {
                foreach (var pid in new List<int>(owned.Keys))
                {
                    DateTime start;
                    if (!TryStart(pid, out start) || start != owned[pid]) owned.Remove(pid);
                }
                var parents = ParentTable();
                bool added = true;
                while (added)
                {
                    added = false;
                    foreach (var kv in parents)
                    {
                        if (owned.ContainsKey(kv.Key) || !owned.ContainsKey(kv.Value)) continue;
                        DateTime start;
                        // A child must have started after its parent, or the parent pid was recycled.
                        if (!TryStart(kv.Key, out start) || start < owned[kv.Value]) continue;
                        owned[kv.Key] = start;
                        added = true;
                    }
                }
                return new HashSet<int>(owned.Keys);
            }
        }

        public bool Owns(int pid)
        {
            lock (gate) { return owned.ContainsKey(pid); }
        }
    }

    public class Bridge
    {
        const int MaxElementsPerWindow = 1500;
        const int MaxDepth = 60;

        // Property ids (UIAutomationClient.h).
        const int P_RuntimeId = 30000, P_Bounding = 30001, P_ProcessId = 30002, P_ControlType = 30003, P_Name = 30005,
            P_HasKeyboardFocus = 30008, P_IsKeyboardFocusable = 30009, P_IsEnabled = 30010, P_AutomationId = 30011,
            P_ClassName = 30012, P_HelpText = 30013, P_LabeledBy = 30018, P_IsPassword = 30019, P_NativeWindowHandle = 30020,
            P_IsOffscreen = 30022, P_IsExpandCollapseAvail = 30028, P_IsInvokeAvail = 30031, P_IsSelectionItemAvail = 30036,
            P_IsSelectionAvail = 30037, P_IsToggleAvail = 30041, P_IsValueAvail = 30043, P_IsWindowAvail = 30044,
            P_ValueValue = 30045, P_ValueIsReadOnly = 30046, P_ExpandCollapseState = 30070, P_WindowIsModal = 30077,
            P_SelectionItemIsSelected = 30079, P_ToggleState = 30086, P_IsLegacyAvail = 30090, P_LegacyState = 30096;
        // Pattern ids.
        const int Pat_Invoke = 10000, Pat_Value = 10002, Pat_ExpandCollapse = 10005, Pat_Window = 10009,
            Pat_SelectionItem = 10010, Pat_Toggle = 10015, Pat_Legacy = 10018;
        // Control type ids used below.
        const int CT_ListItem = 50007, CT_TitleBar = 50037, CT_MenuBar = 50010;
        // Event ids.
        const int E_Invoked = 20009, E_ElementSelected = 20012, E_WindowOpened = 20016;

        static readonly string[] IgnoredWindowClasses = { "ConsoleWindowClass", "PseudoConsoleWindow", "IME", "MSCTFIME UI", "tooltips_class32" };

        readonly TextReader input;
        readonly TextWriter output;
        readonly object writeLock = new object();
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly CUIAutomation8 uia = new CUIAutomation8();
        readonly IUIAutomationCacheRequest cacheRequest;
        readonly object elementsLock = new object();
        Dictionary<string, IUIAutomationElement> elements = new Dictionary<string, IUIAutomationElement>();
        volatile Scope scope;
        readonly object scopeLock = new object();
        volatile bool capturing;
        CaptureHandler captureHandler;

        public Bridge(TextReader input, TextWriter output)
        {
            this.input = input;
            this.output = output;
            json.MaxJsonLength = int.MaxValue;
            // An app that stops answering (a busy or blocked UI thread) must cost a bounded wait per
            // call, not the 20s default; the caller sees the window under `skipped`.
            try
            {
                var u2 = (IUIAutomation2)uia;
                u2.ConnectionTimeout = 1500;
                u2.TransactionTimeout = 3000;
            }
            catch (Exception) { }
            cacheRequest = uia.CreateCacheRequest();
            cacheRequest.TreeScope = TreeScope.TreeScope_Subtree;
            cacheRequest.TreeFilter = uia.ControlViewCondition;
            cacheRequest.AutomationElementMode = AutomationElementMode.AutomationElementMode_Full;
            foreach (var p in new[] { P_RuntimeId, P_Bounding, P_ProcessId, P_ControlType, P_Name, P_HasKeyboardFocus, P_IsKeyboardFocusable,
                P_IsEnabled, P_AutomationId, P_ClassName, P_HelpText, P_LabeledBy, P_IsPassword, P_NativeWindowHandle, P_IsOffscreen,
                P_IsExpandCollapseAvail, P_IsInvokeAvail, P_IsSelectionItemAvail, P_IsSelectionAvail, P_IsToggleAvail, P_IsValueAvail,
                P_IsWindowAvail, P_ValueIsReadOnly, P_ExpandCollapseState, P_WindowIsModal, P_SelectionItemIsSelected, P_ToggleState,
                P_IsLegacyAvail, P_LegacyState })
            {
                cacheRequest.AddProperty(p);
            }
        }

        // --- plumbing ---------------------------------------------------------------------

        public void Write(Dictionary<string, object> message)
        {
            string line = json.Serialize(message);
            lock (writeLock)
            {
                output.Write(line);
                output.Write('\n');
                output.Flush();
            }
        }

        public void Emit(string name, object data)
        {
            var m = new Dictionary<string, object>();
            m["event"] = name;
            m["data"] = data;
            Write(m);
        }

        public void Run()
        {
            Emit("ready", Hello());
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> req;
                try { req = (Dictionary<string, object>)json.DeserializeObject(line); }
                catch (Exception) { continue; }
                if (req == null) continue;
                if (Str(req, "op") == "shutdown") { Reply(req, true, Hello(), null); break; }
                // Each request runs on its own pool thread: a UIA call the app answers slowly (or a
                // pattern call that opens a modal window) must not hold up the next request.
                var captured = req;
                ThreadPool.QueueUserWorkItem(delegate { Handle(captured); });
            }
            if (capturing) StopCapture();
        }

        void Reply(Dictionary<string, object> req, bool ok, object result, BridgeError error)
        {
            var m = new Dictionary<string, object>();
            object id;
            m["id"] = req.TryGetValue("id", out id) ? id : null;
            m["ok"] = ok;
            if (ok) m["result"] = result;
            else
            {
                var e = new Dictionary<string, object>();
                e["code"] = error.Code;
                e["message"] = error.Message;
                m["error"] = e;
            }
            Write(m);
        }

        void Handle(Dictionary<string, object> req)
        {
            try
            {
                Reply(req, true, Dispatch(req), null);
            }
            catch (BridgeError e) { Reply(req, false, null, e); }
            catch (COMException e) { Reply(req, false, null, new BridgeError("uia_error", e.Message)); }
            catch (Exception e) { Reply(req, false, null, new BridgeError("failed", e.GetType().Name + ": " + e.Message)); }
        }

        static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : null;
        }

        static int Int(Dictionary<string, object> d, string key, int fallback)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? Convert.ToInt32(v) : fallback;
        }

        static List<string> StrList(Dictionary<string, object> d, string key)
        {
            var list = new List<string>();
            object v;
            if (!d.TryGetValue(key, out v) || v == null) return list;
            var arr = v as object[];
            if (arr == null) { var al = v as System.Collections.ArrayList; if (al != null) arr = al.ToArray(); }
            if (arr == null) return list;
            foreach (var o in arr) if (o != null) list.Add(Convert.ToString(o));
            return list;
        }

        object Dispatch(Dictionary<string, object> req)
        {
            string op = Str(req, "op");
            switch (op)
            {
                case "hello": return Hello();
                case "attach": return Attach(req);
                case "snapshot": return Snapshot();
                case "act": return Act(req);
                case "key": return Key(req);
                case "screenshot": return Screenshot(req);
                case "foreground": return Foreground();
                case "captureStart": StartCapture(); return true;
                case "captureStop": StopCapture(); return true;
                default: throw new BridgeError("bad_request", "unknown op " + op);
            }
        }

        Dictionary<string, object> Hello()
        {
            var d = new Dictionary<string, object>();
            d["protocol"] = 1;
            d["bridgePid"] = Process.GetCurrentProcess().Id;
            var s = scope;
            if (s != null) d["pid"] = s.RootPid;
            return d;
        }

        Scope RequireScope()
        {
            var s = scope;
            if (s == null) throw new BridgeError("not_attached", "attach to a process first");
            return s;
        }

        // Held for the life of this process and never closed explicitly: when the bridge exits for any
        // reason (stdin closed because the runtime went away, killed, crashed) Windows closes it, and
        // KILL_ON_JOB_CLOSE ends every process of the launched app. No orphaned app windows.
        static IntPtr killJob = IntPtr.Zero;

        object Attach(Dictionary<string, object> req)
        {
            int pid = Int(req, "pid", 0);
            bool killOnClose = req.ContainsKey("killOnClose") && Convert.ToBoolean(req["killOnClose"]);
            Scope s;
            lock (scopeLock)
            {
                if (scope != null)
                {
                    if (scope.RootPid == pid) return Hello();
                    throw new BridgeError("already_attached", "this bridge is bound to process " + scope.RootPid + "; start another bridge for another process");
                }
                s = new Scope(pid);
                if (killOnClose)
                {
                    // Owning (and so ending) a process tree needs proof it is the one the runtime launched.
                    if (!req.ContainsKey("launchedBy") || !req.ContainsKey("launchedAfter"))
                        throw new BridgeError("bad_request", "killOnClose needs launchedBy and launchedAfter");
                    s.VerifyLaunched(Int(req, "launchedBy", 0), Convert.ToInt64(req["launchedAfter"]));
                }
                scope = s;
            }
            var d = Hello();
            try { using (var p = Process.GetProcessById(pid)) d["processName"] = p.ProcessName; } catch (Exception) { }
            if (killOnClose) d["killOnClose"] = TieToBridge(s);
            return d;
        }

        /// <summary>Puts the owned process tree in a job that dies with this bridge. True when the root was assigned.</summary>
        static bool TieToBridge(Scope s)
        {
            if (killJob == IntPtr.Zero)
            {
                var job = Native.CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return false;
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if (!Native.SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                {
                    Native.CloseHandle(job);
                    return false;
                }
                killJob = job;
            }
            bool rootAssigned = false;
            foreach (var pid in s.Refresh())
            {
                IntPtr h = Native.OpenProcess(0x0100 /* PROCESS_SET_QUOTA */ | 0x0001 /* PROCESS_TERMINATE */, false, pid);
                if (h == IntPtr.Zero) continue;
                try
                {
                    bool ok = Native.AssignProcessToJobObject(killJob, h);
                    if (pid == s.RootPid) rootAssigned = ok;
                }
                finally { Native.CloseHandle(h); }
            }
            return rootAssigned;
        }

        // --- windows ----------------------------------------------------------------------

        static string ClassOf(IntPtr hwnd)
        {
            var sb = new StringBuilder(256);
            Native.GetClassName(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        static string TitleOf(IntPtr hwnd)
        {
            var sb = new StringBuilder(1024);
            Native.GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        /// <summary>Visible top-level windows of the owned process tree, topmost first (z-order).</summary>
        List<IntPtr> OwnedWindows(HashSet<int> pids)
        {
            var list = new List<IntPtr>();
            Native.EnumWindows(delegate (IntPtr hwnd, IntPtr l)
            {
                uint pid;
                Native.GetWindowThreadProcessId(hwnd, out pid);
                if (!pids.Contains((int)pid) || !Native.IsWindowVisible(hwnd)) return true;
                string cls = ClassOf(hwnd);
                foreach (var ignored in IgnoredWindowClasses) if (cls == ignored) return true;
                RECT r;
                if (!Native.GetWindowRect(hwnd, out r) || r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return true;
                list.Add(hwnd);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        void RequireOwnedWindow(IntPtr hwnd, HashSet<int> pids)
        {
            uint pid;
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) throw new BridgeError("stale", "window no longer exists");
            Native.GetWindowThreadProcessId(hwnd, out pid);
            if (!pids.Contains((int)pid)) throw new BridgeError("out_of_scope", "window belongs to a process outside the attached process tree");
        }

        static Dictionary<string, object> Rect(RECT r)
        {
            var d = new Dictionary<string, object>();
            d["x"] = r.Left;
            d["y"] = r.Top;
            d["w"] = r.Right - r.Left;
            d["h"] = r.Bottom - r.Top;
            return d;
        }

        static RECT ClientScreenRect(IntPtr hwnd)
        {
            RECT c;
            Native.GetClientRect(hwnd, out c);
            var p = new POINT();
            Native.ClientToScreen(hwnd, ref p);
            var r = new RECT();
            r.Left = p.X;
            r.Top = p.Y;
            r.Right = p.X + (c.Right - c.Left);
            r.Bottom = p.Y + (c.Bottom - c.Top);
            return r;
        }

        static string Rid(object runtimeId)
        {
            var arr = runtimeId as Array;
            if (arr == null) return null;
            var parts = new List<string>();
            foreach (var o in arr) parts.Add(Convert.ToString(o));
            return string.Join(".", parts.ToArray());
        }

        static string ProcessNameOf(int pid)
        {
            try { using (var p = Process.GetProcessById(pid)) return p.ProcessName; } catch (Exception) { return ""; }
        }

        // --- snapshot ---------------------------------------------------------------------

        /// <summary>Longest string (name, value, title...) the bridge reports; longer ones are cut.</summary>
        public const int MaxStringLength = 1000;

        static string Cap(object v)
        {
            string s = Convert.ToString(v) ?? "";
            return s.Length > MaxStringLength ? s.Substring(0, MaxStringLength) : s;
        }

        /// <summary>
        /// The cache request for one walk: the base properties, and a tree filter that admits only
        /// elements of the owned process tree. Another program's window hosted inside the app (a
        /// child window re-parented into it) is never fetched, so none of its names or values reach
        /// this process.
        /// </summary>
        IUIAutomationCacheRequest ScopedCache(HashSet<int> pids)
        {
            var cr = cacheRequest.Clone();
            IUIAutomationCondition owned = null;
            foreach (var pid in pids)
            {
                var c = uia.CreatePropertyCondition(P_ProcessId, pid);
                owned = owned == null ? c : uia.CreateOrCondition(owned, c);
            }
            if (owned == null) owned = uia.CreateFalseCondition();
            cr.TreeFilter = uia.CreateAndCondition(uia.ControlViewCondition, owned);
            return cr;
        }

        /// <summary>
        /// Screen rectangles of child windows inside the app's windows that belong to some other
        /// process. Only handles, process ids and rectangles are read (Win32, no UI Automation):
        /// enough to paint them over in a screenshot, nothing of their content.
        /// </summary>
        static List<RECT> ForeignChildRects(List<IntPtr> windows, HashSet<int> pids)
        {
            var rects = new List<RECT>();
            foreach (var top in windows)
            {
                Native.EnumChildWindows(top, delegate (IntPtr child, IntPtr l)
                {
                    uint pid;
                    Native.GetWindowThreadProcessId(child, out pid);
                    if (!pids.Contains((int)pid) && Native.IsWindowVisible(child))
                    {
                        RECT r;
                        if (Native.GetWindowRect(child, out r)) rects.Add(r);
                    }
                    return true;
                }, IntPtr.Zero);
            }
            return rects;
        }

        object Snapshot()
        {
            var s = RequireScope();
            var pids = s.Refresh();
            var windows = new List<object>();
            var skipped = new List<object>();
            var index = new Dictionary<string, IUIAutomationElement>();
            var cache = ScopedCache(pids);
            foreach (var hwnd in OwnedWindows(pids))
            {
                try
                {
                    var root = uia.ElementFromHandleBuildCache(hwnd, cache);
                    windows.Add(DescribeWindow(hwnd, root, index, pids));
                }
                catch (COMException e)
                {
                    // A window that is closing, or an app that does not answer in time.
                    var sk = new Dictionary<string, object>();
                    sk["hwnd"] = hwnd.ToInt64();
                    sk["title"] = TitleOf(hwnd);
                    sk["error"] = e.Message;
                    skipped.Add(sk);
                }
            }
            lock (elementsLock) elements = index;
            var d = new Dictionary<string, object>();
            d["rootPid"] = s.RootPid;
            d["pids"] = new List<int>(pids);
            d["windows"] = windows;
            d["skipped"] = skipped;
            return d;
        }

        Dictionary<string, object> DescribeWindow(IntPtr hwnd, IUIAutomationElement root, Dictionary<string, IUIAutomationElement> index, HashSet<int> pids)
        {
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            RECT wr;
            Native.GetWindowRect(hwnd, out wr);
            IntPtr owner = Native.GetWindow(hwnd, 4 /* GW_OWNER */);
            var w = new Dictionary<string, object>();
            w["hwnd"] = hwnd.ToInt64();
            w["pid"] = (int)pid;
            w["processName"] = ProcessNameOf((int)pid);
            w["title"] = Cap(TitleOf(hwnd));
            w["className"] = Cap(ClassOf(hwnd));
            w["rect"] = Rect(wr);
            w["client"] = Rect(ClientScreenRect(hwnd));
            w["owner"] = owner.ToInt64();
            w["ownerEnabled"] = owner != IntPtr.Zero && Native.IsWindowEnabled(owner);
            w["enabled"] = Native.IsWindowEnabled(hwnd);
            w["minimized"] = Native.IsIconic(hwnd);
            w["scale"] = ScaleOf(hwnd);
            bool modal = false;
            try { modal = Convert.ToBoolean(root.GetCachedPropertyValue(P_WindowIsModal)); } catch (Exception) { }
            w["modal"] = modal;
            string windowRid = Rid(root.GetCachedPropertyValue(P_RuntimeId));
            w["rid"] = windowRid;
            // The window itself is addressable too (closeWindow acts on it).
            if (windowRid != null) index[windowRid] = root;
            var list = new List<object>();
            var pending = new List<KeyValuePair<Dictionary<string, object>, IUIAutomationElement>>();
            var children = root.GetCachedChildren();
            if (children != null)
            {
                for (int i = 0; i < children.Length; i++) Walk(children.GetElement(i), -1, 0, list, index, pending, pids);
            }
            // Values and label relations need live calls; read them once the structure is known.
            foreach (var kv in pending) FillLive(kv.Key, kv.Value);
            w["elements"] = list;
            return w;
        }

        void Walk(IUIAutomationElement e, int parent, int depth, List<object> list, Dictionary<string, IUIAutomationElement> index,
            List<KeyValuePair<Dictionary<string, object>, IUIAutomationElement>> pending, HashSet<int> pids)
        {
            if (list.Count >= MaxElementsPerWindow || depth > MaxDepth) return;
            // The cache's tree filter already excludes other processes; this is the second check.
            if (!pids.Contains(Convert.ToInt32(e.GetCachedPropertyValue(P_ProcessId)))) return;
            int ct = Convert.ToInt32(e.GetCachedPropertyValue(P_ControlType));
            string aid = Cap(e.GetCachedPropertyValue(P_AutomationId));
            // Window chrome (title bar, system menu) is not part of the application.
            if (ct == CT_TitleBar || (ct == CT_MenuBar && aid == "SystemMenuBar")) return;
            // UIA nests an owned top-level window (a dialog) under its owner; it is reported as its
            // own window instead, so its elements are not listed twice.
            if (ct == 50032)
            {
                var h = new IntPtr(Convert.ToInt64(e.GetCachedPropertyValue(P_NativeWindowHandle)));
                if (h != IntPtr.Zero && Native.GetAncestor(h, 2 /* GA_ROOT */) == h) return;
            }
            string rid = Rid(e.GetCachedPropertyValue(P_RuntimeId));
            if (rid == null) return;
            var el = new Dictionary<string, object>();
            el["rid"] = rid;
            el["parent"] = parent;
            el["ct"] = ct;
            el["name"] = Cap(e.GetCachedPropertyValue(P_Name));
            el["aid"] = aid;
            el["cls"] = Cap(e.GetCachedPropertyValue(P_ClassName));
            el["help"] = Cap(e.GetCachedPropertyValue(P_HelpText));
            var rect = e.GetCachedPropertyValue(P_Bounding) as double[];
            if (rect != null && rect.Length == 4)
            {
                el["x"] = (int)Math.Round(rect[0]);
                el["y"] = (int)Math.Round(rect[1]);
                el["w"] = (int)Math.Round(rect[2]);
                el["h"] = (int)Math.Round(rect[3]);
            }
            else { el["x"] = 0; el["y"] = 0; el["w"] = 0; el["h"] = 0; }
            bool password = Convert.ToBoolean(e.GetCachedPropertyValue(P_IsPassword));
            el["password"] = password;
            el["enabled"] = Convert.ToBoolean(e.GetCachedPropertyValue(P_IsEnabled));
            el["offscreen"] = Convert.ToBoolean(e.GetCachedPropertyValue(P_IsOffscreen));
            el["focusable"] = Convert.ToBoolean(e.GetCachedPropertyValue(P_IsKeyboardFocusable));
            el["focused"] = HasAppFocus(new IntPtr(Convert.ToInt64(e.GetCachedPropertyValue(P_NativeWindowHandle))),
                Convert.ToBoolean(e.GetCachedPropertyValue(P_HasKeyboardFocus)));
            el["hwnd"] = Convert.ToInt64(e.GetCachedPropertyValue(P_NativeWindowHandle));
            var patterns = new List<string>();
            if (Convert.ToBoolean(e.GetCachedPropertyValue(P_IsInvokeAvail))) patterns.Add("invoke");
            if (Convert.ToBoolean(e.GetCachedPropertyValue(P_IsValueAvail))) patterns.Add("value");
            if (Convert.ToBoolean(e.GetCachedPropertyValue(P_IsToggleAvail))) patterns.Add("toggle");
            if (Convert.ToBoolean(e.GetCachedPropertyValue(P_IsSelectionItemAvail))) patterns.Add("selectionItem");
            if (Convert.ToBoolean(e.GetCachedPropertyValue(P_IsSelectionAvail))) patterns.Add("selection");
            if (Convert.ToBoolean(e.GetCachedPropertyValue(P_IsExpandCollapseAvail))) patterns.Add("expandCollapse");
            if (Convert.ToBoolean(e.GetCachedPropertyValue(P_IsWindowAvail))) patterns.Add("window");
            bool legacy = Convert.ToBoolean(e.GetCachedPropertyValue(P_IsLegacyAvail));
            if (legacy) patterns.Add("legacy");
            el["patterns"] = patterns;
            if (patterns.Contains("value")) el["readOnly"] = Convert.ToBoolean(e.GetCachedPropertyValue(P_ValueIsReadOnly));
            if (patterns.Contains("toggle"))
            {
                int ts = Convert.ToInt32(e.GetCachedPropertyValue(P_ToggleState));
                el["toggle"] = ts == 1 ? "on" : ts == 0 ? "off" : "indeterminate";
            }
            if (patterns.Contains("selectionItem")) el["selected"] = Convert.ToBoolean(e.GetCachedPropertyValue(P_SelectionItemIsSelected));
            if (patterns.Contains("expandCollapse"))
            {
                int ecs = Convert.ToInt32(e.GetCachedPropertyValue(P_ExpandCollapseState));
                el["expanded"] = ecs == 1 || ecs == 2;
            }
            if (legacy)
            {
                int state = Convert.ToInt32(e.GetCachedPropertyValue(P_LegacyState));
                el["isDefault"] = (state & 0x100) != 0; // STATE_SYSTEM_DEFAULT
            }
            int myIndex = list.Count;
            list.Add(el);
            index[rid] = e;
            pending.Add(new KeyValuePair<Dictionary<string, object>, IUIAutomationElement>(el, e));
            var children = e.GetCachedChildren();
            if (children == null) return;
            for (int i = 0; i < children.Length; i++) Walk(children.GetElement(i), myIndex, depth + 1, list, index, pending, pids);
        }

        static void FillLive(Dictionary<string, object> el, IUIAutomationElement e)
        {
            try
            {
                var lb = e.GetCachedPropertyValue(P_LabeledBy) as IUIAutomationElement;
                if (lb != null) el["labeledBy"] = Rid(lb.GetRuntimeId());
            }
            catch (Exception) { }
            // Never read the value of a password field: not here, not anywhere.
            if ((bool)el["password"]) return;
            if (!((List<string>)el["patterns"]).Contains("value")) return;
            try { el["value"] = Cap(e.GetCurrentPropertyValue(P_ValueValue)); } catch (Exception) { }
        }

        IUIAutomationElement Lookup(string rid)
        {
            var s = RequireScope();
            IUIAutomationElement e = null;
            lock (elementsLock) elements.TryGetValue(rid, out e);
            if (e == null)
            {
                Snapshot();
                lock (elementsLock) elements.TryGetValue(rid, out e);
            }
            if (e == null) throw new BridgeError("stale", "no element " + rid + " in the attached application (it may have closed or been rebuilt)");
            int pid;
            try { pid = e.CurrentProcessId; }
            catch (COMException) { throw new BridgeError("stale", "element " + rid + " is gone"); }
            s.Refresh();
            if (!s.Owns(pid)) throw new BridgeError("out_of_scope", "element belongs to a process outside the attached process tree");
            return e;
        }

        // --- actions ----------------------------------------------------------------------

        /// <summary>
        /// Runs a pattern call on its own thread and waits up to blockMs. A pattern call into a Windows
        /// Forms app runs the control's handler synchronously, so a click that opens a modal window does
        /// not return until that window closes; the caller gets done=false and observes the result.
        /// </summary>
        static bool RunBounded(Action call, int blockMs)
        {
            Exception failure = null;
            var t = new Thread(delegate ()
            {
                try { call(); } catch (Exception e) { failure = e; }
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
            if (!t.Join(blockMs)) return false;
            if (failure != null)
            {
                if (failure is BridgeError) throw failure;
                throw new BridgeError("pattern_failed", failure.Message);
            }
            return true;
        }

        object Act(Dictionary<string, object> req)
        {
            string rid = Str(req, "rid");
            string kind = Str(req, "kind");
            string value = Str(req, "value");
            int blockMs = Int(req, "blockMs", 1500);
            var e = Lookup(rid);
            Action call;
            switch (kind)
            {
                case "invoke":
                    if (PostButtonClick(e))
                    {
                        var posted = new Dictionary<string, object>();
                        posted["done"] = true;
                        posted["via"] = "bn_clicked";
                        return posted;
                    }
                    call = delegate { Pattern<IUIAutomationInvokePattern>(e, Pat_Invoke, "Invoke").Invoke(); };
                    break;
                case "toggle":
                    call = delegate { Pattern<IUIAutomationTogglePattern>(e, Pat_Toggle, "Toggle").Toggle(); };
                    break;
                case "select":
                    call = delegate { Pattern<IUIAutomationSelectionItemPattern>(e, Pat_SelectionItem, "SelectionItem").Select(); };
                    break;
                case "expand":
                    call = delegate { Pattern<IUIAutomationExpandCollapsePattern>(e, Pat_ExpandCollapse, "ExpandCollapse").Expand(); };
                    break;
                case "collapse":
                    call = delegate { Pattern<IUIAutomationExpandCollapsePattern>(e, Pat_ExpandCollapse, "ExpandCollapse").Collapse(); };
                    break;
                case "legacyDefault":
                    call = delegate { Pattern<IUIAutomationLegacyIAccessiblePattern>(e, Pat_Legacy, "LegacyIAccessible").DoDefaultAction(); };
                    break;
                case "closeWindow":
                    call = delegate { Pattern<IUIAutomationWindowPattern>(e, Pat_Window, "Window").Close(); };
                    break;
                case "setValue":
                    if (value == null) throw new BridgeError("bad_request", "setValue needs a value");
                    if (SetWin32Text(e, value))
                    {
                        var set = new Dictionary<string, object>();
                        set["done"] = true;
                        set["via"] = "wm_settext";
                        return set;
                    }
                    call = delegate
                    {
                        var vp = Pattern<IUIAutomationValuePattern>(e, Pat_Value, "Value");
                        if (vp.CurrentIsReadOnly != 0) throw new BridgeError("read_only", "the control is read-only");
                        vp.SetValue(value);
                    };
                    break;
                case "selectOption":
                    if (value == null) throw new BridgeError("bad_request", "selectOption needs a value");
                    call = delegate { SelectOption(e, value); };
                    break;
                default:
                    throw new BridgeError("bad_request", "unknown act kind " + kind);
            }
            var d = new Dictionary<string, object>();
            d["done"] = RunBounded(call, blockMs);
            return d;
        }

        /// <summary>
        /// A Win32 push button (including a Windows Forms button) is clicked by posting the BN_CLICKED
        /// notification its parent would receive, instead of the UIA Invoke pattern. Invoke on such a
        /// button runs the click handler inside the cross-process call, so a handler that opens a modal
        /// window leaves the app's UI thread inside that call: every UIA request to the app then times
        /// out until the window closes, which would blind the surface exactly when a dialog needs
        /// handling. The posted notification is the app's own message to its own window; no input is
        /// synthesized and nothing is activated. Returns false when the element is not such a button.
        /// </summary>
        bool PostButtonClick(IUIAutomationElement e)
        {
            IntPtr hwnd;
            try { hwnd = e.CurrentNativeWindowHandle; } catch (COMException) { return false; }
            if (hwnd == IntPtr.Zero || ClassOf(hwnd).IndexOf("BUTTON", StringComparison.OrdinalIgnoreCase) < 0) return false;
            int type = Native.GetWindowLong(hwnd, -16 /* GWL_STYLE */) & 0xF;
            if (type != 0x0 && type != 0x1 && type != 0xB) return false; // push, default push, owner-drawn
            // A button of a window disabled by a modal dialog is not clickable, even though its own
            // window handle is still enabled: a click must not reach a form its app has locked.
            if (!Native.IsWindowEnabled(hwnd) || !Native.IsWindowEnabled(Native.GetAncestor(hwnd, 2 /* GA_ROOT */)))
                throw new BridgeError("disabled", "the button is disabled");
            IntPtr parent = Native.GetParent(hwnd);
            if (parent == IntPtr.Zero) return false;
            RequireOwnedWindow(parent, RequireScope().Refresh());
            int id = Native.GetDlgCtrlID(hwnd);
            var wParam = new IntPtr((id & 0xFFFF) | (0 /* BN_CLICKED */ << 16));
            return Native.PostMessage(parent, 0x0111 /* WM_COMMAND */, wParam, hwnd);
        }

        /// <summary>
        /// A Win32 edit control (including a Windows Forms TextBox) gets its text with WM_SETTEXT, sent
        /// to its own window handle, instead of the UIA Value pattern: the UIA Win32 edit proxy's
        /// SetValue brings the app's window to the foreground (measured on Windows 11 against
        /// Teller Workstation), which would take the screen from the person using the machine. The
        /// edit raises EN_CHANGE exactly as for SetValue. False when the element is not such an edit.
        /// </summary>
        bool SetWin32Text(IUIAutomationElement e, string value)
        {
            IntPtr hwnd;
            try { hwnd = e.CurrentNativeWindowHandle; } catch (COMException) { return false; }
            if (hwnd == IntPtr.Zero || ClassOf(hwnd).IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) < 0) return false;
            if ((Native.GetWindowLong(hwnd, -16 /* GWL_STYLE */) & 0x0800 /* ES_READONLY */) != 0) throw new BridgeError("read_only", "the control is read-only");
            if (!Native.IsWindowEnabled(hwnd) || !Native.IsWindowEnabled(Native.GetAncestor(hwnd, 2 /* GA_ROOT */)))
                throw new BridgeError("disabled", "the control is disabled");
            IntPtr ignored;
            IntPtr ok = Native.SendMessageTimeout(hwnd, 0x000C /* WM_SETTEXT */, IntPtr.Zero, value, 0x0002 /* SMTO_ABORTIFHUNG */, 5000, out ignored);
            if (ok == IntPtr.Zero) throw new BridgeError("pattern_failed", "the application did not accept the text (it may be hung)");
            return true;
        }

        /// <summary>Whether the foreground window belongs to the attached process tree. Nothing about any other window is reported.</summary>
        object Foreground()
        {
            var s = RequireScope();
            var pids = s.Refresh();
            uint pid;
            Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
            var d = new Dictionary<string, object>();
            d["owned"] = pids.Contains((int)pid);
            return d;
        }

        /// <summary>
        /// Whether a control has its application's keyboard focus: for a windowed control, the focus
        /// window of the app's own UI thread (true whether or not the app is in the foreground, so it
        /// reads the same while a person types and while nobody does); for a windowless one, UIA's
        /// system-wide HasKeyboardFocus.
        /// </summary>
        static bool HasAppFocus(IntPtr hwnd, bool uiaFocus)
        {
            if (hwnd == IntPtr.Zero) return uiaFocus;
            uint ignored;
            uint tid = Native.GetWindowThreadProcessId(hwnd, out ignored);
            var info = new GUITHREADINFO();
            info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            return Native.GetGUIThreadInfo(tid, ref info) ? info.hwndFocus == hwnd : uiaFocus;
        }

        static T Pattern<T>(IUIAutomationElement e, int patternId, string label) where T : class
        {
            var p = e.GetCurrentPattern(patternId) as T;
            if (p == null) throw new BridgeError("no_pattern", "the control does not support the UIA " + label + " pattern");
            return p;
        }

        void SelectOption(IUIAutomationElement e, string value)
        {
            var cond = uia.CreateAndCondition(
                uia.CreatePropertyCondition(P_ControlType, CT_ListItem),
                uia.CreatePropertyCondition(P_Name, value));
            var item = e.FindFirst(TreeScope.TreeScope_Descendants, cond);
            var ec = e.GetCurrentPattern(Pat_ExpandCollapse) as IUIAutomationExpandCollapsePattern;
            if (item == null && ec != null)
            {
                ec.Expand();
                Thread.Sleep(100);
                item = e.FindFirst(TreeScope.TreeScope_Descendants, cond);
            }
            if (item != null)
            {
                var si = item.GetCurrentPattern(Pat_SelectionItem) as IUIAutomationSelectionItemPattern;
                if (si == null) throw new BridgeError("no_pattern", "the option does not support the UIA SelectionItem pattern");
                si.Select();
                if (ec != null) { try { ec.Collapse(); } catch (Exception) { } }
                return;
            }
            var vp = e.GetCurrentPattern(Pat_Value) as IUIAutomationValuePattern;
            if (vp != null && vp.CurrentIsReadOnly == 0) { vp.SetValue(value); return; }
            throw new BridgeError("option_not_found", "no option named \"" + value + "\"");
        }

        static readonly Dictionary<string, int> VirtualKeys = BuildVirtualKeys();

        static Dictionary<string, int> BuildVirtualKeys()
        {
            var k = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            k["Enter"] = 0x0D; k["NumpadEnter"] = 0x0D; k["Tab"] = 0x09; k["Escape"] = 0x1B; k["Backspace"] = 0x08; k["Delete"] = 0x2E;
            k["Space"] = 0x20; k["ArrowUp"] = 0x26; k["ArrowDown"] = 0x28; k["ArrowLeft"] = 0x25; k["ArrowRight"] = 0x27;
            k["Home"] = 0x24; k["End"] = 0x23; k["PageUp"] = 0x21; k["PageDown"] = 0x22;
            for (int i = 1; i <= 12; i++) k["F" + i] = 0x6F + i;
            return k;
        }

        /// <summary>
        /// Posts one key to one window of the attached app: the element's own window handle (or its
        /// nearest ancestor's), else the window that has keyboard focus on the app's UI thread. The app
        /// translates the posted WM_KEYDOWN itself, exactly as it would a real key; nothing is injected
        /// into the system input queue.
        /// </summary>
        object Key(Dictionary<string, object> req)
        {
            var s = RequireScope();
            var pids = s.Refresh();
            string key = Str(req, "key");
            if (string.IsNullOrEmpty(key)) throw new BridgeError("bad_request", "key needs a key");
            IntPtr target = IntPtr.Zero;
            string rid = Str(req, "rid");
            if (rid != null)
            {
                var e = Lookup(rid);
                target = e.CurrentNativeWindowHandle;
                if (target == IntPtr.Zero)
                {
                    var walker = uia.ControlViewWalker;
                    var p = walker.GetParentElement(e);
                    while (p != null && target == IntPtr.Zero)
                    {
                        target = p.CurrentNativeWindowHandle;
                        p = walker.GetParentElement(p);
                    }
                }
            }
            else
            {
                long hwndArg = Convert.ToInt64(req.ContainsKey("hwnd") ? req["hwnd"] : 0);
                IntPtr top = new IntPtr(hwndArg);
                if (top == IntPtr.Zero)
                {
                    var wins = OwnedWindows(pids);
                    if (wins.Count == 0) throw new BridgeError("stale", "the attached application has no visible window");
                    top = wins[0];
                }
                RequireOwnedWindow(top, pids);
                uint ignored;
                uint tid = Native.GetWindowThreadProcessId(top, out ignored);
                var info = new GUITHREADINFO();
                info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
                target = Native.GetGUIThreadInfo(tid, ref info) && info.hwndFocus != IntPtr.Zero ? info.hwndFocus : top;
            }
            RequireOwnedWindow(target, pids);
            int vk;
            if (VirtualKeys.TryGetValue(key, out vk))
            {
                uint scan = Native.MapVirtualKey((uint)vk, 0);
                long down = 1 | ((long)scan << 16);
                long up = down | 0xC0000000L;
                Native.PostMessage(target, 0x0100 /* WM_KEYDOWN */, new IntPtr(vk), new IntPtr(down));
                Native.PostMessage(target, 0x0101 /* WM_KEYUP */, new IntPtr(vk), new IntPtr(unchecked((int)up)));
            }
            else if (key.Length == 1)
            {
                Native.PostMessage(target, 0x0102 /* WM_CHAR */, new IntPtr(key[0]), new IntPtr(1));
            }
            else
            {
                throw new BridgeError("unsupported_key", "key \"" + key + "\" needs synthesized keyboard input (modifier chords are not posted)");
            }
            var d = new Dictionary<string, object>();
            d["hwnd"] = target.ToInt64();
            return d;
        }

        // --- screenshot -------------------------------------------------------------------

        /// <summary>
        /// The main window's client area with the attached app's other visible windows (dialogs)
        /// composited on top, each captured with PrintWindow from its own surface, so other apps'
        /// windows that overlap it on screen never appear. Painted over: every password field, the
        /// elements named in maskRids, the rectangles in maskRects (screen coordinates), and every
        /// child window of another process hosted inside the app's windows. No typed value is ever
        /// sent here: the caller decides which fields hold one and names them by maskRids.
        /// </summary>
        object Screenshot(Dictionary<string, object> req)
        {
            var s = RequireScope();
            var pids = s.Refresh();
            IntPtr main = new IntPtr(Convert.ToInt64(req.ContainsKey("hwnd") ? req["hwnd"] : 0));
            RequireOwnedWindow(main, pids);
            var maskRids = new HashSet<string>(StrList(req, "maskRids"));
            var client = ClientScreenRect(main);
            // Physical pixels per screenshot pixel: a DPI-unaware app renders at 96 DPI and Windows
            // stretches it on screen, so its own capture is smaller than its on-screen rectangle.
            double scale = ScaleOf(main);
            int cw = Math.Max(1, (int)Math.Round((client.Right - client.Left) / scale));
            int ch = Math.Max(1, (int)Math.Round((client.Bottom - client.Top) / scale));
            var wins = OwnedWindows(pids);
            var masks = new List<RECT>();
            using (var bmp = new Bitmap(cw, ch, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.FromArgb(255, 127, 127, 127));
                    // EnumWindows lists topmost first; paint bottom-up.
                    for (int i = wins.Count - 1; i >= 0; i--)
                    {
                        var hwnd = wins[i];
                        if (Native.IsIconic(hwnd)) continue;
                        RECT wr;
                        Native.GetWindowRect(hwnd, out wr);
                        double ws = ScaleOf(hwnd);
                        int ww = (int)Math.Round((wr.Right - wr.Left) / ws), wh = (int)Math.Round((wr.Bottom - wr.Top) / ws);
                        if (ww <= 0 || wh <= 0) continue;
                        using (var wb = new Bitmap(ww, wh, PixelFormat.Format32bppArgb))
                        {
                            using (var wg = Graphics.FromImage(wb))
                            {
                                IntPtr hdc = wg.GetHdc();
                                try { Native.PrintWindow(hwnd, hdc, 2 /* PW_RENDERFULLCONTENT */); }
                                finally { wg.ReleaseHdc(hdc); }
                            }
                            int dx = (int)Math.Round((wr.Left - client.Left) / scale), dy = (int)Math.Round((wr.Top - client.Top) / scale);
                            if (Math.Abs(ws - scale) < 0.01) g.DrawImageUnscaled(wb, dx, dy);
                            else g.DrawImage(wb, dx, dy, (float)((wr.Right - wr.Left) / scale), (float)((wr.Bottom - wr.Top) / scale));
                        }
                    }
                    // Masks from a fresh walk, so a field that appeared since the caller's last snapshot is covered.
                    var cache = ScopedCache(pids);
                    foreach (var hwnd in wins)
                    {
                        IUIAutomationElement root;
                        try { root = uia.ElementFromHandleBuildCache(hwnd, cache); } catch (COMException) { continue; }
                        CollectMasks(root, maskRids, masks, 0);
                    }
                    // Another program's window hosted inside the app: never shown.
                    masks.AddRange(ForeignChildRects(wins, pids));
                    foreach (var o in StrList(req, "maskRects"))
                    {
                        var parts = o.Split(',');
                        if (parts.Length != 4) continue;
                        var r = new RECT();
                        r.Left = int.Parse(parts[0]); r.Top = int.Parse(parts[1]);
                        r.Right = r.Left + int.Parse(parts[2]); r.Bottom = r.Top + int.Parse(parts[3]);
                        masks.Add(r);
                    }
                    using (var brush = new SolidBrush(Color.FromArgb(255, 127, 127, 127)))
                    {
                        foreach (var r in masks)
                        {
                            float x = (float)Math.Floor((r.Left - client.Left) / scale), y = (float)Math.Floor((r.Top - client.Top) / scale);
                            float w = (float)Math.Ceiling((r.Right - r.Left) / scale) + 1, h = (float)Math.Ceiling((r.Bottom - r.Top) / scale) + 1;
                            g.FillRectangle(brush, x, y, w, h);
                        }
                    }
                }
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    var d = new Dictionary<string, object>();
                    d["png"] = Convert.ToBase64String(ms.ToArray());
                    d["origin"] = Rect(client);
                    d["scale"] = scale;
                    d["width"] = cw;
                    d["height"] = ch;
                    d["masked"] = masks.Count;
                    d["minimized"] = Native.IsIconic(main);
                    return d;
                }
            }
        }

        /// <summary>Physical screen pixels per pixel of the window's own rendering (1 for DPI-aware windows).</summary>
        static double ScaleOf(IntPtr hwnd)
        {
            try
            {
                int awareness = Native.GetAwarenessFromDpiAwarenessContext(Native.GetWindowDpiAwarenessContext(hwnd));
                if (awareness == 2) return 1.0; // per-monitor aware: renders at the monitor's DPI
                uint windowDpi = Native.GetDpiForWindow(hwnd);
                uint mx, my;
                IntPtr monitor = Native.MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
                if (windowDpi == 0 || Native.GetDpiForMonitor(monitor, 0 /* MDT_EFFECTIVE_DPI */, out mx, out my) != 0) return 1.0;
                double s = mx / (double)windowDpi;
                return s > 0.5 && s < 8 ? s : 1.0;
            }
            catch (Exception) { return 1.0; }
        }

        void CollectMasks(IUIAutomationElement e, HashSet<string> maskRids, List<RECT> masks, int depth)
        {
            if (depth > MaxDepth) return;
            var children = e.GetCachedChildren();
            if (children == null) return;
            for (int i = 0; i < children.Length; i++)
            {
                var c = children.GetElement(i);
                bool mask = Convert.ToBoolean(c.GetCachedPropertyValue(P_IsPassword));
                if (!mask && maskRids.Count > 0)
                {
                    string rid = Rid(c.GetCachedPropertyValue(P_RuntimeId));
                    mask = rid != null && maskRids.Contains(rid);
                }
                if (mask)
                {
                    var rect = c.GetCachedPropertyValue(P_Bounding) as double[];
                    if (rect != null && rect.Length == 4)
                    {
                        var r = new RECT();
                        r.Left = (int)Math.Floor(rect[0]) - 1; r.Top = (int)Math.Floor(rect[1]) - 1;
                        r.Right = (int)Math.Ceiling(rect[0] + rect[2]) + 1; r.Bottom = (int)Math.Ceiling(rect[1] + rect[3]) + 1;
                        masks.Add(r);
                    }
                }
                CollectMasks(c, maskRids, masks, depth + 1);
            }
        }

        // --- human-action capture ---------------------------------------------------------

        void StartCapture()
        {
            var s = RequireScope();
            lock (scopeLock)
            {
                if (capturing) return;
                captureHandler = new CaptureHandler(this, s);
                var root = uia.GetRootElement();
                // New windows of the app (a dialog opening, a new screen) are reported as navigation;
                // handlers are attached per window so nothing outside the process tree is subscribed.
                uia.AddAutomationEventHandler(E_WindowOpened, root, TreeScope.TreeScope_Children, null, captureHandler);
                foreach (var hwnd in OwnedWindows(s.Refresh())) captureHandler.Watch(uia, hwnd);
                capturing = true;
            }
        }

        void StopCapture()
        {
            lock (scopeLock)
            {
                if (!capturing) return;
                capturing = false;
                try { uia.RemoveAllEventHandlers(); } catch (Exception) { }
                captureHandler = null;
            }
        }

        public CUIAutomation8 Uia { get { return uia; } }

        /// <summary>Receives UIA events for the attached app and emits HumanAction-shaped facts. Never values.</summary>
        public class CaptureHandler : IUIAutomationEventHandler, IUIAutomationPropertyChangedEventHandler
        {
            readonly Bridge bridge;
            readonly Scope scope;
            readonly HashSet<long> watched = new HashSet<long>();

            public CaptureHandler(Bridge bridge, Scope scope) { this.bridge = bridge; this.scope = scope; }

            public void Watch(CUIAutomation8 uia, IntPtr hwnd)
            {
                lock (watched) { if (!watched.Add(hwnd.ToInt64())) return; }
                IUIAutomationElement w;
                try { w = uia.ElementFromHandle(hwnd); } catch (COMException) { return; }
                uia.AddAutomationEventHandler(E_Invoked, w, TreeScope.TreeScope_Subtree, null, this);
                uia.AddAutomationEventHandler(E_ElementSelected, w, TreeScope.TreeScope_Subtree, null, this);
                uia.AddPropertyChangedEventHandler(w, TreeScope.TreeScope_Subtree, null, this, new[] { P_ValueValue, P_ToggleState, P_Name });
            }

            Dictionary<string, object> Describe(IUIAutomationElement sender, string type)
            {
                int pid;
                try { pid = sender.CurrentProcessId; } catch (COMException) { return null; }
                if (!scope.Owns(pid)) return null;
                var d = new Dictionary<string, object>();
                d["type"] = type;
                try
                {
                    d["ct"] = sender.CurrentControlType;
                    d["name"] = Cap(sender.CurrentName);
                    d["aid"] = Cap(sender.CurrentAutomationId);
                    // The process of the element that fired, so a descendant process's window is
                    // recorded under its own desktop:// origin, not the app's.
                    d["processName"] = ProcessNameOf(pid);
                    d["hwnd"] = sender.CurrentNativeWindowHandle.ToInt64();
                    d["rid"] = Rid(sender.GetRuntimeId());
                    d["password"] = sender.CurrentIsPassword != 0;
                    d["focused"] = HasAppFocus(sender.CurrentNativeWindowHandle, sender.CurrentHasKeyboardFocus != 0);
                    try { d["readOnly"] = Convert.ToBoolean(sender.GetCurrentPropertyValue(P_ValueIsReadOnly)); } catch (Exception) { }
                }
                catch (COMException) { return null; }
                return d;
            }

            // Control types whose name-change notification is passed on: a window's title change is
            // navigation, and Windows Forms raises a name change on a button (and similar) when it is
            // clicked, which is the only cross-process signal a legacy WinForms click leaves.
            static readonly HashSet<int> NameChangeTypes = new HashSet<int> { 50032, 50000, 50002, 50013, 50011, 50005, 50019, 50007 };

            public void HandleAutomationEvent(IUIAutomationElement sender, int eventId)
            {
                try
                {
                    if (eventId == E_WindowOpened)
                    {
                        int pid;
                        try { pid = sender.CurrentProcessId; } catch (COMException) { return; }
                        scope.Refresh();
                        if (!scope.Owns(pid)) return;
                        var hwnd = sender.CurrentNativeWindowHandle;
                        if (hwnd != IntPtr.Zero) Watch(bridge.Uia, hwnd);
                        var d = Describe(sender, "windowOpened");
                        if (d != null) bridge.Emit("human", d);
                        return;
                    }
                    var a = Describe(sender, eventId == E_Invoked ? "invoked" : "selected");
                    if (a != null) bridge.Emit("human", a);
                }
                catch (Exception) { /* an event for an element that went away */ }
            }

            public void HandlePropertyChangedEvent(IUIAutomationElement sender, int propertyId, object newValue)
            {
                // newValue is deliberately never read: a value change is reported as a fact only.
                try
                {
                    string type = propertyId == P_ValueValue ? "valueChanged" : propertyId == P_ToggleState ? "toggled" : "nameChanged";
                    var d = Describe(sender, type);
                    if (d == null) return;
                    if (type == "nameChanged" && !NameChangeTypes.Contains(Convert.ToInt32(d["ct"]))) return;
                    bridge.Emit("human", d);
                }
                catch (Exception) { }
            }
        }

        // --- entry ------------------------------------------------------------------------

        public static void Main()
        {
            // Per-monitor DPI aware: UIA rectangles, window rectangles and captures all in physical pixels.
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.AutoFlush = false;
            Bridge bridge = null;
            var worker = new Thread(delegate ()
            {
                try
                {
                    bridge = new Bridge(stdin, stdout);
                    bridge.Run();
                }
                catch (Exception e)
                {
                    var err = new Dictionary<string, object>();
                    err["event"] = "fatal";
                    err["data"] = e.GetType().Name + ": " + e.Message;
                    lock (stdout) { stdout.Write(new JavaScriptSerializer().Serialize(err) + "\n"); stdout.Flush(); }
                }
            });
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            worker.Join();
        }
    }
}
