package com.nexusagent.android;

import android.app.Activity;
import android.os.Bundle;

/**
 * The launcher shortcut "Talk" (res/xml/shortcuts.xml). Not exported: the launcher starts a shortcut as this
 * app, other apps can't start it. It hands MainActivity the push-to-talk intent with the per-install key
 * (a static shortcut can't carry a secret itself) and closes without showing anything.
 */
public class TalkActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        startActivity(MainActivity.talkIntent(this));
        finish();
    }
}
