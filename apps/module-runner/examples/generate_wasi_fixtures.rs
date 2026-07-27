use std::fs;
use std::path::PathBuf;

use wit_component::{ComponentEncoder, StringEncoding, dummy_module, embed_component_metadata};
use wit_parser::{ManglingAndAbi, Resolve};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/components");
    for name in [
        "echo",
        "filesystem-escape",
        "memory-limit",
        "output-limit",
        "raw-socket",
        "spin",
        "undeclared-import",
    ] {
        let source = fixture_dir.join(format!("{name}.component.wat"));
        let destination = fixture_dir.join(format!("{name}.component.wasm"));
        fs::write(destination, wat::parse_file(source)?)?;
    }

    let mut resolve = Resolve::default();
    let (package, _) = resolve
        .push_path(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("wit/openopc-module.wit"))?;
    let world = resolve.select_world(&[package], Some("module"))?;
    let mut module = dummy_module(&resolve, world, ManglingAndAbi::Standard32);
    embed_component_metadata(&mut module, &resolve, world, StringEncoding::UTF8)?;
    let component = ComponentEncoder::default()
        .validate(true)
        .module(&module)?
        .encode()?;
    fs::write(fixture_dir.join("all-imports.component.wasm"), component)?;
    Ok(())
}
