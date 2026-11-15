; Modules & Signatures
(module_definition
  (module_binding (module_name) @name) @definition.module)

(module_path (module_name) @name) @reference.module
(extended_module_path (module_name) @name) @reference.module

(module_type_definition
  (module_type_name) @name) @definition.interface

(module_type_path (module_type_name) @name) @reference.implementation

; Classes & Methods
[
  (class_definition
    (class_binding (class_name) @name) @definition.class)
  (class_type_definition
    (class_type_binding (class_type_name) @name) @definition.class)
]

[
  (class_path (class_name) @name)
  (class_type_path (class_type_name) @name)
] @reference.class

(method_definition
  (method_name) @name) @definition.method

(method_invocation
  (method_name) @name) @reference.call

; Types
(type_definition
  (type_binding
    name: [
      (type_constructor) @name
      (type_constructor_path (type_constructor) @name)
    ]) @definition.type)

(type_constructor_path (type_constructor) @name) @reference.class

; Functions & Calls
(value_definition
  [
    (let_binding pattern: (value_name) @name (parameter))
    (let_binding
      pattern: (value_name) @name
      body: [(fun_expression) (function_expression)])
  ] @definition.function)

(external
  (value_name) @name) @definition.function

(application_expression
  function: (value_path (value_name) @name)) @reference.call

(infix_expression
  left: (value_path (value_name) @name)
  operator: (concat_operator) @reference.call
  (#eq? @reference.call "@@"))

(infix_expression
  operator: (rel_operator) @reference.call
  right: (value_path (value_name) @name)
  (#eq? @reference.call "|>"))
