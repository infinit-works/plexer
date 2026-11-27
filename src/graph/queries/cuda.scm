; CUDA C/C++ tags
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
(preproc_def name: (identifier) @name) @definition.constant
(preproc_function_def name: (identifier) @name) @definition.function
(namespace_definition name: (namespace_identifier) @name) @definition.module

(function_declarator declarator: (identifier) @name) @definition.function
(function_declarator declarator: (field_identifier) @name) @definition.method
(function_declarator declarator: (qualified_identifier name: (identifier) @name)) @definition.method

(call_expression
  function: [
    (identifier) @name
    (field_expression field: (field_identifier) @name)
    (qualified_identifier name: (identifier) @name)
  ]) @reference.call
