use std::fs;
use std::path::Path;

fn main() {
    tauri_build::build();

    let manifest_path = "../node-components.json";
    println!("cargo:rerun-if-changed={}", manifest_path);

    let content = fs::read_to_string(manifest_path)
        .expect("Failed to read node-components.json");
    let json: serde_json::Value = serde_json::from_str(&content)
        .expect("Failed to parse node-components.json");

    let components = json["components"].as_array()
        .expect("components must be an array");

    let entries: Vec<String> = components.iter().map(|c| {
        let name = c["name"].as_str().unwrap();
        let hw = c["requiresHardware"].as_bool().unwrap();
        format!("    (\"{}\", {})", name, hw)
    }).collect();

    let out = format!(
        "pub const MANIFEST: &[(&str, bool)] = &[\n{}\n];\n",
        entries.join(",\n")
    );

    let out_dir = std::env::var("OUT_DIR").unwrap();
    fs::write(Path::new(&out_dir).join("component_manifest.rs"), out)
        .expect("Failed to write component_manifest.rs");
}
