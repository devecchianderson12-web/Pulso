// Pulso's settings as a JSON file in the app's config folder (same keys as the Electron build).
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub struct Settings {
    file: PathBuf,
    data: Map<String, Value>,
}

fn defaults() -> Map<String, Value> {
    let v = json!({
        "bounds": { "width": 1200, "height": 800 },
        "maximized": false,
        "closeToTray": true,
        "startMinimized": false,
        "launchAtLogin": false,
        "notificationSound": true,
        "flashOnMessage": true,
        "spellcheck": true,
        "spellcheckLanguages": ["es", "en-US"],
        "zoomFactor": 1.0,
        "hardwareAcceleration": true,
        "theme": "pulso",
        "barColor": "#0e1413",
        "icon": null,
    });
    match v {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

impl Settings {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join("settings.json");
        let mut data = defaults();
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(Value::Object(saved)) = serde_json::from_str::<Value>(&text) {
                data.extend(saved);
            }
        }
        Settings { file, data }
    }

    pub fn get(&self, key: &str) -> Value {
        self.data.get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn bool(&self, key: &str) -> bool {
        self.data.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn str(&self, key: &str) -> String {
        self.data.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
    }

    pub fn f64(&self, key: &str) -> Option<f64> {
        self.data.get(key).and_then(Value::as_f64)
    }

    pub fn set(&mut self, key: &str, value: Value) {
        if self.data.get(key) == Some(&value) {
            return;
        }
        self.data.insert(key.to_string(), value);
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&Value::Object(self.data.clone())) {
            let _ = std::fs::write(&self.file, text);
        }
    }
}
