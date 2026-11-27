; Functions & Container Methods
(function_declaration
  name: (identifier) @name) @definition.function

; Structs, Enums, Unions & Opaque Types
(variable_declaration
  (identifier) @name
  (struct_declaration)) @definition.class

(variable_declaration
  (identifier) @name
  (enum_declaration)) @definition.enum

(variable_declaration
  (identifier) @name
  (union_declaration)) @definition.type

(variable_declaration
  (identifier) @name
  (opaque_declaration)) @definition.type

; Tests
(test_declaration
  (string (string_content) @name)) @definition.function

; Calls & References
(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (field_expression
    member: (identifier) @name)) @reference.call

(struct_initializer
  (identifier) @name) @reference.class

(parameter
  type: (identifier) @name) @reference.class

(pointer_type
  (identifier) @name) @reference.class

(nullable_type
  (identifier) @name) @reference.class

(slice_type
  (identifier) @name) @reference.class
