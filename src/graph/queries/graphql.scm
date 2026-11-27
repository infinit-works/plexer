; GraphQL schema & query tags
(object_type_definition
  (name) @name) @definition.struct

(interface_type_definition
  (name) @name) @definition.interface

(input_object_type_definition
  (name) @name) @definition.struct

(enum_type_definition
  (name) @name) @definition.enum

(union_type_definition
  (name) @name) @definition.type

(scalar_type_definition
  (name) @name) @definition.type

(fragment_definition
  (fragment_name (name) @name)) @definition.function

(operation_definition
  (name) @name) @definition.function

(named_type
  (name) @name) @reference.class

(fragment_spread
  (fragment_name (name) @name)) @reference.call
