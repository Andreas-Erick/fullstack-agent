package com.nexusagent.android;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RadialGradient;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

/**
 * The futuristic HUD look for the app's own (native) screens: setup and connection errors. Same
 * language as the web client (renderer/remote): a perspective grid floor, corner brackets, glowing
 * monospace titles. Drawn in code, no libraries or image assets.
 */
final class Hud {
    private Hud() {}

    static int accent(Context c) {
        return c.getColor(R.color.accent);
    }

    static int alpha(int color, float a) {
        return Color.argb(Math.round(255 * a), Color.red(color), Color.green(color), Color.blue(color));
    }

    static float dp(Context c, float v) {
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics());
    }

    /** Screen background: the theme color, a glow, and a perspective grid receding to a horizon. */
    static Drawable background(Context c) {
        return new Drawable() {
            final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
            final Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);

            @Override
            public void draw(Canvas canvas) {
                Rect b = getBounds();
                int a = accent(c);
                canvas.drawColor(c.getColor(R.color.bg));
                float horizon = b.height() * 0.68f;
                glow.setShader(new RadialGradient(b.exactCenterX(), horizon, b.width() * 0.7f, alpha(a, 0.16f), Color.TRANSPARENT, Shader.TileMode.CLAMP));
                canvas.drawRect(b, glow);
                line.setStrokeWidth(dp(c, 1));
                // Lines toward a vanishing point, fading out at the horizon.
                line.setShader(new LinearGradient(0, horizon, 0, b.bottom, Color.TRANSPARENT, alpha(a, 0.45f), Shader.TileMode.CLAMP));
                float vx = b.exactCenterX();
                for (int i = -12; i <= 12; i++) canvas.drawLine(vx, horizon, vx + i * b.width() * 0.16f, b.bottom, line);
                // Cross lines, closer together toward the horizon.
                for (int i = 1; i <= 9; i++) {
                    float t = (float) Math.pow(i / 9f, 2.2);
                    float y = horizon + (b.bottom - horizon) * t;
                    canvas.drawLine(b.left, y, b.right, y, line);
                }
                line.setShader(null);
                line.setColor(alpha(a, 0.35f));
                canvas.drawLine(b.left, horizon, b.right, horizon, line);
            }

            @Override public void setAlpha(int alpha) {}
            @Override public void setColorFilter(ColorFilter cf) {}
            @Override public int getOpacity() { return PixelFormat.OPAQUE; }
        };
    }

    /** Corner brackets around a panel. */
    static Drawable frame(Context c) {
        return new Drawable() {
            final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

            @Override
            public void draw(Canvas canvas) {
                Rect b = getBounds();
                float s = dp(c, 18);
                float w = dp(c, 1.5f);
                float in = w / 2;
                p.setColor(alpha(accent(c), 0.85f));
                p.setStrokeWidth(w);
                p.setStyle(Paint.Style.STROKE);
                p.setShadowLayer(dp(c, 4), 0, 0, alpha(accent(c), 0.6f));
                float l = b.left + in, t = b.top + in, r = b.right - in, btm = b.bottom - in;
                canvas.drawLines(new float[] {l, t, l + s, t, l, t, l, t + s, r, t, r - s, t, r, t, r, t + s, l, btm, l + s, btm, l, btm, l, btm - s, r, btm, r - s, btm, r, btm, r, btm - s}, p);
            }

            @Override public void setAlpha(int alpha) {}
            @Override public void setColorFilter(ColorFilter cf) {}
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        };
    }

    /** A glowing, letter-spaced monospace title. */
    static void title(TextView t) {
        t.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        t.setLetterSpacing(0.22f);
        t.setAllCaps(true);
        t.setTextColor(accent(t.getContext()));
        t.setShadowLayer(dp(t.getContext(), 10), 0, 0, alpha(accent(t.getContext()), 0.8f));
    }

    /** Small monospace readout text. */
    static void readout(TextView t) {
        t.setTypeface(Typeface.MONOSPACE);
        t.setLetterSpacing(0.06f);
    }

    static void field(EditText e) {
        Context c = e.getContext();
        GradientDrawable d = new GradientDrawable();
        d.setColor(alpha(Color.BLACK, 0.35f));
        d.setCornerRadius(dp(c, 6));
        d.setStroke(Math.round(dp(c, 1)), alpha(accent(c), 0.45f));
        e.setBackground(d);
        int px = Math.round(dp(c, 14));
        e.setPadding(px, px, px, px);
        e.setTypeface(Typeface.MONOSPACE);
    }

    static void button(Button btn, boolean primary) {
        Context c = btn.getContext();
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(c, 6));
        d.setColor(primary ? alpha(accent(c), 0.18f) : Color.TRANSPARENT);
        d.setStroke(Math.round(dp(c, primary ? 1.5f : 1)), alpha(accent(c), primary ? 0.9f : 0.4f));
        btn.setBackground(d);
        btn.setTextColor(primary ? accent(c) : c.getColor(R.color.text));
        btn.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        btn.setLetterSpacing(0.2f);
        btn.setStateListAnimator(null);
        int px = Math.round(dp(c, 12));
        btn.setPadding(px, px, px, px);
    }
}
