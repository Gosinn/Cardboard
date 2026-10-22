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
	background := len(os.Args) > 1 && os.Args[1] == "--background"

	if _, err := os.Stat(filepath.Join(dir, "src", "cli.ts")); err != nil {
		fail("Cardboard.exe has to stay in the Cardboard folder (next to the src folder). Put it back there, and make a shortcut to it instead.")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		fail("Cardboard needs Node.js, and it isn't on this computer (or Windows can't find it).\n\nInstall Node.js LTS from nodejs.org, then open Cardboard again.")
	}

	// One copy keeps Cardboard running; any other copy only opens the window.
	name, _ := syscall.UTF16PtrFromString("Local\\CardboardDesktop")
	mutex, _, lastErr := kernel32.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(name)))
	keeper := mutex != 0 && lastErr != syscall.Errno(errAlreadyExists)
	if keeper {
		jobForChildren()
		go keepRunning(dir, node)
	}
	if !background {
		firstRun(exe, dir)
		openWindow()
	}
	if keeper {
		select {} // Keep Cardboard running until Windows signs out (or Task Manager ends "Cardboard").
	}
}

// keepRunning starts Cardboard and starts it again if it stops, like start-cardboard.cmd.
func keepRunning(dir, node string) {
	for {
		if answering() {
			// Something else (start-cardboard.cmd?) is running it. Look again in a minute.
			time.Sleep(time.Minute)
			continue
		}
		if git, err := exec.LookPath("git"); err == nil {
			if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
				update(dir, git)
			}
		}
		run(dir, 0, node, "src/cli.ts", "start", "--tunnel", "tailscale")
		time.Sleep(15 * time.Second)
	}
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

// firstRun puts Cardboard on the desktop and in the Start menu, once, and asks about starting with Windows.
func firstRun(exe, dir string) {
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

	shortcut(exe, dir, "Desktop", "")
	shortcut(exe, dir, "Programs", "")
	answer := message("Cardboard", "Cardboard is now on your desktop and in the Start menu.\n\nStart Cardboard by itself when Windows starts, and keep this computer awake while it's plugged in? Then your phone can always reach it.\n\n(Change it later: Settings → Apps → Startup.)", mbYesNo|mbIconInformation)
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
	script := `$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut((Join-Path ([Environment]::GetFolderPath($env:CB_FOLDER)) 'Cardboard.lnk'))
$s.TargetPath = $env:CB_EXE
$s.Arguments = $env:CB_ARGS
$s.WorkingDirectory = $env:CB_DIR
$s.IconLocation = $env:CB_EXE + ',0'
$s.Description = 'Cardboard'
$s.Save()`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "-")
	cmd.Stdin = strings.NewReader(script)
	cmd.Env = append(os.Environ(), "CB_FOLDER="+folder, "CB_EXE="+exe, "CB_ARGS="+args, "CB_DIR="+dir)
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
