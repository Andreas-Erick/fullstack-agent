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

/** Today on the wrist: what's next on the schedule, and the habits, checked off with a tap. */
public class TodayActivity extends Activity {
    private Link link;
    private LinearLayout col;
    private ScrollView scroll;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        link = new Link(this);
        int pad = (int) (getResources().getDisplayMetrics().widthPixels * 0.12f);
        col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);
        scroll = new ScrollView(this);
        scroll.setBackgroundColor(getColor(R.color.bg));
        scroll.setFocusable(true);
        scroll.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);
        show(text(getString(R.string.loading), 14, getColor(R.color.muted)));
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
            show(text(r.problem != null && r.problem.equals("unpaired") ? getString(R.string.unpaired) : r.problem != null && r.problem.equals("no_relay") ? getString(R.string.no_relay) : r.error != null ? r.error : getString(R.string.no_phone), 14, getColor(R.color.text)));
            return;
        }
        col.removeAllViews();
        TextView title = text(getString(R.string.today).toUpperCase(Locale.ROOT), 13, getColor(R.color.accent));
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
            col.addView(text(when + "  " + e.optString("title"), 14, getColor(R.color.text)));
            shown++;
        }
        if (shown == 0) col.addView(text(getString(R.string.nothing_today), 13, getColor(R.color.muted)));

        // Habits: tap to check off (or undo).
        col.addView(heading(getString(R.string.habits)));
        JSONArray habits = r.body.optJSONArray("habits");
        int count = 0;
        for (int i = 0; habits != null && i < habits.length(); i++) {
            JSONObject h = habits.optJSONObject(i);
            if (h == null || h.optBoolean("paused")) continue;
            col.addView(habit(h));
            count++;
        }
        if (count == 0) col.addView(text(getString(R.string.no_habits), 13, getColor(R.color.muted)));
    }

    private View habit(JSONObject h) {
        boolean done = h.optBoolean("doneToday");
        String name = h.optString("name");
        int streak = h.optInt("streak");
        TextView t = text((done ? "✓  " : "○  ") + name + (streak > 0 ? "  · " + streak + (h.optString("streakUnit").equals("weeks") ? " wk" : " d") : ""), 15, done ? getColor(R.color.bg) : getColor(R.color.text));
        t.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        t.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(18));
        bg.setColor(done ? getColor(R.color.accent) : Color.argb(36, 45, 212, 191));
        t.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(4), 0, 0);
        t.setLayoutParams(lp);
        t.setContentDescription(name + (done ? ", done today" : ", not done yet"));
        t.setOnClickListener((v) -> {
            v.performHapticFeedback(done ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.CONFIRM);
            v.setAlpha(0.5f);
            JSONObject body = new JSONObject();
            try {
                body.put("name", name).put("done", !done);
            } catch (Exception ignored) {
                // fixed keys
            }
            link.request("/siren/habit", "/siren/today", body, 30_000, this::render);
        });
        return t;
    }

    private TextView heading(String s) {
        TextView t = text(s.toUpperCase(Locale.ROOT), 11, getColor(R.color.muted));
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
