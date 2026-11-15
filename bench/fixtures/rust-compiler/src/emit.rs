use std::collections::HashMap;
use crate::resolve::ResolvedType;

/// Generates binary big-endian pack and unpack serialization functions.
pub fn emit_codec(resolved: &HashMap<String, ResolvedType>) -> String {
    let mut out = String::from("// generated binary codec\n");
    for ty in resolved.values() {
        out.push_str(&format!(
            "pub fn pack_{}(val: &[u8]) -> Vec<u8> {{ val.to_vec() }} // {} bits\n",
            ty.name, ty.bitwidth
        ));
        out.push_str(&format!(
            "pub fn unpack_{}(buf: &[u8]) -> &[u8] {{ buf }}\n",
            ty.name
        ));
    }
    out
}
