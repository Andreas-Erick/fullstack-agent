package com.nexusagent.android.wear;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * The persona's colors on the watch (from the desktop theme, data item /siren/look), remembered so
 * every screen opens in them. Only four colors; nothing else is kept.
 */
final class Look {
    final int bg;
    final int accent;
    final int text;
    final int muted;

    private Look(int bg, int accent, int text, int muted) {
        this.bg = bg;
        this.accent = accent;
        this.text = text;
        this.muted = muted;
    }

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences("look", Context.MODE_PRIVATE);
    }

    static Look of(Context c) {
        SharedPreferences p = sp(c);
        return new Look(p.getInt("bg", c.getColor(R.color.bg)), p.getInt("accent", c.getColor(R.color.accent)), p.getInt("text", c.getColor(R.color.text)), p.getInt("muted", c.getColor(R.color.muted)));
    }

    static void save(Context c, int bg, int accent, int text, int muted) {
        sp(c).edit().putInt("bg", bg).putInt("accent", accent).putInt("text", text).putInt("muted", muted).apply();
    }
}
