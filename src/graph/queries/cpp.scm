(struct_specifier name: (type_identifier) @name body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name)) @definition.class

(namespace_definition name: (namespace_identifier) @name) @definition.module

(preproc_def name: (identifier) @name) @definition.constant

(preproc_function_def name: (identifier) @name) @definition.function

(function_declarator declarator: (identifier) @name) @definition.function

(function_declarator declarator: (field_identifier) @name) @definition.method

(function_declarator
  declarator: (qualified_identifier
    name: [
      (identifier) @name
      (qualified_identifier name: (identifier) @name)
      (qualified_identifier name: (qualified_identifier name: (identifier) @name))
    ])) @definition.method

(type_definition declarator: (type_identifier) @name) @definition.type

(enum_specifier name: (type_identifier) @name) @definition.enum

(class_specifier name: (type_identifier) @name) @definition.class

(call_expression
  function: [
    (identifier) @name
    (field_expression field: (field_identifier) @name)
    (qualified_identifier name: (identifier) @name)
    (qualified_identifier name: (qualified_identifier name: (identifier) @name))
  ]) @reference.call

(new_expression
  type: (type_identifier) @name) @reference.call
