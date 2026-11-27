; Nix tags — standard tree-sitter tags convention (@definition.<kind> + @name + @reference.call).
; Based on upstream tree-sitter-nix queries, extended for plexer's breadth tier.
;
; Note: `binding` inside `let_expression` cannot have its children matched in
; tree-sitter queries (parse error), so let-bound variables are NOT captured as
; @definition. They are still searchable via the file node's residual body.

; Function definitions: `name = args: body` (top-level attrsets and let bindings)
(binding
  (attrpath (identifier) @name)
  (function_expression) @definition.function)

; Flake / attrset named expressions in top-level or let bindings
(let_expression
  (binding_set
    (binding
      (attrpath (identifier) @name)
      expression: (function_expression)) @definition.function))

; Inherit statements: `inherit (source) name1 name2`
(inherit
  (inherited_attrs (identifier) @name @definition.constant))

; Method/attribute calls: `builtins.map`, `pkgs.python3.withPackages`, etc.
(apply_expression
  function: (select_expression
    attrpath: (attrpath attr: (identifier) @name))) @reference.call

; Direct function application: `f arg` (also covers nested `f arg1 arg2` via inner apply_expression)
(apply_expression
  function: (variable_expression
    name: (identifier) @name)) @reference.call
