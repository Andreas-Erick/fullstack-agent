// Siren for Galaxy Watch (Wear OS 3+: Galaxy Watch 4 and newer). A small native app: ask by voice,
// hear and read the answer, see today and check habits off. It reaches the computer through the
// Siren phone app (WearRelayService, Google's Wear Data Layer), so it needs no pairing of its own.
// Approvals need no code here: the phone's Allow / Deny notifications show on the watch by themselves.
// Same applicationId and signing key as the phone app: the Data Layer only links those.
plugins {
    id("com.android.application")
}

val keystore: String? = System.getenv("NEXUS_KEYSTORE")

android {
    namespace = "com.nexusagent.android.wear"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.nexusagent.android"
        minSdk = 30 // Wear OS 3 (Galaxy Watch 4)
        targetSdk = 36
        // Its own version codes, above the phone's, so a store can carry both under one app.
        versionCode = 1_000_000 + (System.getenv("NEXUS_VERSION_CODE")?.toIntOrNull() ?: 1)
        versionName = System.getenv("NEXUS_VERSION") ?: "0.1.0"
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("NEXUS_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("NEXUS_KEY_ALIAS")
                keyPassword = System.getenv("NEXUS_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-wearable:20.0.1")
}
