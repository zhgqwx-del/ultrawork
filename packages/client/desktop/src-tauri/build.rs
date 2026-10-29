use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=ULTRAWORK_BUILD_BRAND_FILE");
    println!("cargo:rerun-if-env-changed=ULTRAWORK_BRAND_TRAY_ICON");
    println!("cargo:rerun-if-env-changed=ULTRAWORK_BRAND_MACOS_ICON");
    let macos_icon = env::var_os("ULTRAWORK_BRAND_MACOS_ICON").filter(|value| !value.is_empty())
        .map(PathBuf::from).unwrap_or_else(|| PathBuf::from("icons/icon-macos.icns"));
    println!("cargo:rerun-if-changed={}", macos_icon.display());
    let default = serde_json::json!({
        "schemaVersion": 1, "brandId": "ultrawork", "productName": "Ultrawork",
        "identifier": "com.ultrawork.desktop", "namespace": "ultrawork", "isDefault": true
    });
    let identity = match env::var("ULTRAWORK_BUILD_BRAND_FILE").ok().filter(|s| !s.is_empty()) {
        Some(path) => {
            println!("cargo:rerun-if-changed={path}");
            let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).expect("brand identity file is readable"))
                .expect("brand identity file is valid JSON");
            for key in ["brandId", "productName", "identifier", "namespace"] {
                assert!(value.get(key).and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()), "brand identity is missing {key}");
            }
            assert_eq!(value["schemaVersion"], 1, "unsupported build brand schema");
            let namespace = value["namespace"].as_str().unwrap();
            assert!(namespace.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "unsafe brand namespace");
            value
        }
        None => default,
    };
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::write(output.join("brand.json"), serde_json::to_vec(&identity).unwrap()).unwrap();
    println!("cargo:rustc-env=ULTRAWORK_COMPILED_NAMESPACE={}", identity["namespace"].as_str().unwrap());
    println!("cargo:rustc-env=ULTRAWORK_COMPILED_PRODUCT_NAME={}", identity["productName"].as_str().unwrap());
    let tray = env::var("ULTRAWORK_BRAND_TRAY_ICON").ok().filter(|s| !s.is_empty())
        .map(PathBuf::from).unwrap_or_else(|| PathBuf::from("icons/tray-template@2x.png"));
    println!("cargo:rerun-if-changed={}", tray.display());
    let tray_output = output.join("brand-tray.png");
    fs::copy(&tray, &tray_output).expect("brand tray icon is readable");
    println!("cargo:rustc-env=ULTRAWORK_COMPILED_TRAY_ICON={}", tray_output.display());
    tauri_build::build()
}
