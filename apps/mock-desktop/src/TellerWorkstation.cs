// Teller Workstation: a deliberately dated Windows Forms back-office app, the desktop target for
// discovery and replay (apps/mock-desktop/README.md). All data is fictional.
//
// Compiled at launch by apps/mock-desktop/teller.ps1 (Add-Type, C# 5, .NET Framework 4.x), so it
// runs as its own TellerWorkstation.exe process: the desktop surface identifies an application
// by its process name, and a script host (powershell.exe) would make every script-hosted app the
// same "origin".
//
// What it deliberately does:
//  - Mixed accessibility: some controls have a Name (UIA AutomationId), some have a label just
//    before them in z-order (the Win32 proxy names the edit after it), and some have neither (the
//    Member ID box is created before its label, so it has no accessible name at all).
//  - Never activates itself: every window overrides ShowWithoutActivation and opens at the
//    bottom-right edge of the primary screen, small, never TopMost, so it cannot steal focus from
//    the person using the machine while tests drive it. The confirmation dialog is modal by
//    disabling its owner, not by ShowDialog, which would activate it.
//  - Fault switches (MOCK_DESKTOP_FAULTS env JSON, and a control file named by
//    MOCK_DESKTOP_FAULT_FILE that is re-read before every action): failLookup, expireSession
//    (one-shot), slowMs.
//  - Exits by itself when the process named by MOCK_DESKTOP_WATCH_PID goes away, so a crashed
//    test runner cannot leave a window behind.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace MockDesktop
{
    /// <summary>A form that never takes activation when shown.</summary>
    public class QuietForm : Form
    {
        protected override bool ShowWithoutActivation { get { return true; } }
    }

    public class Member
    {
        public string Id, FirstName, MiddleInitial, LastName, JoinDate, Address, Phone, TaxId;
        public long SavingsCents, CheckingCents;
        public bool Restricted;

        public string FullName
        {
            get
            {
                var parts = new List<string>();
                parts.Add(FirstName);
                if (!string.IsNullOrEmpty(MiddleInitial)) parts.Add(MiddleInitial + ".");
                parts.Add(LastName);
                return string.Join(" ", parts.ToArray());
            }
        }
    }

    public class Faults
    {
        public bool FailLookup;
        public bool ExpireSession;
        public int SlowMs;
    }

    public class TellerApp
    {
        const string TitlePrefix = "Teller Workstation";
        readonly Dictionary<string, Member> members = new Dictionary<string, Member>();
        readonly string validUser;
        readonly string validPassword;
        readonly string faultFile;
        readonly Faults envFaults;
        bool envExpireConsumed;
        DateTime fileExpireConsumedAt = DateTime.MinValue;
        int nextRef = 1000001;
        Member current;

        public readonly QuietForm Main = new QuietForm();
        readonly Panel signOnPanel = new Panel();
        readonly Panel lookupPanel = new Panel();
        readonly Panel detailPanel = new Panel();

        // Sign-on screen.
        TextBox txtUserId, txtPassword;
        Button btnSignOn;
        Label lblSignOnError, lblExpired;
        // Lookup screen.
        TextBox txtMemberId;
        Button btnFind, btnSignOff;
        Label lblLookupMessage;
        // Detail screen.
        Label lblMemberHeader, lblChecking, lblDetailStatus;
        TextBox txtName, txtAddress, txtPhone, txtTaxId, txtSavings;
        Button btnOpenSub, btnNewLookup;

        public TellerApp(string dataPath, string user, string password, string faultFile, Faults envFaults)
        {
            validUser = user;
            validPassword = password;
            this.faultFile = faultFile;
            this.envFaults = envFaults;
            LoadMembers(dataPath);
            BuildMain();
            ShowSignOn(false);
        }

        void LoadMembers(string path)
        {
            var json = new JavaScriptSerializer();
            var root = (Dictionary<string, object>)json.DeserializeObject(File.ReadAllText(path));
            foreach (var o in (object[])root["members"])
            {
                var d = (Dictionary<string, object>)o;
                var m = new Member();
                m.Id = (string)d["id"];
                m.FirstName = (string)d["firstName"];
                m.MiddleInitial = (string)d["middleInitial"];
                m.LastName = (string)d["lastName"];
                m.JoinDate = (string)d["joinDate"];
                m.Address = (string)d["address"];
                m.Phone = (string)d["phone"];
                m.TaxId = (string)d["taxId"];
                m.SavingsCents = Convert.ToInt64(d["savingsCents"]);
                m.CheckingCents = Convert.ToInt64(d["checkingCents"]);
                m.Restricted = (bool)d["restricted"];
                members[m.Id] = m;
            }
        }

        public static string FormatCents(long cents)
        {
            bool neg = cents < 0;
            long abs = Math.Abs(cents);
            return (neg ? "-" : "") + "$" + (abs / 100).ToString("#,0") + "." + (abs % 100).ToString("00");
        }

        // --- layout -------------------------------------------------------------------------

        static Label AddLabel(Control parent, string text, int x, int y, int w)
        {
            var l = new Label();
            l.Text = text;
            l.Location = new Point(x, y);
            l.Size = new Size(w, 16);
            parent.Controls.Add(l);
            return l;
        }

        static TextBox AddBox(Control parent, string name, int x, int y, int w, bool readOnly)
        {
            var t = new TextBox();
            if (name != null) t.Name = name;
            t.Location = new Point(x, y);
            t.Size = new Size(w, 20);
            t.ReadOnly = readOnly;
            parent.Controls.Add(t);
            return t;
        }

        static Button AddButton(Control parent, string name, string text, int x, int y, int w)
        {
            var b = new Button();
            if (name != null) b.Name = name;
            b.Text = text;
            b.Location = new Point(x, y);
            b.Size = new Size(w, 24);
            parent.Controls.Add(b);
            return b;
        }

        void BuildMain()
        {
            Main.Font = new Font("Microsoft Sans Serif", 8.25f);
            Main.FormBorderStyle = FormBorderStyle.FixedSingle;
            Main.MaximizeBox = false;
            Main.ClientSize = new Size(440, 300);
            Main.StartPosition = FormStartPosition.Manual;
            Main.ShowInTaskbar = Environment.GetEnvironmentVariable("MOCK_DESKTOP_QUIET") != "1";
            var area = Screen.PrimaryScreen.WorkingArea;
            Main.Location = new Point(area.Right - Main.Width - 8, area.Bottom - Main.Height - 8);

            foreach (var p in new[] { signOnPanel, lookupPanel, detailPanel })
            {
                p.Dock = DockStyle.Fill;
                p.Visible = false;
                Main.Controls.Add(p);
            }
            BuildSignOn();
            BuildLookup();
            BuildDetail();
        }

        void BuildSignOn()
        {
            var p = signOnPanel;
            var header = AddLabel(p, "TELLER WORKSTATION  v3.1  -  AUTHORIZED USE ONLY", 16, 12, 400);
            header.Font = new Font(Main.Font, FontStyle.Bold);
            lblExpired = AddLabel(p, "Your session has expired. Please sign on again.", 16, 36, 400);
            lblExpired.ForeColor = Color.DarkRed;
            lblExpired.Name = "lblExpired";
            // Label first, then its box: the Win32 proxy names each box after the label before it.
            AddLabel(p, "User ID:", 16, 70, 80);
            txtUserId = AddBox(p, "txtUserId", 110, 67, 160, false);
            AddLabel(p, "Password:", 16, 100, 80);
            txtPassword = AddBox(p, null, 110, 97, 160, false);
            txtPassword.UseSystemPasswordChar = true;
            btnSignOn = AddButton(p, "btnSignOn", "Sign On", 110, 130, 90);
            btnSignOn.Click += delegate { SignOn(); };
            lblSignOnError = AddLabel(p, "Invalid user ID or password.", 110, 164, 300);
            lblSignOnError.ForeColor = Color.DarkRed;
        }

        void BuildLookup()
        {
            var p = lookupPanel;
            // Created before its label on purpose: no preceding static, so no accessible name.
            txtMemberId = AddBox(p, null, 110, 47, 120, false);
            var header = AddLabel(p, "MEMBER LOOKUP", 16, 12, 300);
            header.Font = new Font(Main.Font, FontStyle.Bold);
            AddLabel(p, "Member ID:", 16, 50, 80);
            btnFind = AddButton(p, null, "Find", 240, 45, 70);
            btnFind.Click += delegate { Find(); };
            btnSignOff = AddButton(p, "btnSignOff", "Sign Off", 330, 260, 90);
            btnSignOff.Click += delegate { ShowSignOn(false); };
            lblLookupMessage = AddLabel(p, "", 16, 90, 410);
            lblLookupMessage.Name = "lblLookupMessage";
            lblLookupMessage.Size = new Size(410, 32);
        }

        void BuildDetail()
        {
            var p = detailPanel;
            var header = AddLabel(p, "MEMBER DETAIL", 16, 8, 200);
            header.Font = new Font(Main.Font, FontStyle.Bold);
            lblMemberHeader = AddLabel(p, "", 16, 26, 400);
            lblMemberHeader.Name = "lblMemberHeader";

            var contact = new GroupBox();
            contact.Text = "Contact Information";
            contact.Location = new Point(12, 48);
            contact.Size = new Size(416, 110);
            p.Controls.Add(contact);
            AddLabel(contact, "Name:", 10, 20, 70);
            txtName = AddBox(contact, null, 90, 17, 300, true);
            AddLabel(contact, "Address:", 10, 43, 70);
            txtAddress = AddBox(contact, null, 90, 40, 300, true);
            AddLabel(contact, "Phone:", 10, 66, 70);
            txtPhone = AddBox(contact, null, 90, 63, 140, true);
            AddLabel(contact, "Tax ID:", 10, 89, 70);
            txtTaxId = AddBox(contact, "txtTaxId", 90, 86, 140, true);

            var balances = new GroupBox();
            balances.Text = "Balances";
            balances.Location = new Point(12, 162);
            balances.Size = new Size(416, 66);
            p.Controls.Add(balances);
            AddLabel(balances, "Savings Balance:", 10, 20, 100);
            txtSavings = AddBox(balances, "txtSavings", 120, 17, 120, true);
            AddLabel(balances, "Checking Balance:", 10, 43, 100);
            lblChecking = AddLabel(balances, "", 120, 43, 120);

            btnOpenSub = AddButton(p, "btnOpenSubAccount", "Open Sub-Account...", 12, 236, 130);
            btnOpenSub.Click += delegate { OpenSubAccount(); };
            btnNewLookup = AddButton(p, null, "New Lookup", 150, 236, 90);
            btnNewLookup.Click += delegate { if (!SessionExpired()) ShowLookup(""); };
            lblDetailStatus = AddLabel(p, "", 12, 268, 416);
            lblDetailStatus.Name = "lblDetailStatus";
        }

        // --- screens ------------------------------------------------------------------------

        void Show(Panel panel, string title, Button accept)
        {
            foreach (var p in new[] { signOnPanel, lookupPanel, detailPanel }) p.Visible = p == panel;
            Main.Text = TitlePrefix + " - " + title;
            Main.AcceptButton = accept;
        }

        void ShowSignOn(bool expired)
        {
            current = null;
            txtUserId.Text = "";
            txtPassword.Text = "";
            lblSignOnError.Visible = false;
            lblExpired.Visible = expired;
            Show(signOnPanel, expired ? "Session Expired" : "Sign On", btnSignOn);
        }

        void ShowLookup(string message)
        {
            current = null;
            txtMemberId.Text = "";
            lblLookupMessage.Text = message;
            Show(lookupPanel, "Member Lookup", btnFind);
        }

        void ShowDetail(Member m)
        {
            current = m;
            lblMemberHeader.Text = "Member " + m.Id + " - " + m.FullName;
            txtName.Text = m.FullName;
            txtAddress.Text = m.Address;
            txtPhone.Text = m.Phone;
            txtTaxId.Text = m.TaxId;
            txtSavings.Text = FormatCents(m.SavingsCents);
            lblChecking.Text = FormatCents(m.CheckingCents);
            lblDetailStatus.Text = "";
            Show(detailPanel, "Member " + m.Id, null);
        }

        // --- faults -------------------------------------------------------------------------

        Faults ReadFaults(out DateTime fileStamp)
        {
            var f = new Faults();
            f.FailLookup = envFaults.FailLookup;
            f.SlowMs = envFaults.SlowMs;
            f.ExpireSession = envFaults.ExpireSession && !envExpireConsumed;
            fileStamp = DateTime.MinValue;
            if (!string.IsNullOrEmpty(faultFile) && File.Exists(faultFile))
            {
                try
                {
                    fileStamp = File.GetLastWriteTimeUtc(faultFile);
                    var d = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(faultFile));
                    object v;
                    if (d.TryGetValue("failLookup", out v)) f.FailLookup = Convert.ToBoolean(v);
                    if (d.TryGetValue("slowMs", out v)) f.SlowMs = Convert.ToInt32(v);
                    if (d.TryGetValue("expireSession", out v) && Convert.ToBoolean(v) && fileStamp != fileExpireConsumedAt) f.ExpireSession = true;
                }
                catch (Exception)
                {
                    // A half-written control file reads as "no change" until the next action.
                }
            }
            return f;
        }

        /// <summary>Consumes a pending expireSession fault: back to sign-on with the expiry banner.</summary>
        bool SessionExpired()
        {
            DateTime stamp;
            var f = ReadFaults(out stamp);
            if (!f.ExpireSession) return false;
            if (envFaults.ExpireSession && !envExpireConsumed) envExpireConsumed = true;
            else fileExpireConsumedAt = stamp;
            ShowSignOn(true);
            return true;
        }

        // --- actions ------------------------------------------------------------------------

        void SignOn()
        {
            if (txtUserId.Text == validUser && txtPassword.Text == validPassword)
            {
                ShowLookup("");
                return;
            }
            txtPassword.Text = "";
            lblSignOnError.Visible = true;
        }

        void Find()
        {
            if (SessionExpired()) return;
            DateTime stamp;
            var f = ReadFaults(out stamp);
            var id = txtMemberId.Text.Trim();
            if (f.SlowMs > 0)
            {
                lblLookupMessage.Text = "Searching...";
                btnFind.Enabled = false;
                var timer = new Timer();
                timer.Interval = f.SlowMs;
                timer.Tick += delegate
                {
                    timer.Stop();
                    timer.Dispose();
                    btnFind.Enabled = true;
                    CompleteFind(id, f.FailLookup);
                };
                timer.Start();
                return;
            }
            CompleteFind(id, f.FailLookup);
        }

        void CompleteFind(string id, bool fail)
        {
            if (fail)
            {
                Main.Text = TitlePrefix + " - Application Error";
                lblLookupMessage.Text = "Application Error: ORA-01017 member service unavailable. Contact the help desk.";
                return;
            }
            if (id.Length == 0)
            {
                lblLookupMessage.Text = "Enter a member ID.";
                return;
            }
            Member m;
            if (!members.TryGetValue(id, out m))
            {
                lblLookupMessage.Text = "No member found with ID " + id + ".";
                return;
            }
            if (m.Restricted)
            {
                lblLookupMessage.Text = "Access denied: member record " + id + " is restricted.";
                return;
            }
            ShowDetail(m);
        }

        void OpenSubAccount()
        {
            if (SessionExpired()) return;
            var m = current;
            if (m == null) return;
            var dlg = new QuietForm();
            dlg.Text = "Confirm Open Sub-Account";
            dlg.Font = Main.Font;
            dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
            dlg.MinimizeBox = false;
            dlg.MaximizeBox = false;
            dlg.ShowInTaskbar = false;
            dlg.ClientSize = new Size(340, 110);
            dlg.StartPosition = FormStartPosition.Manual;
            dlg.Location = new Point(Main.Left + (Main.Width - dlg.Width) / 2, Main.Top + (Main.Height - dlg.Height) / 2);
            var msg = AddLabel(dlg, "Open a new Share Savings sub-account for member " + m.Id + "? This cannot be undone.", 12, 14, 316);
            msg.Size = new Size(316, 32);
            var ok = AddButton(dlg, null, "Open Sub-Account", 120, 70, 120);
            var cancel = AddButton(dlg, null, "Cancel", 248, 70, 80);
            ok.Click += delegate { dlg.DialogResult = DialogResult.OK; dlg.Close(); };
            cancel.Click += delegate { dlg.DialogResult = DialogResult.Cancel; dlg.Close(); };
            dlg.AcceptButton = ok;
            dlg.CancelButton = cancel;
            dlg.FormClosed += delegate
            {
                Main.Enabled = true;
                var result = dlg.DialogResult;
                dlg.Dispose();
                if (result != DialogResult.OK) return;
                var reference = "SA-" + nextRef.ToString("0000000");
                nextRef++;
                lblDetailStatus.Text = "Sub-account " + reference + " opened for member " + m.Id + ".";
            };
            // Modal the way ShowDialog is (the owner is disabled until the dialog closes), but shown
            // with Show(owner): ShowDialog activates its window, which would take the foreground from
            // whatever the person at the machine is doing.
            Main.Enabled = false;
            dlg.Show(Main);
        }
    }

    public static class Program
    {
        static Faults ParseEnvFaults()
        {
            var f = new Faults();
            var raw = Environment.GetEnvironmentVariable("MOCK_DESKTOP_FAULTS");
            if (string.IsNullOrEmpty(raw)) return f;
            var d = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(raw);
            object v;
            if (d.TryGetValue("failLookup", out v)) f.FailLookup = Convert.ToBoolean(v);
            if (d.TryGetValue("expireSession", out v)) f.ExpireSession = Convert.ToBoolean(v);
            if (d.TryGetValue("slowMs", out v)) f.SlowMs = Convert.ToInt32(v);
            return f;
        }

        static string Env(string name, string fallback)
        {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? fallback : v;
        }

        [STAThread]
        public static int Main(string[] args)
        {
            var dataPath = args.Length > 0 ? args[0] : Env("MOCK_DESKTOP_DATA", "members.json");
            var app = new TellerApp(
                dataPath,
                Env("MOCK_USER", "operator1"),
                Env("MOCK_PASSWORD", "demo-pass-123"),
                Env("MOCK_DESKTOP_FAULT_FILE", ""),
                ParseEnvFaults());

            // Exit when the watched process (the test runner or launcher) is gone.
            int watchPid;
            if (int.TryParse(Env("MOCK_DESKTOP_WATCH_PID", ""), out watchPid) && watchPid > 0)
            {
                Process watched = null;
                try { watched = Process.GetProcessById(watchPid); } catch (ArgumentException) { return 3; }
                var watchdog = new Timer();
                watchdog.Interval = 1000;
                watchdog.Tick += delegate { if (watched.HasExited) Application.Exit(); };
                watchdog.Start();
            }
            Application.Run(app.Main);
            return 0;
        }
    }
}
