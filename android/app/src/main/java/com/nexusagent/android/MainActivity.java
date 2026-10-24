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
        root.removeAllViews();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        int pad = dp(24);
        box.setPadding(pad, pad, pad, pad);

        TextView title = text(getString(R.string.setup_title), 22, getColor(R.color.text));
        TextView hint = text(getString(R.string.setup_hint), 15, getColor(R.color.muted));
        hint.setPadding(0, dp(10), 0, dp(18));
        EditText address = new EditText(this);
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
        box.addView(hint);
        box.addView(address, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(err);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        box.addView(connect, lp);
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void showError(String detail) {
        destroyWeb();
        root.removeAllViews();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        int pad = dp(24);
        box.setPadding(pad, pad, pad, pad);
        box.addView(text(getString(R.string.error_title), 20, getColor(R.color.text)));
        TextView d = text(origin + "\n" + detail, 14, getColor(R.color.muted));
        d.setPadding(0, dp(8), 0, dp(16));
        box.addView(d);
        Button retry = new Button(this);
        retry.setText(R.string.error_retry);
        retry.setOnClickListener(v -> showWeb());
        Button change = new Button(this);
        change.setText(R.string.error_change);
        change.setOnClickListener(v -> showSetup(null, null));
        box.addView(retry);
        box.addView(change);
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // ------------------------------------------------------------ web view
    private void showWeb() {
        destroyWeb();
        root.removeAllViews();
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
