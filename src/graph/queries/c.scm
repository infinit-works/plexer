(struct_specifier name: (type_identifier) @name body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name)) @definition.class

(preproc_def name: (identifier) @name) @definition.constant

(preproc_function_def name: (identifier) @name) @definition.function

(function_declarator declarator: (identifier) @name) @definition.function

(type_definition declarator: (type_identifier) @name) @definition.type

(enum_specifier name: (type_identifier) @name) @definition.type

; plexer: call sites (direct and function-pointer struct member calls)
(call_expression
  function: [
    (identifier) @name
    (field_expression field: (field_identifier) @name)
  ]) @reference.call
