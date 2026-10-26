package com.nexusagent.android.wear;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.view.View;

/**
 * Siren's presence on the watch: song rings around a glowing pearl, in her teal and gold. Idle it
 * breathes; listening, the rings draw inward; thinking, a dashed gold halo turns; speaking, rings
 * ripple outward. Light on the battery: slow frames at idle, and nothing is drawn while the app
 * isn't on screen.
 */
public class SirenRing extends View {
    enum State { IDLE, LISTENING, THINKING, SPEAKING }

    private static final int TEAL = 0xFF2DD4BF;
    private static final int SKY = 0xFF38BDF8;
    private static final int GOLD = 0xFFE3B85A;

    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private State state = State.IDLE;
    private long start = System.currentTimeMillis();

    public SirenRing(Context c) {
        super(c);
        ring.setStyle(Paint.Style.STROKE);
        halo.setStyle(Paint.Style.STROKE);
        halo.setColor(GOLD);
        halo.setPathEffect(new DashPathEffect(new float[] {18, 10, 4, 10}, 0));
        setContentDescription("Siren");
    }

    void setState(State s) {
        state = s;
        start = System.currentTimeMillis();
        invalidate();
    }

    @Override
    protected void onDraw(Canvas c) {
        float w = getWidth();
        float h = getHeight();
        float cx = w / 2f;
        float cy = h / 2f;
        float r = Math.min(w, h) / 2f;
        float t = (System.currentTimeMillis() - start) / 1000f;
        // The pearl, breathing.
        float breathe = 1f + 0.05f * (float) Math.sin(t * (state == State.IDLE ? 1.6 : 4.0));
        float pr = r * 0.3f * breathe;
        fill.setShader(new RadialGradient(cx, cy - pr * 0.3f, pr * 1.6f, new int[] {0xFFE6FFFB, TEAL, 0x002DD4BF}, new float[] {0f, 0.45f, 1f}, Shader.TileMode.CLAMP));
        c.drawCircle(cx, cy, pr * 1.6f, fill);
        // Song rings: out while speaking or idle, in while listening.
        int rings = 3;
        float speed = state == State.SPEAKING ? 0.7f : state == State.LISTENING ? -0.6f : 0.22f;
        for (int i = 0; i < rings; i++) {
            float p = ((t * speed + i / (float) rings) % 1f + 1f) % 1f;
            float rr = r * (0.42f + p * 0.55f);
            int alpha = (int) (Math.sin(p * Math.PI) * (state == State.IDLE ? 90 : 190));
            ring.setColor(((i % 2 == 0 ? TEAL : SKY) & 0x00FFFFFF) | (alpha << 24));
            ring.setStrokeWidth(r * 0.025f);
            c.drawCircle(cx, cy, rr, ring);
        }
        // The lyre halo turns while she thinks.
        if (state == State.THINKING) {
            c.save();
            c.rotate(t * 140f, cx, cy);
            halo.setStrokeWidth(r * 0.035f);
            c.drawCircle(cx, cy, r * 0.62f, halo);
            c.restore();
        }
        // Idle breathes slowly (a frame every ~66 ms); the rest animates at full rate.
        if (state == State.IDLE) postInvalidateDelayed(66);
        else postInvalidateOnAnimation();
    }
}
