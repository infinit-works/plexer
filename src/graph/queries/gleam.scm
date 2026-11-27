; Gleam tags
(function
  name: (identifier) @name) @definition.function

(type_definition
  (type_name name: (type_identifier) @name)) @definition.struct

(type_alias
  (type_name name: (type_identifier) @name)) @definition.type

(constant
  name: (identifier) @name) @definition.constant

(function_call
  function: [
    (identifier) @name
    (field_access field: (label) @name)
  ]) @reference.call
