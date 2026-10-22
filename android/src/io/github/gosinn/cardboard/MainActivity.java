package io.github.gosinn.cardboard;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Cardboard for Android: your own Cardboard in its own window, at the address you type once.
 * It puts Cardboard in the Share menu and saves downloads to the phone. Everything is sealed
 * and opened by the dashboard page, exactly as in a browser: this app never holds a key, and
 * talks to the page only through a message port it hands to your Cardboard's address alone.
 */
public class MainActivity extends Activity {
  static final String VERSION = "1";
  static final int PICK_FILES = 1;
  /** The most the page reads or writes in one message, in bytes (it travels as base64). */
  static final int PIECE_MAX = 1 << 20;
  static final int PAPER = 0xFFF3EADB, PAPER_NIGHT = 0xFF1B1611, INK = 0xFF2B2118, INK_NIGHT = 0xFFF3EADB, ERROR = 0xFFB3261E;

  final Handler main = new Handler(Looper.getMainLooper());
  /** One thread for the page's requests, so the pieces of a download are written in order. */
  final ExecutorService io = Executors.newSingleThreadExecutor();
  SharedPreferences prefs;
  FrameLayout root;
  WebView web;
  /** The address screen or the "isn't answering" screen, shown over the page. */
  View cover;
  View fullscreen;
  WebChromeClient.CustomViewCallback fullscreenDone;
  /** Your Cardboard, like https://laptop.tail1234.ts.net:8443 (no path). */
  String origin;
  ValueCallback<Uri[]> chooser;
  WebMessagePort port;
  /** What another app shared to Cardboard, until the page has sent it. */
  volatile Shared shared;
  final Map<Integer, Saving> saving = new HashMap<>();
  int nextSave = 1;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    prefs = getSharedPreferences("cardboard", MODE_PRIVATE);
    origin = prefs.getString("origin", null);
    root = new FrameLayout(this);
    root.setBackgroundColor(night() ? PAPER_NIGHT : PAPER);
    // Drawn edge to edge on every Android version, kept clear of the status bar, the navigation bar and the keyboard.
    if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
    else {
      int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
      if (!night()) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
      getWindow().getDecorView().setSystemUiVisibility(flags);
    }
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
      return insets.consumeSystemWindowInsets();
    });
    setContentView(root);
    boolean sharing = take(getIntent());
    if (origin == null) ask(null);
    else open(sharing ? sendPath() : "/");
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (take(intent) && origin != null) open(sendPath());
  }

  /** The dashboard's "Send to yourself" page; a fresh path each time, so the page sees the change. */
  static String sendPath() {
    return "/#/send?app=" + System.currentTimeMillis();
  }

  boolean night() {
    return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  void open(String path) {
    removeCover();
    if (web == null) {
      web = makeWeb();
      root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }
    web.loadUrl(origin + path);
  }

  WebView makeWeb() {
    WebView view = new WebView(this);
    view.setBackgroundColor(night() ? PAPER_NIGHT : PAPER);
    WebSettings s = view.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setGeolocationEnabled(false);
    s.setSupportMultipleWindows(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    // Lets the dashboard know to use this app for the Share menu and for downloads.
    s.setUserAgentString(s.getUserAgentString() + " CardboardAndroid/" + VERSION);
    view.setWebViewClient(new Client());
    view.setWebChromeClient(new Chrome());
    view.setDownloadListener((url, agent, disposition, type, length) -> {
      // The dashboard saves its own downloads through this app; anything else is for the browser.
      Uri u = Uri.parse(url);
      if (!ours(u)) openOutside(u);
    });
    return view;
  }

  /** Is this address your Cardboard (same scheme, host and port)? */
  boolean ours(Uri u) {
    return origin != null && origin.equals(originOf(u.toString()));
  }

  void openOutside(Uri u) {
    String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
    if (!Arrays.asList("https", "http", "mailto", "tel").contains(scheme)) return;
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE));
    } catch (ActivityNotFoundException ignored) {
      toast("No app on this phone opens that.");
    }
  }

  class Client extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      Uri u = request.getUrl();
      if (ours(u) || "blob".equals(u.getScheme()) || "about".equals(u.getScheme())) return false;
      // Other sites open in their own app (your browser), never inside Cardboard's window.
      if (request.isForMainFrame()) openOutside(u);
      return true;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap icon) {
      // A new page: the old one's port is gone with it. (Not called when only the #part changes.)
      if (port != null) port.close();
      port = null;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
      if (port == null && url != null && ours(Uri.parse(url))) connect();
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
      if (request.isForMainFrame()) trouble(request.getUrl().toString(), String.valueOf(error.getDescription()));
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
      handler.cancel();
      trouble(error.getUrl(), "Its certificate isn't valid, so the app won't trust it.");
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
      // The page crashed (or Android reclaimed its memory): start it again rather than close the app.
      root.removeView(view);
      view.destroy();
      if (view == web) {
        web = null;
        port = null;
        open("/");
      }
      return true;
    }
  }

  class Chrome extends WebChromeClient {
    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
      if (chooser != null) chooser.onReceiveValue(null);
      chooser = callback;
      Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
      if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
      try {
        startActivityForResult(pick, PICK_FILES);
      } catch (ActivityNotFoundException e) {
        chooser = null;
        callback.onReceiveValue(null);
      }
      return true;
    }

    @Override
    public void onShowCustomView(View view, CustomViewCallback done) {
      // A video going full screen.
      if (fullscreen != null) {
        done.onCustomViewHidden();
        return;
      }
      fullscreen = view;
      fullscreenDone = done;
      root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    @Override
    public void onHideCustomView() {
      leaveFullscreen();
    }
  }

  void leaveFullscreen() {
    if (fullscreen == null) return;
    root.removeView(fullscreen);
    fullscreen = null;
    if (fullscreenDone != null) fullscreenDone.onCustomViewHidden();
    fullscreenDone = null;
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    if (request != PICK_FILES || chooser == null) return;
    Uri[] picked = null;
    if (result == RESULT_OK && data != null) {
      ClipData clip = data.getClipData();
      if (clip != null) {
        picked = new Uri[clip.getItemCount()];
        for (int i = 0; i < picked.length; i++) picked[i] = clip.getItemAt(i).getUri();
      } else if (data.getData() != null) picked = new Uri[] {data.getData()};
    }
    chooser.onReceiveValue(picked);
    chooser = null;
  }

  @Override
  public void onBackPressed() {
    if (fullscreen != null) leaveFullscreen();
    else if (cover != null && web != null && origin != null) removeCover();
    else if (web != null && web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }

  @Override
  protected void onPause() {
    super.onPause();
    if (web != null) web.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (web != null) web.onResume();
  }

  @Override
  protected void onDestroy() {
    io.execute(() -> {
      closeShared();
      for (Saving s : saving.values()) s.abandon(getContentResolver());
      saving.clear();
    });
    io.shutdown();
    if (web != null) web.destroy();
    super.onDestroy();
  }

  // ── Talking to the page ──────────────────────────────────────────────────────

  /**
   * Hands the page one end of a message channel. Android delivers it only if the page's origin is
   * your Cardboard's, so no other site ever gets it.
   */
  void connect() {
    WebMessagePort[] ports = web.createWebMessageChannel();
    final WebMessagePort mine = ports[0];
    port = mine;
    mine.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
      @Override
      public void onMessage(WebMessagePort p, WebMessage message) {
        answer(mine, message.getData());
      }
    });
    web.postWebMessage(new WebMessage("cardboard-android", new WebMessagePort[] {ports[1]}), Uri.parse(origin));
  }

  void answer(WebMessagePort to, String data) {
    io.execute(() -> {
      JSONObject reply;
      int id = 0;
      try {
        JSONObject m = new JSONObject(data);
        id = m.optInt("id");
        reply = handle(m);
      } catch (Exception e) {
        reply = new JSONObject();
        put(reply, "error", e.getMessage() == null ? e.toString() : e.getMessage());
      }
      put(reply, "id", id);
      String text = reply.toString();
      main.post(() -> {
        if (to == port) to.postMessage(new WebMessage(text));
      });
    });
  }

  /** One request from the page (runs on the io thread). */
  JSONObject handle(JSONObject m) throws Exception {
    ContentResolver resolver = getContentResolver();
    JSONObject out = new JSONObject();
    switch (m.getString("op")) {
      case "share": {
        Shared s = shared;
        if (s == null) return out.put("none", true);
        JSONArray files = new JSONArray();
        for (int i = 0; i < s.uris.size(); i++) files.put(describe(resolver, s.uris.get(i)).put("n", i));
        return out.put("text", s.text).put("files", files);
      }
      case "read": {
        Shared s = shared;
        if (s == null) throw new IOException("What was shared isn't here any more. Share it again.");
        int length = Math.max(0, Math.min(m.getInt("length"), PIECE_MAX));
        byte[] bytes = s.read(resolver, m.getInt("file"), m.getLong("offset"), length);
        return out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
      }
      case "share-done":
        closeShared();
        return out;
      case "save-start": {
        String name = cleanName(m.optString("name"));
        String type = m.optString("type");
        if (!type.matches("[\\w.+-]+/[\\w.+-]+")) type = "application/octet-stream";
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, type);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Cardboard");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IOException("Android wouldn't make a new file in Downloads. Is the phone full?");
        OutputStream stream = resolver.openOutputStream(uri);
        if (stream == null) throw new IOException("Android wouldn't let Cardboard write to Downloads.");
        int handle = nextSave++;
        saving.put(handle, new Saving(uri, stream, name));
        return out.put("handle", handle);
      }
      case "save": {
        Saving s = saving.get(m.getInt("handle"));
        if (s == null) throw new IOException("This download was stopped. Start it again.");
        s.out.write(Base64.decode(m.getString("data"), Base64.NO_WRAP));
        return out;
      }
      case "save-end": {
        Saving s = saving.remove(m.getInt("handle"));
        if (s == null) return out;
        if (!m.optBoolean("ok")) {
          s.abandon(resolver);
          return out;
        }
        s.out.close();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(s.uri, v, null, null);
        main.post(() -> toast("Saved in Downloads › Cardboard: " + s.name));
        return out.put("where", "Downloads › Cardboard");
      }
      default:
        throw new IOException("This Cardboard app is older than your Cardboard. Install the new app.");
    }
  }

  static void put(JSONObject o, String key, Object value) {
    try {
      o.put(key, value);
    } catch (JSONException ignored) {
      // Only a null key or a non-finite number can fail, and neither happens here.
    }
  }

  static JSONObject describe(ContentResolver resolver, Uri uri) throws JSONException {
    String name = null;
    long size = -1;
    try (Cursor c = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        if (!c.isNull(0)) name = c.getString(0);
        if (!c.isNull(1)) size = c.getLong(1);
      }
    } catch (RuntimeException ignored) {
      // Some apps share things they can't describe; the page reads it to the end instead.
    }
    if (name == null) name = uri.getLastPathSegment();
    String type = resolver.getType(uri);
    return new JSONObject().put("name", cleanName(name)).put("type", type == null ? "" : type).put("size", size);
  }

  static String cleanName(String name) {
    String clean = name == null ? "" : name.replaceAll("[\\x00-\\x1f/\\\\:*?\"<>|]", "_").trim();
    if (clean.length() > 200) clean = clean.substring(0, 200);
    return clean.isEmpty() || clean.startsWith(".") ? "file" + clean : clean;
  }

  // ── The Share menu ───────────────────────────────────────────────────────────

  /** Something another app shared: text, and files (each read only when the page asks for it). */
  static final class Shared {
    final String text;
    final List<Uri> uris;
    InputStream in;
    int inFile = -1;
    long inAt;

    Shared(String text, List<Uri> uris) {
      this.text = text;
      this.uris = uris;
    }

    synchronized byte[] read(ContentResolver resolver, int n, long offset, int length) throws IOException {
      if (n < 0 || n >= uris.size()) throw new IOException("There's no such shared file.");
      if (in == null || n != inFile || offset != inAt) {
        close();
        in = resolver.openInputStream(uris.get(n));
        if (in == null) throw new IOException("The app that shared this file won't let Cardboard read it.");
        inFile = n;
        inAt = 0;
        while (inAt < offset) {
          long skipped = in.skip(offset - inAt);
          if (skipped <= 0) {
            if (in.read() < 0) break;
            skipped = 1;
          }
          inAt += skipped;
        }
      }
      byte[] bytes = new byte[length];
      int got = 0;
      while (got < length) {
        int r = in.read(bytes, got, length - got);
        if (r < 0) break;
        got += r;
      }
      inAt += got;
      return got == length ? bytes : Arrays.copyOf(bytes, got);
    }

    synchronized void close() {
      try {
        if (in != null) in.close();
      } catch (IOException ignored) {
        // Nothing more to read either way.
      }
      in = null;
      inFile = -1;
    }
  }

  /** Takes what another app shared. Returns true if there's something to send. */
  boolean take(Intent intent) {
    if (intent == null) return false;
    String action = intent.getAction();
    boolean one = Intent.ACTION_SEND.equals(action);
    if (!one && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
    List<Uri> found = new ArrayList<>();
    if (one) {
      Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
      if (u != null) found.add(u);
    } else {
      ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
      if (list != null) found.addAll(list);
    }
    ClipData clip = intent.getClipData();
    if (found.isEmpty() && clip != null) for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) found.add(clip.getItemAt(i).getUri());
    // Only content:// from other apps. A file:// path could point into this app's own storage.
    List<Uri> uris = new ArrayList<>();
    for (Uri u : found) if (u != null && "content".equals(u.getScheme()) && !getPackageName().equals(u.getAuthority())) uris.add(u);
    CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
    CharSequence body = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
    StringBuilder text = new StringBuilder();
    if (subject != null && subject.toString().trim().length() > 0 && (body == null || !body.toString().contains(subject))) text.append(subject).append('\n');
    if (body != null) text.append(body);
    String t = text.toString().trim();
    if (t.isEmpty() && uris.isEmpty()) return false;
    Shared old = shared;
    shared = new Shared(t, uris);
    if (old != null) io.execute(old::close);
    return true;
  }

  void closeShared() {
    Shared s = shared;
    shared = null;
    if (s != null) s.close();
  }

  // ── Downloads ────────────────────────────────────────────────────────────────

  static final class Saving {
    final Uri uri;
    final OutputStream out;
    final String name;

    Saving(Uri uri, OutputStream out, String name) {
      this.uri = uri;
      this.out = out;
      this.name = name;
    }

    void abandon(ContentResolver resolver) {
      try {
        out.close();
      } catch (IOException ignored) {
        // It's deleted next anyway.
      }
      resolver.delete(uri, null, null);
    }
  }

  // ── The address screen, and when Cardboard isn't answering ───────────────────

  /** https://host[:port] from what someone typed or tapped, or null if it isn't a Cardboard address. */
  static String originOf(String typed) {
    String t = typed == null ? "" : typed.trim();
    if (t.isEmpty()) return null;
    if (!t.contains("://")) t = "https://" + t;
    Uri u = Uri.parse(t);
    if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty() || u.getUserInfo() != null) return null;
    String host = u.getHost().toLowerCase(Locale.ROOT);
    if (!host.matches("[a-z0-9.-]+")) return null;
    return "https://" + host + (u.getPort() > 0 && u.getPort() != 443 ? ":" + u.getPort() : "");
  }

  void ask(String problem) {
    LinearLayout page = column();
    page.addView(text("Cardboard", 30, true));
    page.addView(text("What's your Cardboard's address?", 18, true));
    page.addView(text("It's the address you open Cardboard at, like https://laptop.tail1234.ts.net:8443. You type it once; the app remembers it.", 15, false));
    EditText field = new EditText(this);
    field.setSingleLine(true);
    field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    field.setImeOptions(EditorInfo.IME_ACTION_GO);
    field.setHint("https://…");
    field.setTextColor(night() ? INK_NIGHT : INK);
    if (origin != null) field.setText(origin);
    page.addView(field);
    TextView error = text(problem == null ? "" : problem, 15, false);
    error.setTextColor(ERROR);
    page.addView(error);
    Button go = new Button(this);
    go.setText("Open my Cardboard");
    Button paste = new Button(this);
    paste.setText("Paste");
    paste.setOnClickListener(v -> {
      ClipboardManager clipboard = getSystemService(ClipboardManager.class);
      ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
      if (clip != null && clip.getItemCount() > 0 && clip.getItemAt(0).getText() != null) field.setText(clip.getItemAt(0).getText().toString().trim());
    });
    go.setOnClickListener(v -> {
      String chosen = originOf(field.getText().toString());
      if (chosen == null) {
        error.setText("That doesn't look like a Cardboard address. It starts with https:// and has no spaces.");
        return;
      }
      if (web != null && !chosen.equals(origin)) {
        // A different Cardboard: start a fresh page for it.
        root.removeView(web);
        web.destroy();
        web = null;
        port = null;
      }
      origin = chosen;
      prefs.edit().putString("origin", origin).apply();
      open(shared != null ? sendPath() : "/");
    });
    field.setOnEditorActionListener((v, action, event) -> go.performClick());
    page.addView(row(paste, go));
    showCover(page);
  }

  void trouble(String failing, String detail) {
    LinearLayout page = column();
    page.addView(text("Cardboard isn't answering", 24, true));
    page.addView(text("Is the computer Cardboard runs on switched on and online? It's at " + origin + ".", 16, false));
    if (detail != null && !detail.isEmpty()) page.addView(text("(" + detail + ")", 13, false));
    Button again = new Button(this);
    again.setText("Try again");
    again.setOnClickListener(v -> {
      removeCover();
      if (web != null) web.loadUrl(failing != null && ours(Uri.parse(failing)) ? failing : origin + "/");
    });
    Button change = new Button(this);
    change.setText("Change address");
    change.setOnClickListener(v -> ask(null));
    page.addView(row(change, again));
    showCover(page);
  }

  LinearLayout column() {
    LinearLayout page = new LinearLayout(this);
    page.setOrientation(LinearLayout.VERTICAL);
    int pad = dp(24);
    page.setPadding(pad, pad * 2, pad, pad);
    return page;
  }

  LinearLayout row(View... views) {
    LinearLayout row = new LinearLayout(this);
    row.setGravity(Gravity.END);
    for (View v : views) row.addView(v);
    return row;
  }

  TextView text(String words, int sp, boolean strong) {
    TextView t = new TextView(this);
    t.setText(words);
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
    t.setTextColor(night() ? INK_NIGHT : INK);
    if (strong) t.setTypeface(Typeface.DEFAULT_BOLD);
    t.setPadding(0, 0, 0, dp(12));
    return t;
  }

  int dp(int n) {
    return Math.round(n * getResources().getDisplayMetrics().density);
  }

  void showCover(View content) {
    removeCover();
    ScrollView scroll = new ScrollView(this);
    scroll.setBackgroundColor(night() ? PAPER_NIGHT : PAPER);
    scroll.addView(content);
    cover = scroll;
    root.addView(cover, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  void removeCover() {
    if (cover != null) root.removeView(cover);
    cover = null;
  }

  void toast(String words) {
    Toast.makeText(this, words, Toast.LENGTH_LONG).show();
  }
}
