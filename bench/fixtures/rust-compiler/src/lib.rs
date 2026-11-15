pub mod emit;
pub mod lexer;
pub mod parser;
pub mod resolve;

use crate::emit::emit_codec;
use crate::lexer::scan_tokens;
use crate::parser::parse_schema;
use crate::resolve::resolve_bitwidths;

pub fn compile_schema(source: &str) -> Result<String, String> {
    let tokens = scan_tokens(source);
    let ast = parse_schema(&tokens);
    let table = resolve_bitwidths(&ast)?;
    Ok(emit_codec(&table))
}
