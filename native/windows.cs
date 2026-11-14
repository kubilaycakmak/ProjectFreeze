using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class Native {
    const uint Query = 0x1000, Synchronize = 0x100000, SuspendResume = 0x800, Terminate = 1;
    static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup {
        public int size;
        public string reserved, desktop, title;
        public int x, y, xSize, ySize, xCount, yCount, attributes, flags;
        public short show, reservedSize;
        public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Child { public IntPtr process, thread; public int pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct TokenUser { public IntPtr sid; public int attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Entry {
        public uint size, usage, pid;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string image;
    }
    [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32")] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("psapi")] static extern bool GetProcessMemoryInfo(IntPtr handle, [Out] byte[] data, int size);
    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32")] static extern bool QueryInformationJobObject(IntPtr job, int info, IntPtr buffer, int length, out int written);
    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder args, IntPtr psec, IntPtr tsec, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out Child child);
    [DllImport("kernel32")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref Entry entry);
    [DllImport("advapi32")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32")] static extern bool GetTokenInformation(IntPtr token, int type, IntPtr data, int length, out int actual);
    [DllImport("ntdll")] static extern int NtSuspendProcess(IntPtr process);
    [DllImport("ntdll")] static extern int NtResumeProcess(IntPtr process);

    static bool Owned(IntPtr handle) {
        IntPtr token;
        if (!OpenProcessToken(handle, 8, out token)) return false;
        try {
            int size;
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out size);
            if (size <= 0) return false;
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                if (!GetTokenInformation(token, 1, data, size, out size)) return false;
                TokenUser owner = (TokenUser)Marshal.PtrToStructure(data, typeof(TokenUser));
                return User.Equals(new SecurityIdentifier(owner.sid));
            } finally { Marshal.FreeHGlobal(data); }
        } finally { CloseHandle(token); }
    }

    static int Suspension(int pid) {
        try {
            using (var process = Process.GetProcessById(pid)) {
                int active = 0, suspended = 0;
                foreach (ProcessThread thread in process.Threads) {
                    using (thread) {
                        if (thread.ThreadState == ThreadState.Wait && thread.WaitReason == ThreadWaitReason.Suspended) suspended++;
                        else active++;
                    }
                }
                return active > 0 ? (suspended == 0 ? 0 : 2) : suspended > 0 ? 1 : -1;
            }
        } catch (InvalidOperationException) { return -1; }
          catch (ArgumentException) { return -1; }
          catch (System.ComponentModel.Win32Exception) { return -1; }
    }

    static int Control(string verb, int pid, string birth) {
        if (pid < 5 || pid == Process.GetCurrentProcess().Id) return 2;
        uint access = Query | Synchronize;
        if (verb == "force") access |= Terminate;
        else if (verb == "freeze" || verb == "resume") access |= SuspendResume;
        else return 5;
        IntPtr handle = OpenProcess(access, false, pid);
        if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? 3 : 4;
        try {
            long created, exited, kernel, user;
            if (!Owned(handle)) return 4;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user) ||
                created.ToString(CultureInfo.InvariantCulture) != birth || WaitForSingleObject(handle, 0) != 258) return 3;
            if (verb == "force") return TerminateProcess(handle, 1) ? 0 : 4;
            int state = Suspension(pid);
            if (state < 0 || state == 2) return 4;
            if (state == (verb == "freeze" ? 1 : 0)) return 10;
            int result = verb == "freeze" ? NtSuspendProcess(handle) : NtResumeProcess(handle);
            return result == 0 ? 0 : 4;
        } finally { CloseHandle(handle); }
    }

    static int Scan() {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) return 4;
        try {
            var entry = new Entry { size = (uint)Marshal.SizeOf(typeof(Entry)) };
            if (!Process32First(snapshot, ref entry)) return 4;
            do {
                IntPtr handle = OpenProcess(Query | Synchronize, false, (int)entry.pid);
                if (handle == IntPtr.Zero) continue;
                try {
                    long created, exited, kernel, user;
                    if (!Owned(handle) || WaitForSingleObject(handle, 0) != 258 || !GetProcessTimes(handle, out created, out exited, out kernel, out user)) continue;
                    int size = 32768;
                    var path = new StringBuilder(size);
                    QueryFullProcessImageName(handle, 0, path, ref size);
                    byte[] memory = new byte[IntPtr.Size == 8 ? 72 : 40];
                    BitConverter.GetBytes(memory.Length).CopyTo(memory, 0);
                    long rss = GetProcessMemoryInfo(handle, memory, memory.Length) ?
                        (IntPtr.Size == 8 ? BitConverter.ToInt64(memory, 16) : BitConverter.ToUInt32(memory, 12)) : -1;
                    int state = Suspension((int)entry.pid);
                    Console.WriteLine("{0}\t{1}\t{2}\t{3}\t{4}\t{5}\t{6}", entry.pid, entry.parent, created,
                        state == 1 ? "T" : state == 2 ? "M" : state < 0 ? "?" : "R", (kernel + user) * 100, rss,
                        Convert.ToBase64String(Encoding.UTF8.GetBytes(path.ToString())));
                } finally { CloseHandle(handle); }
            } while (Process32Next(snapshot, ref entry));
            return 0;
        } finally { CloseHandle(snapshot); }
    }

    static string Quote(string value) {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            quoted.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            quoted.Append(c);
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2);
        return quoted.Append('"').ToString();
    }

    static int Launch(string[] args) {
        IntPtr job = CreateJobObject(IntPtr.Zero, args[1]);
        if (job == IntPtr.Zero) return 4;
        try {
            if (Marshal.GetLastWin32Error() == 183) return 6;
            var startup = new Startup { size = Marshal.SizeOf(typeof(Startup)) };
            Child child;
            var command = new StringBuilder(String.Join(" ", args.Skip(2).Select(Quote)));
            if (!CreateProcess(args[2], command, IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, null, ref startup, out child)) return 4;
            try {
                long created, exited, kernel, user;
                if (!AssignProcessToJobObject(job, child.process) || !GetProcessTimes(child.process, out created, out exited, out kernel, out user)) {
                    TerminateProcess(child.process, 1);
                    return 4;
                }
                Console.WriteLine("{0}\t{1}", child.pid, created);
                Console.Out.Flush();
                if (Console.In.Read() != 'G') { TerminateProcess(child.process, 1); return 4; }
                if (ResumeThread(child.thread) == UInt32.MaxValue) { TerminateProcess(child.process, 1); return 4; }
                WaitForSingleObject(child.process, UInt32.MaxValue);
                uint code;
                if (!GetExitCodeProcess(child.process, out code)) return 4;
                return (int)code;
            } finally { CloseHandle(child.thread); CloseHandle(child.process); }
        } finally { CloseHandle(job); }
    }

    static int Members(string name) {
        IntPtr job = OpenJobObject(4, false, name);
        if (job == IntPtr.Zero) return Marshal.GetLastWin32Error() == 2 ? 3 : 4;
        const int capacity = 131072;
        IntPtr data = Marshal.AllocHGlobal(capacity);
        try {
            int written;
            if (!QueryInformationJobObject(job, 3, data, capacity, out written)) return 4;
            int count = Marshal.ReadInt32(data, 4);
            for (int i = 0; i < count; i++) Console.WriteLine(Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
            return 0;
        } finally { Marshal.FreeHGlobal(data); CloseHandle(job); }
    }

    static int SecureDirectory(string path) {
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var security = new DirectorySecurity();
        security.SetOwner(User);
        security.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { User, system }) {
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        }
        var directory = Directory.CreateDirectory(path, security);
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) return 4;
        var actual = directory.GetAccessControl();
        if (!User.Equals(actual.GetOwner(typeof(SecurityIdentifier))) || !actual.AreAccessRulesProtected) return 4;
        var rules = actual.GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (FileSystemAccessRule rule in rules) {
            if (rule.AccessControlType == AccessControlType.Allow && !User.Equals(rule.IdentityReference) && !system.Equals(rule.IdentityReference)) return 4;
        }
        return 0;
    }

    static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "scan") return Scan();
            if (args.Length == 2 && args[0] == "secure-directory") return SecureDirectory(args[1]);
            if (args.Length == 2 && args[0] == "members") return Members(args[1]);
            if (args.Length >= 3 && args[0] == "launch") return Launch(args);
            int pid;
            if (args.Length == 3 && Int32.TryParse(args[1], out pid)) return Control(args[0], pid, args[2]);
            return 2;
        } catch (UnauthorizedAccessException) { return 4; }
          catch (IOException) { return 4; }
          catch (EntryPointNotFoundException) { return 5; }
    }
}
