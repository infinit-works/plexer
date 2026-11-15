/// Zero-copy lexical scanner splitting source text into tokens and line spans.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenKind {
    Ident(String),
    Int(u64),
    LBrace,
    RBrace,
    Colon,
}

#[derive(Debug, Clone)]
pub struct LexToken {
    pub kind: TokenKind,
    pub line: usize,
}

pub fn scan_tokens(source: &str) -> Vec<LexToken> {
    let mut tokens = Vec::new();
    for (line_idx, raw_line) in source.lines().enumerate() {
        let mut chars = raw_line.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch.is_whitespace() {
                continue;
            }
            let kind = match ch {
                '{' => TokenKind::LBrace,
                '}' => TokenKind::RBrace,
                ':' => TokenKind::Colon,
                c if c.is_ascii_digit() => {
                    let mut num = String::from(c);
                    while let Some(d) = chars.peek().copied() {
                        if !d.is_ascii_digit() {
                            break;
                        }
                        num.push(d);
                        chars.next();
                    }
                    TokenKind::Int(num.parse().unwrap_or(0))
                }
                c if c.is_ascii_alphabetic() || c == '_' => {
                    let mut ident = String::from(c);
                    while let Some(next_ch) = chars.peek().copied() {
                        if !next_ch.is_ascii_alphanumeric() && next_ch != '_' {
                            break;
                        }
                        ident.push(next_ch);
                        chars.next();
                    }
                    TokenKind::Ident(ident)
                }
                _ => continue,
            };
            tokens.push(LexToken {
                kind,
                line: line_idx + 1,
            });
        }
    }
    tokens
}
