; tags.scm for tree-sitter-luau 1.2.0 — installed by roblox-dev scripts/plexer_luau.py.
; Every rule below was validated against the shipped wasm under plexer's web-tree-sitter.

; function f() … end   /   local function f() … end
(function_declaration name: (identifier) @name) @definition.function

; function M.create() … end
(function_declaration
  name: (dot_index_expression field: (identifier) @name)) @definition.function

; function M:method() … end
(function_declaration
  name: (method_index_expression method: (identifier) @name)) @definition.method

; local f = function() end   /   f = function() end
(assignment_statement
  (variable_list name: (identifier) @name)
  (expression_list value: (function_definition))) @definition.function

; M.f = function() end
(assignment_statement
  (variable_list name: (dot_index_expression field: (identifier) @name))
  (expression_list value: (function_definition))) @definition.function

; { name = function() end } — anchored on (field …), not on the table constructor
(field name: (identifier) @name value: (function_definition)) @definition.function

; { ["name"] = function() end }
(field name: (string (string_content) @name) value: (function_definition)) @definition.function

; type X = …   /   export type X = …
(type_definition name: (identifier) @name) @definition.type

; type X<T> = …   /   export type X<T> = …
(type_definition name: (generic_type . (identifier) @name)) @definition.type

; calls: f(), M.f(), obj:m()
(function_call name: (identifier) @name) @reference.call
(function_call name: (dot_index_expression field: (identifier) @name)) @reference.call
(function_call name: (method_index_expression method: (identifier) @name)) @reference.call
