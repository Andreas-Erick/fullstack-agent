package com.nexusagent.android.wear;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Today on the wrist: what's next on the schedule. */
public class TodayActivity extends Activity {
    private Link link;
    private LinearLayout col;
    private ScrollView scroll;
    private Look look;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        link = new Link(this);
        look = Look.of(this); // the persona's colors (WatchActivity keeps them current)
        int pad = (int) (getResources().getDisplayMetrics().widthPixels * 0.12f);
        col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);
        scroll = new ScrollView(this);
        scroll.setBackgroundColor(look.bg);
        scroll.setFocusable(true);
        scroll.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);
        show(text(getString(R.string.loading), 14, look.muted));
    }

    @Override
    protected void onResume() {
        super.onResume();
        link.start();
        scroll.requestFocus();
        link.request("/siren/today", "/siren/today", new JSONObject(), 30_000, this::render);
    }

    @Override
    protected void onPause() {
        link.stop();
        super.onPause();
    }

    private void render(Link.Result r) {
        if (r.body == null) {
            String p = r.problem == null ? "" : r.problem;
            String why = p.equals("unpaired") ? getString(R.string.unpaired)
                : p.equals("no_relay") ? getString(R.string.no_relay)
                : p.equals("unreachable") ? getString(R.string.computer_offline)
                : p.equals("offline") ? (r.error != null && !r.error.isEmpty() ? r.error : getString(R.string.computer_offline))
                : getString(R.string.no_phone);
            show(text(why, 14, look.text));
            return;
        }
        col.removeAllViews();
        TextView title = text(getString(R.string.today).toUpperCase(Locale.ROOT), 13, look.accent);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setLetterSpacing(0.12f);
        col.addView(title);

        // What's still coming today.
        col.addView(heading(getString(R.string.schedule)));
        JSONArray events = r.body.optJSONArray("events");
        int shown = 0;
        long now = System.currentTimeMillis();
        SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.ROOT);
        SimpleDateFormat out = new SimpleDateFormat("HH:mm", Locale.getDefault());
        for (int i = 0; events != null && i < events.length(); i++) {
            JSONObject e = events.optJSONObject(i);
            if (e == null) continue;
            String when;
            try {
                Date end = in.parse(e.optString("end"));
                if (!e.optBoolean("allDay") && end != null && end.getTime() < now) continue;
                when = e.optBoolean("allDay") ? getString(R.string.all_day) : out.format(in.parse(e.optString("start")));
            } catch (Exception ex) {
                when = "";
            }
            col.addView(text(when + "  " + e.optString("title"), 14, look.text));
            shown++;
        }
        if (shown == 0) col.addView(text(getString(R.string.nothing_today), 13, look.muted));
    }

    private TextView heading(String s) {
        TextView t = text(s.toUpperCase(Locale.ROOT), 11, look.muted);
        t.setLetterSpacing(0.14f);
        t.setPadding(0, dp(12), 0, dp(2));
        return t;
    }

    private void show(View v) {
        col.removeAllViews();
        col.addView(v);
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }
}
