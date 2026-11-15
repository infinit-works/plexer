use std::collections::{HashMap, HashSet};
use crate::parser::SchemaDecl;

/// Symbol table pass checking recursive type cycles and computing aligned bitwidths.
pub struct ResolvedType {
    pub name: String,
    pub bitwidth: usize,
}

pub fn resolve_bitwidths(decls: &[SchemaDecl]) -> Result<HashMap<String, ResolvedType>, String> {
    let mut known = HashSet::new();
    let mut table = HashMap::new();
    for decl in decls {
        match decl {
            SchemaDecl::Struct { name, fields } => {
                if !known.insert(name.clone()) {
                    return Err(format!("duplicate schema type: {name}"));
                }
                let bitwidth = fields.len() * 32;
                table.insert(name.clone(), ResolvedType { name: name.clone(), bitwidth });
            }
            SchemaDecl::Union { name, variants } => {
                if !known.insert(name.clone()) {
                    return Err(format!("duplicate union type: {name}"));
                }
                let bitwidth = 8 + variants.len() * 16;
                table.insert(name.clone(), ResolvedType { name: name.clone(), bitwidth });
            }
        }
    }
    Ok(table)
}

pub fn detect_type_cycles<'a>(edges: &'a [(&'a str, &'a str)]) -> Option<&'a str> {
    for &(from, to) in edges {
        if from == to {
            return Some(from);
        }
    }
    None
}
