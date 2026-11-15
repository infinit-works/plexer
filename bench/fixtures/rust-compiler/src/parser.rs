use crate::lexer::{LexToken, TokenKind};

/// Recursive-descent parser constructing struct and union syntax trees.
#[derive(Debug, Clone)]
pub struct FieldAst {
    pub name: String,
    pub type_ref: String,
}

#[derive(Debug, Clone)]
pub enum SchemaDecl {
    Struct { name: String, fields: Vec<FieldAst> },
    Union { name: String, variants: Vec<String> },
}

pub fn parse_schema(tokens: &[LexToken]) -> Vec<SchemaDecl> {
    let mut decls = Vec::new();
    let mut cursor = 0;
    while cursor < tokens.len() {
        if let TokenKind::Ident(kw) = &tokens[cursor].kind {
            if kw == "struct" && cursor + 1 < tokens.len() {
                if let TokenKind::Ident(name) = &tokens[cursor + 1].kind {
                    decls.push(SchemaDecl::Struct {
                        name: name.clone(),
                        fields: Vec::new(),
                    });
                    cursor += 2;
                    continue;
                }
            }
            if kw == "union" && cursor + 1 < tokens.len() {
                if let TokenKind::Ident(name) = &tokens[cursor + 1].kind {
                    decls.push(SchemaDecl::Union {
                        name: name.clone(),
                        variants: Vec::new(),
                    });
                    cursor += 2;
                    continue;
                }
            }
        }
        cursor += 1;
    }
    decls
}
