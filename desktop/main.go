//go:build windows

// Cardboard.exe: Cardboard on a Windows computer, without a terminal.
//
// Double-click it and Cardboard runs in the background (no window), then opens in its
// own app window. Double-click it again and it just opens the window. The first time,
// it puts Cardboard on the desktop and in the Start menu, and asks whether to start
// with Windows. Each start brings the code up to date (git pull), the same as
// start-cardboard.cmd, which still works for seeing what Cardboard says.
//
// It never sees anyone's data: it only starts `node src/cli.ts start --tunnel tailscale`
// from its own folder and opens the address Cardboard reports. Cardboard's output is
// not kept anywhere (it can hold invite links).
package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	port              = "8787"
	createNoWindow    = 0x08000000
	breakawayFromJob  = 0x01000000
	errAlreadyExists  = 183
	mbOK              = 0x0
	mbYesNo           = 0x4
	mbIconInformation = 0x40
	mbIconWarning     = 0x30
	idYes             = 6
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
)

func main() {
	exe, err := os.Executable()
	if err != nil {
		fail("Cardboard couldn't find itself on this computer.")
	}
	dir := filepath.Dir(exe)
	args := os.Args[1:]
	// Moving the storage runs where it was started (it starts Cardboard again itself, which then leaves the job).
	if !has(args, "--storage") && escapeParentJob(exe, args) {
		return
	}
	background := has(args, "--background")

	if !isCardboard(dir) {
		// A copy somewhere else (on the desktop, say): find the Cardboard folder, and let the
		// Cardboard.exe in it do the work, since that's the one that stays up to date.
		folder := findFolder()
		if folder == "" {
			fail("Cardboard couldn't find your Cardboard folder, so it can't start.\n\nOpen Cardboard.exe again and choose the folder (it's the one with a folder called src in it).")
		}
		inFolder := filepath.Join(folder, "Cardboard.exe")
		if _, err := os.Stat(inFolder); err != nil {
			if git, err := exec.LookPath("git"); err == nil {
				run(folder, time.Minute, git, "checkout", "--", "Cardboard.exe")
			}
		}
		if _, err := os.Stat(inFolder); err == nil && !sameFile(exe, inFolder) {
			if strings.EqualFold(filepath.Base(dir), "Desktop") && !has(args, "--on-desktop") {
				args = append(args, "--on-desktop") // This copy is the desktop icon: don't add a second one.
			}
			cmd := exec.Command(inFolder, args...)
			cmd.Dir = folder
			if cmd.Start() == nil {
				return
			}
		}
		dir = folder
	}
	remember(dir)
	node, err := exec.LookPath("node")
	if err != nil {
		fail("Cardboard needs Node.js, and it isn't on this computer (or Windows can't find it).\n\nInstall Node.js LTS from nodejs.org, then open Cardboard again.")
	}
	if has(args, "--storage") {
		moveStorage(filepath.Join(dir, "Cardboard.exe"), dir, node, args)
		return
	}

	// One copy keeps Cardboard running; any other copy only opens the window.
	name, _ := syscall.UTF16PtrFromString("Local\\CardboardDesktop")
	mutex, _, lastErr := kernel32.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(name)))
	keeper := mutex != 0 && lastErr != syscall.Errno(errAlreadyExists)
	if keeper {
		jobForChildren()
		go keepRunning(dir, node)
	}
	if has(args, "--backups") {
		chooseBackups(dir, true)
		return
	}
	if !background {
		firstRun(filepath.Join(dir, "Cardboard.exe"), dir, has(args, "--on-desktop"))
		backupsShortcut(filepath.Join(dir, "Cardboard.exe"), dir)
		storageShortcut(filepath.Join(dir, "Cardboard.exe"), dir)
		if !loadSettings().AskedBackup {
			chooseBackups(dir, false)
		}
		openWindow()
	}
	if keeper {
		select {} // Keep Cardboard running until Windows signs out (or Task Manager ends "Cardboard").
	}
}

// escapeParentJob: started from inside another program's job (a terminal, an assistant's session), Cardboard
// would be stopped when that program closes, and its address would answer "502 Bad Gateway". So it starts
// itself again outside it: breaking away from the job if it allows that, or else through Windows' shell.
func escapeParentJob(exe string, args []string) bool {
	if has(args, "--free") {
		return false
	}
	var inJob int32
	self, _ := syscall.GetCurrentProcess()
	if ok, _, _ := kernel32.NewProc("IsProcessInJob").Call(uintptr(self), 0, uintptr(unsafe.Pointer(&inJob))); ok == 0 || inJob == 0 {
		return false
	}
	cmd := exec.Command(exe, append(append([]string{}, args...), "--free")...)
	cmd.Dir = filepath.Dir(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: breakawayFromJob}
	if cmd.Start() == nil {
		return true
	}
	// The job doesn't let anything leave it. Explorer starts it instead (once a minute at most, so a
	// computer where everything runs in a job doesn't go round and round).
	marker := filepath.Join(os.Getenv("LOCALAPPDATA"), "Cardboard", "escaped")
	if info, err := os.Stat(marker); err == nil && time.Since(info.ModTime()) < time.Minute {
		return false
	}
	_ = os.MkdirAll(filepath.Dir(marker), 0o700)
	_ = os.WriteFile(marker, nil, 0o600)
	return exec.Command("explorer.exe", exe).Start() == nil
}

func has(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func isCardboard(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "src", "cli.ts"))
	return err == nil
}

func sameFile(a, b string) bool {
	x, errA := os.Stat(a)
	y, errB := os.Stat(b)
	return errA == nil && errB == nil && os.SameFile(x, y)
}

// rememberedFolder is where Cardboard.exe writes down where the Cardboard folder is (just the path).
func rememberedFolder() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Cardboard", "folder.txt")
}

func remember(dir string) {
	if os.Getenv("LOCALAPPDATA") == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(rememberedFolder()), 0o700)
	_ = os.WriteFile(rememberedFolder(), []byte(dir), 0o600)
}

// findFolder finds the Cardboard folder: where it was last time, the usual places, or by asking.
func findFolder() string {
	if os.Getenv("LOCALAPPDATA") != "" {
		if saved, err := os.ReadFile(rememberedFolder()); err == nil && isCardboard(strings.TrimSpace(string(saved))) {
			return strings.TrimSpace(string(saved))
		}
	}
	// Only folders inside your own user folder: anyone on this computer can make C:\Cardboard (or one on a USB drive) and put their own code in it.
	home := os.Getenv("USERPROFILE")
	for _, dir := range []string{
		filepath.Join(home, "Cardboard"),
		filepath.Join(home, "Documents", "Cardboard"), filepath.Join(home, "Desktop", "Cardboard"), filepath.Join(home, "Downloads", "Cardboard"),
	} {
		if isCardboard(dir) {
			return dir
		}
	}
	for {
		dir := pickFolder("Where is your Cardboard folder?")
		if dir == "" || isCardboard(dir) {
			return dir
		}
		if message("Cardboard", "That isn't the Cardboard folder. It's the one with a folder called src in it, next to start-cardboard and Cardboard.exe.\n\nChoose again?", mbYesNo|mbIconWarning) != idYes {
			return ""
		}
	}
}

// pickFolder asks for a folder with Windows' own folder picker (through PowerShell). "" if cancelled.
func pickFolder(question string) string {
	script := `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:CB_QUESTION
if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", "-")
	cmd.Stdin = strings.NewReader(script)
	cmd.Env = append(os.Environ(), "CB_QUESTION="+question)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// keepRunning starts Cardboard and starts it again if it stops, like start-cardboard.cmd. While it
// runs, it looks for a new version every hour, and restarts Cardboard on it (a few seconds offline).
func keepRunning(dir, node string) {
	git, _ := exec.LookPath("git")
	_, repoErr := os.Stat(filepath.Join(dir, ".git"))
	canUpdate := git != "" && repoErr == nil
	// The version last restarted for: if pulling it didn't work (files changed by hand), Cardboard
	// isn't restarted for it again every hour, only when a newer one comes.
	tried := ""
	for {
		if answering() {
			// Something else (start-cardboard.cmd?) is running it. Look again in a minute.
			time.Sleep(time.Minute)
			continue
		}
		settings := loadSettings()
		if settings.DataDir != "" {
			if _, err := os.Stat(filepath.Join(settings.DataDir, "cardboard.db")); err != nil {
				// Its drive isn't plugged in (or not there yet): wait for it, rather than start an empty Cardboard.
				time.Sleep(30 * time.Second)
				continue
			}
		}
		if canUpdate {
			update(dir, git)
		}
		cmd := hidden(dir, node, "src/cli.ts", "start", "--tunnel", "tailscale")
		cmd.Env = os.Environ()
		if settings.BackupTo != "" {
			cmd.Env = append(cmd.Env, "CARDBOARD_BACKUP_TO="+settings.BackupTo)
		}
		if settings.DataDir != "" {
			// Moved to another drive: if it's unplugged, Cardboard stops (and is tried again) rather than start empty.
			cmd.Env = append(cmd.Env, "CARDBOARD_DATA="+settings.DataDir, "CARDBOARD_DATA_MUST_EXIST=1")
		}
		if cmd.Start() != nil {
			time.Sleep(15 * time.Second)
			continue
		}
		stopped := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(stopped)
		}()
		updating := false
		hourly := time.NewTicker(time.Hour)
		minutely := time.NewTicker(time.Minute)
	running:
		for {
			select {
			case <-stopped:
				break running
			case <-minutely.C:
				// Where backups go changed (Start menu → Cardboard backups), or where it keeps everything: start again with it.
				if now := loadSettings(); now.BackupTo != settings.BackupTo || now.DataDir != settings.DataDir {
					updating = true
					_ = cmd.Process.Kill()
					<-stopped
					break running
				}
			case <-hourly.C:
				if !canUpdate {
					continue
				}
				if up := newer(dir, git); up != "" && up != tried {
					tried = up
					updating = true
					_ = cmd.Process.Kill()
					<-stopped
					break running
				}
			}
		}
		hourly.Stop()
		minutely.Stop()
		if !updating {
			time.Sleep(15 * time.Second)
		}
	}
}

// newer says whether the Cardboard folder is behind the version on GitHub, in a way a pull can
// simply move forward to.
func newer(dir, git string) string {
	run(dir, 2*time.Minute, git, "fetch", "--quiet")
	head := output(dir, git, "rev-parse", "HEAD")
	upstream := output(dir, git, "rev-parse", "@{u}")
	if head != "" && upstream != "" && head != upstream && quiet(dir, git, "merge-base", "--is-ancestor", "HEAD", "@{u}") {
		return upstream
	}
	return ""
}

func hidden(dir, name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

// output runs a command in dir with no window, and gives what it printed ("" if it failed).
func output(dir, name string, args ...string) string {
	out, err := hidden(dir, name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// quiet runs a command in dir with no window, and says whether it succeeded.
func quiet(dir, name string, args ...string) bool {
	return hidden(dir, name, args...).Run() == nil
}

// update brings the Cardboard folder up to date. Windows won't let git replace a program
// that's running (this one), but it does let it be renamed: so this copy moves aside to
// Cardboard.exe.old, and git puts a fresh Cardboard.exe back before pulling.
func update(dir, git string) {
	exe := filepath.Join(dir, "Cardboard.exe")
	old := exe + ".old"
	_ = os.Remove(old) // Left from last time; it stays while that copy is still running.
	if _, err := os.Stat(old); os.IsNotExist(err) && os.Rename(exe, old) == nil {
		run(dir, time.Minute, git, "checkout", "--", "Cardboard.exe")
		if _, err := os.Stat(exe); err != nil {
			_ = os.Rename(old, exe) // git couldn't: put it back.
		}
	}
	run(dir, 2*time.Minute, git, "pull", "--ff-only")
}

// run runs a command in dir with no window and its output thrown away, waiting at most `limit` (0: no limit).
func run(dir string, limit time.Duration, name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if cmd.Start() != nil {
		return
	}
	if limit > 0 {
		timer := time.AfterFunc(limit, func() { _ = cmd.Process.Kill() })
		defer timer.Stop()
	}
	_ = cmd.Wait()
}

// jobForChildren puts this process in a job that ends with it, so ending "Cardboard" in
// Task Manager (or signing out) also stops Cardboard and its tunnel, never leaving them behind.
func jobForChildren() {
	type basicLimits struct {
		PerProcessUserTimeLimit int64
		PerJobUserTimeLimit     int64
		LimitFlags              uint32
		MinimumWorkingSetSize   uintptr
		MaximumWorkingSetSize   uintptr
		ActiveProcessLimit      uint32
		Affinity                uintptr
		PriorityClass           uint32
		SchedulingClass         uint32
	}
	type extendedLimits struct {
		Basic                 basicLimits
		IoInfo                [6]uint64
		ProcessMemoryLimit    uintptr
		JobMemoryLimit        uintptr
		PeakProcessMemoryUsed uintptr
		PeakJobMemoryUsed     uintptr
	}
	job, _, _ := kernel32.NewProc("CreateJobObjectW").Call(0, 0)
	if job == 0 {
		return
	}
	// Kill on close; and the browser window may break away (it isn't Cardboard's to stop).
	limits := extendedLimits{Basic: basicLimits{LimitFlags: 0x2000 | 0x800}}
	kernel32.NewProc("SetInformationJobObject").Call(job, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	self, _ := syscall.GetCurrentProcess()
	kernel32.NewProc("AssignProcessToJobObject").Call(job, uintptr(self))
}

// answering says whether Cardboard is running on this computer.
func answering() bool {
	_, ok := address(3 * time.Second)
	return ok
}

// address asks the Cardboard running here for its address (the tunnel's https:// one).
func address(timeout time.Duration) (string, bool) {
	client := http.Client{Timeout: timeout}
	res, err := client.Post("http://127.0.0.1:"+port+"/v1/hello", "application/json", strings.NewReader("{}"))
	if err != nil {
		return "", false
	}
	defer res.Body.Close()
	var hello struct {
		Name   string `json:"name"`
		Issuer string `json:"issuer"`
	}
	if json.NewDecoder(res.Body).Decode(&hello) != nil || hello.Name != "cardboard" {
		return "", false
	}
	return hello.Issuer, true
}

// openWindow waits for Cardboard to answer, then opens it in an app window.
func openWindow() {
	deadline := time.Now().Add(3 * time.Minute)
	for {
		if issuer, ok := address(3 * time.Second); ok {
			target := "http://127.0.0.1:" + port + "/"
			if u, err := url.Parse(issuer); err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" {
				target = u.Scheme + "://" + u.Host + "/"
			}
			show(target)
			return
		}
		if time.Now().After(deadline) {
			message("Cardboard didn't start", "Cardboard didn't start within three minutes.\n\nTo see why: in the Cardboard folder, double-click start-cardboard. Its window says what's wrong (for example, Tailscale isn't running).", mbOK|mbIconWarning)
			os.Exit(1)
		}
		time.Sleep(time.Second)
	}
}

// show opens the address in its own window (Chrome, Edge, Brave or Vivaldi), or in the default browser.
func show(target string) {
	if browser := defaultBrowser(); browser != "" {
		base := strings.ToLower(filepath.Base(browser))
		if base == "chrome.exe" || base == "msedge.exe" || base == "brave.exe" || base == "vivaldi.exe" {
			cmd := exec.Command(browser, "--app="+target)
			cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: breakawayFromJob}
			if cmd.Start() == nil {
				return
			}
		}
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(target)
	shell32.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
}

// defaultBrowser is the program Windows opens https links with, or "" if it can't tell.
func defaultBrowser() string {
	progID := regString(syscall.HKEY_CURRENT_USER, `Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`, "ProgId")
	if progID == "" {
		return ""
	}
	command := regString(syscall.HKEY_CLASSES_ROOT, progID+`\shell\open\command`, "")
	// Like: "C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1
	if strings.HasPrefix(command, `"`) {
		if end := strings.Index(command[1:], `"`); end > 0 {
			return command[1 : end+1]
		}
	}
	return ""
}

func regString(root syscall.Handle, path, name string) string {
	var key syscall.Handle
	p, _ := syscall.UTF16PtrFromString(path)
	if syscall.RegOpenKeyEx(root, p, 0, syscall.KEY_READ, &key) != nil {
		return ""
	}
	defer syscall.RegCloseKey(key)
	var n, kind uint32
	var namePtr *uint16
	if name != "" {
		namePtr, _ = syscall.UTF16PtrFromString(name)
	}
	if syscall.RegQueryValueEx(key, namePtr, nil, &kind, nil, &n) != nil || n == 0 {
		return ""
	}
	buf := make([]uint16, n/2+1)
	if syscall.RegQueryValueEx(key, namePtr, nil, &kind, (*byte)(unsafe.Pointer(&buf[0])), &n) != nil {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// ── Backups somewhere else ───────────────────────────────────────────────────

// Settings is what Cardboard.exe remembers (in %LOCALAPPDATA%\Cardboard\settings.json): no secrets.
type Settings struct {
	BackupTo    string `json:"backupTo,omitempty"`
	AskedBackup bool   `json:"askedBackup,omitempty"`
	DataDir     string `json:"dataDir,omitempty"` // Where Cardboard keeps everything, once moved (Start menu → Cardboard storage).
}

func settingsFile() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Cardboard", "settings.json")
}

func loadSettings() Settings {
	var s Settings
	if data, err := os.ReadFile(settingsFile()); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

func saveSettings(s Settings) {
	if os.Getenv("LOCALAPPDATA") == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(settingsFile()), 0o700)
	// Written whole under another name, then renamed: the once-a-minute check never reads half a file.
	if data, err := json.MarshalIndent(s, "", "  "); err == nil && os.WriteFile(settingsFile()+".new", data, 0o600) == nil {
		_ = os.Rename(settingsFile()+".new", settingsFile())
	}
}

// chooseBackups asks where Cardboard should keep a copy of everything (another drive). `again`:
// opened from the Start menu, to change it.
func chooseBackups(dir string, again bool) {
	s := loadSettings()
	s.AskedBackup = true
	saveSettings(s)
	question := "Keep a backup of Cardboard somewhere else?\n\nEverything you keep in Cardboard is on this computer only. If it breaks or is lost, a copy on another drive (a USB stick, or an SSD like a T7) brings it all back. What you keep is sealed in it: it can't be opened without your devices.\n\nChoose where next. (You can change it later: Start menu → Cardboard backups.)"
	if again && s.BackupTo != "" {
		question = "Cardboard keeps a backup copy in:\n\n" + s.BackupTo + "\n\nChoose another place? (No keeps it as it is.)"
	}
	if message("Cardboard backups", question, mbYesNo|mbIconInformation) != idYes {
		return
	}
	for {
		picked := pickFolder("Where should Cardboard keep its backup copies? (Another drive is best.)")
		if picked == "" {
			return
		}
		if strings.EqualFold(filepath.VolumeName(picked), filepath.VolumeName(dir)) {
			answer := message("Cardboard backups", "That's on the same drive as Cardboard itself, so if that drive fails, the backup goes with it.\n\nChoose another drive? (No uses this one anyway.)", mbYesNo|mbIconWarning)
			if answer == idYes {
				continue
			}
		}
		target := picked
		if !strings.EqualFold(filepath.Base(target), "Cardboard backups") {
			target = filepath.Join(picked, "Cardboard backups")
		}
		s.BackupTo = target
		saveSettings(s)
		message("Cardboard backups", "Done. Cardboard keeps a copy in:\n\n"+target+"\n\nIt makes one within a few minutes, then every day. If that drive isn't plugged in, it tries again every hour, and your Cardboard says so (Security).", mbOK|mbIconInformation)
		return
	}
}

// backupsShortcut puts "Cardboard backups" in the Start menu, to change where backups go.
func backupsShortcut(exe, dir string) {
	if _, err := os.Stat(filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "Cardboard backups.lnk")); err == nil {
		return
	}
	shortcutNamed(exe, dir, "Programs", "--backups", "Cardboard backups")
}

// ── Storage on another drive ─────────────────────────────────────────────────

// storageShortcut puts "Cardboard storage" in the Start menu, to move where Cardboard keeps everything.
func storageShortcut(exe, dir string) {
	if _, err := os.Stat(filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "Cardboard storage.lnk")); err == nil {
		return
	}
	shortcutNamed(exe, dir, "Programs", "--storage", "Cardboard storage")
}

// dataDir is where Cardboard keeps everything now.
func dataDir(dir string) string {
	if d := loadSettings().DataDir; d != "" {
		return d
	}
	return filepath.Join(dir, "cardboard-data")
}

// moveStorage moves everything Cardboard keeps (one sealed database, its key and backups) to another
// drive: it stops Cardboard, has Cardboard copy and check it (cardboard move-data), starts Cardboard
// again from there, then offers to delete the old copy. `--storage X:\` does it without asking
// (add --delete-old to delete the old copy once Cardboard runs from the new place); what happened
// goes in %LOCALAPPDATA%\Cardboard\storage.txt.
func moveStorage(exe, dir, node string, args []string) {
	picked := ""
	for i, a := range args {
		if a == "--storage" && i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
			picked = args[i+1]
		}
	}
	asking := picked == ""
	old := dataDir(dir)
	say := func(text string, flags uintptr) uintptr {
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			_ = os.MkdirAll(filepath.Join(local, "Cardboard"), 0o700)
			_ = os.WriteFile(filepath.Join(local, "Cardboard", "storage.txt"), []byte(time.Now().Format(time.RFC3339)+"\r\n"+strings.ReplaceAll(text, "\n", "\r\n")+"\r\n"), 0o600)
		}
		if !asking {
			return idYes
		}
		return message("Cardboard storage", text, flags)
	}
	if asking {
		question := "Cardboard keeps everything people put in it here:\n\n" + old + "\n\nMove it to another drive with more room? Cardboard is offline while it copies (a few minutes for a few GB), then starts again from there. Nothing is lost: the old copy stays until you say to delete it."
		if message("Cardboard storage", question, mbYesNo|mbIconInformation) != idYes {
			return
		}
		for {
			picked = pickFolder("Where should Cardboard keep everything? (Pick a drive with room, like X:)")
			if picked == "" {
				return
			}
			if strings.EqualFold(filepath.VolumeName(picked), filepath.VolumeName(old)) {
				if message("Cardboard storage", "That's the same drive it's on now, so it wouldn't make any room.\n\nChoose another drive?", mbYesNo|mbIconWarning) == idYes {
					continue
				}
				return
			}
			break
		}
	}

	stopCardboard(dir)
	cmd := hidden(dir, node, "src/cli.ts", "move-data", picked)
	cmd.Env = append(os.Environ(), "CARDBOARD_DATA="+old)
	out, _ := cmd.CombinedOutput()
	target := ""
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "MOVED ") {
			target = strings.TrimSpace(strings.TrimPrefix(line, "MOVED "))
		}
	}
	if target == "" {
		startCardboard(exe, dir)
		say("Nothing was moved, and Cardboard is starting again where it was.\n\n"+plain(string(out)), mbOK|mbIconWarning)
		return
	}
	s := loadSettings()
	s.DataDir = target
	saveSettings(s)
	startCardboard(exe, dir)
	deadline := time.Now().Add(3 * time.Minute)
	for !answering() && time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
	}
	if !answering() {
		say("Everything was copied to:\n\n"+target+"\n\nbut Cardboard hasn't started from there yet. The old copy is still at "+old+", untouched.", mbOK|mbIconWarning)
		return
	}
	done := "Done. Cardboard now keeps everything in:\n\n" + target + "\n\nand it's running from there."
	if strings.EqualFold(filepath.Clean(old), filepath.Clean(target)) {
		say(done, mbOK|mbIconInformation)
		return
	}
	remove := has(args, "--delete-old")
	if asking {
		remove = say(done+"\n\nDelete the old copy at "+old+" to free up that space? (No keeps it.)", mbYesNo|mbIconInformation) == idYes
	}
	if remove && os.RemoveAll(old) == nil {
		say(done+"\n\nThe old copy at "+old+" is deleted.", mbOK|mbIconInformation)
	} else if !asking {
		say(done+"\n\nThe old copy is still at "+old+".", mbOK|mbIconInformation)
	}
}

// plain is what Cardboard printed, without the terminal's colours.
func plain(text string) string {
	var b strings.Builder
	for i := 0; i < len(text); i++ {
		if text[i] == 0x1b {
			for i < len(text) && text[i] != 'm' {
				i++
			}
			continue
		}
		b.WriteByte(text[i])
	}
	return strings.TrimSpace(b.String())
}

// stopCardboard stops every other Cardboard.exe (with what it started) and any Cardboard started some
// other way (start-cardboard.cmd), and waits until nothing answers.
func stopCardboard(dir string) {
	script := `Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -like 'Cardboard.exe*' -and $_.ProcessId -ne [int]$env:CB_SELF) -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*cli.ts*start*')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
	for try := 0; try < 3; try++ {
		cmd := hidden(dir, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "-")
		cmd.Stdin = strings.NewReader(script)
		cmd.Env = append(os.Environ(), "CB_SELF="+strconv.Itoa(os.Getpid()))
		_ = cmd.Run()
		deadline := time.Now().Add(20 * time.Second)
		for answering() && time.Now().Before(deadline) {
			time.Sleep(time.Second)
		}
		if !answering() {
			break
		}
	}
	time.Sleep(2 * time.Second) // Windows lets go of the database file.
}

// startCardboard starts the Cardboard.exe that keeps Cardboard running, in the background.
func startCardboard(exe, dir string) {
	cmd := exec.Command(exe, "--background")
	cmd.Dir = dir
	_ = cmd.Start()
}

// firstRun puts Cardboard on the desktop and in the Start menu, once, and asks about starting with Windows.
func firstRun(exe, dir string, onDesktop bool) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return
	}
	marker := filepath.Join(local, "Cardboard", "desktop-setup-done")
	if _, err := os.Stat(marker); err == nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(marker), 0o700)
	_ = os.WriteFile(marker, []byte("Cardboard.exe made its shortcuts. Delete this file to be asked again.\r\n"), 0o600)

	if !onDesktop {
		shortcut(exe, dir, "Desktop", "")
	}
	shortcut(exe, dir, "Programs", "")
	answer := message("Cardboard", "Cardboard is on your desktop and in the Start menu.\n\nStart Cardboard by itself when Windows starts, and keep this computer awake while it's plugged in? Then your phone can always reach it.\n\n(Change it later: Settings → Apps → Startup.)", mbYesNo|mbIconInformation)
	if answer != idYes {
		return
	}
	shortcut(exe, dir, "Startup", "--background")
	// The older way of starting with Windows (node src/cli.ts autostart on) would start a second copy.
	if appData := os.Getenv("APPDATA"); appData != "" {
		_ = os.Remove(filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Cardboard.cmd"))
	}
	for _, args := range [][]string{
		{"/change", "standby-timeout-ac", "0"},
		{"/setacvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", "0"},
		{"/setactive", "SCHEME_CURRENT"},
	} {
		run(dir, 30*time.Second, "powercfg", args...)
	}
}

// shortcut makes "Cardboard" in one of Windows' special folders (Desktop, Programs, Startup).
// Windows' own shortcut maker is reached through PowerShell; the paths go in as environment
// variables, so nothing in them is ever read as code.
func shortcut(exe, dir, folder, args string) {
	shortcutNamed(exe, dir, folder, args, "Cardboard")
}

func shortcutNamed(exe, dir, folder, args, name string) {
	script := `$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut((Join-Path ([Environment]::GetFolderPath($env:CB_FOLDER)) ($env:CB_NAME + '.lnk')))
$s.TargetPath = $env:CB_EXE
$s.Arguments = $env:CB_ARGS
$s.WorkingDirectory = $env:CB_DIR
$s.IconLocation = $env:CB_EXE + ',0'
$s.Description = $env:CB_NAME
$s.Save()`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "-")
	cmd.Stdin = strings.NewReader(script)
	cmd.Env = append(os.Environ(), "CB_FOLDER="+folder, "CB_EXE="+exe, "CB_ARGS="+args, "CB_DIR="+dir, "CB_NAME="+name)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	_ = cmd.Run()
}

func message(title, text string, flags uintptr) uintptr {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	r, _, _ := user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags)
	return r
}

func fail(text string) {
	message("Cardboard", text, mbOK|mbIconWarning)
	os.Exit(1)
}
