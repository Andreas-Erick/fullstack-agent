package com.nexusagent.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * Shows the phone client served by the desktop (renderer/remote) in a WebView that only ever loads
 * that one address (plus the Cloudflare Access sign-in, if the user put Access in front of it). Links
 * elsewhere open in the browser. A small bridge (window.NexusAndroid) lets the page hand over the
 * device token for background notifications; it only answers while our own address is loaded.
 */
public class MainActivity extends Activity {
    static final String ACTION_TALK = "com.nexusagent.android.TALK";
    private static final int REQ_MIC = 1;
    private static final int REQ_NOTIFY = 2;
    /** The link in the desktop's pairing QR code: address + #pair=one-time secret. */
    private static final java.util.regex.Pattern PAIR_LINK = java.util.regex.Pattern.compile("^(https?://\\S+?)/?#pair=([A-Za-z0-9_-]{43})$");
    /** A one-time secret for moving this device to the secure address (companion.js /api/move). */
    private static final java.util.regex.Pattern MOVE_SECRET = java.util.regex.Pattern.compile("^[A-Za-z0-9_-]{43}$");

    /** True while the app is on screen; the service then leaves notifications to the page. */
    static volatile boolean foreground;

    private FrameLayout root;
    private WebView web;
    private String origin;
    private volatile String pageOrigin = "";
    private boolean loaded;
    private String pendingJs;
    private PermissionRequest pendingPermission;
    /** "#pair=…" for the next page load only (from a pairing link entered on the setup screen). */
    private String pendingPair;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Debug builds only: lets Chrome DevTools inspect the page (chrome://inspect).
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.bg));
        // Edge to edge: keep the page clear of the status bar, navigation bar and keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return WindowInsets.CONSUMED;
        });
        setContentView(root);
        origin = Prefs.server(this);
        if (origin == null) showSetup(null, null);
        else showWeb();
        handleIntent(getIntent());
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        foreground = false;
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ------------------------------------------------------------ first run
    /** prefill: a pairing link shared to the app; it is only filled in, the user still taps Connect. */
    private void showSetup(String error, String prefill) {
        destroyWeb();
        LinearLayout box = hudPanel();

        TextView title = text(getString(R.string.setup_title), 18, getColor(R.color.text));
        Hud.title(title);
        TextView sub = text(getString(R.string.hud_setup_sub), 11, getColor(R.color.muted));
        Hud.readout(sub);
        sub.setPadding(0, dp(6), 0, 0);
        TextView hint = text(getString(R.string.setup_hint), 15, getColor(R.color.muted));
        hint.setPadding(0, dp(14), 0, dp(10));
        TextView kinds = text(getString(R.string.setup_kinds), 13, getColor(R.color.muted));
        Hud.readout(kinds);
        kinds.setGravity(Gravity.START);
        kinds.setLineSpacing(dp(3), 1f);
        kinds.setPadding(dp(4), 0, dp(4), dp(16));
        EditText address = new EditText(this);
        Hud.field(address);
        address.setHint(R.string.setup_address);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setTextColor(getColor(R.color.text));
        address.setHintTextColor(getColor(R.color.muted));
        String last = Prefs.server(this);
        if (prefill != null) address.setText(prefill);
        else if (last != null) address.setText(last);
        TextView err = text(error == null ? "" : error, 14, Color.rgb(255, 77, 109));
        err.setPadding(0, dp(8), 0, 0);
        Button connect = new Button(this);
        connect.setText(R.string.setup_connect);
        Hud.button(connect, true);
        Button paste = new Button(this);
        paste.setText(R.string.setup_paste);
        Hud.button(paste, false);
        paste.setOnClickListener(v -> {
            android.content.ClipboardManager cm = getSystemService(android.content.ClipboardManager.class);
            android.content.ClipData clip = cm == null ? null : cm.getPrimaryClip();
            CharSequence t = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(this) : null;
            if (t == null || t.toString().trim().isEmpty()) err.setText(R.string.setup_paste_empty);
            else address.setText(t.toString().trim());
        });
        Runnable go = () -> {
            String typed = address.getText().toString().trim();
            // A pairing link (from the QR code) connects and pairs in one step; only the address is saved.
            java.util.regex.Matcher link = PAIR_LINK.matcher(typed);
            boolean isLink = link.matches();
            String o = Prefs.toOrigin(isLink ? link.group(1) : typed);
            if (o == null) {
                err.setText(R.string.setup_invalid);
                return;
            }
            if (!o.equals(Prefs.server(this)) || isLink) Prefs.setToken(this, null, null); // a new desktop or pairing: pair again
            Prefs.setServer(this, o);
            origin = o;
            pendingPair = isLink ? "#pair=" + link.group(2) : null;
            showWeb();
        };
        connect.setOnClickListener(v -> go.run());
        address.setOnEditorActionListener((v, id, ev) -> {
            go.run();
            return true;
        });
        box.addView(title);
        box.addView(sub);
        box.addView(hint);
        box.addView(kinds);
        box.addView(address, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(err);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        row.addView(paste, half);
        LinearLayout.LayoutParams half2 = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 2f);
        half2.leftMargin = dp(10);
        row.addView(connect, half2);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        box.addView(row, lp);
    }

    private void showError(String detail) {
        destroyWeb();
        LinearLayout box = hudPanel();
        TextView title = text(getString(R.string.error_title), 17, getColor(R.color.text));
        Hud.title(title);
        title.setTextColor(Color.rgb(255, 77, 109));
        title.setShadowLayer(dp(10), 0, 0, Color.argb(200, 255, 77, 109));
        box.addView(title);
        String why = origin.endsWith(".ts.net") ? getString(R.string.error_tailscale) : origin.startsWith("http://") ? getString(R.string.error_lan) : "";
        TextView d = text(origin + "\n" + detail + (why.isEmpty() ? "" : "\n\n" + why), 13, getColor(R.color.muted));
        Hud.readout(d);
        d.setPadding(0, dp(10), 0, dp(18));
        box.addView(d);
        Button retry = new Button(this);
        retry.setText(R.string.error_retry);
        Hud.button(retry, true);
        retry.setOnClickListener(v -> showWeb());
        Button change = new Button(this);
        change.setText(R.string.error_change);
        Hud.button(change, false);
        change.setOnClickListener(v -> showSetup(null, null));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        box.addView(retry, lp);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = dp(10);
        box.addView(change, lp2);
    }

    /** A native screen in the HUD style: grid background, and a bracketed panel in the middle (returned). */
    private LinearLayout hudPanel() {
        root.removeAllViews();
        root.setBackground(Hud.background(this));
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setBackground(Hud.frame(this));
        int pad = dp(22);
        panel.setPadding(pad, pad, pad, pad);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        lp.leftMargin = lp.rightMargin = dp(20);
        lp.topMargin = lp.bottomMargin = dp(16);
        // Centered, and scrollable on a small screen or with the keyboard open.
        FrameLayout holder = new FrameLayout(this);
        holder.addView(panel, lp);
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(holder, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return panel;
    }

    // ------------------------------------------------------------ web view
    private void showWeb() {
        destroyWeb();
        root.removeAllViews();
        root.setBackgroundColor(getColor(R.color.bg));
        loaded = false;
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.bg));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new Bridge(), "NexusAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (allowedInApp(u)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                    // no app for this link
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageOrigin = Prefs.originOf(url);
                loaded = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loaded = origin.equals(Prefs.originOf(url));
                if (loaded && pendingJs != null) {
                    view.evaluateJavascript(pendingJs, null);
                    pendingJs = null;
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                if (req.isForMainFrame()) showError(String.valueOf(error.getDescription()));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest req) {
                boolean ours = origin.equals(Prefs.originOf(req.getOrigin().toString()));
                boolean audioOnly = req.getResources().length == 1 && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(req.getResources()[0]);
                if (!ours || !audioOnly) {
                    req.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    req.grant(req.getResources());
                } else {
                    pendingPermission = req;
                    requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(origin + "/" + (pendingPair == null ? "" : pendingPair));
        pendingPair = null;
    }

    /** Our desktop's address, and Cloudflare Access's sign-in pages (only if the address is https). */
    private boolean allowedInApp(Uri u) {
        if (origin.equals(Prefs.originOf(u.toString()))) return true;
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
        return "https".equals(u.getScheme()) && origin.startsWith("https://") && host.endsWith(".cloudflareaccess.com");
    }

    private void destroyWeb() {
        if (web == null) return;
        root.removeView(web);
        web.destroy();
        web = null;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_MIC && pendingPermission != null) {
            if (granted) pendingPermission.grant(pendingPermission.getResources());
            else pendingPermission.deny();
            pendingPermission = null;
        }
        if (code == REQ_NOTIFY) {
            Prefs.setBackground(this, granted);
            if (granted) ConnectionService.start(this);
            runJs("window.nexusBackgroundChanged && nexusBackgroundChanged(" + granted + ")");
        }
    }

    // ------------------------------------------------------------ intents
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && PAIR_LINK.matcher(text.trim()).matches()) showSetup(null, text.trim()); // the user confirms the address
            else if (text != null && !text.trim().isEmpty()) runJs("window.nexusShare && nexusShare(" + JSONObject.quote(text.trim()) + ")");
        } else if (ACTION_TALK.equals(intent.getAction())) {
            runJs("window.nexusTalk && nexusTalk()");
        }
    }

    /** Runs JavaScript in our page now, or once it has loaded. */
    private void runJs(String js) {
        if (web != null && loaded) web.evaluateJavascript(js, null);
        else pendingJs = js;
    }

    // ------------------------------------------------------------ bridge
    /** Called by renderer/remote/app.js. Every method checks that our own page is the one asking. */
    private final class Bridge {
        private boolean trusted() {
            return origin != null && origin.equals(pageOrigin);
        }

        @JavascriptInterface
        public void setToken(String token, String deviceName) {
            if (!trusted()) return;
            Prefs.setToken(MainActivity.this, token, deviceName);
            if (Prefs.background(MainActivity.this)) ConnectionService.start(MainActivity.this);
        }

        @JavascriptInterface
        public void clearToken() {
            if (!trusted()) return;
            Prefs.setToken(MainActivity.this, null, null);
            ConnectionService.stop(MainActivity.this);
        }

        @JavascriptInterface
        public boolean backgroundEnabled() {
            return trusted() && Prefs.background(MainActivity.this);
        }

        /** Notifications while the app is closed (a foreground service keeps the connection). */
        @JavascriptInterface
        public void setBackground(boolean on) {
            if (!trusted()) return;
            runOnUiThread(() -> {
                if (!on) {
                    Prefs.setBackground(MainActivity.this, false);
                    ConnectionService.stop(MainActivity.this);
                } else if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
                } else {
                    Prefs.setBackground(MainActivity.this, true);
                    ConnectionService.start(MainActivity.this);
                }
            });
        }

        /**
         * The page got a one-time secret for the computer's secure address: load that address with it,
         * where the page finishes the switch and hands over the new token (setToken).
         */
        @JavascriptInterface
        public void moveTo(String url, String secret) {
            if (!trusted()) return;
            String o = Prefs.toOrigin(url);
            if (o == null || !o.startsWith("https://") || secret == null || !MOVE_SECRET.matcher(secret).matches()) return;
            runOnUiThread(() -> {
                // The old token stops working once the switch is done; the service restarts with the new one.
                ConnectionService.stop(MainActivity.this);
                Prefs.setServer(MainActivity.this, o);
                origin = o;
                pendingPair = "#move=" + secret;
                showWeb();
            });
        }

        @JavascriptInterface
        public void changeServer() {
            if (!trusted()) return;
            runOnUiThread(() -> {
                ConnectionService.stop(MainActivity.this);
                Prefs.setToken(MainActivity.this, null, null);
                Prefs.setBackground(MainActivity.this, false);
                showSetup(null, null);
            });
        }
    }

    // ------------------------------------------------------------ helpers
    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
